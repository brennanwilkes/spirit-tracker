// viz/app/mapping.js
import { loadSkuMetaBestEffort } from "./api.js";
import { normalizeImplicitSkuKey, buildGroupsAndCanonicalMap } from "./sku_canonical.js";

let CACHED = null;

export async function loadSkuRules() {
	if (CACHED) return CACHED;

	const meta = await loadSkuMetaBestEffort();
	const links = Array.isArray(meta?.links) ? meta.links : [];

	const { canonBySku, groupsByCanon } = buildGroupsAndCanonicalMap(links);

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

	CACHED = { canonicalSku, groupForCanonical };

	return CACHED;
}
