#!/usr/bin/env python3
"""
tools/linker_ml/encode.py — re-encode every current SKU with the FIXED fine-tuned encoder.

This is the cheap per-scrape half of the embedding pipeline (the expensive fine-tune is
train_embed.py, run by hand every few months). run_daily.sh calls this after the scrape +
build_dataset.mjs so newly-scraped SKUs get vectors WITHOUT retraining weights. The output is
deterministic (fixed weights, model.eval(), 4-decimal rounding) — an unchanged catalog yields
byte-identical embeddings.json, so git/LFS see no change.

Inputs:  $LINKER_MODEL_DIR (or out/model_ft) — the fine-tuned checkpoint. In CI it's a GitHub
         Release asset restored via actions/cache (NOT git-LFS — the cron never smudges data LFS,
         so an LFS checkpoint would arrive as a useless pointer; a release asset also costs no LFS
         bandwidth/storage). A hand-retrain leaves it in out/model_ft.
         tools/linker_ml/out/sku_texts.jsonl  (skuToTextEnriched per SKU, from build_dataset.mjs)
Output:  tools/linker_ml/out/embeddings.json  ({sku: [384 floats]}), then copied by run_daily.sh
         to <worktree>/viz/data/sku_embeddings.json (LFS).

Run (inside the venv):  python tools/linker_ml/encode.py
Loads the checkpoint OFFLINE — never reaches HuggingFace (the model is local + complete).
"""

import json
import os
import sys

# Force offline so a missing network / HF outage can't change behavior or hang CI.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
# Checkpoint location: CI sets LINKER_MODEL_DIR to where the Release-asset checkpoint was
# extracted; a local hand-retrain leaves it in out/model_ft (where train_embed.py saved it).
MODEL_DIR = os.environ.get("LINKER_MODEL_DIR") or os.path.join(OUT, "model_ft")
TEXTS_PATH = os.path.join(OUT, "sku_texts.jsonl")
EMB_PATH = os.path.join(OUT, "embeddings.json")


def main():
    if not os.path.isdir(MODEL_DIR):
        sys.exit(
            f"fine-tuned checkpoint not found at {MODEL_DIR}.\n"
            "Run train_embed.py (hand-retrain) to produce + commit it — there is no base-model\n"
            "fallback on purpose: base vectors live in a different space and would corrupt cosines."
        )
    if not os.path.isfile(TEXTS_PATH):
        sys.exit(f"{TEXTS_PATH} missing — run `node tools/linker_ml/build_dataset.mjs` first.")

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        sys.exit(
            "sentence-transformers / torch not importable. Install (in a venv):\n"
            "  pip install torch --index-url https://download.pytorch.org/whl/cpu\n"
            "  pip install -r tools/linker_ml/requirements.txt"
        )

    with open(TEXTS_PATH) as f:
        rows = [json.loads(line) for line in f if line.strip()]
    skus = [r["sku"] for r in rows]
    texts = [r["text"] for r in rows]
    print(f"encoding {len(skus)} SKUs with {MODEL_DIR} ...", flush=True)

    model = SentenceTransformer(MODEL_DIR)
    model.eval()
    # Same encode params as train_embed.encode_all → bit-for-bit comparable vectors.
    vecs = model.encode(
        texts,
        batch_size=256,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    out = {s: [round(float(x), 4) for x in v] for s, v in zip(skus, vecs)}
    json.dump(out, open(EMB_PATH, "w"))
    print(f"wrote {EMB_PATH} ({len(out)} vectors, dim {len(vecs[0])})", flush=True)


if __name__ == "__main__":
    main()
