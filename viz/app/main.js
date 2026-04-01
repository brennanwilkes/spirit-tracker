/**
 * Hash routes:
 *   #/                search
 *   #/item/<sku>      detail
 *   #/link            sku linker (local-write only)
 *   #/store/<store>   store page (in-stock only)
 *   #/stats           statistics
 *   #/login           auth
 *   #/signup          auth
 *   #/forgot          password reset request
 *   #/reset?token=... password reset confirm
 *   #/settings        settings
 *   #/shortlists       public shortlists directory
 *   #/stores          stores directory
 */

import { syncStackOnBrowserNav } from "./nav.js";
import { destroyChart } from "./item_page.js";
import { renderSearch } from "./search_page.js";
import { renderItem } from "./item_page.js";
import { renderSkuLinker } from "./linker_page.js";
import { renderStore } from "./store_page.js";
import { renderStats, destroyStatsChart } from "./stats_page.js";
import { renderLogin, renderSignup, renderOauth, renderForgot, renderReset } from "./auth_page.js";
import { renderShortlist } from "./shortlist_page.js";
import { getAuthStatus, getMyDetails } from "./cloud.js";
import { renderSettings } from "./settings_page.js";
import { renderPublicShortlists } from "./public_shortlists_page.js";
import { renderStores } from "./stores_page.js";
import { applyStoredColorScheme, applyColorScheme } from "./theme.js";

// Apply stored theme immediately to prevent FOUC
applyStoredColorScheme();

function parseHashRoute(fullHash) {
	const full = String(fullHash || "#/");

	// OAuth return looks like: "#/oauth#token=...&userId=..."
	// Split on the second '#'
	const secondHashIdx = full.indexOf("#", 1);
	if (secondHashIdx !== -1) {
		const routeHash = full.slice(0, secondHashIdx); // "#/oauth"
		const oauthHash = full.slice(secondHashIdx); // "#token=...&userId=..."
		return { special: { routeHash, paramHash: oauthHash } };
	}

	const frag = full.startsWith("#") ? full.slice(1) : full;
	const pathish = frag && frag !== "" ? frag : "/";

	// Make a fake URL so we can parse "/login?verified=1" inside the hash.
	const u = new URL(pathish.startsWith("/") ? `https://x${pathish}` : `https://x/${pathish}`);
	const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
	const params = {};
	for (const [k, v] of u.searchParams.entries()) params[k] = v;
	return { parts, params };
}

function route() {
	const $app = document.getElementById("app");
	if (!$app) return;

	// always clean up chart when navigating
	destroyChart();
	destroyStatsChart();

	const parsed = parseHashRoute(window.location.hash || "#/");

	// Special double-hash handling (OAuth)
	if (parsed.special) {
		const { routeHash, paramHash } = parsed.special;
		if (routeHash === "#/oauth" && paramHash.startsWith("#token=")) {
			// renderOauth expects window.location.hash to be "#token=..."
			window.location.hash = paramHash;
			return renderOauth($app);
		}
		// fallthrough: treat unknown special as search
		return renderSearch($app);
	}

	const parts = parsed.parts || [];
	const params = parsed.params || {};

	if (parts.length === 0) return renderSearch($app);
	if (parts[0] === "item" && parts[1]) return renderItem($app, decodeURIComponent(parts[1]));
	if (parts[0] === "store" && parts[1]) return renderStore($app, decodeURIComponent(parts[1]));
	if (parts[0] === "link") return renderSkuLinker($app);
	if (parts[0] === "stats") return renderStats($app);
	if (parts[0] === "stores") return renderStores($app);

	if (parts[0] === "login") return renderLogin($app, { flash: params });
	if (parts[0] === "signup") return renderSignup($app, { flash: params });
	if (parts[0] === "forgot") return renderForgot($app, { flash: params });
	if (parts[0] === "reset") return renderReset($app, { token: params.token || "" });
	if (parts[0] === "oauth") return renderOauth($app);
	if (parts[0] === "settings") {
		const a = getAuthStatus();
		if (!a.ok || !a.token) {
			location.hash = "#/login";
			return;
		}
		return renderSettings($app);
	}
	if (parts[0] === "shortlists") return renderPublicShortlists($app);

	if (parts[0] === "shortlist") {
		// Preferred: #/shortlist/<uuid>
		if (parts[1]) return renderShortlist($app, decodeURIComponent(parts[1]));

		// Back-compat: redirect #/shortlist -> #/shortlist/<my uuid>
		const a = getAuthStatus();
		if (a.ok && a.userId) {
			location.hash = `#/shortlist/${encodeURIComponent(a.userId)}`;
			return;
		}

		// Not authed -> login
		location.hash = "#/login";
		return;
	}

	return renderSearch($app);
}

// popstate fires on browser back/forward but NOT on programmatic location.hash changes.
// Use it to detect browser-initiated navigation and keep our sessionStorage nav stack in sync.
let _browserNav = false;
window.addEventListener("popstate", () => { _browserNav = true; });
window.addEventListener("hashchange", (e) => {
	if (_browserNav) {
		_browserNav = false;
		syncStackOnBrowserNav(new URL(e.oldURL).hash);
	}
	route();
});
route();

// Sync color scheme from account in background
(async () => {
	const a = getAuthStatus();
	if (a.ok && a.token) {
		try {
			const d = await getMyDetails();
			if (d && typeof d === "object") applyColorScheme(d.colorScheme ?? null);
		} catch { /* ignore */ }
	}
})();
