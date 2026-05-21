// viz/app/mapping.js
import { loadSkuMetaBestEffort, isLocalWriteMode } from "./api.js";
import { applyPendingToMeta } from "./pending.js";
import { normalizeImplicitSkuKey, buildGroupsAndCanonicalMap } from "./sku_canonical.js";

let CACHED = null;

export function clearSkuRulesCache() {
	CACHED = null;
}

function canonicalPairKey(a, b) {
	const x = normalizeImplicitSkuKey(a);
	const y = normalizeImplicitSkuKey(b);
	if (!x || !y) return "";
	return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function buildForwardMap(links) {
	const m = new Map();
	for (const x of Array.isArray(links) ? links : []) {
		const fromSku = normalizeImplicitSkuKey(x?.fromSku);
		const toSku = normalizeImplicitSkuKey(x?.toSku);
		if (fromSku && toSku && fromSku !== toSku) m.set(fromSku, toSku);
	}
	return m;
}

function buildIgnoreSet(ignores) {
	const s = new Set();
	for (const x of Array.isArray(ignores) ? ignores : []) {
		const a = String(x?.skuA || x?.a || x?.left || "").trim();
		const b = String(x?.skuB || x?.b || x?.right || "").trim();
		const k = canonicalPairKey(a, b);
		if (k) s.add(k);
	}
	return s;
}

export async function loadSkuRules() {
	if (CACHED) return CACHED;

	let meta = await loadSkuMetaBestEffort();

	// On GitHub Pages (read-only), overlay local pending+submitted edits from localStorage
	if (!isLocalWriteMode()) {
		meta = applyPendingToMeta(meta);
	}

	const links = Array.isArray(meta?.links) ? meta.links : [];
	const ignores = Array.isArray(meta?.ignores) ? meta.ignores : [];

	const forwardMap = buildForwardMap(links);

	const { canonBySku, groupsByCanon } = buildGroupsAndCanonicalMap(links);
	const ignoreSet = buildIgnoreSet(ignores);

	function canonicalSku(sku) {
		const s = normalizeImplicitSkuKey(sku);
		if (!s) return s;
		return canonBySku.get(s) || s;
	}

	function groupForCanonical(toSku) {
		const canon = canonicalSku(toSku);
		const g = groupsByCanon.get(canon);
		return g ? new Set(g) : new Set([canon]);
	}

	function isIgnoredPair(a, b) {
		const k = canonicalPairKey(a, b);
		return k ? ignoreSet.has(k) : false;
	}

	CACHED = {
		links,
		ignores,
		forwardMap,

		// "toGroups" retained name for compatibility with existing code
		toGroups: groupsByCanon,
		ignoreSet,

		canonicalSku,
		groupForCanonical,
		isIgnoredPair,
		canonicalPairKey,
	};

	return CACHED;
}
