// Shared rarity scoring. Parallel sibling of `src/utils/rarity.js` (CJS) —
// keep both in sync. ESM form here for the viz.
//
// At runtime the viz typically reads precomputed values from viz/data/rarity.json
// (built by tools/build_viz_rarity.js). The scoring functions below exist so the
// viz can recompute on demand for items not in the precomputed snapshot.

// Fallback tracker epoch — used only when an `eventsByStore` entry has no
// per-DB-file `epochMs`. Real epoch is per DB file's createdAt; resolved per
// item as min(entry.epochMs) across stores. See src/utils/rarity.js for notes.
export const TRACKER_EPOCH_MS = Date.UTC(2026, 0, 19);

// Brief OOS gaps within an in-stock spell are treated as sensor flap rather
// than a real sellout-and-restock. See src/utils/rarity.js for full notes.
const COALESCE_GAP_MS = 24 * 60 * 60 * 1000;

// Ramp (days) over which a currently-open in-stock spell contributes to
// "effective availability". See src/utils/rarity.js for full notes.
const AVAIL_RAMP_DAYS = 7;

export function dedupRenameEvents(events) {
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

export function coalescePeriods(periods, stillOpen, gapMs) {
	const all = (periods || []).slice();
	if (stillOpen) all.push({ start: stillOpen.start, end: null });
	all.sort((a, b) => a.start - b.start);
	const merged = [];
	for (const p of all) {
		const last = merged[merged.length - 1];
		if (last && last.end !== null && p.start - last.end <= gapMs) {
			last.end = p.end;
		} else {
			merged.push({ start: p.start, end: p.end });
		}
	}
	let outStillOpen = null;
	const outPeriods = [];
	for (const m of merged) {
		if (m.end === null) outStillOpen = { start: m.start, end: null };
		else outPeriods.push(m);
	}
	return { periods: outPeriods, stillOpen: outStillOpen };
}

// See src/utils/rarity.js for full notes. Merge category-DB-file entries that
// share a storeId; the unified state is IS iff any of the entries is IS.
export function storeIdFromDbFile(key) {
	const base = String(key || "").split("/").pop() || "";
	const i = base.indexOf("__");
	return i > 0 ? base.slice(0, i) : base;
}

export function unifySameStoreEntries(eventsByStore) {
	const byStoreId = new Map();
	for (const [key, entry] of Object.entries(eventsByStore || {})) {
		const sid = storeIdFromDbFile(key);
		if (!byStoreId.has(sid)) byStoreId.set(sid, []);
		byStoreId.get(sid).push({ key, entry });
	}

	const out = {};
	for (const [, group] of byStoreId) {
		if (group.length === 1) {
			out[group[0].key] = group[0].entry;
			continue;
		}

		const events = [];
		for (let i = 0; i < group.length; i++) {
			for (const ev of group[i].entry.events || []) {
				const t = Date.parse(ev.ts);
				if (!Number.isFinite(t)) continue;
				events.push({ t, ts: ev.ts, p: ev.p, fi: i });
			}
		}
		events.sort((a, b) => {
			if (a.t !== b.t) return a.t - b.t;
			return (b.p != null ? 1 : 0) - (a.p != null ? 1 : 0);
		});

		const fileStates = new Array(group.length).fill(null);
		const merged = [];
		let lastEmittedState = null;
		let lastEmittedPrice = null;

		for (const ev of events) {
			fileStates[ev.fi] = ev.p != null ? { p: ev.p } : "OOS";

			let isPrice = null;
			let anyOos = false;
			for (const fs of fileStates) {
				if (fs === null) continue;
				if (fs === "OOS") anyOos = true;
				else if (isPrice === null) isPrice = fs.p;
			}
			const curState = isPrice !== null ? "IS" : anyOos ? "OOS" : null;
			if (curState === null) continue;

			if (curState === lastEmittedState && (curState !== "IS" || isPrice === lastEmittedPrice)) continue;

			if (curState === "IS") merged.push({ ts: ev.ts, p: isPrice });
			else merged.push({ ts: ev.ts });
			lastEmittedState = curState;
			lastEmittedPrice = isPrice;
		}

		const label = group.find((g) => g.entry && g.entry.label)?.entry.label || "";
		let groupEpoch = Infinity;
		for (const g of group) {
			const ep = g.entry && g.entry.epochMs;
			if (Number.isFinite(ep) && ep < groupEpoch) groupEpoch = ep;
		}
		const unified = { label, events: merged };
		if (Number.isFinite(groupEpoch)) unified.epochMs = groupEpoch;
		out[group[0].key] = unified;
	}
	return out;
}

export function scoreSku(eventsByStore, nowMs) {
	const NOW = Number.isFinite(nowMs) ? nowMs : Date.now();
	eventsByStore = unifySameStoreEntries(eventsByStore || {});
	const stores = Object.keys(eventsByStore || {});
	let firstEverTs = Infinity;
	let lastEverTs = -Infinity;
	let lastInStockEverTs = -Infinity;
	const completedPeriodsMs = [];
	const openDurationsMs = [];
	let totalRestocks = 0;
	let totalPriceChanges = 0;
	let currentlyStockedStores = 0;
	let effectiveStockedStores = 0;
	let totalInStockMs = 0;
	let totalEvents = 0;

	let rareActingStores = 0;
	for (const s of stores) {
		const rawEvs = (eventsByStore[s] && eventsByStore[s].events) || [];
		const evs = dedupRenameEvents(rawEvs);
		totalEvents += evs.length;
		const raw = computeStorePeriods(evs);
		const coalesced = coalescePeriods(raw.periods, raw.stillOpen, COALESCE_GAP_MS);
		const periods = coalesced.periods;
		const stillOpen = coalesced.stillOpen;
		const distinctPrices = raw.distinctPrices;
		const storePeriodsMs = [
			...periods.map((p) => p.end - p.start),
			...(stillOpen ? [NOW - stillOpen.start] : []),
		];
		if (storePeriodsMs.length > 0) {
			const meanAtStoreDays =
				storePeriodsMs.reduce((a, b) => a + b, 0) / storePeriodsMs.length / 86400000;
			if (meanAtStoreDays < 7) rareActingStores += 1;
		}
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
			effectiveStockedStores += Math.min(openDur / 86400000 / AVAIL_RAMP_DAYS, 1);
		}
		if (distinctPrices > 1) totalPriceChanges += distinctPrices - 1;

		for (const ev of evs) {
			const t = new Date(ev.ts).getTime();
			if (!Number.isFinite(t)) continue;
			if (t < firstEverTs) firstEverTs = t;
			if (t > lastEverTs) lastEverTs = t;
			if (ev.p != null && t > lastInStockEverTs) lastInStockEverTs = t;
		}
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

	const S_breadth = 1 / (1 + breadth / 3);
	const S_avail = breadth > 0 ? 1 - effectiveStockedStores / breadth : 1;
	const S_velocity = 1 / (1 + meanPeriodDays / 7);
	const S_restock_low = totalRestocks / (totalRestocks + 3);
	const S_persistence_low = totalInStockDays / (totalInStockDays + 45);
	// Multi-store fast-sellout = allocation. See src/utils/rarity.js.
	const S_allocation = rareActingStores / Math.max(5, breadth);

	// Asymmetric "widely available" penalty — only fires for items at many
	// stores with few OOS. See src/utils/rarity.js for rationale.
	const widelyAvailableBreadthFactor = Math.min(Math.max(0, breadth - 5) / 10, 1);
	const widelyAvailableAvailFactor = Math.max(0, 0.3 - S_avail) / 0.3;
	const S_widely_available = widelyAvailableBreadthFactor * widelyAvailableAvailFactor;

	const rarity =
		0.30 * S_breadth +
		0.25 * S_avail +
		0.05 * S_velocity +
		0.05 * (1 - S_restock_low) +
		0.20 * (1 - S_persistence_low) +
		0.15 * S_allocation -
		0.15 * S_widely_available;

	// Confidence: only two ways to lose it.
	//   ageSignal — penalty if we've just started seeing this item; ramps to
	//   full over the first 7 days of any observation history. Anything past
	//   a week of any visibility is enough to commit to a tier.
	//   epochSignal — penalty if the last in-stock observation was suspiciously
	//   close to the tracker's absolute start date (we can't tell if a 5-day
	//   post-epoch sellout is genuinely scarce or just an artifact of catching
	//   the item mid-cycle). Quadratic ramp so the penalty is sharp in the
	//   first weeks and irrelevant by day 30.
	const ageSignal = Math.min(ageDays / 7, 1);
	let effectiveEpochMs = Infinity;
	for (const s of stores) {
		const ep = eventsByStore[s] && eventsByStore[s].epochMs;
		if (Number.isFinite(ep) && ep < effectiveEpochMs) effectiveEpochMs = ep;
	}
	if (!Number.isFinite(effectiveEpochMs)) effectiveEpochMs = TRACKER_EPOCH_MS;
	const daysFromEpochToLastInStock =
		lastInStockEverTs === -Infinity
			? 0
			: Math.max(0, (lastInStockEverTs - effectiveEpochMs) / 86400000);
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

// Squared-confidence shrinkage toward the neutral midpoint 0.5. Pulls
// low-confidence items toward "common" smoothly from both ends. Used for
// both ranking and tier classification so they can never disagree.
export function effectiveRarity(rarity, confidence) {
	const r = Number.isFinite(rarity) ? rarity : 0.5;
	const c = Number.isFinite(confidence) ? confidence : 0;
	return 0.5 + c * c * (r - 0.5);
}

// Fixed floor on the "rare" threshold. See src/utils/rarity.js for rationale.
export const RARE_MIN_FLOOR = 0.600;

// Fixed ceiling on the "staple" threshold. See src/utils/rarity.js for rationale.
export const STAPLE_MAX_CEILING = 0.178;

// Given a sorted-ascending array of EFFECTIVE rarity values, compute the
// 10th- and 90th-percentile cutoffs that mark "staple" and "rare" tiers.
// rareMin is additionally floored at RARE_MIN_FLOOR.
export function computeTierThresholds(rarities) {
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
export function tierFor(effRarity, thresholds) {
	if (!thresholds) return "common";
	if (effRarity <= thresholds.stapleMax) return "staple";
	if (effRarity >= thresholds.rareMin) return "rare";
	return "common";
}
