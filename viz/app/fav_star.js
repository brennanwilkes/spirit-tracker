// favourites.js (or wherever your first snippet lives)
import { esc } from "./dom.js";
import {
	AuthError,
	getAuthStatus,
	getMyFavourites,
	setMyFavourite,
	patchMyFavourites, // <-- add
} from "./cloud.js";
import { loadSkuRules } from "./mapping.js"; // <-- add

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

function setFavStarsForGroup(root, groupSet, on) {
	for (const sku of groupSet) setFavStarsForSku(root, sku, on);
}

function getButtonsForGroup(root, groupSet) {
	const out = new Set();
	for (const sku of groupSet) {
		const key = String(sku || "").trim();
		if (!key) continue;
		const sel = `.favStarBtn[data-sku="${cssEscape(key)}"]`;
		for (const btn of Array.from(root.querySelectorAll(sel))) out.add(btn);
	}
	return Array.from(out);
}

let _rulesPromise = null;
async function getSkuRulesSafe() {
	if (!_rulesPromise) _rulesPromise = loadSkuRules().catch(() => null);
	return await _rulesPromise;
}

function anyFavInGroup(set, groupSet) {
	for (const sku of groupSet) if (set.has(sku)) return true;
	return false;
}

export function installFavStars(root, favSet) {
	const set = favSet instanceof Set ? favSet : new Set();
	const inflight = new Set();

	async function onClick(e) {
		const btn = e.target?.closest?.(".favStarBtn");
		if (!btn || !root.contains(btn)) return;

		e.preventDefault();
		e.stopPropagation();

		const rawSku = String(btn.getAttribute("data-sku") || "").trim();
		if (!rawSku) return;

		const auth = getAuthStatus();
		if (!auth.ok) {
			openLoginNewTab("#/login");
			return;
		}

		const rules = await getSkuRulesSafe();
		const canon = rules ? rules.canonicalSku(rawSku) : rawSku;
		const group = rules ? rules.groupForCanonical(rawSku) : new Set([rawSku]);

		const inflightKey = canon || rawSku;
		if (inflight.has(inflightKey)) return;
		inflight.add(inflightKey);

		const beforeOn = anyFavInGroup(set, group) || set.has(canon);
		const desired = !beforeOn;

		const btns = getButtonsForGroup(root, group);
		for (const b of btns) {
			b.classList.add("favBusy");
			b.disabled = true;
		}

		try {
			if (desired) {
				// store canon on "add" to avoid duplicates
				await setMyFavourite(canon, true);
				set.add(canon);
				// optional cleanup of legacy mapped keys in local set
				for (const s of group) if (s !== canon) set.delete(s);
			} else {
				// IMPORTANT: remove *all mapped SKUs* (and canon) together
				const boolMap = {};
				for (const s of group) boolMap[s] = false;
				boolMap[canon] = false;
				await patchMyFavourites(boolMap);

				for (const s of group) set.delete(s);
				set.delete(canon);
			}

			setFavStarsForGroup(root, group, desired);
		} catch (err) {
			if (err && (err.name === "AuthError" || err instanceof AuthError)) {
				openLoginNewTab("#/login");
			}
			// revert UI to prior state for whole group
			setFavStarsForGroup(root, group, beforeOn);
		} finally {
			for (const b of btns) {
				b.classList.remove("favBusy");
				b.disabled = false;
			}
			inflight.delete(inflightKey);
		}
	}

	root.addEventListener("click", onClick);
}
