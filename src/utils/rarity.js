"use strict";

// Shared rarity scoring. Parallel sibling of `viz/app/rarity.js` (ESM) —
// keep both in sync. CJS form here for the tracker / build tools.
//
// All inputs are in milliseconds (event ts). All emitted durations are days.
// Rarity = single 0..1 value derived from five smooth signals (no branches).

// Tracker absolute start date — observations earlier than this don't exist by
// construction. Used to temper confidence for items whose only in-stock signals
// cluster near the start of recorded history (we can't tell if they were already
// scarce or just briefly visible to us).
const TRACKER_EPOCH_MS = Date.UTC(2026, 0, 19);

// ---------- per-store period extraction ----------

// Removes "rename pairs": events at the same timestamp & store that have
// both in-stock and OOS forms cancel out (they represent a SKU identity
// change where one cache file emitted an OOS marker while another emitted
// the equivalent in-stock event). Pre-process events from merged SKU cache
// files through this before period extraction or scoring.
function dedupRenameEvents(events) {
	if (!Array.isArray(events) || events.length === 0) return [];
	const sorted = events.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
	const out = [];
	let i = 0;
	while (i < sorted.length) {
		let j = i;
		while (j < sorted.length && sorted[j].ts === sorted[i].ts) j++;
		const group = sorted.slice(i, j);
		const hasInStock = group.some((e) => "p" in e);
		const hasOOS = group.some((e) => !("p" in e));
		if (hasInStock && hasOOS) {
			// rename pair at same ts — drop the whole group
		} else {
			out.push(group[0]);
		}
		i = j;
	}
	return out;
}

// events: [{ ts, p? }] where p present = in-stock observation, absent = OOS marker.
function computeStorePeriods(events) {
	const sorted = (events || []).slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
	const periods = [];
	const prices = [];
	let openStart = null;
	for (const ev of sorted) {
		const t = new Date(ev.ts).getTime();
		if (ev.p != null) {
			prices.push({ t, p: ev.p });
			if (openStart === null) openStart = t;
		} else {
			if (openStart !== null) {
				periods.push({ start: openStart, end: t });
				openStart = null;
			}
		}
	}
	const stillOpen = openStart !== null ? { start: openStart, end: null } : null;
	const distinctPrices = new Set(prices.map((x) => x.p)).size;
	return { periods, stillOpen, prices, distinctPrices };
}

// ---------- scoring ----------

// eventsByStore: { [storeFile]: { label?, events: [{ ts, p? }] } }
// nowMs: optional fixed timestamp for tests (defaults to Date.now())
function scoreSku(eventsByStore, nowMs) {
	const NOW = Number.isFinite(nowMs) ? nowMs : Date.now();
	const stores = Object.keys(eventsByStore || {});
	let firstEverTs = Infinity;
	let lastEverTs = -Infinity;
	let lastInStockEverTs = -Infinity;
	const completedPeriodsMs = [];
	const openDurationsMs = [];
	let totalRestocks = 0;
	let totalPriceChanges = 0;
	let currentlyStockedStores = 0;
	let totalInStockMs = 0;
	let totalEvents = 0;

	for (const s of stores) {
		const rawEvs = (eventsByStore[s] && eventsByStore[s].events) || [];
		const evs = dedupRenameEvents(rawEvs);
		totalEvents += evs.length;
		const { periods, stillOpen, distinctPrices } = computeStorePeriods(evs);
		const totalListings = periods.length + (stillOpen ? 1 : 0);
		if (totalListings > 1) totalRestocks += totalListings - 1;
		for (const p of periods) {
			completedPeriodsMs.push(p.end - p.start);
			totalInStockMs += p.end - p.start;
		}
		if (stillOpen) {
			const openDur = NOW - stillOpen.start;
			openDurationsMs.push(openDur);
			totalInStockMs += openDur;
			currentlyStockedStores += 1;
		}
		if (distinctPrices > 1) totalPriceChanges += distinctPrices - 1;

		for (const ev of evs) {
			const t = new Date(ev.ts).getTime();
			if (!Number.isFinite(t)) continue;
			if (t < firstEverTs) firstEverTs = t;
			if (t > lastEverTs) lastEverTs = t;
			if (ev.p != null && t > lastInStockEverTs) lastInStockEverTs = t;
		}
		// A currently-open period also implies "last in stock = now"
		if (stillOpen) lastInStockEverTs = Math.max(lastInStockEverTs, NOW);
	}

	const breadth = stores.length;
	const ageDays = firstEverTs === Infinity ? 0 : (NOW - firstEverTs) / 86400000;
	const lastSeenDaysAgo = lastEverTs === -Infinity ? Infinity : (NOW - lastEverTs) / 86400000;

	const allPeriodDays = [
		...completedPeriodsMs.map((ms) => ms / 86400000),
		...openDurationsMs.map((ms) => ms / 86400000),
	];
	const meanPeriodDays = allPeriodDays.length
		? allPeriodDays.reduce((a, b) => a + b, 0) / allPeriodDays.length
		: 0;
	const totalInStockDays = totalInStockMs / 86400000;

	// Smooth signals (each 0..1, higher = rarer)
	const S_breadth = 1 / (1 + breadth / 3);
	const S_avail = breadth > 0 ? 1 - currentlyStockedStores / breadth : 1;
	const S_velocity = 1 / (1 + meanPeriodDays / 7);
	const S_restock_low = totalRestocks / (totalRestocks + 3);
	const S_persistence_low = totalInStockDays / (totalInStockDays + 45);

	const rarity =
		0.30 * S_breadth +
		0.25 * S_avail +
		0.20 * S_velocity +
		0.05 * (1 - S_restock_low) +
		0.20 * (1 - S_persistence_low);

	// Confidence: only two ways to lose it.
	//   ageSignal — penalty for not-yet-enough observation. Different ramp
	//   depending on what we're observing:
	//     fully OOS now    → ramp on accumulated OOS time (5d for full credit)
	//                         brief in-stock followed by sustained OOS is
	//                         exactly the rare-item signature.
	//     partially OOS    → ramp on ageDays (7d for full credit)
	//                         some stores have stock and some don't — moderate
	//                         signal, give the benefit of the doubt quickly.
	//     fully in stock   → ramp on ageDays (30d for full credit)
	//                         continuous availability at every known store is
	//                         the weakest signal: it could just mean the
	//                         retailers got generous initial allocations.
	//   epochSignal — penalty if the last in-stock observation was suspiciously
	//   close to the tracker's absolute start date (we can't tell if a 5-day
	//   post-epoch sellout is genuinely scarce or just an artifact of catching
	//   the item mid-cycle). Quadratic ramp so the penalty is sharp in the
	//   first weeks and irrelevant by day 30.
	let ageSignal;
	if (currentlyStockedStores === 0) {
		const oosTime = Math.max(0, ageDays - totalInStockDays);
		ageSignal = Math.min(oosTime / 5, 1);
	} else if (currentlyStockedStores >= stores.length) {
		ageSignal = Math.min(ageDays / 30, 1);
	} else {
		ageSignal = Math.min(ageDays / 7, 1);
	}
	const daysFromEpochToLastInStock =
		lastInStockEverTs === -Infinity
			? 0
			: Math.max(0, (lastInStockEverTs - TRACKER_EPOCH_MS) / 86400000);
	const epochRamp = Math.min(daysFromEpochToLastInStock / 30, 1);
	const epochSignal = epochRamp * epochRamp;
	const confidence = ageSignal * epochSignal;

	return {
		rarity,
		confidence,
		breadth,
		currentlyStockedStores,
		totalRestocks,
		totalPriceChanges,
		ageDays,
		lastSeenDaysAgo: Number.isFinite(lastSeenDaysAgo) ? lastSeenDaysAgo : null,
		meanPeriodDays,
		completedPeriods: completedPeriodsMs.length,
		totalInStockDays,
		totalEvents,
		scores: {
			breadth: S_breadth,
			avail: S_avail,
			velocity: S_velocity,
			restockLow: S_restock_low,
			persistenceLow: S_persistence_low,
		},
	};
}

// ---------- effective rarity ----------

// Squared-confidence shrinkage toward the neutral midpoint 0.5. Pulls
// low-confidence items toward "common" smoothly from both ends — a high-r
// low-c item drifts toward 0.5 instead of dominating sorts, and a low-r
// low-c item likewise can't outrank a confident genuine staple. Replaces
// the previous hard MIN_TIER_CONFIDENCE gate. Used for both ranking and
// tier classification so they can never disagree.
function effectiveRarity(rarity, confidence) {
	const r = Number.isFinite(rarity) ? rarity : 0.5;
	const c = Number.isFinite(confidence) ? confidence : 0;
	return 0.5 + c * c * (r - 0.5);
}

// ---------- tier classification ----------

// Fixed floor on the "rare" threshold. Because effective rarity shrinks
// low-confidence items toward 0.5, the natural 90th-percentile cutoff can
// fall arbitrarily close to neutral when many items cluster near 0.5 — at
// that point being "rare" stops meaning anything. The floor enforces that
// rare items must sit a meaningful distance above neutral, on top of any
// percentile-based cutoff.
const RARE_MIN_FLOOR = 0.600;

// Fixed ceiling on the "staple" threshold. Mirror of RARE_MIN_FLOOR — keeps
// the staple tier from drifting upward into items that aren't really
// distinctively common. Anything above this cannot be staple regardless of
// where the 10th percentile falls.
const STAPLE_MAX_CEILING = 0.178;

// Given a sorted-ascending array of EFFECTIVE rarity values, compute the
// 10th- and 90th-percentile cutoffs that mark "staple" and "rare" tiers.
// rareMin is additionally floored at RARE_MIN_FLOOR.
function computeTierThresholds(rarities) {
	if (!Array.isArray(rarities) || rarities.length === 0) {
		return { stapleMax: 0, rareMin: 1 };
	}
	const sorted = rarities.slice().sort((a, b) => a - b);
	const idxStaple = Math.floor(sorted.length * 0.10);
	const idxRare = Math.floor(sorted.length * 0.90);
	return {
		stapleMax: Math.min(STAPLE_MAX_CEILING, sorted[Math.max(0, idxStaple - 1)]),
		rareMin: Math.max(RARE_MIN_FLOOR, sorted[Math.min(sorted.length - 1, idxRare)]),
	};
}

// Classify a single effective rarity value against the thresholds.
//   effRarity <= stapleMax  -> "staple"
//   effRarity >= rareMin    -> "rare"
//   otherwise               -> "common" (no special styling)
function tierFor(effRarity, thresholds) {
	if (!thresholds) return "common";
	if (effRarity <= thresholds.stapleMax) return "staple";
	if (effRarity >= thresholds.rareMin) return "rare";
	return "common";
}

module.exports = {
	computeStorePeriods,
	dedupRenameEvents,
	scoreSku,
	effectiveRarity,
	computeTierThresholds,
	tierFor,
	TRACKER_EPOCH_MS,
};
