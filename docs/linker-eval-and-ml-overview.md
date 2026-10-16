# Linker evaluation harness and learned classifier (overview)

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

## Linker Evaluation & Training Harness (`tools/linker_eval/`)

Dev/analysis tooling for the SKU-matching algorithm. **NOT** run by `run_daily.sh` —
these are run by hand against the `.worktrees/data` worktree.

**Start here:** `tools/linker_eval/CLAUDE.md` is the iteration guide for future
sessions — the metrics that matter (AUC+, auto-link thresholds), the measure-risk-
before-adding-a-rule loop, the hard-won lessons (which discriminators are safe vs
which break confirmed links), and how to edit the links file safely.

- `tools/linker_eval/TECHNICAL_REPORT.md` — **canonical spec** of the scoring
  algorithm: full pipeline, formulas, every tuned constant, and the named benchmark
  cases. Update it whenever the scorer changes.
- `tools/linker_eval/CLASSIFIER_PLAN.md` — roadmap for the **future learned
  classifier** (calibrated yes/no model run in CI): log-linear blend of the existing
  factors, group-profile features with leave-one-out, hard-negative mining, and an
  optional fine-tuned MiniLM embedding for semantic matches (e.g. `PM` ↔ `Port
  Mourant`) the token-based scorer structurally cannot make. Precision-first; a review
  step (now the hand-run agent audits) handles everything below the auto-link
  threshold.
- `tools/linker_eval.mjs` — eval harness, scored ENTIRELY against the big labeled set
  (`sku_links.json` links = positives, ignores = curated hard negatives; no more
  `fixtures.json`). Headline metrics: **AUC+** (AUC vs auto-mined hard negatives — the
  one that matters; a trivial shared-word baseline is printed as the floor) and the
  **auto-link threshold table** (what cutoff hits 90/95/98/99% precision and the recall
  there). **Output convention (keep it):** every run prints aligned monospace tables —
  a headline-metrics table (AUC+, AUC vs ignores, trivial floor, pair counts), the
  threshold table, a precision/recall grid, and **worst false-positive / false-negative
  charts with a consistent column set** (`# · algo score · expected (LINK/IGNORE) · SKU A ·
  Name A · SKU B · Name B`) so they're scannable, not prose. Re-run on every scorer change.
  Imports the live scorer (`viz/app/linker_page/suggestions.js`) so eval and ranker never
  drift. NOTE: labels lag reality (hundreds of links/ignores still unadded) — treat the
  current links/ignores as ground truth and assume they keep improving; don't tune to the
  unlabeled middle.
- `tools/linker_outliers.mjs` — label QA + disagreement analytics. Emits
  `outliers.json` (missed links, suspect ignores/links, intra-group conflicts) and
  `algo_failures.md` (a readable, factor-decomposed report of where the algorithm
  disagrees with human labels — built for downstream analysis). Runs in ~5 s.

The single most important supervision signal is `data/sku_links.json` (manual links +
`ignores`); see "SKU Identity & Canonical Mapping" above. Implicit links (same raw SKU
at ≥2 stores) are captured for free by aggregating per raw SKU.

### How to REPORT benchmark results to the user (required format)

When presenting eval/benchmark output, do NOT paste the raw harness text. **Re-render it
yourself as clean Markdown tables** (the kind that draw nicely in the terminal), with
column headers, and **show every requested row** (e.g. all 15 worst offenders — never
truncate to a few). Prose analysis is welcome *before and after*, but the tables are
mandatory. Three tables, in this order:

1. **Headline metrics** — columns `Metric | Value | Floor / note`. Always include AUC+
   (vs hard negatives) with its trivial shared-word floor, AUC vs ignores, and the
   auto-link thresholds for 95% and 99% precision (with recall). These are the numbers
   that matter; the small-fixtures era is over.
2. **15 worst false positives** (ignored pairs scored high) — columns
   `# | Algo | Expected | SKU A | Name A | SKU B | Name B | Why`. Expected = `IGNORE`.
3. **15 worst false negatives** (linked pairs scored low) — same columns, Expected = `LINK`.

Always include the raw SKUs (so they're searchable) and a short "Why" cell per row
(size variant / one-sided age / SMWS-code-lost / possessive-brand / probable-mislabel …).
Flag suspected mislabels explicitly so they can be relabeled rather than chased.

## Learned Classifier + Attention Embedder (`tools/linker_ml/`)

The deterministic scorer is bag-of-tokens and structurally cannot match names that share no
tokens (`TBWC` ↔ `That Boutique-y Whisky Company`, `Compass Box Artist` ↔ `Great King Street
Artist's Blend`). `tools/linker_ml/` **augments** it (does not replace it) with a learned
classifier over the existing factors **+ 13 canonical-GROUP↔GROUP features + a MiniLM attention
embedding** (fine-tuned on `data/sku_links.json`, its text enriched with group-resolved
size/abv/year/category). The full deterministic score is one feature, so the current algo's
strengths are preserved. **The shipping classifier is a gradient-boosted tree** (`export_gbt.py`
→ `gbt_model.json`, run live via `viz/app/linker_page/gbt.js`); a logistic blend
(`blend_weights.js`) is the graceful fallback. The GBT fixed the linear blend's tail pathologies
(over-scored zero-token-overlap pairs; under-scored matches with a missing embedding vector).
Held-out auto-link **recall @99% precision, measured honestly (2026-10-09): 45% for a brand-new listing joining a
group (prod was 25%), 85% for an existing listing meeting another group (prod 72%).** Earlier headlines (95.2% etc.)
were inflated by a label leak in the encoder text; see `tools/linker_ml/CLAUDE.md` §"2026-10-09".

**Start here:** `tools/linker_ml/CLAUDE.md` — the iteration + **re-train** guide (the retrain
chain to re-run when the labeled set grows, the venv prereqs, the no-leakage group split, the
hard-won notes, and **§"Shipping the checkpoint"** — the must-do re-release after every retrain so
CI's per-build re-encode uses the new weights). `tools/linker_ml/README.md` is the pipeline diagram.

**Per-build re-encode (SHIPPED):** `run_daily.sh` re-encodes `sku_embeddings.json` every scrape with
the FIXED fine-tuned checkpoint (`encode.py`), so new SKUs get vectors without retraining. The
checkpoint ships as a **GitHub Release asset** (`model-ft-<MODEL_VERSION>`), restored in CI via
`actions/cache` — NOT git/LFS (the cron never smudges data-branch LFS; details in that CLAUDE.md).

- Pure-Node, zero-dep substrate (`featurize.mjs`, `build_dataset.mjs`, `dump_features.mjs`,
  `train_blend.mjs`, `eval_gap.mjs`) — runs immediately, reuses the live scorer's helpers.
- Python venv (`train_embed.py`, CPU torch + sentence-transformers, manual MNRL loop — no
  `datasets` dep) fine-tunes the encoder. The venv (`.venv/`), HF cache (`.hf_cache/`), and
  all artifacts (`out/`, incl. `blend_weights.json` + `embeddings.json`) are gitignored.
- Headline metric: **recall at ≥99% precision** (a wrong auto-link corrupts a canonical
  group), then AUC+. Train/val is split by canonical group so the embedding lift isn't leaked.
