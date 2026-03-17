"use strict";

function padRight(s, n) {
	s = String(s);
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padLeft(s, n) {
	s = String(s);
	return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function stripAnsi(s) {
	return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padRightV(s, n) {
	s = String(s);
	const w = stripAnsi(s).length;
	return w >= n ? s : s + " ".repeat(n - w);
}

function padLeftV(s, n) {
	s = String(s);
	const w = stripAnsi(s).length;
	return w >= n ? s : " ".repeat(n - w) + s;
}

/**
 * Returns the first non-empty string from its arguments.
 * Values may be strings, arrays of strings, or arrays of objects with url/src/image keys.
 */
function firstNonEmptyStr(...vals) {
	for (const v of vals) {
		const s = typeof v === "string" ? v.trim() : "";
		if (s) return s;
		if (Array.isArray(v)) {
			for (const a of v) {
				if (typeof a === "string" && a.trim()) return a.trim();
				if (a && typeof a === "object") {
					const u = String(a.url || a.src || a.image || "").trim();
					if (u) return u;
				}
			}
		}
	}
	return "";
}

module.exports = { padRight, padLeft, stripAnsi, padRightV, padLeftV, firstNonEmptyStr };
