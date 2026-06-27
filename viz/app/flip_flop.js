/**
 * Flip-flop (transient oscillation) detection for the ITEM PAGE CHART.
 *
 * Background: some stores report changes that oscillate — a price that bounces
 * between two fixed values (Craft Cellars' session-state-dependent pricing), or
 * an item that toggles in/out of stock repeatedly. These are scraper/store
 * noise, not real market moves.
 *
 * Crucially, a SINGLE round-trip `A → B → A` (then stays at A) is NOT a
 * flip-flop — it's just a one-off sale / blip. Only when the excursion REPEATS
 * (`A → B → A → B …`, i.e. the value is revisited) is it oscillation worth
 * flagging. This is stricter than the recent-feed / email-pack suppressors
 * (`tools/build_viz_recent.js`, `tools/build_email_event_pack.js`), which gate a
 * single same-kind round-trip within 48h. They suppress (drop the event); this
 * module does NOT suppress — it locates the oscillating region so the chart can
 * render it dashed/dot-less ("something is going on here") rather than as solid,
 * trustworthy history.
 *
 * Window: each oscillation leg must be short (≤ FLAP_WINDOW_MS, ~3 days). A
 * genuine periodic sale (drop to B for a day, back to A for two months, repeat)
 * has a long interior A-leg, so it is NOT flagged — only rapid back-and-forth is.
 */

import { parsePriceToNumber } from "./sku.js";

// Max duration of a single oscillation leg to count as flip-flop noise.
export const FLAP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// Minimum spells in an alternating run to qualify (A,B,A,B — the value B is
// revisited, so it's a repeat, not a one-off round-trip).
const MIN_RUN = 4;

// A change-point event is { ts, p } (in stock @ price p) or { ts } (OOS).
// State key: integer cents for in-stock, the token "oos" for out-of-stock, or
// NaN for an unparseable in-stock price (NaN never matches → fail-safe to "not
// a flap"). Adjacent change-point events always differ, so a run alternates
// cleanly between exactly two states until a third value appears.
function stateKey(ev) {
	if (!ev || !("p" in ev)) return "oos";
	const n = parsePriceToNumber(ev.p);
	return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function buildSpells(events) {
	const evs = (Array.isArray(events) ? events : [])
		.filter((e) => e && e.ts && Number.isFinite(Date.parse(e.ts)))
		.slice()
		.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

	const spells = evs.map((e) => ({ state: stateKey(e), startMs: Date.parse(e.ts) }));
	for (let i = 0; i < spells.length; i++) {
		spells[i].endMs = i + 1 < spells.length ? spells[i + 1].startMs : Infinity;
	}
	return spells;
}

const dur = (s) => s.endMs - s.startMs;

/**
 * Given a store/variant's chronological change-point events, return the
 * oscillating excursion intervals to render dashed.
 *
 * An oscillation is a maximal run of consecutive spells that strictly alternate
 * between exactly two states A and B (e.g. price 100↔80, or 50↔OOS). It is a
 * flip-flop when the run has ≥ 4 spells (so B is revisited — `A,B,A,B`) AND every
 * interior leg is short (≤ FLAP_WINDOW_MS). The leading/trailing spells may be
 * long stable baselines (the price before it started flapping, or the value it
 * finally settled on); those stay solid — only the unstable middle is dashed.
 *
 * @param {Array<{ts:string, p?:any}>} events
 * @returns {Array<{startMs:number, endMs:number}>}  intervals [startMs, endMs)
 */
export function detectFlapSpans(events) {
	const spells = buildSpells(events);
	const spans = [];

	let i = 0;
	while (i + MIN_RUN - 1 < spells.length) {
		const A = spells[i].state;
		const B = spells[i + 1].state;
		if (A === B || Number.isNaN(A) || Number.isNaN(B)) {
			i++;
			continue;
		}

		// Extend the alternating A,B,A,B… run as far as it holds.
		let k = i + 1;
		while (k + 1 < spells.length) {
			const expected = (k + 1 - i) % 2 === 0 ? A : B;
			if (spells[k + 1].state === expected) k++;
			else break;
		}

		if (k - i + 1 >= MIN_RUN) {
			let interiorShort = true;
			for (let m = i + 1; m <= k - 1; m++) {
				if (dur(spells[m]) > FLAP_WINDOW_MS) {
					interiorShort = false;
					break;
				}
			}
			if (interiorShort) {
				const startMs = dur(spells[i]) > FLAP_WINDOW_MS ? spells[i + 1].startMs : spells[i].startMs;
				const endMs = dur(spells[k]) > FLAP_WINDOW_MS ? spells[k].startMs : spells[k].endMs;
				spans.push({ startMs, endMs });
			}
			i = k + 1;
			continue;
		}

		i++;
	}

	return spans;
}
