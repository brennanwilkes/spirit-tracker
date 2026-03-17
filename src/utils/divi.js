"use strict";

const { decodeHtml } = require("./html");

/**
 * Extract the Divi Ajax Filter nonce/security token from page HTML.
 * Looks for loadmore_ajax_object or filter_ajax_object.
 */
function extractDiviAjaxSecurity(html) {
	const s = String(html || "");
	const m =
		s.match(/loadmore_ajax_object\s*=\s*\{[\s\S]*?"security"\s*:\s*"([a-f0-9]{8,64})"/i) ||
		s.match(/filter_ajax_object\s*=\s*\{[\s\S]*?"security"\s*:\s*"([a-f0-9]{8,64})"/i) ||
		s.match(/"security"\s*:\s*"([a-f0-9]{8,64})"/i);
	return (m && m[1]) || "";
}

/**
 * Extract the data-filter-var JSON object from page HTML.
 * Returns a parsed object or null if missing/malformed.
 */
function extractDiviFilterVarQuery(html) {
	const s = String(html || "");
	const m = s.match(/\bdata-filter-var\s*=\s*'([\s\S]*?)'\s*/i);
	if (!m || !m[1]) return null;
	const raw = decodeHtml(m[1]);
	try { return JSON.parse(raw); } catch { return null; }
}

/**
 * POST one loadmore page to the Divi Ajax Filter endpoint.
 * Uses ctx.store.host for the Origin header and ctx.store.key for the log key.
 */
async function fetchDiviLoadMore(ctx, endpoint, body) {
	return await ctx.http.fetchJsonWithRetry(
		endpoint,
		`${ctx.store.key}:divi:${ctx.cat.key}:p${body.page}`,
		ctx.store.ua,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"X-Requested-With": "XMLHttpRequest",
				Origin: `https://${ctx.store.host}`,
				Referer: ctx.cat.startUrl,
			},
			body: JSON.stringify(body),
		},
	);
}

module.exports = { extractDiviAjaxSecurity, extractDiviFilterVarQuery, fetchDiviLoadMore };
