"use strict";

// Shared canonical-SKU utilities used by both the Node tracker side and the
// viz side. Because viz uses native ES modules and the tracker uses CommonJS
// (no build step in this repo), this file has a parallel sibling at
// `viz/app/sku_canonical.js` that MUST be kept in sync. If you change the
// logic here, mirror it there.

/* ---------------- Implicit-SKU normalization ---------------- */

// Standard implicit-key normalization used by link/canonical processing:
//   "id:12345"  -> "012345"  (zero-pad to 6 digits)
//   anything else -> returned trimmed
//
// Note: `tools/lib/sku.js` has a *more aggressive* variant that also extracts
// any 6-10 digit substring; that variant is intentionally distinct and should
// not be folded into this one. See `tools/lib/sku.js` for callers.
function normalizeImplicitSkuKey(k) {
	const s = String(k || "").trim();
	const m = s.match(/^id:(\d+)$/i);
	if (m) return String(m[1]).padStart(6, "0");
	return s;
}

/* ---------------- SKU classification helpers ---------------- */

function isUnknownSkuKey(k) {
	return String(k || "").startsWith("u:");
}

function isNumericSku(k) {
	return /^\d+$/.test(String(k || "").trim());
}

function isUpcSku(k) {
	const s = String(k || "").trim();
	if (s.startsWith("upc:")) return true;
	return /^\d{12,14}$/.test(s); // bare 12-14 digit barcodes
}

/* ---------------- Canonical ordering ---------------- */

// Stable ordering used to pick the canonical representative of a canonical group.
// Priority: real (non-u:) > unknown (u:); among reals: non-UPC > UPC;
// among numeric reals: integer-asc; fallback: lex.
//
// In practice the UPC clause rarely changes outcomes vs pure lex (UPCs sort late
// lexically anyway), but keeping the explicit clause makes the intent durable.
function compareSku(a, b) {
	a = String(a || "").trim();
	b = String(b || "").trim();
	if (a === b) return 0;

	const au = isUnknownSkuKey(a);
	const bu = isUnknownSkuKey(b);
	if (au !== bu) return au ? 1 : -1;

	const aUpc = isUpcSku(a);
	const bUpc = isUpcSku(b);
	if (aUpc !== bUpc) return aUpc ? 1 : -1;

	const an = isNumericSku(a);
	const bn = isNumericSku(b);
	if (an && bn) {
		const na = Number(a);
		const nb = Number(b);
		if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? -1 : 1;
	}

	return a < b ? -1 : 1;
}

/* ---------------- Union-Find (undirected grouping) ---------------- */

class DSU {
	constructor() {
		this.parent = new Map();
		this.rank = new Map();
	}
	_add(x) {
		if (!this.parent.has(x)) {
			this.parent.set(x, x);
			this.rank.set(x, 0);
		}
	}
	find(x) {
		x = String(x || "").trim();
		if (!x) return "";
		this._add(x);
		let p = this.parent.get(x);
		if (p !== x) {
			p = this.find(p);
			this.parent.set(x, p);
		}
		return p;
	}
	union(a, b) {
		a = String(a || "").trim();
		b = String(b || "").trim();
		if (!a || !b || a === b) return;
		const ra = this.find(a);
		const rb = this.find(b);
		if (!ra || !rb || ra === rb) return;

		const rka = this.rank.get(ra) || 0;
		const rkb = this.rank.get(rb) || 0;

		if (rka < rkb) this.parent.set(ra, rb);
		else if (rkb < rka) this.parent.set(rb, ra);
		else {
			this.parent.set(rb, ra);
			this.rank.set(ra, rka + 1);
		}
	}
}

/* ---------------- Canonical-group construction ---------------- */

// Given an array of link records ({ fromSku, toSku, ... }), build:
//   canonBySku:    Map<sku, canonicalRep>
//   groupsByCanon: Map<canonicalRep, Set<member>>  (each canonical group includes its own rep)
function buildGroupsAndCanonicalMap(links) {
	const dsu = new DSU();
	const all = new Set();

	for (const x of Array.isArray(links) ? links : []) {
		const a = normalizeImplicitSkuKey(x?.fromSku);
		const b = normalizeImplicitSkuKey(x?.toSku);
		if (!a || !b) continue;
		all.add(a);
		all.add(b);
		dsu.union(a, b);
	}

	const groupsByRoot = new Map();
	for (const s of all) {
		const r = dsu.find(s);
		if (!r) continue;
		let set = groupsByRoot.get(r);
		if (!set) groupsByRoot.set(r, (set = new Set()));
		set.add(s);
	}

	const repByRoot = new Map();
	for (const [root, members] of groupsByRoot.entries()) {
		const arr = Array.from(members).sort(compareSku);
		repByRoot.set(root, arr[0] || root);
	}

	const canonBySku = new Map();
	const groupsByCanon = new Map();
	for (const [root, members] of groupsByRoot.entries()) {
		const rep = repByRoot.get(root) || root;
		let g = groupsByCanon.get(rep);
		if (!g) groupsByCanon.set(rep, (g = new Set([rep])));
		for (const s of members) {
			canonBySku.set(s, rep);
			g.add(s);
		}
	}

	return { canonBySku, groupsByCanon };
}

module.exports = {
	normalizeImplicitSkuKey,
	isUnknownSkuKey,
	isNumericSku,
	isUpcSku,
	compareSku,
	DSU,
	buildGroupsAndCanonicalMap,
};
