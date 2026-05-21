// Shared canonical-SKU utilities. Parallel sibling of `src/utils/sku_canonical.js`.
// Because viz uses native ES modules and the tracker uses CommonJS (no build
// step in this repo), the two files must be kept in sync manually. If you
// change the logic here, mirror it in src/utils/sku_canonical.js.

/* ---------------- Implicit-SKU normalization ---------------- */

export function normalizeImplicitSkuKey(k) {
	const s = String(k || "").trim();
	const m = s.match(/^id:(\d+)$/i);
	if (m) return String(m[1]).padStart(6, "0");
	return s;
}

/* ---------------- SKU classification helpers ---------------- */

export function isUnknownSkuKey(k) {
	return String(k || "").startsWith("u:");
}

export function isNumericSku(k) {
	return /^\d+$/.test(String(k || "").trim());
}

export function isUpcSku(k) {
	const s = String(k || "").trim();
	if (s.startsWith("upc:")) return true;
	return /^\d{12,14}$/.test(s);
}

/* ---------------- Canonical ordering ---------------- */

export function compareSku(a, b) {
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

export class DSU {
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

export function buildGroupsAndCanonicalMap(links) {
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
