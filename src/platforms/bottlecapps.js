// src/platforms/bottlecapps.js
"use strict";

/**
 * Bottlecapps adapter — SKELETON.
 *
 * Bottlecapps is a multi-tenant e-commerce platform used by several Canadian
 * liquor retailers. The exact REST endpoints and payload shape are still
 * unverified — see Plan 2 §2.3 in the platform-expansion plans for the
 * research task that will fill in the API contract.
 *
 * Until then, calling the scanCategory returned from this factory will throw,
 * so accidental wire-up surfaces immediately. The opts shape and the SKU /
 * stock conventions are stubbed in to keep the call site identical to the
 * other platform adapters.
 */

/**
 * createBottlecappsAdapter
 *
 * opts:
 *  - storeId: string (required) — Bottlecapps tenant identifier
 *  - categoryIds: { [kind: string]: number } (required) — maps ctx.cat.kind to API category id
 *  - apiBase: string (default "https://api.bottlecapps.com")
 */
function createBottlecappsAdapter(opts) {
	const {
		storeId = "",
		categoryIds = {},
		apiBase = "https://api.bottlecapps.com",
	} = opts || {};

	if (!storeId) throw new Error("bottlecapps: storeId required");
	if (!categoryIds || typeof categoryIds !== "object") {
		throw new Error("bottlecapps: categoryIds map required");
	}

	return async function scanCategory(ctx, _prevDb, _report) {
		const kind = String(ctx?.cat?.kind || ctx?.cat?.key || "").trim();
		const categoryId = categoryIds[kind];
		if (!Number.isFinite(categoryId)) {
			throw new Error(`bottlecapps: no categoryId for kind=${kind}`);
		}

		throw new Error(
			`bottlecapps adapter not yet implemented — see Plan 2 §2.3 for the API contract research task ` +
				`(store=${storeId} kind=${kind} categoryId=${categoryId} apiBase=${apiBase})`,
		);
	};
}

module.exports = { createBottlecappsAdapter };
