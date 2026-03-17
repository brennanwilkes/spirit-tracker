"use strict";

function normalizeCspc(v) {
	const m = String(v ?? "").match(/\b(\d{6})\b/);
	return m ? m[1] : "";
}

function fnv1a32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function normalizeImplicitSkuKey(k) {
	const s = String(k ?? "").trim();
	const idm = s.match(/^id:(\d{1,6})$/i);
	if (idm) return String(idm[1]).padStart(6, "0");
	const m = s.match(/\b(\d{6,10})\b/);
	if (m) return m[1];
	return s;
}

function priceToNumber(v) {
	const s = String(v ?? "").replace(/[^0-9.]/g, "");
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

function dateOnly(iso) {
	const m = String(iso ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
	return m ? m[1] : "";
}

module.exports = {
	normalizeCspc,
	fnv1a32,
	normalizeImplicitSkuKey,
	priceToNumber,
	dateOnly,
};
