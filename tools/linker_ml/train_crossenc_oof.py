#!/usr/bin/env python3
"""
tools/linker_ml/train_crossenc_oof.py — OUT-OF-FOLD cross-encoder scoring of every
dataset pair (Task 4). The prior single-fit cross-encoder (Exp 4) regressed TEST rec@99
to 79.8% because it was fit on TRAIN groups then scored ALL pairs: the crossEnc column was
near-perfect on TRAIN rows and noisier on TEST, so the GBT over-trusted a train-memorized
feature and the 99%-precision tail broke.

Fix: 5-fold over canonical GROUPS (fold = fnv(canon) % 5). For each fold k, fine-tune a
cross-encoder on the OTHER 4 folds' pairs, then score fold k's pairs. Concatenate → every
pair has an OUT-OF-FOLD crossEnc score (the model that scored it never saw its group).

noTrain pairs: excluded from every fold's TRAINING set (same policy as the other trainers),
but still SCORED (by whichever fold owns their group) so the feature column is complete.

Manual torch BCE loop (no `datasets` dep), mirroring train_embed.py's hand-rolled loop.
Base: cross-encoder/ms-marco-MiniLM-L-6-v2 (a regression/classification CrossEncoder head).

Output: out/crossenc_oof_scores.json  { "skuA|skuB": prob, ... }  (keys sorted a<b)
        out/crossenc_oof.log
Also saves the LAST fold's model dir out/crossenc_oof_model/ for reuse.

Run (venv):
  HF_HOME="$PWD/tools/linker_ml/.hf_cache" \
    tools/linker_ml/.venv/bin/python tools/linker_ml/train_crossenc_oof.py --epochs 2 --folds 5
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")


def fnv1a32(s: str) -> int:
    h = 0x811C9DC5
    for ch in str(s):
        h ^= ord(ch) & 0xFF
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def load_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def pkey(a, b):
    return f"{a}|{b}" if a < b else f"{b}|{a}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="cross-encoder/ms-marco-MiniLM-L-6-v2")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--lr", type=float, default=2e-5)
    args = ap.parse_args()

    try:
        import torch
        import torch.nn.functional as F
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
    except ImportError:
        sys.exit("torch / transformers not importable in the venv.")

    texts = load_jsonl(os.path.join(OUT, "sku_texts.jsonl"))
    sku_text = {r["sku"]: r["text"] for r in texts}
    sku_canon = {r["sku"]: r["canon"] for r in texts}

    pairs = load_jsonl(os.path.join(OUT, "dataset_pairs.jsonl"))
    # keep only pairs whose both SKUs have text
    pairs = [p for p in pairs if p["a"] in sku_text and p["b"] in sku_text]

    def fold_of(sku):
        return fnv1a32(sku_canon.get(sku, sku)) % args.folds

    # a pair belongs to fold = fold of its canonA (matches build/dump canonA convention:
    # the GBT split keys off canonA, so fold-by-canonA = no group leakage into the held fold).
    no_train_keys = set(pkey(p["a"], p["b"]) for p in pairs if p.get("noTrain"))
    print(f"pairs with text: {len(pairs)}; noTrain held out of training: {len(no_train_keys)}", flush=True)

    device = "cpu"
    tok = AutoTokenizer.from_pretrained(args.model)

    def encode(a_texts, b_texts):
        return tok(a_texts, b_texts, padding=True, truncation=True, max_length=128, return_tensors="pt")

    oof_scores = {}
    import random

    last_model_dir = None
    for k in range(args.folds):
        train_rows = [
            p for p in pairs
            if fold_of(p["a"]) != k and pkey(p["a"], p["b"]) not in no_train_keys
        ]
        test_rows = [p for p in pairs if fold_of(p["a"]) == k]
        if not train_rows or not test_rows:
            print(f"fold {k}: empty (train {len(train_rows)} / test {len(test_rows)}) — skip", flush=True)
            continue

        # balance: all positives + an equal random sample of negatives
        pos = [p for p in train_rows if p["label"] == 1]
        neg = [p for p in train_rows if p["label"] == 0]
        rnd = random.Random(100 + k)
        rnd.shuffle(neg)
        neg = neg[: max(len(pos), 1)]
        tr = pos + neg
        rnd.shuffle(tr)
        print(f"fold {k}: train {len(tr)} ({len(pos)} pos + {len(neg)} neg) → score {len(test_rows)} pairs", flush=True)

        model = AutoModelForSequenceClassification.from_pretrained(args.model, num_labels=1)
        model.to(device)
        model.train()
        opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
        bs = args.batch
        for ep in range(args.epochs):
            rnd.shuffle(tr)
            ep_loss, steps = 0.0, 0
            for s in range(0, len(tr), bs):
                chunk = tr[s : s + bs]
                a = [sku_text[r["a"]] for r in chunk]
                b = [sku_text[r["b"]] for r in chunk]
                y = torch.tensor([float(r["label"]) for r in chunk], device=device)
                enc = encode(a, b)
                enc = {kk: vv.to(device) for kk, vv in enc.items()}
                logits = model(**enc).logits.squeeze(-1)
                loss = F.binary_cross_entropy_with_logits(logits, y)
                opt.zero_grad()
                loss.backward()
                opt.step()
                ep_loss += float(loss.detach())
                steps += 1
            print(f"  fold {k} epoch {ep + 1}/{args.epochs} mean loss {ep_loss / max(1, steps):.4f}", flush=True)

        model.eval()
        with torch.no_grad():
            for s in range(0, len(test_rows), 256):
                chunk = test_rows[s : s + 256]
                a = [sku_text[r["a"]] for r in chunk]
                b = [sku_text[r["b"]] for r in chunk]
                enc = encode(a, b)
                enc = {kk: vv.to(device) for kk, vv in enc.items()}
                probs = torch.sigmoid(model(**enc).logits.squeeze(-1)).tolist()
                if isinstance(probs, float):
                    probs = [probs]
                for r, pr in zip(chunk, probs):
                    oof_scores[pkey(r["a"], r["b"])] = round(float(pr), 5)
        last_model_dir = os.path.join(OUT, "crossenc_oof_model")
        model.save_pretrained(last_model_dir)
        tok.save_pretrained(last_model_dir)

    out_path = os.path.join(OUT, "crossenc_oof_scores.json")
    json.dump(oof_scores, open(out_path, "w"))
    print(f"wrote {out_path} ({len(oof_scores)} OOF scores); last model → {last_model_dir}", flush=True)


if __name__ == "__main__":
    main()
