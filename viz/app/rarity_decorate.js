// One-shot decorator: walks all .item[data-sku] elements within a root and adds
// rarity-* classes based on the precomputed rarity snapshot.
//
// Several pages build item-card HTML inline rather than using itemCardHtml.
// Calling decorateRarity(container) after such a render is the cheapest way to
// add tier styling without touching every template.

import { loadRarity } from "./state.js";
import { loadSkuRules } from "./mapping.js";
import { tierFor } from "./rarity.js";

let CACHED = null;

async function ensureLoaded() {
	if (CACHED) return CACHED;
	const [rules, rarity] = await Promise.all([loadSkuRules(), loadRarity()]);
	CACHED = { rules, rarity };
	return CACHED;
}

// Returns the tier class suffix for a SKU ("staple", "rare", or "" for default).
export function rarityTierForSync(sku, rules, rarity) {
	if (!rules || !rarity) return "";
	const canon = rules.canonicalSku(String(sku || ""));
	const entry = rarity.byCanon?.[canon];
	if (!entry) return "";
	const t = tierFor(entry.r, rarity.thresholds, entry.c);
	return t === "common" ? "" : t;
}

// Decorate a container (defaults to document) by adding rarity-* classes to
// every .item[data-sku] inside. Idempotent: safe to call multiple times.
export async function decorateRarity(root) {
	const { rules, rarity } = await ensureLoaded();
	const scope = root || document;
	const nodes = scope.querySelectorAll(".item[data-sku]");
	for (const el of nodes) {
		// remove any prior tier class so re-decorating after sort/filter works
		el.classList.remove("rarity-staple", "rarity-rare");
		const sku = el.getAttribute("data-sku");
		if (!sku) continue;
		const tier = rarityTierForSync(sku, rules, rarity);
		if (tier) el.classList.add(`rarity-${tier}`);
	}
}
