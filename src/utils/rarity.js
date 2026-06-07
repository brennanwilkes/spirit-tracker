"use strict";

// Shared rarity scoring. Parallel sibling of `viz/app/rarity.js` (ESM) —
// keep both in sync. CJS form here for the tracker / build tools.
//
// All inputs are in milliseconds (event ts). All emitted durations are days.
// Rarity = single 0..1 value derived from five smooth signals (no branches).

// Fallback tracker start date — used only when an `eventsByStore` entry has
// no per-DB-file `epochMs`. The real epoch is per DB file (categories added
// later have later epochs; e.g. gin was tracked long after the original
// launch). Callers should inject `entry.epochMs` from each DB file's
// `createdAt`; the resolved per-item epoch is min(entry.epochMs) across the
// stores tracking that item — the earliest moment we'd have seen it anywhere.
const TRACKER_EPOCH_MS = Date.UTC(2026, 0, 19);

// Brief OOS gaps within an in-stock spell are treated as sensor flap rather
// than a real sellout-and-restock. A store toggling IS/OOS every few hours is
// almost always reporting noise on a bottle that's actually been sitting on the
// shelf — coalescing collapses that pattern into one long spell so the rarity
// signals (mean period, restock count, allocation) reflect reality.
const COALESCE_GAP_MS = 24 * 60 * 60 * 1000;

// Ramp (days) over which a currently-open in-stock spell ramps from 0 to 1
// contribution to "effective availability". A bottle that just came back in
// stock 6 hours ago shouldn't be treated the same as one that's been on the
// shelf for weeks — the recent reappearance is consistent with a fast-selling
// item that briefly restocked, so we shouldn't punish its rarity for it yet.
// If it stays on the shelf, the contribution ramps up daily and rarity drifts
// down to "common" naturally.
const AVAIL_RAMP_DAYS = 7;

// Ramp (days) for an OPEN in-stock spell's contribution to mean-period stats.
// A spell that's been open for only a few hours carries almost no information
// about how long the item stays on the shelf before selling out — a completed
// 21-day spell next to a 0.1-day still-open spell shouldn't average down to
// 10d. Open spells get weight = min(durationDays / ramp, 1) in the mean;
// completed spells (real sellouts) always get full weight.
const MEAN_OPEN_RAMP_DAYS = 7;

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

// Merge in-stock spells separated by an OOS gap shorter than gapMs. Treats
// rapid IS/OOS oscillation as a single continuous spell (the bottle was on the
// shelf the whole time; the OOS markers were sensor noise). The bridging OOS
// interval is absorbed INTO the spell — totalInStockMs grows correspondingly,
// which is intentional: if it wasn't really sold out, the in-stock duration
// should include those gaps.
function coalescePeriods(periods, stillOpen, gapMs) {
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

// ---------- cross-category store merge ----------

// Per-SKU caches are keyed by DB file path (e.g. ".../sierrasprings__other__...").
// Two entries that share the same storeId prefix represent the same physical
// store — usually a category-migration leftover where the item moved between
// the store's category pages and the old listing keeps reporting OOS while the
// new one reports IS. SKU mapping (union-find) doesn't fix this because the
// SKU is identical; the duplication is on (storeId, sku). Without merging,
// rarity sees breadth=2 for a one-store item and the merged event timeline
// looks like sensor flap.
//
// Rule: unify entries that share a storeId into one event stream where the
// unified state is IS iff any of the entries is currently IS (a bottle on the
// shelf in one category page is on the shelf for sale, regardless of what a
// stale category page says). Returns a new eventsByStore object.
function storeIdFromDbFile(key) {
	const base = String(key || "").split("/").pop() || "";
	const i = base.indexOf("__");
	return i > 0 ? base.slice(0, i) : base;
}

function unifySameStoreEntries(eventsByStore) {
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

		// Collect every event, tagged with which file (group index) it came from.
		const events = [];
		for (let i = 0; i < group.length; i++) {
			for (const ev of group[i].entry.events || []) {
				const t = Date.parse(ev.ts);
				if (!Number.isFinite(t)) continue;
				events.push({ t, ts: ev.ts, p: ev.p, fi: i });
			}
		}
		// Sort by ts; on ties prefer IS over OOS so the unified state never
		// transiently flips OOS when one file's IS arrives simultaneously with
		// another file's OOS at the same timestamp.
		events.sort((a, b) => {
			if (a.t !== b.t) return a.t - b.t;
			return (b.p != null ? 1 : 0) - (a.p != null ? 1 : 0);
		});

		// Per-file last-known state. null = unobserved, "OOS" = out, { p } = in.
		const fileStates = new Array(group.length).fill(null);
		const merged = [];
		let lastEmittedState = null; // "IS" | "OOS"
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
		// Preserve earliest per-file epoch across the unified group — same-store
		// category-migration leftovers may have different createdAt timestamps;
		// the earliest reflects when we first started tracking this physical
		// store's listing, which is the right epoch for confidence.
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

// ---------- scoring ----------

// eventsByStore: { [storeFile]: { label?, events: [{ ts, p? }] } }
// nowMs: optional fixed timestamp for tests (defaults to Date.now())
function scoreSku(eventsByStore, nowMs) {
	const NOW = Number.isFinite(nowMs) ? nowMs : Date.now();
	// Merge entries belonging to the same physical store before scoring so
	// breadth reflects unique stores and a category-migration leftover doesn't
	// look like sensor flap.
	// Dedupe rename pairs (same-ts IS+OOS within ONE file representing a SKU
	// remap) BEFORE unification — otherwise the unifier collapses the pair
	// into a stray OOS final state and the post-unify dedup has nothing to
	// cancel, leaving the unified store stream prematurely OOS.
	const dedupedByFile = {};
	for (const [k, entry] of Object.entries(eventsByStore || {})) {
		dedupedByFile[k] = {
			...entry,
			events: dedupRenameEvents((entry && entry.events) || []),
		};
	}
	eventsByStore = unifySameStoreEntries(dedupedByFile);
	const stores = Object.keys(eventsByStore || {});
	let firstEverTs = Infinity;
	let lastEverTs = -Infinity;
	const completedPeriodsMs = [];
	const openDurationsMs = [];
	let totalRestocks = 0;
	let totalPriceChanges = 0;
	let currentlyStockedStores = 0;
	let effectiveStockedStores = 0;
	let totalInStockMs = 0;
	let totalEvents = 0;

	let rareActingStores = 0;
	// Per-store epoch signals. The epoch penalty (a sellout suspiciously close to a
	// store's tracking start might be an artifact of catching the item mid-cycle) is
	// inherently PER STORE: each DB file has its own start date. We compute the signal
	// independently for every store, then take the MAX across stores — the item is
	// confidently rare if ANY store has watched it long enough past its own epoch to
	// trust what it sees. A fresh in-stock flicker at a brand-new store contributes a
	// near-zero signal (correctly discounted), but it can't suppress the strong signal
	// a long-observing store already earned.
	const storeEpochSignals = [];
	for (const s of stores) {
		const rawEvs = (eventsByStore[s] && eventsByStore[s].events) || [];
		const evs = dedupRenameEvents(rawEvs);
		totalEvents += evs.length;
		const raw = computeStorePeriods(evs);
		const coalesced = coalescePeriods(raw.periods, raw.stillOpen, COALESCE_GAP_MS);
		const periods = coalesced.periods;
		const stillOpen = coalesced.stillOpen;
		const distinctPrices = raw.distinctPrices;
		// A store is "rare-acting" if its average in-stock period is brief
		// (< 7d). Stores that hold the item on the shelf for months don't
		// count toward the allocation signal — that's the dilution principle:
		// many fast-selling stores are only "rare" if other stores aren't
		// quietly sitting on inventory at the same time.
		let storeWS = 0;
		let storeWT = 0;
		for (const p of periods) {
			storeWS += (p.end - p.start) / 86400000;
			storeWT += 1;
		}
		if (stillOpen) {
			const d = (NOW - stillOpen.start) / 86400000;
			const w = Math.min(d / MEAN_OPEN_RAMP_DAYS, 1);
			storeWS += d * w;
			storeWT += w;
		}
		if (storeWT > 0) {
			const meanAtStoreDays = storeWS / storeWT;
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
			const epOpen = eventsByStore[s] && eventsByStore[s].epochMs;
			// If the spell began when we STARTED tracking this store (start ≈ its epoch), the
			// item has been on the shelf the whole time we've watched — not a suspicious fresh
			// restock — so credit FULL availability instead of ramping. Without this, a newly-
			// added store makes a ubiquitous staple look scarce (it inflates S_avail, which in
			// turn disables the widely-available discount). A genuine restock at a long-tracked
			// store (spell starts well after its epoch) still ramps. Mirrors the confidence fix.
			const inStockSinceEpoch = Number.isFinite(epOpen) && stillOpen.start <= epOpen + COALESCE_GAP_MS;
			effectiveStockedStores += inStockSinceEpoch ? 1 : Math.min(openDur / 86400000 / AVAIL_RAMP_DAYS, 1);
		}
		if (distinctPrices > 1) totalPriceChanges += distinctPrices - 1;

		let storeLastInStockTs = -Infinity;
		for (const ev of evs) {
			const t = new Date(ev.ts).getTime();
			if (!Number.isFinite(t)) continue;
			if (t < firstEverTs) firstEverTs = t;
			if (t > lastEverTs) lastEverTs = t;
			if (ev.p != null && t > storeLastInStockTs) storeLastInStockTs = t;
		}
		// A currently-open period also implies "last in stock = now"
		if (stillOpen) storeLastInStockTs = NOW;
		// This store's contribution to the epoch signal: how far its most recent
		// in-stock observation sits past its OWN tracking epoch. Quadratic ramp,
		// full credit by day 30. A store that never had the item in stock has no
		// epoch evidence to offer and contributes nothing. Falls back to the global
		// epoch for stores not yet backfilled with a per-file createdAt.
		if (storeLastInStockTs > -Infinity) {
			const epStore = eventsByStore[s] && eventsByStore[s].epochMs;
			const anchor = Number.isFinite(epStore) ? epStore : TRACKER_EPOCH_MS;
			const d = Math.max(0, (storeLastInStockTs - anchor) / 86400000);
			const ramp = Math.min(d / 30, 1);
			storeEpochSignals.push(ramp * ramp);
		}
	}

	const breadth = stores.length;
	const ageDays = firstEverTs === Infinity ? 0 : (NOW - firstEverTs) / 86400000;
	const lastSeenDaysAgo = lastEverTs === -Infinity ? Infinity : (NOW - lastEverTs) / 86400000;

	// Weighted mean: completed spells contribute fully, open spells contribute
	// proportional to age over MEAN_OPEN_RAMP_DAYS. Avoids a fresh restock
	// dragging a real completed spell's mean toward zero.
	let meanWS = 0;
	let meanWT = 0;
	for (const ms of completedPeriodsMs) {
		meanWS += ms / 86400000;
		meanWT += 1;
	}
	for (const ms of openDurationsMs) {
		const d = ms / 86400000;
		const w = Math.min(d / MEAN_OPEN_RAMP_DAYS, 1);
		meanWS += d * w;
		meanWT += w;
	}
	const meanPeriodDays = meanWT > 0 ? meanWS / meanWT : 0;
	const totalInStockDays = totalInStockMs / 86400000;

	// Smooth signals (each 0..1, higher = rarer)
	const S_breadth = 1 / (1 + breadth / 3);
	const S_avail = breadth > 0 ? 1 - effectiveStockedStores / breadth : 1;
	const S_velocity = 1 / (1 + meanPeriodDays / 7);
	const S_restock_low = totalRestocks / (totalRestocks + 3);
	const S_persistence_low = totalInStockDays / (totalInStockDays + 45);
	// Multi-store fast-sellout = allocation. A single store cycling through
	// stock could be many things (small initial order, deliberate slow restock,
	// etc.), but if it's selling out fast at multiple stores simultaneously,
	// demand clearly outpaces supply at the brand level.
	// Counts only stores where the item ACTUALLY sells fast (mean period < 7d)
	// — stores that sit on inventory dilute the signal even if the brand-level
	// "mean velocity" looks fast. Denominator is max(5, breadth) so the signal
	// saturates at 5 rare-acting stores but per-store contributions remain
	// fractional for items that have mixed behavior across stores.
	const S_allocation = rareActingStores / Math.max(5, breadth);

	// Asymmetric "widely available" penalty — only fires for items at MANY
	// stores with FEW OOS at any time. Rare items have either low breadth or
	// many stores OOS, so they get zero penalty and aren't affected. Pulls
	// common items further down the rarity scale without touching rare ones.
	const widelyAvailableBreadthFactor = Math.min(Math.max(0, breadth - 5) / 10, 1);
	const widelyAvailableAvailFactor = Math.max(0, 0.3 - S_avail) / 0.3;
	const S_widely_available = widelyAvailableBreadthFactor * widelyAvailableAvailFactor;

	const rarity =
		0.25 * S_breadth +
		0.25 * S_avail +
		0.10 * S_velocity +
		0.05 * (1 - S_restock_low) +
		0.20 * (1 - S_persistence_low) +
		0.20 * S_allocation -
		0.15 * S_widely_available;

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
	//   epochSignal — penalty if the most recent in-stock observation was
	//   suspiciously close to a store's tracking start (we can't tell if a 5-day
	//   post-epoch sellout is genuinely scarce or just an artifact of catching the
	//   item mid-cycle). Computed PER STORE against that store's own epoch (above),
	//   then combined with MAX: the penalty applies to each store's evidence
	//   individually, but the item is confident as soon as ANY store has watched it
	//   long enough past its own epoch. A fresh in-stock flicker at a brand-new store
	//   is discounted on its own merits, yet it cannot erase the confidence a
	//   long-observing store already earned. (An item seen ONLY at new stores still
	//   scores low — every store's signal is near-zero, so the max is too.)
	let ageSignal;
	if (currentlyStockedStores === 0) {
		const oosTime = Math.max(0, ageDays - totalInStockDays);
		ageSignal = Math.min(oosTime / 5, 1);
	} else if (currentlyStockedStores >= stores.length) {
		ageSignal = Math.min(ageDays / 30, 1);
	} else {
		ageSignal = Math.min(ageDays / 7, 1);
	}
	const epochSignal = storeEpochSignals.length ? Math.max(...storeEpochSignals) : 0;
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
	coalescePeriods,
	dedupRenameEvents,
	scoreSku,
	unifySameStoreEntries,
	storeIdFromDbFile,
	effectiveRarity,
	computeTierThresholds,
	tierFor,
	TRACKER_EPOCH_MS,
};
