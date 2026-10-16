# CI / automation and run observability

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

## CI / Automation

`.github/workflows/cron_tracker.yaml` is **dispatch-only**. Its clock is a Cloudflare Worker cron
in `~/spirit-tracker-api` (`src/tracker_schedule.ts`, `wrangler.toml` `crons = ["25,48 * * * *"]`),
which matches on Pacific wall time (DST-proof) and POSTs one `workflow_dispatch` per slot using
the Worker secret `GH_DISPATCH_TOKEN` (fine-grained PAT, Actions r/w on this repo). No KV, no retries.
- **Big** (all stores, direct): dispatched 23:25 / 11:25 PT (run ~30 min → email ~00:00 / 12:00 PT)
- **Small** (sierra_springs, craft_cellars, colordevino, liquorama, zyn, highlander; VPN): dispatched
  :48 before 03/06/09/15/18/21 PT (run ~10 min → email ~on the hour). 02:48 does not exist on the
  spring-forward day, so that one run is skipped once a year.

**Why not GitHub `schedule:`** (measured 2026-09-14..10-05): scheduled triggers started 2-5 h late
(median 4.8 h for the 05:45Z big, 2.9 h for 17:45Z), varied by up to 3 h day to day, and 54 of 176
(31%) never fired at all. Dispatched runs start with 0 s delay.

**One-shot failed-store retry.** Store failures are usually a bad random Azure egress
IP (see §"Datacenter-IP Blocking"), and recover on the next run's different IP. So after
a run, if the tracker's `[[FAILED-STORES]]` sentinel is non-empty, `run_daily.sh` surfaces
those store keys as the `failed_stores` step output, and the workflow **re-dispatches
itself** for exactly those stores (`-f stores=… -f mode=big -f is_retry=true -f vpn=<opposite>`) on a fresh
runner with the other egress (direct ↔ VPN). `is_retry=true` makes the retry skip its own retry step (no recursion — exactly
one retry), and `concurrency: tracker-cron` queues it until the first run fully completes.

Each run executes `scripts/run_daily.sh`, which:
1. Sets up / repairs the `.worktrees/data/` worktree
2. Pulls latest `data` branch and merges `main` into it
3. Runs the tracker (writes `data/db/` JSON + a `reports/*.txt` file)
4. Builds viz artifacts via `tools/build_*.js` scripts
5. **Re-encodes the linker embeddings** (`build_dataset.mjs` → `tools/linker_ml/encode.py`) with the
   fixed fine-tuned checkpoint so newly-scraped SKUs get vectors — weights are NOT retrained here.
   See `tools/linker_ml/CLAUDE.md` §"Shipping the checkpoint" (best-effort; skips if no venv/checkpoint).
6. **Auto-link classification** (`tools/auto_link_classify.mjs --since 25`) — appends high-confidence
   cross-store links to `data/sku_links.json` using the just-written embeddings.
   See §"Auto-Link Classification + Review". Best-effort; before the email pack so alerts reflect
   the new groupings.
7. Commits + pushes all changes to the `data` branch
8. Triggers the Pages deploy and email pack workflows

## Run Observability (commit messages)

Every `data`-branch commit from `run_daily.sh` encodes run health so failures are
visible at a glance in `git log` over time:

- **First line**: `run: <ts>` — and, when any category's scan threw, ` | FAILED(n): Store | Label; …`.
  Source of truth: the tracker prints a stable `[[FAILED-CATEGORIES]] …` sentinel on
  stdout (always, even on no-op runs); `run_daily.sh` tees tracker output and lifts it.
  Internally, `report.failedCategories[]` (populated in `run_all.js`'s catch) also
  renders a `FAILED CATEGORIES (n)` section in the report body.
- **Body**: a `runner: ip=<egress-ip> run_id=… os=… name=…` line (egress IP via
  best-effort `api.ipify.org`) so store blocks can be correlated to the runner IP —
  most store failures are datacenter-IP reputation (see §"Cloudflare Egress Proxy").
- **Limitation**: the `meaningful`-changes short-circuit means a run where *everything*
  fails (no data at all) writes no commit, so it leaves no record. Partial failures
  (the common case) do commit and are recorded.
