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
		// iOS Safari only applies :active (the tab's pressed state) when a touchstart
		// listener exists on the element or an ancestor.
		$nav.addEventListener("touchstart", () => {}, { passive: true });

		/* A touched tab navigates on touch-up, like a native tab bar, not on the click iOS
		 * synthesizes afterwards. iOS withholds that click while the page is still adding
		 * content (the shortlist's chunked render) or still momentum-scrolling, so the first
		 * tap did nothing. A drag past 10px or a pan (pointercancel) is not a tap. */
		let down = null;
		let tapped = false;
		$nav.addEventListener("pointerdown", (e) => {
			tapped = false;
			down = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY, $a: e.target.closest(".bottomNavItem") } : null;
		});
		$nav.addEventListener("pointercancel", () => { down = null; });
		$nav.addEventListener("pointerup", (e) => {
			const d = down;
			down = null;
			if (d === null || d.$a === null || !d.$a.isConnected) return;
			if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
			tapped = true;
			const href = d.$a.getAttribute("href");
			if (location.hash === href) window.scrollTo({ top: 0, behavior: "smooth" }); // native: re-tap the tab = top
			else location.hash = href;
		});
		// The late click would re-navigate to the same hash, which REPLACES the history entry and
		// drops its state (main.js keys kept pages by it).
		$nav.addEventListener("click", (e) => {
			if (!tapped) return;
			tapped = false;
			e.preventDefault();
		});
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
