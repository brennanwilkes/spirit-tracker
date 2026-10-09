#!/usr/bin/env node
/* Per-item share pages for link previews. Run by .github/workflows/pages.yaml on the site
 * artifact only, after index.json + sku_links*.json + sku_hidden.json are staged into viz/data.
 *
 *   node tools/build_share_pages.mjs <site-dir> <site-base-url>
 *
 * The SPA is hash-routed, and link-preview crawlers never send the fragment or run JS, so every
 * shared `#/item/<sku>` previews as the site's own title. Each canonical sku gets a static
 * `i/<key>/index.html` with the listing's own Open Graph title and image, which JS-redirects to
 * the item page. The redirect is JS-only on purpose: Facebook's crawler follows a meta refresh
 * and would read the target's (generic) tags instead.
 *
 * Name/image/canonicalisation reuse the viz modules the item page itself uses, so a preview
 * shows what the page shows. `shareKey` must match viz/app/item_page.js.
 */
import fs from "node:fs";
import path from "node:path";
import { selectBestDisplayInfo } from "../viz/app/catalog.js";
import { keySkuForRow, parsePriceToNumber, displaySku } from "../viz/app/sku.js";
import { buildGroupsAndCanonicalMap, normalizeImplicitSkuKey } from "../viz/app/sku_canonical.js";
import { listingKey, isHiddenListing } from "../viz/app/hidden.js";
import { normalizeStoreId } from "../viz/app/stores.js";
import { esc } from "../viz/app/dom.js";

const [root, baseArg] = process.argv.slice(2);
if (root === undefined || baseArg === undefined) {
	throw new Error("usage: node tools/build_share_pages.mjs <site-dir> <site-base-url>");
}
const base = baseArg.replace(/\/+$/, "");
// iMessage builds its preview on the sender's phone in a WebView that RUNS this page's JS, so an
// unconditional redirect made it read index.html's site-wide tags. It (and the other JS-running
// previewers) identify with a crawler UA such as "facebookexternalhit/1.1 Facebot Twitterbot/1.0".
const PREVIEWER_UA = /facebookexternalhit|Facebot|Twitterbot|bot\b|crawler|spider|preview/i;
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const index = readJson("data/index.json");
const manual = readJson("data/sku_links.json");
const auto = readJson("data/sku_links_auto.json");
const hidden = readJson("data/sku_hidden.json");

const { canonBySku } = buildGroupsAndCanonicalMap([...manual.links, ...auto.links]);
const canonical = (sku) => {
	const s = normalizeImplicitSkuKey(sku);
	return canonBySku.get(s) ?? s;
};
const hiddenSet = new Set(hidden.hidden.map((e) => listingKey(normalizeStoreId(e.storeId), e.sku)));

const rowsBySku = new Map();
for (const r of index.items) {
	const raw = keySkuForRow(r);
	if (isHiddenListing(hiddenSet, r.storeLabel || r.store, raw)) continue;
	const sku = canonical(raw);
	let rows = rowsBySku.get(sku);
	if (rows === undefined) rowsBySku.set(sku, (rows = []));
	rows.push(r);
}

// A shared link must outlive its key: a u: sku is upgraded to a real one (sku_links_auto) and a new
// link can move a group's canonical rep, either of which would 404 a link shared earlier. So every
// non-canonical sku named in a link file gets its group's page under its own key too.
const aliasesByCanon = new Map();
for (const l of [...manual.links, ...auto.links]) {
	for (const raw of [l.fromSku, l.toSku]) {
		const s = normalizeImplicitSkuKey(raw);
		const canon = canonical(s);
		if (s === canon) continue;
		let set = aliasesByCanon.get(canon);
		if (set === undefined) aliasesByCanon.set(canon, (set = new Set()));
		set.add(s);
	}
}

const outRoot = path.join(root, "i");
fs.rmSync(outRoot, { recursive: true, force: true });

let written = 0;
let aliases = 0;
for (const [sku, rows] of rowsBySku) {
	const live = rows.filter((r) => !r.removed);
	// item_page.js picks its title/photo from live rows when any exist.
	const { bestName, bestImg: photo } = selectBestDisplayInfo(live.length > 0 ? live : rows);
	const bestImg = photo || `${base}/icons/og.png`;
	const title = bestName || `SKU ${displaySku(sku)}`;

	let cheapest = null;
	for (const r of live) {
		const p = parsePriceToNumber(r.price);
		if (p !== null && (cheapest === null || p < cheapest.p)) cheapest = { p, store: r.storeLabel || r.store };
	}
	const storeCount = new Set(live.map((r) => r.storeLabel || r.store)).size;
	const desc =
		cheapest !== null
			? `$${cheapest.p.toFixed(2)} at ${cheapest.store}${storeCount > 1 ? ` · ${storeCount} stores` : ""}`
			: "Currently out of stock everywhere";

	const key = sku.replaceAll(":", "-");
	const shareUrl = `${base}/i/${key}/`;
	// Relative, so the redirect keeps the scheme the link was opened on: Pages reports an
	// http:// base while HTTPS is not enforced, and http is a different origin from the app.
	const appRel = `../../#/item/${encodeURIComponent(sku)}`;
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Spirit Tracker</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(shareUrl)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Spirit Tracker">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(shareUrl)}">
<meta property="og:image" content="${esc(bestImg)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(bestImg)}">
<script>if (!${PREVIEWER_UA}.test(navigator.userAgent)) location.replace(${JSON.stringify(appRel).replaceAll("<", "\\u003c")});</script>
</head>
<body><a href="${esc(appRel)}">${esc(title)}</a></body>
</html>
`;
	fs.mkdirSync(path.join(outRoot, key), { recursive: true });
	fs.writeFileSync(path.join(outRoot, key, "index.html"), html);
	written++;
	for (const alias of aliasesByCanon.get(sku) ?? []) {
		const aliasKey = alias.replaceAll(":", "-");
		if (fs.existsSync(path.join(outRoot, aliasKey))) continue;
		fs.mkdirSync(path.join(outRoot, aliasKey), { recursive: true });
		fs.writeFileSync(path.join(outRoot, aliasKey, "index.html"), html);
		aliases++;
	}
}
console.log(`wrote ${written} share pages + ${aliases} alias pages to ${outRoot}`);
