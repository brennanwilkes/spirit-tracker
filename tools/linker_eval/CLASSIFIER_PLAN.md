# SKU Linker — Plan for a Learned Classifier

Companion to `TECHNICAL_REPORT.md` (the current deterministic scorer). This file
describes where we want to take SKU matching: from a hand-tuned formula to a
**learned, calibrated yes/no classifier** that can link newly-scraped SKUs
automatically. It is deliberately realistic — we are not building Claude-for-booze.

> **STATUS — PROTOTYPED (see `tools/linker_ml/`).** Ladder steps 2–4 below are built and
> measured: the **log-linear blend** over the existing factors (§2/ §3) and a **fine-tuned
> MiniLM attention embedder** (§5) with hard-negative mining. Measured on the labeled set
> (held-out by canonical group): **AUC+ 0.81 → 0.91**, and **recall at 99% precision rose
> several-fold**, with the semantic-gap class (`TBWC`↔expansion, `Compass Box`↔`Great King
> Street`) recovered. Re-train guide + numbers: `tools/linker_ml/CLAUDE.md` +
> `tools/linker_ml/RESULTS.md`. Still future: the GitHub-Action auto-triage loop (§2 "CI
> auto-linker"), group-profile leave-one-out features (§4), and ONNX export for CI.

## 1. The goal, stated precisely

Given two listings (or a new listing and an existing canonical group), output a
**calibrated probability they are the same product**, and auto-link only above a
near-100%-precision threshold. Everything below goes to a human review queue
(reusing the existing `stviz/issue-*` GitHub-issue edit flow). A wrong auto-link
corrupts a canonical group, so **precision is the hard constraint; recall is the
thing we grow over time.**

## 2. Two tiers (resolves the infra tension)

- **Browser `#/link` ranker** — stays pure-JS, heuristic, human-in-the-loop. Its
  job is *candidate retrieval + rough ranking + label harvesting*. Every
  accept→link / reject→ignore is a labeled example. This is the data flywheel.
- **CI auto-linker** — runs in the scraper's GitHub Action, where Python /
  LightGBM / ONNX / sentence-transformers are all available. This is where the
  heavy model lives. The Action already has Node, so retrieval reuses the exact
  `recommendSimilar` (no drift), emits candidate pairs as JSON, and hands them to
  a Python reranker. Single retrieval definition; new rerank head only.

"Dynamic over time" = **instant inference with today's model** (retrieve →
classify any new item) + **periodic batch retrain** on accumulated labels. Batch
is fine; scraping is already batch. Nothing needs to be streaming/online.

## 3. The ladder (highest ROI first)

1. **Measure + harvest** *(done / in progress)* — `linker_eval.mjs` (P/R/F1,
   margins) + `linker_outliers.mjs` (disagreements, group conflicts,
   `algo_failures.md`). Also: a per-pair **feature-logging** dump (the factor
   values + label → JSONL) is the substrate for everything below.
2. **Learn the blend.** The score is a *product* of factors, so
   `log(score) = Σ log(factor)`. A **logistic regression on log-transformed
   factors** literally learns the optimal exponent/weight on each *existing*
   factor — an interpretable generalization of the hand-tuned constants
   (`WO_POW`, the coverage floors, …). Train offline, ship ~11 weights as JSON,
   infer with a dot product (works in *both* tiers). Highest ROI per unit effort;
   gives calibrated confidence for the auto-link threshold.
3. **Add features, then a small GBM.** Feed the same model new pairwise features
   (below). A depth-3 / ~50-tree gradient-boosted ensemble captures interactions
   and still exports to JSON for pure-JS inference.
4. **Embeddings** *(only if 2–3 plateau)* — see §5.

## 4. Feature design (what a training row is)

A training example is a **(group profile A, group profile B, label)** triple. A
new/single item is just a group of one — this unifies item↔item, item↔group, and
group↔group into one shape, and matches inference (a new item vs an existing
group).

Each **group profile** aggregates its members: union of name tokens (so if one
member spells "Port Mourant" and another writes "PM", the profile carries both),
size *set* (a sizeless member inherits the group's 375 ml), ABV/age range, store
set, edition codes, price range. Features then compare profiles:

- the ~11 existing scorer factors (token overlap, coverage penalties, edition
  codes, size, price, age, ABV) — already computed
- **size-set overlap/conflict** (the fill-in effect above)
- **store-set overlap** — a weak *negative* signal (a store rarely lists the same
  product under two SKUs in two groups)
- **same-store boolean** (direct `A.store == B.store`)
- intra-group attribute conflicts (size/ABV/age/edition) as profile quality flags

**Excluded by design:** URL, image, store *name*, price *history* — too
noisy / non-stationary (stores and products churn constantly). Raw SKU is an
*identity / label source*, not a matching feature.

**Critical trap — leave-one-out.** When building a positive ("item X ∈ group G"),
construct G's profile **with X removed**, or the features leak the answer and the
model learns nothing. Held-out-member-vs-rest = exactly the live inference case,
so this also buys train/inference parity for free.

## 5. Embeddings & "attention" — realistic scope

The deterministic scorer is bag-of-tokens: "PM" and "Port Mourant" share zero
tokens, so **no weight-tuning can ever connect them** — the representation is the
ceiling. A learned embedding maps listings to vectors where *meaning*, not
spelling, drives closeness; trained contrastively on our confirmed links it
generalizes abbreviations, synonyms, producer↔region relations. Its cosine
becomes one more feature for the classifier (it also speeds retrieval — a bonus).

- **"Attention"** is not a separate build — it is the machinery inside a small
  transformer encoder (MiniLM-sized). Fine-tune one and we get it for free.
- An **off-the-shelf** model knows general English, not rum-world equivalences —
  those live in *our* labels, so the encoder must be **fine-tuned on our pairs**.
  This is why embeddings come *after* a solid labeled set exists.
- **Hard-negative mining** is the key training trick and we get it free: the eval
  harness already mines same-distinctive-bigram / different-group pairs, plus the
  curated `ignores`. Contrastive training on those is what sharpens precision.
- Division of labor for near-zero false positives: **embeddings raise recall**
  (catch PM = Port Mourant); **deterministic constraints still veto** (ABV, size,
  cask/edition codes). Semantic feature finds more; hard rules protect precision.

## 6. What we are explicitly NOT doing

No LLM in the hot path, no giant model, no streaming infra, no per-product
fine-tuning. The end state is a small, calibrated, mostly-interpretable
classifier (LR/GBM + one optional fine-tuned MiniLM feature) running batch in CI,
gated hard on precision, fed by a human-reviewed label flywheel.
