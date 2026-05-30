#!/usr/bin/env python3
"""
tools/linker_ml/train_embed.py — contrastive fine-tune of an attention encoder.

The deterministic scorer is bag-of-tokens: "TBWC" and "That Boutique-y Whisky Company"
share zero tokens, so no weight-tuning can connect them. A transformer (attention) encoder
maps listings to vectors where MEANING drives closeness; fine-tuned contrastively on our
confirmed links it learns the equivalences that live only in OUR labels (TBWC↔expansion,
MCDXCIV↔1494, Compass Box↔Great King Street).

Pipeline:
  1. Load out/sku_texts.jsonl (sku→normalized name, canon) and out/groups.json.
  2. Split by canonical group (SAME FNV hash + 25% as train_blend.mjs) so val pairs are
     never seen in training → the AUC+ lift we report is honest.
  3. Encode every SKU with the BASE model → out/embeddings_base.json (off-the-shelf ablation).
  4. Fine-tune all-MiniLM-L6-v2 with MultipleNegativesRankingLoss on TRAIN-group positive
     pairs (in-batch negatives). Encode every SKU → out/embeddings.json.

Then back on the Node side:
  node tools/linker_ml/dump_features.mjs   # fills embed_cosine from embeddings.json
  node tools/linker_ml/train_blend.mjs     # re-trains the blend WITH the semantic feature
  node tools/linker_ml/eval_gap.mjs        # before/after on the semantic-gap benchmark

Run (inside the venv):  python tools/linker_ml/train_embed.py --epochs 3
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
VAL_FRAC = 0.25


def fnv1a32(s: str) -> int:
    """Identical to train_blend.mjs hash32 → same train/val split across languages."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch) & 0xFF
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def is_val(canon: str) -> bool:
    return (fnv1a32(str(canon)) % 1000) / 1000.0 < VAL_FRAC


def load_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--max-pairs-per-group", type=int, default=60)
    ap.add_argument("--skip-base", action="store_true", help="don't write embeddings_base.json")
    ap.add_argument("--scale", type=float, default=20.0, help="MNRL temperature scale")
    ap.add_argument("--lr", type=float, default=2e-5, help="AdamW learning rate")
    ap.add_argument("--tag", default="ft", help="output tag: writes embeddings_<tag>.json (or embeddings.json if 'ft')")
    ap.add_argument(
        "--no-hard-negs",
        action="store_true",
        help="train with in-batch negatives only (skip curated ignore/hard triplets)",
    )
    args = ap.parse_args()

    try:
        import torch
        import torch.nn.functional as F
        from sentence_transformers import SentenceTransformer
    except ImportError:
        sys.exit(
            "sentence-transformers / torch not importable. Install (in a venv):\n"
            "  pip install torch --index-url https://download.pytorch.org/whl/cpu\n"
            "  pip install -r tools/linker_ml/requirements.txt"
        )

    texts = load_jsonl(os.path.join(OUT, "sku_texts.jsonl"))
    sku_text = {r["sku"]: r["text"] for r in texts}
    sku_canon = {r["sku"]: r["canon"] for r in texts}
    groups = json.load(open(os.path.join(OUT, "groups.json")))

    skus_all = list(sku_text.keys())
    text_all = [sku_text[s] for s in skus_all]

    def encode_all(model, tag):
        print(f"[{tag}] encoding {len(skus_all)} SKUs ...", flush=True)
        vecs = model.encode(
            text_all,
            batch_size=256,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=True,
        )
        out = {s: [round(float(x), 4) for x in v] for s, v in zip(skus_all, vecs)}
        path = os.path.join(OUT, f"embeddings_{tag}.json" if tag != "ft" else "embeddings.json")
        json.dump(out, open(path, "w"))
        print(f"[{tag}] wrote {path} ({len(out)} vectors, dim {len(vecs[0])})", flush=True)

    print(f"loading base model {args.model} ...", flush=True)
    model = SentenceTransformer(args.model)

    if not args.skip_base:
        encode_all(model, "base")

    # Train positives: within-group pairs from TRAIN groups only (no val leakage).
    pair_skus = []
    n_train_groups = 0
    for g in groups:
        canon = sku_canon.get(g[0], g[0])
        if is_val(canon):
            continue
        n_train_groups += 1
        members = [s for s in g if s in sku_text and sku_text[s]]
        cnt = 0
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                pair_skus.append((members[i], members[j]))
                cnt += 1
                if cnt >= args.max_pairs_per_group:
                    break
            if cnt >= args.max_pairs_per_group:
                break
    n = len(pair_skus)

    # Hard negatives per anchor: curated ignores + auto-mined hard pairs, TRAIN-only.
    # Pushing confirmed non-matches apart is what protects the high-precision tail (the
    # cases where two DIFFERENT products are semantically near — edition/size variants).
    import random

    rnd_py = random.Random(123)
    hard_map = {}
    use_hard = not args.no_hard_negs
    if use_hard:
        for r in load_jsonl(os.path.join(OUT, "dataset_pairs.jsonl")):
            if r.get("label") != 0 or r.get("kind") not in ("ignore", "hard"):
                continue
            a, b = r["a"], r["b"]
            if a not in sku_text or b not in sku_text:
                continue
            if is_val(sku_canon.get(a, a)) or is_val(sku_canon.get(b, b)):
                continue
            hard_map.setdefault(a, []).append(b)
            hard_map.setdefault(b, []).append(a)
    train_skus = [s for s in sku_text if not is_val(sku_canon.get(s, s))]

    def neg_text_for(anchor_sku):
        cands = hard_map.get(anchor_sku)
        if cands:
            return sku_text[rnd_py.choice(cands)], True
        for _ in range(8):  # random different-group fallback
            s = rnd_py.choice(train_skus)
            if sku_canon.get(s, s) != sku_canon.get(anchor_sku, anchor_sku):
                return sku_text[s], False
        return sku_text[anchor_sku], False

    neg_texts, n_real_hard = [], 0
    for a, _b in pair_skus:
        t, real = neg_text_for(a)
        neg_texts.append(t)
        if real:
            n_real_hard += 1
    print(
        f"train: {n} positive pairs from {n_train_groups} train groups; "
        f"hard-negs={'on' if use_hard else 'off'} ({n_real_hard}/{n} from curated, rest random)",
        flush=True,
    )

    # ---- manual MultipleNegativesRankingLoss loop (no `datasets` dependency) ----
    # Per batch: embed anchors A, positives P, hard-negatives N; the candidate pool is
    # [P ; N], scores = A·candᵀ·scale, and each anchor's true class is its own positive.
    # Other in-batch positives AND every hard negative are negatives — standard MNRL with
    # explicit hard negatives. scale=20.
    device = "cpu"
    model.to(device)
    model.train()
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    scale = args.scale
    bs = args.batch
    rng = torch.Generator().manual_seed(42)

    # Underlying HF tokenizer + transformer (stable across ST versions); all-MiniLM uses
    # mean pooling, matching model.encode() at inference time.
    tok = model.tokenizer
    auto = model[0].auto_model

    def mean_pool(last_hidden, mask):
        m = mask.unsqueeze(-1).float()
        return (last_hidden * m).sum(1) / m.sum(1).clamp(min=1e-9)

    def embed_batch(texts):
        enc = tok(texts, padding=True, truncation=True, max_length=128, return_tensors="pt")
        enc = {k: v.to(device) for k, v in enc.items()}
        out = auto(**enc)
        return F.normalize(mean_pool(out.last_hidden_state, enc["attention_mask"]), p=2, dim=1)

    for ep in range(args.epochs):
        perm = torch.randperm(n, generator=rng).tolist()
        ep_loss, ep_steps = 0.0, 0
        for start in range(0, n, bs):
            idx = perm[start : start + bs]
            if len(idx) < 2:
                continue
            a = [sku_text[pair_skus[i][0]] for i in idx]
            p = [sku_text[pair_skus[i][1]] for i in idx]
            nneg = [neg_texts[i] for i in idx]
            emb_a = embed_batch(a)
            emb_p = embed_batch(p)
            emb_n = embed_batch(nneg)
            cand = torch.cat([emb_p, emb_n], dim=0)  # (2B x d)
            scores = (emb_a @ cand.t()) * scale  # (B x 2B)
            labels = torch.arange(len(idx), device=device)
            loss = F.cross_entropy(scores, labels)
            opt.zero_grad()
            loss.backward()
            opt.step()
            ep_loss += float(loss.detach())
            ep_steps += 1
        print(
            f"  epoch {ep + 1}/{args.epochs}  steps {ep_steps}  mean_loss {ep_loss / max(1, ep_steps):.4f}",
            flush=True,
        )

    model.eval()
    encode_all(model, args.tag)
    print("done. Now run: node tools/linker_ml/dump_features.mjs && node tools/linker_ml/train_blend.mjs", flush=True)


if __name__ == "__main__":
    main()
