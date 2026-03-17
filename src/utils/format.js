"use strict";

const { humanBytes } = require("./bytes");
const { padLeft } = require("./string");

function kbStr(bytes) {
	return humanBytes(bytes).padStart(8, " ");
}

function secStr(ms) {
	const s = Number.isFinite(ms) ? ms / 1000 : 0;
	const tenths = Math.round(s * 10) / 10;
	let out;
	if (tenths < 10) out = `${tenths.toFixed(1)}s`;
	else out = `${Math.round(s)}s`;
	return out.padStart(7, " ");
}

function pageStr(i, total) {
	const leftW = String(total).length;
	return `${padLeft(i, leftW)}/${total}`;
}

function pctStr(done, total) {
	const pct = total ? Math.floor((done / total) * 100) : 0;
	return `${padLeft(pct, 3)}%`;
}

function cad(n) {
	const x = Number(n);
	if (!Number.isFinite(x)) return "";
	return `$${x.toFixed(2)}`;
}

module.exports = { kbStr, secStr, pageStr, pctStr, cad };
