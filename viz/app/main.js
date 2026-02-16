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

function normalizeOauthHash() {
	const h = location.hash || "";

	// Backend sends: #token=...&userId=...
	if (h.startsWith("#token=") || h.includes("&token=") || h.includes("?token=")) {
		const qs = h.startsWith("#") ? h.slice(1) : h; // "token=...&userId=..."
		// Replace so router sees the oauth route
		location.replace(`#/oauth?${qs}`);
		return true;
	}
	return false;
}

function route() {
	const $app = document.getElementById("app");
	if (!$app) return;

	// If we just arrived from OAuth, rewrite the hash and bail;
	// the hashchange will re-run route().
	if (normalizeOauthHash()) return;

	// always clean up chart when navigating
	destroyChart();
	destroyStatsChart();

	const h = location.hash || "#/";
	const [pathPart, queryPart = ""] = h.replace(/^#\/?/, "").split("?", 2);
	const parts = pathPart.split("/").filter(Boolean);
	const query = new URLSearchParams(queryPart);

	if (parts.length === 0) return renderSearch($app);
	if (parts[0] === "item" && parts[1]) return renderItem($app, decodeURIComponent(parts[1]));
	if (parts[0] === "store" && parts[1]) return renderStore($app, decodeURIComponent(parts[1]));
	if (parts[0] === "link") return renderSkuLinker($app);
	if (parts[0] === "stats") return renderStats($app);
	if (parts[0] === "login") return renderLogin($app);
	if (parts[0] === "signup") return renderSignup($app);
	if (parts[0] === "oauth") return renderOauth($app, query);

	return renderSearch($app);
}

window.addEventListener("hashchange", route);
route();
