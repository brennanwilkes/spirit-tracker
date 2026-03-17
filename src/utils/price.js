"use strict";

function normPrice(p) {
	return String(p || "")
		.trim()
		.replace(/\s+/g, "");
}

function priceToNumber(p) {
	const s = String(p || "");
	const n = Number(s.replace(/[^0-9.]/g, ""));
	return Number.isFinite(n) ? n : NaN;
}

function salePctOff(oldPriceStr, newPriceStr) {
	const oldN = priceToNumber(oldPriceStr);
	const newN = priceToNumber(newPriceStr);
	if (!Number.isFinite(oldN) || !Number.isFinite(newN) || oldN <= 0) return null;
	if (newN >= oldN) return null;
	return Math.round(((oldN - newN) / oldN) * 100);
}

// Extract the first "$X.XX" or "$X,XXX.XX" from a string (strips whitespace/commas).
function extractPrice(str) {
	const s = String(str || "");
	const m = s.match(/\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\$\s*\d+(?:\.\d{2})?/);
	if (!m) return "";
	const raw = m[0].replace(/\s+/g, "");
	return raw.replace(/,/g, "");
}

module.exports = { normPrice, priceToNumber, salePctOff, extractPrice };
