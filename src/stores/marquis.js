"use strict";

// Marquis Wine Cellars — BigCommerce + Halo theme. No public JSON catalog; the
// product grid is rendered client-side, but every category page embeds its
// products inline as a TagRocket analytics array:
//   {price:81.99,currency:'CAD',name:"...",category:{...},sku:"1025673",
//    productSku:"1025673",productId:15102 }
// We regex those objects out of the HTML to get name/price/sku/productId.
//
// The inline array has NO product URL or image. We resolve both via the
// BigCommerce Storefront GraphQL API: every page embeds a short-lived JWT
// storefront token, which we extract and use to batch-query products by
// entityId (== productId) for their canonical `path` and `defaultImage`.
// `search.php?search_query=<sku>` is NOT a stable product link (it renders a
// client-side search page), so it must never be used as the record URL.
//
// SKU caveat: the `sku` is a BC-internal 7-digit ID, NOT a BCLDB code, so it
// must NOT be promoted to a CSPC (that would falsely merge with real CSPC /
// id: SKUs at other stores). We let it fall through to a synthetic u: key —
// Marquis items are singletons until manually bridged in data/sku_links.json
// by bottle name. This is the documented Marquis exception (~100% u:).
//
// No stock flag in the inline data: presence in the listing => available.

const { sanitizeName } = require("../utils/text");
const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { finalizeCategoryScan } = require("../tracker/finalize");

const HOST = "www.marquis-wines.com";

// Matches one inline product object; tolerant of field whitespace.
const PRODUCT_RE = /price:([0-9.]+),currency:'[^']*',name:"((?:[^"\\]|\\.)*)",category:\{[^{}]*\},sku:"(\d+)"(?:,productSku:"\d+")?,productId:(\d+)/g;

// BigCommerce Storefront API JWT embedded in the page (header is {"typ":"JWT"}).
const TOKEN_RE = /eyJ0eXAiOiJKV1Qi[A-Za-z0-9_.-]+/;

const GQL_CHUNK = 50;

function decodeJsString(s) {
	return String(s || "").replace(/\\(["'\\/])/g, "$1").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Resolve productId -> { path, img } via the Storefront GraphQL API.
async function resolveProducts(ctx, token, ids) {
	const out = new Map();
	for (let i = 0; i < ids.length; i += GQL_CHUNK) {
		const chunk = ids.slice(i, i + GQL_CHUNK);
		const query = `{ site { products(entityIds: [${chunk.join(",")}], first: ${GQL_CHUNK}) { edges { node { entityId path defaultImage { url(width: 500) } } } } } }`;
		const { json } = await ctx.http.fetchJsonWithRetry(
			`https://${HOST}/graphql`,
			`${ctx.store.key}:gql:${ctx.cat.key}:chunk${i / GQL_CHUNK}`,
			ctx.store.ua,
			{
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ query }),
			},
		);
		for (const edge of json?.data?.site?.products?.edges || []) {
			const node = edge?.node;
			if (!node || node.path == null) continue;
			out.set(node.entityId, {
				path: node.path,
				img: node.defaultImage?.url || "",
			});
		}
	}
	return out;
}

async function fetchCategorySlug(ctx, slug, rawProducts, tokenHolder) {
	const maxPages = ctx.config.maxPages === null ? 50 : Math.min(ctx.config.maxPages, 50);
	let page = 1;
	while (page <= maxPages) {
		const url = `https://${HOST}/${slug}/?page=${page}`;
		let text;
		try {
			({ text } = await ctx.http.fetchTextWithRetry(url, `${ctx.store.key}:html:${ctx.cat.key}:${slug}:p${page}`, ctx.store.ua));
		} catch (e) {
			// Marquis returns 404 past the last page (not an empty 200).
			if (page > 1) break;
			throw e;
		}
		if (!tokenHolder.token) {
			const tm = text.match(TOKEN_RE);
			if (tm) tokenHolder.token = tm[0];
		}
		let found = 0;
		PRODUCT_RE.lastIndex = 0;
		let m;
		while ((m = PRODUCT_RE.exec(text)) !== null) {
			found++;
			const name = sanitizeName(decodeJsString(m[2]));
			if (!name) continue;
			rawProducts.push({
				name,
				price: `$${Number(m[1]).toFixed(2)}`,
				sku: m[3],
				productId: Number(m[4]),
			});
		}
		if (found === 0) break;
		page++;
	}
}

function scanCategoryMarquis(slugs) {
	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();
		const rawProducts = [];
		const tokenHolder = { token: "" };
		for (const slug of slugs) {
			await fetchCategorySlug(ctx, slug, rawProducts, tokenHolder);
		}

		if (!tokenHolder.token) throw new Error("marquis: storefront GraphQL token not found in category HTML");

		const ids = [...new Set(rawProducts.map((p) => p.productId))];
		const resolved = await resolveProducts(ctx, tokenHolder.token, ids);

		const discovered = new Map();
		let unresolved = 0;
		for (const p of rawProducts) {
			const meta = resolved.get(p.productId);
			if (!meta) {
				// In the listing but not returned by GraphQL — discontinued/odd.
				// Skip rather than fabricate a broken URL.
				unresolved++;
				continue;
			}
			const prodUrl = `https://${HOST}${meta.path}`;
			const prev = prevDb?.byUrl?.get(prodUrl) || null;

			// Pass raw 7-digit BC-internal sku: it is NOT a CSPC, so it
			// normalizes to a synthetic u: key (no false cross-store merge).
			const skuNorm = normalizeSkuKey(p.sku, { storeLabel: ctx.store.name, url: prodUrl });
			const finalSku = pickBetterSku(skuNorm, prev?.sku || "");

			discovered.set(prodUrl, {
				name: p.name,
				price: p.price || prev?.price || "",
				url: prodUrl,
				sku: finalSku,
				img: meta.img || prev?.img || "",
			});
		}

		ctx.logger.ok(`${ctx.catPrefixOut} | marquis slugs=${slugs.join("+")} kept=${discovered.size}${unresolved ? ` unresolved=${unresolved}` : ""}`);
		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 0 });
	};
}

function createStore(defaultUa) {
	return {
		key: "marquis",
		region: "BC",
		name: "Marquis Wine Cellars",
		host: HOST,
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whisky", label: "Whisky", _scan: scanCategoryMarquis(["single-malt-scotch", "american-whiskey", "other-whiskey"]) },
			{ key: "rum",    label: "Rum",    _scan: scanCategoryMarquis(["rum"]) },
			{ key: "gin",    label: "Gin",    _scan: scanCategoryMarquis(["gin"]) },
		],
	};
}

module.exports = { createStore };
