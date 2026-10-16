# Rarity scoring: details and the 2026-10-12 review

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

## Rarity Scoring

`src/utils/rarity.js` (CJS) and `viz/app/rarity.js` (ESM) define `scoreSku()`, which combines five smooth signals into a 0..1 rarity score. `tools/build_viz_rarity.js` runs once per `run_daily.sh` and writes `viz/data/rarity.json` keyed by canonical SKU. Consumers (viz, email pack) canonicalize first then look up.

**Per-DB-file epoch.** Confidence's "post-epoch sellout might be an artifact" penalty is scoped per DB file, not globally. Each `data/db/*.json` carries a `createdAt` field stamped on first write (and one-time backfilled from `git log --diff-filter=A` via `tools/backfill_db_created_at.js`). `tools/build_viz_rarity.js` loads these via `src/utils/db_epochs.js` and injects `epochMs` into each `eventsByStore[file]` entry. `scoreSku` resolves an item's effective epoch as `min(entry.epochMs)` across the stores tracking it — earliest wins because once *any* DB file has been observing for 30+ days the OOS signal is no longer suspicious. `TRACKER_EPOCH_MS` (Jan 19 2026) survives only as a fallback for un-backfilled files. This matters because categories were added over time (e.g. gin much later than whisky); items in a late-added DB file shouldn't be flagged rare just because they sold out shortly after we started watching that page.

**Review of 2026-10-12** (8,567 groups, measured against allocated-brand anecdotes):
- **Epoch signal uses spell ENDS.** The SKU cache stores change points, so a bottle in stock from
  its store's epoch until it sold out weeks later had its last in-stock *event* at the epoch and
  got confidence 0 (~500 of 604 `c=0` groups; Chichibu 10, Mizunara 25 shrunk to neutral).
- **Persistence is per store** (`totalInStockDays / breadth`): the summed version counted breadth
  against allocated multi-store items (Blanton's 0.31 → 0.36, EH Taylor 0.49 → 0.58).
- **One-shot batch gate** (`dropOneShotBatches`, used by `build_viz_rarity.js` and
  `rarity_report.js`): a store entry that is one <30 h in-stock blip is dropped when ≥7 such
  blips share its first-seen run timestamp. Artifact runs measured 7–45 (BSW 2026-04-24 old
  catalog, Sierra Springs 2026-04-12, Strath on the tracker's first day); real drops ≤4 (ZYN
  Springbank 2026-09-18). Isolated one-shots stay rare: Longrow 18 vs Glenfiddich 25 Rare Oak
  are indistinguishable in the data (same store, hours each).
- Rejected: a 180-day duty cycle (made 410 long-delisted single-store bottles rare), a 14-day
  allocation threshold (churned the staple boundary), any price term (owner: rarity =
  obtainability, a $3,500 bottle on a shelf is buyable). Owner confirmed Kilkerran 12 / Longrow
  Peated as staples is correct for BC/AB.
- **No "gone too long" decay.** A brand-by-brand read of all 236 rare, out-of-stock groups found
  ~130 genuinely limited (single casks, IBs, SMWS, allocated bourbon) against ~25 core-range
  delistings (Bladnoch 10, Balvenie DW12, Glendalough Black Pitts). Neither time gone nor
  delisting-run size separates them: Co-op's 872-listing run took Adelphi IBs, Sierra Springs'
  88-listing run took Caol Ila 17 Unpeated next to Balvenie DW12.
- **Most remaining rare-tier noise is off-category listings** (~35): wine, beer, cognac, RTDs,
  minis, tasting-event tickets, mostly from Malts & Grains "All Spirits" and Sierra Springs
  "Spirits". That is a hidden-list / scraper-filter fix, not a scoring fix.
- **`build_viz_rarity.js` runs after `auto_link_classify.mjs`** in `run_daily.sh`. Before, a
  listing auto-linked into a rare group that run was scored as its own fresh group, so the email
  showed it neutral. A restock keeps a rare group rare on the scrape that sees it (Longrow 18
  0.82 → 0.78); `AVAIL_RAMP_DAYS` lets it drift to common only after 1–2 weeks on the shelf.
  Rarity and the email pack resolve canonicals identically (0 of 35k listings disagree).
- The ESM `scoreSku` is unused by the viz (it reads `rarity.json`) but had drifted (old
  `ageSignal`); now byte-equal in output to the CJS one over all 15.5k caches. Re-check parity
  after any scorer edit.

**Tier classification** uses dynamic 10th/90th percentile thresholds computed per build:
- `staple` (bottom ~10%): widely available, frequent restocks
- `rare` (top ~10%): hard to obtain (OOS or fast sellouts)
- `common` (middle ~80%): no special styling

**Color tokens** — defined in `viz/style.css` as CSS custom properties (`--rarity-staple-*`, `--rarity-rare-*`, plus light-theme overrides). Staple is warm amber (subtle border + glow), rare is deep purple with a diagonal corner sheen, purple ring, and outer glow. The same visual language must be mirrored in the email repo (`~/spirit-tracker-api`) as parallel CSS — neither thresholds nor colors are shipped in event packs. Each pack carries only the raw `rarity` number (0..1) per event; the renderer is responsible for thresholding and styling. **Email gotcha:** Gmail's dark mode inverts
solid colours but never gradients, so no opaque colour may sit in a card gradient (a fade-to-`#ffffff`
left rare cards white under light text). The rare star fade is baked into
`viz/email-assets/rare-stars-fade.svg` instead, so the Pages deploy must ship it before the email worker.
