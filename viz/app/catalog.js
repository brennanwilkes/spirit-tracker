import { normImg } from "./dom.js";
import { parsePriceToNumber, keySkuForRow, normSearchText } from "./sku.js";
import { resolveItemSpiritTypes } from "./spirit_types.js";
import { normalizeStoreId } from "./stores.js";
import { isHiddenListing } from "./hidden.js";

// Display priority for name/photo selection across the site.
// Photo bumps a store up one tier (floored at 0) — so a BCL record with a photo
// can beat a Strath record without one, but not a Strath record with a photo.
const STORE_DISPLAY_TIER = Object.freeze({
	strath: 0,
	bcl: 1,
	kwm: 2,
	craftcellars: 3,
	vintage: 4,
	vessel: 5,
	clbspirits: 6,
});

function storeDisplayTier(storeLabel) {
	return STORE_DISPLAY_TIER[normalizeStoreId(storeLabel)] ?? 7;
}

/**
 * Pick the best name and image for a canonical SKU group.
 *
 * Sort key per row: (displayTier, hasPhoto, -nameLength)
 *   - displayTier: photo bumps up one tier (max(0, tier-1))
 *   - hasPhoto: rows with a photo sort first (same-tier tiebreaker)
 *   - nameLength: longer names preferred (final tiebreaker)
 *
 * Name: first row in sorted order.
 * Image: first row in sorted order with a non-empty image.
 */
export function selectBestDisplayInfo(rows) {
	const scored = [];
	for (const r of rows) {
		const name = String(r?.name || "");
		const img = normImg(r?.img || r?.image || r?.thumb || "");
		const storeLabel = String(r?.storeLabel || r?.store || "");
		if (!name && !img) continue;
		const tier = storeDisplayTier(storeLabel);
		const hasPhoto = !!img;
		const displayTier = hasPhoto ? Math.max(0, tier - 1) : tier;
		scored.push({ name, img, displayTier, hasPhoto, nameLen: name.length });
	}

	scored.sort((a, b) => {
		if (a.displayTier !== b.displayTier) return a.displayTier - b.displayTier;
		if (a.hasPhoto !== b.hasPhoto) return a.hasPhoto ? -1 : 1;
		return b.nameLen - a.nameLen;
	});

	return {
		bestName: scored.find((s) => s.name)?.name || "",
		bestImg: scored.find((s) => s.img)?.img || "",
	};
}

// Build one row per *canonical* SKU (after applying sku map) + combined searchable text
export function aggregateBySku(listings, canonicalizeSkuFn, hiddenSet) {
	const canon = typeof canonicalizeSkuFn === "function" ? canonicalizeSkuFn : (x) => x;

	const bySku = new Map();

	for (const r of listings) {
		const rawSku = keySkuForRow(r);

		if (hiddenSet && hiddenSet.size > 0) {
			const sid = normalizeStoreId(r?.storeLabel || r?.store || "");
			if (isHiddenListing(hiddenSet, sid, rawSku)) continue;
		}

		const sku = canon(rawSku);

		const name = String(r?.name || "");
		const url = String(r?.url || "");
		const storeLabel = String(r?.storeLabel || r?.store || "");
		const removed = Boolean(r?.removed);

		const img = normImg(r?.img || r?.image || r?.thumb || "");

		const pNum = parsePriceToNumber(r?.price);
		const pStr = String(r?.price || "");

		let agg = bySku.get(sku);
		if (!agg) {
			agg = {
				sku, // canonical sku
				name: "",
				img: "",
				cheapestPriceStr: pStr || "",
				cheapestPriceNum: pNum,
				cheapestStoreLabel: storeLabel || "",
				stores: new Set(), // LIVE stores only
				storesEver: new Set(), // live + removed presence (history)
				sampleUrl: url || "",
				spiritTypes: new Set(), // normalized spirit type ids from all rows
				_searchParts: [],
				searchText: "",
				_rows: [],
			};
			bySku.set(sku, agg);
		}

		// Collect spirit types from this row's category + URL (null = unclassifiable, skip)
		const sts = resolveItemSpiritTypes(r?.category || "", r?.url || "", r?.name || "");
		if (sts) for (const st of sts) agg.spiritTypes.add(st);

		if (storeLabel) {
			agg.storesEver.add(storeLabel);
			if (!removed) agg.stores.add(storeLabel);
		}
		if (!agg.sampleUrl && url) agg.sampleUrl = url;

		agg._rows.push({ name, img, storeLabel });

		// cheapest across LIVE rows only (so removed history doesn't "win")
		if (!removed && pNum !== null) {
			if (agg.cheapestPriceNum === null || pNum < agg.cheapestPriceNum) {
				agg.cheapestPriceNum = pNum;
				agg.cheapestPriceStr = pStr || "";
				agg.cheapestStoreLabel = storeLabel || agg.cheapestStoreLabel;
			}
		}

		// search parts: include canonical + raw sku so searching either works
		agg._searchParts.push(sku);
		if (rawSku && rawSku !== sku) agg._searchParts.push(rawSku);
		if (name) agg._searchParts.push(name);
		if (url) agg._searchParts.push(url);
		if (storeLabel) agg._searchParts.push(storeLabel);
		if (removed) agg._searchParts.push("removed");
	}

	const out = [...bySku.values()];

	for (const it of out) {
		const { bestName, bestImg } = selectBestDisplayInfo(it._rows);
		it.name = bestName;
		it.img = bestImg;
		delete it._rows;

		it.storeCount = it.stores.size;
		it.storeCountEver = it.storesEver.size;
		it.removedEverywhere = it.storeCount === 0;

		it._searchParts.push(it.sku);
		it._searchParts.push(it.name || "");
		it._searchParts.push(it.sampleUrl || "");
		it._searchParts.push(it.cheapestStoreLabel || "");
		it.searchText = normSearchText(it._searchParts.join(" | "));
		delete it._searchParts;
	}

	out.sort((a, b) => (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku));
	return out;
}
