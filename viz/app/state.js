import { fetchJson } from "./api.js";
import { loadSkuRules } from "./mapping.js";
import { tierFor, effectiveRarity } from "./rarity.js";

let INDEX = null;
let RECENT = null;
let RARITY = null;

export async function loadIndex() {
	if (INDEX) return INDEX;
	INDEX = await fetchJson("./data/index.json");
	return INDEX;
}

export async function loadRecent() {
	if (RECENT) return RECENT;
	try {
		RECENT = await fetchJson("./data/recent.json");
	} catch {
		RECENT = { count: 0, items: [] };
	}
	return RECENT;
}

// Precomputed rarity snapshot (viz/data/rarity.json, built by tools/build_viz_rarity.js).
// byCanon is keyed by canonical SKU, so callers must canonicalize their input first.
export async function loadRarity() {
	if (RARITY) return RARITY;
	try {
		RARITY = await fetchJson("./data/rarity.json");
	} catch {
		RARITY = { count: 0, thresholds: { stapleMax: 0, rareMin: 1 }, byCanon: {} };
	}
	return RARITY;
}

// Convenience: given any raw SKU, returns { rarity, confidence, tier } or null if unknown.
// Uses the canonical map (sku_links.json + sku_links_auto.json) for lookup.
export async function getRarityFor(rawSku) {
	const [rules, rarity] = await Promise.all([loadSkuRules(), loadRarity()]);
	const canon = rules.canonicalSku(String(rawSku || ""));
	const entry = rarity.byCanon?.[canon];
	if (!entry) return null;
	return {
		rarity: entry.r,
		confidence: entry.c,
		tier: tierFor(effectiveRarity(entry.r, entry.c), rarity.thresholds),
	};
}

// Synchronous variant for tight loops once both have been loaded once.
// Callers must pass the already-loaded rules and rarity objects.
export function getRarityForSync(rawSku, rules, rarity) {
	if (!rules || !rarity) return null;
	const canon = rules.canonicalSku(String(rawSku || ""));
	const entry = rarity.byCanon?.[canon];
	if (!entry) return null;
	return {
		rarity: entry.r,
		confidence: entry.c,
		tier: tierFor(effectiveRarity(entry.r, entry.c), rarity.thresholds),
	};
}

// persist search box value across navigation
const Q_LS_KEY = "stviz:v1:search:q";

export function loadSavedQuery() {
	try {
		return localStorage.getItem(Q_LS_KEY) || "";
	} catch {
		return "";
	}
}

export function saveQuery(v) {
	try {
		localStorage.setItem(Q_LS_KEY, String(v ?? ""));
	} catch {}
}
