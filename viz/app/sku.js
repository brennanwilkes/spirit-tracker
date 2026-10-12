import { applyQueryAliases } from "./search_aliases.js";

export function parsePriceToNumber(v) {
	const s = String(v ?? "").replace(/[^0-9.]/g, "");
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

export function fnv1a32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function makeSyntheticSku(r) {
	const store = String(r?.storeLabel || r?.store || "store");
	const url = String(r?.url || "");
	const key = `${store}|${url}`;
	return `u:${fnv1a32(key)}`;
}

export function keySkuForRow(r) {
	const real0 = String(r?.sku || "").trim();
	if (real0) {
		const m = real0.match(/^id:(\d+)$/i);
		return m ? String(m[1]).padStart(6, "0") : real0;
	}
	return makeSyntheticSku(r);
}

// A collision split key c:<sku>:<tag> shows the store's real number.
export function displaySku(key) {
	const s = String(key || "");
	if (s.startsWith("u:")) return "unknown";
	const m = s.match(/^c:([^:]+):[a-z0-9]+$/);
	return m ? m[1] : s;
}

export function isUnknownSkuKey(key) {
	return String(key || "").startsWith("u:");
}

// Normalize for search: lowercase, punctuation -> space, collapse spaces
export function normSearchText(s) {
	return String(s ?? "")
		// Fold diacritics so "Diplomático"→"diplomatico", "Añejo"→"anejo",
		// "Càirdeas"→"cairdeas" — otherwise the accented letter is stripped to a
		// space and splits the word (matching + search both break).
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// A possessive is dropped ("gordon's" -> "gordon"): its lone "s" would otherwise have to be a
// whole word and miss listings spelled "Gordons".
export function tokenizeQuery(q) {
	const n = normSearchText(applyQueryAliases(String(q ?? "").replace(/['’`]s\b/gi, "")));
	return n ? n.split(" ").filter(Boolean) : [];
}

// Tokens match as substrings, except a one-character token, which must be a whole word:
// a lone "m" or "7" as a substring matches nearly every item.
export function matchesAllTokens(hayNorm, tokens) {
	if (!tokens.length) return true;
	nextToken: for (const t of tokens) {
		if (t.length > 1) {
			if (!hayNorm.includes(t)) return false;
			continue;
		}
		for (let i = hayNorm.indexOf(t); i !== -1; i = hayNorm.indexOf(t, i + 1)) {
			if ((i === 0 || hayNorm[i - 1] === " ") && (i + 1 === hayNorm.length || hayNorm[i + 1] === " ")) {
				continue nextToken;
			}
		}
		return false;
	}
	return true;
}
