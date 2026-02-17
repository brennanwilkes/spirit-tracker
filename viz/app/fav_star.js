import { esc } from "./dom.js";
import { AuthError, getAuthStatus, getMyFavourites, setMyFavourite } from "./cloud.js";

function cssEscape(s) {
	const v = String(s ?? "");
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(v);
	return v.replace(/["\\]/g, "\\$&");
}

function makeLoginUrl(loginHash = "#/login") {
	const h = String(loginHash || "#/login");
	const hash = h.startsWith("#") ? h : `#${h}`;
	return `${window.location.pathname}${window.location.search}${hash}`;
}

function openLoginNewTab(loginHash = "#/login") {
	try {
		const url = makeLoginUrl(loginHash);
		const w = window.open(url, "_blank");
		if (w) w.opener = null;
	} catch {}
}

function favSetFromPayload(payload) {
	if (!payload) return new Set();

	if (Array.isArray(payload)) {
		return new Set(payload.filter((x) => typeof x === "string" && x.length));
	}

	if (typeof payload === "object") {
		if (Array.isArray(payload.items)) {
			return new Set(payload.items.filter((x) => typeof x === "string" && x.length));
		}
		const out = new Set();
		for (const [k, v] of Object.entries(payload)) {
			if (v === true) out.add(String(k));
		}
		return out;
	}

	return new Set();
}

export async function loadMyFavouritesSet() {
	const s = getAuthStatus();
	if (!s.ok) return { set: new Set(), authed: false };

	try {
		const j = await getMyFavourites();
		return { set: favSetFromPayload(j), authed: true };
	} catch (e) {
		if (e && e.name === "AuthError") return { set: new Set(), authed: false };
		return { set: new Set(), authed: false };
	}
}

export function favStarHtml(sku, on, { cls = "" } = {}) {
	const key = String(sku || "").trim();
	if (!key) return "";
	const isOn = !!on;

	return `
	<button
		type="button"
		class="favStarBtn ${isOn ? "favOn" : "favOff"} ${cls}"
		data-sku="${esc(key)}"
		aria-pressed="${isOn ? "true" : "false"}"
	>
		<span class="favStarIcon">${isOn ? "★" : "☆"}</span>
	</button>
	`;
}

export function setFavStarEl(btn, on) {
	if (!btn) return;
	const isOn = !!on;
	btn.classList.toggle("favOn", isOn);
	btn.classList.toggle("favOff", !isOn);
	btn.setAttribute("aria-pressed", isOn ? "true" : "false");
	const icon = btn.querySelector(".favStarIcon");
	if (icon) icon.textContent = isOn ? "★" : "☆";
}

export function setFavStarsForSku(root, sku, on) {
	const key = String(sku || "").trim();
	if (!key) return;
	const sel = `.favStarBtn[data-sku="${cssEscape(key)}"]`;
	for (const btn of Array.from(root.querySelectorAll(sel))) {
		setFavStarEl(btn, on);
	}
}

export function installFavStars(root, favSet) {
	const set = favSet instanceof Set ? favSet : new Set();
	const inflight = new Set();

	async function onClick(e) {
		const btn = e.target?.closest?.(".favStarBtn");
		if (!btn || !root.contains(btn)) return;

		e.preventDefault();
		e.stopPropagation();

		const sku = String(btn.getAttribute("data-sku") || "").trim();
		if (!sku) return;

		const auth = getAuthStatus();
		if (!auth.ok) {
			openLoginNewTab("#/login");
			return;
		}

		if (inflight.has(sku)) return;
		inflight.add(sku);

		const currentlyOn = btn.classList.contains("favOn");
		const desired = !currentlyOn;

		btn.classList.add("favBusy");
		btn.disabled = true;

		try {
			await setMyFavourite(sku, desired);
			if (desired) set.add(sku);
			else set.delete(sku);
			setFavStarsForSku(root, sku, desired);
		} catch (err) {
			if (err && (err.name === "AuthError" || err instanceof AuthError)) {
				openLoginNewTab("#/login");
			}
			setFavStarEl(btn, set.has(sku));
		} finally {
			btn.classList.remove("favBusy");
			btn.disabled = false;
			inflight.delete(sku);
		}
	}

	root.addEventListener("click", onClick);
}
