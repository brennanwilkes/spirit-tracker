# Stale-embeddings incident (2026-08-20 to 2026-09-19)

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

### The stale-embeddings incident (2026-08-20 → 2026-09-19) — the single most damaging defect found

**The `embeddings-latest` Release asset was frozen for a month while every cron job reported
success.** Root cause: the CI venv cache restores `tools/linker_ml/.venv`, whose `bin/python` is a
symlink into the runner image's interpreter; a Python patch bump in a new image dangled it, the
`-x "$PYTHON_BIN"` guard in `run_daily.sh` went false, and the skip printed a bare `INFO`. The
upload step then found no file and also printed a bare `INFO`. Nothing failed; nothing was loud.

Blast radius is production, not just the audit: `auto_link_classify.mjs` scores against those
vectors every scrape, so **every SKU first seen after 2026-08-20 had no vector, took the GBT's
conservative missing-embedding branch, and was never auto-linked.** The linker page reads the same
asset. Re-encoding is cheap — 13,785 SKUs in ~12 s on CPU — so the cost was pure silence.

Effect of a fresh encode on the full default window, no code change:

| | stale | fresh |
|---|---|---|
| `no-embedding` candidate pairs | 47.8% of near-miss | **0 / 21,497** |
| near-miss listings | 900 | **448** |
| want-links | 54 | **117** |
| need-unlinks | 0 | 2 |

**A previous claim here was wrong and is retracted:** the no-embedding hint was NOT "embeddings are
keyed by the aggregate SKU so a store's alias listing misses". It was staleness, full stop. With a
current file the rate is zero. The only SKUs legitimately without a vector are `sku_hidden.json`
listings, which `featurize.mjs` excludes from the linker ML entirely (~300 of 14,088) — see
[[feedback_notrain_and_hidden_exclusion]].

Hardening shipped (all three, because any one alone still fails silently):
1. `cron_tracker.yaml` salts the venv cache key with `python -VV` and adds a **validate-restored-venv**
   step that rebuilds when `import torch, sentence_transformers` fails. A dead cache now busts
   instead of poisoning.
2. `run_daily.sh` guards on a POPULATED checkpoint dir (the workflow comment already claimed this;
   the code only checked `-d`), and both skip branches are now `WARN`, not `INFO`.
3. `run_daily.sh` asserts the exact freshness invariant after the upload: **every SKU in the
   `sku_texts.jsonl` this run just wrote must have a vector in the file being shipped.** Percentage
   thresholds cannot catch this — a full month of freezing only moved catalog coverage from 1.8% to
   4.7% missing, well inside any sane tolerance.

**Recovery — DONE 2026-09-20.** The `embeddings-latest` asset was refreshed by hand
(`gh release upload --clobber`, after asserting all 13,785 encoder inputs had vectors), and the
one-time backlog sweep was run, because `--since 2` only anchors the last 2 days and would never
have re-scored the blind month.

`auto_link_classify --top 10 --since 40` found **66 above-bar pairs over 1,498 anchors** — and
16 of them were false positives, so **the sweep was NOT applied as-is**. It was triaged against
`data/sku_link_policy.md` and applied as an `agent-audit` proposal
(`audit/proposal-backlog-sweep-2026-09-20.json`): 46 links accepted (36 net, 10 transitively
redundant), 17 rejected to curated ignores, 3 to `review[]` and since resolved. Result: links
5,845 → 5,881, ignores 12,606 → 12,626.

**The lesson for the next sweep: a backlog sweep is not a cron run and must not be applied
blind.** A normal `--since 2` run anchors a handful of same-day SKUs; a 40-day sweep re-scores a
month of accumulated orphans at once, which is exactly the population where the near-bar
false-positive classes concentrate. The 16 rejects were: 6× `Drumshanbo Gunpowder Year of the
Dragon` vs plain Gunpowder (the literal named example in the limited-edition rule), 3× Shelter
Point `The Collective` vs `Cask Strength`, 2× Raasay unpeated vs peated single casks, Elijah Craig
Barrel Proof bourbon vs RYE batch A925, Ardbeg Dark Cove vs its Committee Release, G&M CC
Bruichladdich vs Bruichladdich Rare Cask, plus the two already-known FPs (Aberfeldy 12 `840932` ↔
`id:8289118`, Traveller `153264` ↔ `102811`).
