// Shared rarity scoring. Parallel sibling of `src/utils/rarity.js` (CJS) —
// keep both in sync. ESM form here for the viz.
//
// At runtime the viz typically reads precomputed values from viz/data/rarity.json
// (built by tools/build_viz_rarity.js). The scoring functions below exist so the
// viz can recompute on demand for items not in the precomputed snapshot.

export function computeStorePeriods(events) {
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

export function scoreSku(eventsByStore, nowMs) {
	const NOW = Number.isFinite(nowMs) ? nowMs : Date.now();
	const stores = Object.keys(eventsByStore || {});
	let firstEverTs = Infinity;
	let lastEverTs = -Infinity;
	const completedPeriodsMs = [];
	const openDurationsMs = [];
	let totalRestocks = 0;
	let totalPriceChanges = 0;
	let currentlyStockedStores = 0;
	let totalInStockMs = 0;
	let totalEvents = 0;

	for (const s of stores) {
		const evs = (eventsByStore[s] && eventsByStore[s].events) || [];
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
		}
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

	const S_breadth = 1 / (1 + breadth / 3);
	const S_avail = breadth > 0 ? 1 - currentlyStockedStores / breadth : 1;
	const S_velocity = 1 / (1 + meanPeriodDays / 7);
	const S_restock_low = totalRestocks / (totalRestocks + 3);
	const S_persistence_low = totalInStockDays / (totalInStockDays + 90);

	const rarity =
		0.30 * S_breadth +
		0.25 * S_avail +
		0.20 * S_velocity +
		0.15 * (1 - S_restock_low) +
		0.10 * (1 - S_persistence_low);

	const completedSignal = Math.min(completedPeriodsMs.length / 3, 1);
	const ageSignal = Math.min(ageDays / 60, 1);
	const eventSignal = Math.min(totalEvents / 8, 1);
	const confidence = 0.5 * completedSignal + 0.3 * ageSignal + 0.2 * eventSignal;

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

export function computeTierThresholds(rarities) {
	if (!Array.isArray(rarities) || rarities.length === 0) {
		return { stapleMax: 0, rareMin: 1 };
	}
	const sorted = rarities.slice().sort((a, b) => a - b);
	const idxStaple = Math.floor(sorted.length * 0.10);
	const idxRare = Math.floor(sorted.length * 0.90);
	return {
		stapleMax: sorted[Math.max(0, idxStaple - 1)],
		rareMin: sorted[Math.min(sorted.length - 1, idxRare)],
	};
}

// Returns one of "staple", "rare", "common".
// "common" is the default tier — no special styling is applied.
export function tierFor(rarity, thresholds) {
	if (!thresholds) return "common";
	if (rarity <= thresholds.stapleMax) return "staple";
	if (rarity >= thresholds.rareMin) return "rare";
	return "common";
}
