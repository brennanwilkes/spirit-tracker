/**
 * Flip-flop (transient change) detection — the SINGLE documented definition of
 * what counts as a non-real, self-reverting change.
 *
 * Background: several stores report a change that reverts almost immediately —
 * a price that drops and snaps right back, or an item that goes OOS and returns
 * within hours (e.g. Craft Cellars' session-state-dependent pricing oscillating
 * between two fixed values; AMRUT @ ARC dropping $482.99→$410.59→$482.99 in one
 * day). These are scraper/store noise, not real market moves.
 *
 * The project already SUPPRESSES these from the "what changed" surfaces, using a
 * 48h window:
 *   - tools/build_viz_recent.js  (the recent.json activity feed)
 *   - tools/build_email_event_pack.js::isFlipFlop  (email alerts)
 *   - src/utils/rarity.js::coalescePeriods  (24h gap coalesce for availability)
 * Those operate on the cross-commit event feed. This module is the parallel
 * definition for the ITEM PAGE CHART, which works from the per-SKU cache's
 * change-point events. It does NOT suppress — it locates the transient
 * excursions so the chart can render them dashed/dot-less ("something is going
 * on here") instead of as solid, trustworthy history.
 *
 * Keep the 48h window (FLAP_WINDOW_MS) in sync with the tools above.
 */

import { parsePriceToNumber } from "./sku.js";

// Same window the recent-feed / email-pack suppressors use.
export const FLAP_WINDOW_MS = 48 * 60 * 60 * 1000;

// A change-point event is { ts, p } (in stock @ price p) or { ts } (OOS).
function stateOf(ev) {
	if (!ev || !("p" in ev)) return { in: false, cents: null };
	const n = parsePriceToNumber(ev.p);
	return { in: true, cents: Number.isFinite(n) ? Math.round(n * 100) : null };
}

/**
 * Given a store/variant's chronological change-point events, return the
 * transient excursion intervals to render dashed.
 *
 * An event at index i (with a predecessor and successor) is a flap when the
 * state RETURNS at i+1 to what it was at i-1, and the excursion was transient
 * (it reverted within FLAP_WINDOW_MS). Three shapes:
 *   - price flap   in@X → in@Y → in@X   (a dip/spike back to the prior price)
 *   - oos flap     in    → OUT  → in     (briefly out of stock, then back)
 *   - instock flap OUT   → in   → OUT    (a brief reappearance, then gone again)
 * A real, sustained sale or sellout is NOT a flap: its excursion outlasts the
 * window, so the window guard drops it (matching the tools' behavior).
 *
 * @param {Array<{ts:string, p?:any}>} events
 * @returns {Array<{startMs:number, endMs:number, kind:'price'|'oos'|'instock'}>}
 *          intervals are [startMs, endMs): startMs = excursion began, endMs = it reverted
 */
export function detectFlapSpans(events) {
	const evs = (Array.isArray(events) ? events : [])
		.filter((e) => e && e.ts)
		.slice()
		.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

	const spans = [];
	for (let i = 1; i < evs.length - 1; i++) {
		const tCur = Date.parse(evs[i].ts);
		const tNext = Date.parse(evs[i + 1].ts);
		if (!Number.isFinite(tCur) || !Number.isFinite(tNext)) continue;
		if (tNext - tCur > FLAP_WINDOW_MS) continue; // excursion outlasted the window → real change

		const prev = stateOf(evs[i - 1]);
		const cur = stateOf(evs[i]);
		const next = stateOf(evs[i + 1]);

		let kind = null;
		if (prev.in && cur.in && next.in) {
			// returns to the prior price (and the dip/spike actually differed)
			if (prev.cents != null && next.cents != null && prev.cents === next.cents && cur.cents !== prev.cents) {
				kind = "price";
			}
		} else if (prev.in && !cur.in && next.in) {
			kind = "oos";
		} else if (!prev.in && cur.in && !next.in) {
			kind = "instock";
		}

		if (kind) spans.push({ startMs: tCur, endMs: tNext, kind });
	}
	return spans;
}

/**
 * Convenience: is a given day (UTC ms at noon) inside any excursion span?
 */
export function dayInFlap(spans, dayMs) {
	if (!Array.isArray(spans)) return false;
	for (const sp of spans) {
		if (dayMs >= sp.startMs && dayMs < sp.endMs) return true;
	}
	return false;
}
