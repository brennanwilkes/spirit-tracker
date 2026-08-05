import { esc } from "../dom.js";
import { getAuthStatus } from "../cloud.js";

/**
 * Bottom tab bar (phones, small windows, all touch devices — visibility is
 * CSS-driven, see style.css §12/§14). Rendered as a <nav> sibling of #app so
 * page re-renders never destroy it; call on every route() to refresh the
 * active tab and the auth-dependent shortlist target.
 */
export function renderBottomNav() {
	const auth = getAuthStatus();
	const shortlistHref = auth.ok
		? `#/shortlist/${encodeURIComponent(auth.userId)}`
		: "#/shortlists";

	const tabs = [
		{ key: "search", href: "#/", icon: "fa-magnifying-glass", label: "Search" },
		{ key: "stores", href: "#/stores", icon: "fa-store", label: "Stores" },
		{ key: "stats", href: "#/stats", icon: "fa-chart-line", label: "Stats" },
		{ key: "shortlist", href: shortlistHref, icon: "fa-list-check", label: "Shortlist" },
		{ key: "settings", href: "#/settings", icon: "fa-gear", label: "Settings" },
	];

	let $nav = document.getElementById("bottomNav");
	if (!$nav) {
		$nav = document.createElement("nav");
		$nav.id = "bottomNav";
		$nav.className = "bottomNav";
		$nav.setAttribute("aria-label", "Primary");
		document.body.appendChild($nav);
	}

	const active = activeTabKey();
	$nav.innerHTML = tabs
		.map(
			(t) => `
		<a class="bottomNavItem${t.key === active ? " isActive" : ""}" href="${esc(t.href)}"${t.key === active ? ` aria-current="page"` : ""}>
			<i class="fa-solid ${esc(t.icon)}" aria-hidden="true"></i>
			<span>${esc(t.label)}</span>
		</a>`,
		)
		.join("");
}

function activeTabKey() {
	const frag = String(window.location.hash || "#/").slice(1);
	const first = frag.replace(/^\/+/, "").split(/[/?#]/)[0] || "";
	if (first === "" || first === "item") return "search";
	if (first === "store" || first === "stores") return "stores";
	if (first === "stats") return "stats";
	if (first === "shortlist" || first === "shortlists") return "shortlist";
	if (["settings", "login", "signup", "forgot", "reset", "oauth"].includes(first)) return "settings";
	return "";
}
