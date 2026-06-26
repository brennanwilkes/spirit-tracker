// viz/app/components/store_set_selector.js
// Shared "store set" selector: preset chips (All / regions / cities / My Stores)
// plus an ad-hoc multi-select of individual stores. Mirrors the spirit-filter
// dropdown pattern. Used by the search page and the store page.

import { esc } from "../dom.js";
import { STORES, storesByRegion } from "../stores.js";
import {
	builtInPresets,
	resolveStoreSet,
	serializeStoreSet,
	storeSetLabel,
	sameStoreSet,
} from "../store_set.js";

const REGION_ORDER = [
	{ region: "bc", label: "BC" },
	{ region: "ab", label: "Alberta" },
];

export function storeSetSelectorHtml() {
	const groups = REGION_ORDER.map(({ region, label }) => {
		const rows = storesByRegion(region)
			.map(
				(s) => `
				<label class="storeSetOption">
					<input type="checkbox" value="${esc(s.id)}">
					<span class="storeSetCheck"></span>
					<span class="storeSetOptionLabel">${esc(s.label)}</span>
				</label>`,
			)
			.join("");
		return `
			<div class="storeSetGroup">
				<div class="storeSetGroupLabel">${esc(label)}</div>
				${rows}
			</div>`;
	}).join("");

	return `
		<div class="storeSet" id="storeSet">
			<button class="selectSmall storeSetTrigger" id="storeSetTrigger"
			        type="button" aria-haspopup="dialog" aria-expanded="false">
				<i class="fa-solid fa-store" aria-hidden="true"></i>
				<span id="storeSetLabel">All stores</span>
			</button>
			<div class="storeSetPanel" id="storeSetPanel" hidden role="dialog" aria-label="Filter by store">
				<div class="storeSetPresets" id="storeSetPresets"></div>
				<div class="storeSetListWrap">${groups}</div>
				<div class="storeSetActions">
					<span class="small" id="storeSetCount"></span>
					<button class="btn btnSm" id="storeSetClear" type="button">All stores</button>
				</div>
			</div>
		</div>`;
}

/**
 * Wire up the selector.
 *
 * @param {object}   params
 * @param {Element}  params.$container   - root .storeSet element
 * @param {object}   params.spec         - initial store-set spec (mutated? no — tracked internally)
 * @param {string[]} [params.myStores]   - signed-in user's saved store ids (enables "My Stores")
 * @param {boolean}  [params.authed]     - whether a user is signed in
 * @param {Function} params.onChange     - called with the new spec after any change
 * @returns {{ getSpec, setSpec }}
 */
export function installStoreSetSelector({ $container, spec, myStores = null, authed = false, onChange }) {
	let current = spec || { kind: "all" };

	const $trigger = $container.querySelector("#storeSetTrigger");
	const $label = $container.querySelector("#storeSetLabel");
	const $panel = $container.querySelector("#storeSetPanel");
	const $presets = $container.querySelector("#storeSetPresets");
	const $clear = $container.querySelector("#storeSetClear");
	const $count = $container.querySelector("#storeSetCount");
	const checkboxes = [...$panel.querySelectorAll('input[type="checkbox"]')];

	// Build preset chips (My Stores only when signed in with a non-empty saved set)
	const presets = builtInPresets();
	if (authed && Array.isArray(myStores) && myStores.length) {
		presets.push({ spec: { kind: "mine" }, label: "My Stores" });
	}
	$presets.innerHTML = presets
		.map(
			(p, i) =>
				`<button class="pillBtn storeSetPreset" type="button" data-preset="${i}">${esc(p.label)}</button>`,
		)
		.join("");
	const presetBtns = [...$presets.querySelectorAll(".storeSetPreset")];

	function resolvedIds() {
		return resolveStoreSet(current, { myStores });
	}

	function syncUI() {
		$label.textContent = storeSetLabel(current);
		$trigger.classList.toggle("is-active", current.kind !== "all");

		const ids = resolvedIds(); // Set | null (null = all)
		for (const cb of checkboxes) {
			cb.checked = ids ? ids.has(cb.value) : false;
		}

		for (let i = 0; i < presetBtns.length; i++) {
			presetBtns[i].classList.toggle("isOn", sameStoreSet(current, presets[i].spec));
		}

		const n = ids ? ids.size : STORES.length;
		$count.textContent = current.kind === "all" ? `${STORES.length} stores` : `${n} selected`;
	}

	function commit(next) {
		current = next;
		syncUI();
		onChange?.(current);
	}

	function specFromCheckboxes() {
		const ids = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
		if (!ids.length) return { kind: "all" };
		// Match a preset for a nicer label when the checked set equals one exactly.
		for (const p of presets) {
			const r = resolveStoreSet(p.spec, { myStores });
			if (r && r.size === ids.length && ids.every((id) => r.has(id))) return p.spec;
		}
		return { kind: "stores", ids };
	}

	function close() {
		$panel.hidden = true;
		$trigger.classList.remove("is-open");
		$trigger.setAttribute("aria-expanded", "false");
	}

	$trigger.addEventListener("click", (e) => {
		e.stopPropagation();
		const opening = $panel.hidden;
		$panel.hidden = !opening;
		$trigger.classList.toggle("is-open", opening);
		$trigger.setAttribute("aria-expanded", String(opening));
	});

	document.addEventListener("click", (e) => {
		if (!$container.contains(e.target)) close();
	});

	$panel.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			close();
			$trigger.focus();
		}
	});

	$presets.addEventListener("click", (e) => {
		const btn = e.target.closest(".storeSetPreset");
		if (!btn) return;
		const i = Number(btn.getAttribute("data-preset"));
		if (!Number.isInteger(i) || !presets[i]) return;
		commit(presets[i].spec);
	});

	$panel.addEventListener("change", (e) => {
		if (e.target?.type !== "checkbox") return;
		commit(specFromCheckboxes());
	});

	$clear.addEventListener("click", () => commit({ kind: "all" }));

	syncUI();

	return {
		getSpec: () => current,
		setSpec: (next) => commit(next || { kind: "all" }),
	};
}
