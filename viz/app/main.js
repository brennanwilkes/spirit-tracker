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

function rewriteOauthHashToRoute() {
	const h = window.location.hash || "";

	// Backend sends: #token=...&userId=...
	// Your router expects: #/oauth  (and renderOauth reads window.location.hash)
	if (!h || h === "#") return false;

	const params = new URLSearchParams(h.startsWith("#") ? h.slice(1) : h);
	if (!params.get("token")) return false;

	// Put the token back into the hash exactly how renderOauth expects it (#token=...)
	// but make the router route be /oauth by setting the path in the URL (pathname) OR by switching to #/oauth first.
	//
	// We can do this by moving the token into sessionStorage and navigating to #/oauth,
	// then restore window.location.hash to #token=... just before calling renderOauth.
	// Simpler: stash token, route to #/oauth, then put it back and render.
	sessionStorage.setItem("viz:oauthHash", h);

	// Go to the oauth route; hashchange will fire route()
	window.location.replace("#/oauth");
	return true;
}

function restoreOauthHashIfNeeded() {
	// When we arrive at #/oauth, restore the original #token=... hash temporarily
	// so renderOauth() sees it and consumes it.
	if ((window.location.hash || "") !== "#/oauth") return;

	const saved = sessionStorage.getItem("viz:oauthHash");
	if (!saved) return;

	sessionStorage.removeItem("viz:oauthHash");
	window.location.hash = saved; // sets hash to #token=...&userId=...
	// route() will run again via hashchange; it will not loop because saved is removed.
}

function route() {
	const $app = document.getElementById("app");
	if (!$app) return;

	// 1) If we just got redirected from the backend with #token=..., rewrite to #/oauth
	if (rewriteOauthHashToRoute()) return;

	// 2) If we are on #/oauth but need to restore #token=... so renderOauth can read it
	restoreOauthHashIfNeeded();

	// always clean up chart when navigating
	destroyChart();
	destroyStatsChart();

	const h = location.hash || "#/";
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
