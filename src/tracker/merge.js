// src/tracker/merge.js
"use strict";

const { normalizeSkuKey, normalizeCspc, pickBetterSku } = require("../utils/sku");
const { normPrice } = require("../utils/price");

function normImg(v) {
	const s = String(v || "").trim();
	if (!s) return "";
	if (/^data:/i.test(s)) return "";
	if (/%7Bwidth%7D|\{width\}/i.test(s)) return ""; // drop Shopify width-template URLs
	return s;
}

function dbStoreLabel(prevDb) {
	return String(prevDb?.storeLabel || prevDb?.store || "").trim();
}

function mergeDiscoveredIntoDb(prevDb, discovered, { storeLabel } = {}) {
	const effectiveStoreLabel = String(storeLabel || dbStoreLabel(prevDb)).trim();
	if (!effectiveStoreLabel) {
		throw new Error(
			"mergeDiscoveredIntoDb: missing storeLabel; refusing to generate synthetic SKUs with fallback 'store'",
		);
	}

	function normalizeSkuForDb(raw, url) {
		return normalizeSkuKey(raw, { storeLabel: effectiveStoreLabel, url });
	}

	const merged = new Map(prevDb.byUrl);

	const newItems = [];
	const updatedItems = [];
	const removedItems = [];
	const restoredItems = [];
	const metaChangedItems = [];
	const skuUpgrades = []; // { fromSku, toSku, url } when pickBetterSku changes a record's sku in place

	// Choose a deterministic "best" record among dup active SKU rows.
	// Prefer: more complete fields, then lexicographically smallest URL.
	function scoreItem(it) {
		if (!it) return 0;
		const name = String(it.name || "").trim();
		const price = String(it.price || "").trim();
		const url = String(it.url || "").trim();
		const img = String(it.img || "").trim();
		return (name ? 1 : 0) + (price ? 1 : 0) + (url ? 1 : 0) + (img ? 1 : 0);
	}

	function pickBetter({ url: urlA, item: a }, { url: urlB, item: b }) {
		const sa = scoreItem(a);
		const sb = scoreItem(b);
		if (sa !== sb) return sa > sb ? { url: urlA, item: a } : { url: urlB, item: b };
		// tie-breaker: stable + deterministic
		return String(urlA || "") <= String(urlB || "") ? { url: urlA, item: a } : { url: urlB, item: b };
	}

	// Index active items by non-synthetic skuKey (CSPC / id:* / upc:* / etc).
	// Also track *all* urls per skuKey to cleanup dupes.
	const prevBySkuKey = new Map(); // skuKey -> { url, item } (best)
	const prevUrlsBySkuKey = new Map(); // skuKey -> Set(urls)

	for (const [url, it] of prevDb.byUrl.entries()) {
		if (!it || it.removed) continue;

		const skuKey = normalizeSkuForDb(it.sku, url);
		if (!skuKey || /^u:/i.test(skuKey)) continue;

		let set = prevUrlsBySkuKey.get(skuKey);
		if (!set) prevUrlsBySkuKey.set(skuKey, (set = new Set()));
		set.add(url);

		const cur = prevBySkuKey.get(skuKey);
		const next = { url, item: it };
		if (!cur) prevBySkuKey.set(skuKey, next);
		else prevBySkuKey.set(skuKey, pickBetter(cur, next));
	}

	const matchedPrevUrls = new Set(); // old URLs we "found" via skuKey even if URL changed

	for (const [url, nowRaw] of discovered.entries()) {
		let prev = prevDb.byUrl.get(url);
		let prevUrlForThisItem = url;

		// URL not found in previous DB: try to match by non-synthetic skuKey.
		if (!prev) {
			const nowSkuKey = normalizeSkuForDb(nowRaw.sku, url);
			if (nowSkuKey && !/^u:/i.test(nowSkuKey)) {
				const hit = prevBySkuKey.get(nowSkuKey);
				// A skuKey match means "this product moved to a new URL" — but ONLY if the old
				// URL is gone. When both URLs are live in the SAME scan they are two distinct
				// products that merely collide on a normalized SKU (e.g. BSW sells
				// pendleton-directors-reserve as sku 795231 and
				// pendleton-directors-reserve-whisky-2018 as 795231-2, which normalizes to the
				// same key). Treating that as a migration made the pair annihilate each other:
				// whichever was scanned second hard-deleted the other, so the DB kept one record
				// whose price alternated every single run ($230 <-> $350) forever.
				if (hit && hit.url && hit.url !== url && !discovered.has(hit.url)) {
					prev = hit.item;
					prevUrlForThisItem = hit.url;

					// Mark ALL prior URLs for this skuKey as matched, so we don't later "remove" them.
					// Skip any that are live in this scan — those are separate products, and
					// marking them matched would suppress their own (correct) processing.
					const allOld = prevUrlsBySkuKey.get(nowSkuKey);
					if (allOld) {
						for (const u of allOld) {
							if (!discovered.has(u)) matchedPrevUrls.add(u);
						}
					} else {
						matchedPrevUrls.add(hit.url);
					}

					// Cleanup: remove any existing active duplicates for this skuKey from the merged map.
					// We'll re-add the chosen record at the new URL below.
					if (allOld) {
						for (const u of allOld) {
							if (u !== url && !discovered.has(u) && merged.has(u)) merged.delete(u);
						}
					} else {
						if (merged.has(hit.url)) merged.delete(hit.url);
					}
				}
			}
		}

		// Truly new (no URL match, no skuKey match)
		if (!prev) {
			const nowSku = normalizeSkuForDb(nowRaw.sku, url);
			const now = {
				...nowRaw,
				sku: nowSku,
				img: normImg(nowRaw.img),
				removed: false,
			};
			newItems.push(now);
			merged.set(url, now);
			continue;
		}

		// If the previous record was removed and we found it by the SAME URL, keep current behavior (restored).
		if (prevUrlForThisItem === url && prev.removed) {
			const prevSku = normalizeSkuForDb(prev.sku, prev.url);
			const rawNowSku = normalizeSkuForDb(nowRaw.sku, url);
			const nowSku = pickBetterSku(rawNowSku, prevSku);

			if (prevSku && nowSku && prevSku !== nowSku) {
				skuUpgrades.push({ fromSku: prevSku, toSku: nowSku, url });
			}

			const now = {
				...nowRaw,
				sku: nowSku,
				img: normImg(nowRaw.img) || normImg(prev.img),
				removed: false,
			};

			restoredItems.push({
				url,
				name: now.name || prev.name || "",
				price: now.price || prev.price || "",
				sku: now.sku || "",
			});

			merged.set(url, now);
			continue;
		}

		// Update-in-place (or URL-move-with-skuKey): update DB, report price changes normally.
		const prevPrice = normPrice(prev.price);
		const nowPrice = normPrice(nowRaw.price);

		const prevSku = normalizeSkuForDb(prev.sku, prev.url);
		const rawNowSku = normalizeSkuForDb(nowRaw.sku, url);
		const nowSku = pickBetterSku(rawNowSku, prevSku);

		const prevImg = normImg(prev.img);
		let nowImg = normImg(nowRaw.img);
		if (!nowImg) nowImg = prevImg;

		const nameChanged = String(prev.name || "") !== String(nowRaw.name || "");
		const priceChanged = prevPrice !== nowPrice;
		const skuChanged = prevSku !== nowSku;
		const imgChanged = prevImg !== nowImg;

		if (skuChanged && prevSku && nowSku) {
			skuUpgrades.push({ fromSku: prevSku, toSku: nowSku, url });
		}

		if (nameChanged || priceChanged || skuChanged || imgChanged || prevUrlForThisItem !== url) {
			merged.set(url, { ...nowRaw, sku: nowSku, img: nowImg, removed: false });
		}

		if (priceChanged) {
			updatedItems.push({
				url,
				name: nowRaw.name || prev.name || "",
				sku: nowSku || "",
				oldPrice: prev.price || "",
				newPrice: nowRaw.price || "",
			});
		} else if (nameChanged || skuChanged || imgChanged || prevUrlForThisItem !== url) {
			// Count non-price changes (SKU upgrades, name/img changes, or URL moves) as meaningful.
			metaChangedItems.push({
				url,
				name: nowRaw.name || prev.name || "",
				sku: nowSku || "",
			});
		}
	}

	for (const [url, prev] of prevDb.byUrl.entries()) {
		if (discovered.has(url)) continue;
		if (matchedPrevUrls.has(url)) continue; // de-dupe URL changes for skuKey items (and cleanup dupes)
		if (!prev.removed) {
			const removed = { ...prev, removed: true };
			merged.set(url, removed);
			removedItems.push({
				url,
				name: prev.name || "",
				price: prev.price || "",
				sku: normalizeCspc(prev.sku) || "",
			});
		}
	}

	return { merged, newItems, updatedItems, removedItems, restoredItems, metaChangedItems, skuUpgrades };
}

/**
 * If discovered < 60% of previous item count, restore old active items to avoid
 * a partial scrape (network glitch, site change) wiping out good historical data.
 * Returns true if protection was triggered.
 *
 * A scan that discovers ZERO items counts as the most severe case, not an exemption
 * — a live store never legitimately empties an entire category. The old early-return
 * on discSize === 0 is what let Sierra Springs wipe 1049 listings on 2026-08-07 when
 * its shippability filter started dropping every product.
 */
function avoidMassRemoval(prevDb, discovered, ctx, reason, report) {
	// Count only ACTIVE previous items: byUrl also holds every long-removed record
	// ever seen, so using its raw size compares a live listing count against a
	// historical total and trips the guard on healthy categories (e.g. Sierra
	// Springs "Other" is 8 live listings out of 471 accumulated records).
	let prevSize = 0;
	for (const it of prevDb?.byUrl?.values() || []) {
		if (it && !it.removed) prevSize++;
	}
	const discSize = discovered?.size || 0;

	if (prevSize <= 0) return false;

	const ratio = discSize / Math.max(1, prevSize);
	if (ratio >= 0.6) return false;

	ctx.logger.warn?.(
		`${ctx.catPrefixOut} | Partial scan (${discSize}/${prevSize}); preserving DB to avoid mass removals (${reason}).`,
	);

	// Record it on the report too: a silent guard trip means a store's scraper is
	// quietly broken while the DB looks healthy. Surfaces in the report body, the
	// [[GUARDED-CATEGORIES]] sentinel and the data-branch commit first line.
	if (report && Array.isArray(report.massRemovalGuards)) {
		report.massRemovalGuards.push({
			store: ctx.store.name,
			label: ctx.cat.label,
			key: ctx.store.key,
			discovered: discSize,
			previous: prevSize,
			reason,
		});
	}

	for (const [u, it] of prevDb.byUrl.entries()) {
		if (!it || it.removed) continue;
		if (!discovered.has(u)) discovered.set(u, it);
	}
	return true;
}

module.exports = { mergeDiscoveredIntoDb, avoidMassRemoval };
