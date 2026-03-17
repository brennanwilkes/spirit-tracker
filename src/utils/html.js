"use strict";

function stripTags(s) {
	return String(s).replace(/<[^>]*>/g, "");
}

function cleanText(s) {
	return String(s)
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtml(s) {
	return String(s)
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#039;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&laquo;/g, "«")
		.replace(/&raquo;/g, "»");
}

function escapeRe(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHtmlAttr(html, attrName) {
	const re = new RegExp(`\\b${escapeRe(attrName)}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i");
	const m = re.exec(html);
	if (!m) return "";
	return m[1] ?? m[2] ?? m[3] ?? "";
}

function pickFirstUrlFromSrcset(srcset) {
	const s = String(srcset || "").trim();
	if (!s) return "";
	const first = (s.split(",")[0] || "").trim();
	const url = (first.split(/\s+/)[0] || "").trim();
	return url.replace(/^["']|["']$/g, "");
}

function normalizeMaybeRelativeUrl(raw, baseUrl) {
	const r = String(raw || "").trim();
	if (!r) return "";
	let u = r;
	if (u.startsWith("//")) u = `https:${u}`;
	try {
		return baseUrl ? new URL(u, baseUrl).toString() : new URL(u).toString();
	} catch {
		return u;
	}
}

function resolveShopifyWidthPlaceholder(url, tag) {
	const s = String(url || "");
	if (!/%7Bwidth%7D|\{width\}/i.test(s)) return s;

	// Pick a reasonable width from data-widths if available
	let w = 400;
	const dw = extractHtmlAttr(tag, "data-widths");
	if (dw) {
		try {
			const arr = JSON.parse(dw);
			if (Array.isArray(arr) && arr.length) {
				if (arr.includes(400)) w = 400;
				else if (arr.includes(360)) w = 360;
				else w = arr[0];
			}
		} catch {}
	}

	return s
		.replace(/_%7Bwidth%7D(x)/gi, `_${w}$1`)
		.replace(/_\{width\}(x)/gi, `_${w}$1`)
		.replace(/%7Bwidth%7D/gi, String(w))
		.replace(/\{width\}/gi, String(w));
}

function extractFirstImgUrl(html, baseUrl) {
	const s = String(html || "");
	const m = s.match(/<img\b[^>]*>/i);
	if (!m) return "";

	const tag = m[0];

	const attrs = ["data-src", "data-lazy-src", "data-original", "data-srcset", "srcset", "src"];

	for (const a of attrs) {
		let v = extractHtmlAttr(tag, a);
		if (!v) continue;

		v = decodeHtml(String(v)).trim();
		if (!v) continue;

		const isSrcset = a.toLowerCase().includes("srcset");
		if (isSrcset) v = pickFirstUrlFromSrcset(v);
		v = String(v || "").trim();
		if (!v) continue;

		if (/^data:/i.test(v)) continue;

		// If this attr is a template URL, prefer trying srcset next
		if (!isSrcset && /%7Bwidth%7D|\{width\}/i.test(v)) continue;

		let abs = normalizeMaybeRelativeUrl(v, baseUrl);
		abs = resolveShopifyWidthPlaceholder(abs, tag);
		if (abs) return abs;
	}

	// Fallback: accept template URLs but force a width
	for (const a of ["data-src", "src"]) {
		let v = extractHtmlAttr(tag, a);
		if (!v) continue;
		v = decodeHtml(String(v)).trim();
		if (!v || /^data:/i.test(v)) continue;
		let abs = normalizeMaybeRelativeUrl(v, baseUrl);
		abs = resolveShopifyWidthPlaceholder(abs, tag);
		if (abs) return abs;
	}

	return "";
}

/**
 * Split an HTML string on <li class="...product..."> boundaries.
 * Returns an array of block strings, each starting with its full opening <li> tag.
 */
function splitLiProductBlocks(html) {
	const re = /<li\b[^>]*class=["'][^"']*\bproduct\b[^"']*["'][^>]*>/gi;
	const parts = String(html).split(re);
	const matches = [...String(html).matchAll(re)];
	return matches.map((m, i) => m[0] + parts[i + 1]);
}

module.exports = {
	stripTags,
	cleanText,
	decodeHtml,
	escapeRe,
	extractHtmlAttr,
	extractFirstImgUrl,
	splitLiProductBlocks,
};
