/**
 * Hash routes:
 *   #/                search
 *   #/item/<sku>      detail
 *   #/link            sku linker (local-write only)
 *   #/store/<store>   store page (in-stock only)
 *   #/stats           statistics
 */

import { destroyChart } from "./item_page.js";
import { renderSearch } from "./search_page.js";
import { renderItem } from "./item_page.js";
import { renderSkuLinker } from "./linker_page.js";
import { renderStore } from "./store_page.js";
import { renderStats, destroyStatsChart } from "./stats_page.js";
import { renderLogin, renderSignup, renderOauth } from "./auth_page.js";

function route() {
	const $app = document.getElementById("app");
	if (!$app) return;

	// always clean up chart when navigating
	destroyChart();
	destroyStatsChart();

	const full = window.location.hash || "#/";

	// OAuth return looks like: "#/oauth#token=...&userId=..."
	// Split on the second '#'
	const secondHashIdx = full.indexOf("#", 1);
	if (secondHashIdx !== -1) {
		const routeHash = full.slice(0, secondHashIdx); // "#/oauth"
		const oauthHash = full.slice(secondHashIdx);    // "#token=...&userId=..."

		if (routeHash === "#/oauth" && oauthHash.startsWith("#token=")) {
			// renderOauth expects window.location.hash to be "#token=..."
			// Temporarily swap it, render, then let renderOauth clearHash + redirect.
			window.location.hash = oauthHash;
			return renderOauth($app);
		}
	}

	const h = full || "#/";
	const parts = h.replace(/^#\/?/, "").split("/").filter(Boolean);

	if (parts.length === 0) return renderSearch($app);
	if (parts[0] === "item" && parts[1]) return renderItem($app, decodeURIComponent(parts[1]));
	if (parts[0] === "store" && parts[1]) return renderStore($app, decodeURIComponent(parts[1]));
	if (parts[0] === "link") return renderSkuLinker($app);
	if (parts[0] === "stats") return renderStats($app);
	if (parts[0] === "login") return renderLogin($app);
	if (parts[0] === "signup") return renderSignup($app);
	if (parts[0] === "oauth") return renderOauth($app);

	return renderSearch($app);
}

window.addEventListener("hashchange", route);
route();
