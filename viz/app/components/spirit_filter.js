// viz/app/components/spirit_filter.js
// Shared spirit-type multi-select dropdown component.
// Used on search, store, and shortlist pages.

import { esc } from "../dom.js";
import { SPIRIT_TYPE_LIST } from "../spirit_types.js";

/**
 * Render the spirit type multi-select dropdown HTML.
 * Wire up behavior with installSpiritFilter() after inserting into the DOM.
 *
 * @param {object} [ids]
 * @param {string} [ids.containerId="spiritFilter"]
 * @param {string} [ids.triggerId="spiritFilterTrigger"]
 * @param {string} [ids.panelId="spiritFilterPanel"]
 * @param {string} [ids.labelId="spiritFilterLabel"]
 * @returns {string} HTML string
 */
export function spiritFilterHtml({
	containerId = "spiritFilter",
	triggerId   = "spiritFilterTrigger",
	panelId     = "spiritFilterPanel",
	labelId     = "spiritFilterLabel",
} = {}) {
	const opts = SPIRIT_TYPE_LIST.map(({ id, label }) => `
		<label class="spiritFilterOption">
			<input type="checkbox" value="${esc(id)}">
			<span class="spiritFilterCheck"></span>
			<span>${esc(label)}</span>
		</label>`).join("");

	return `
		<div class="spiritFilter" id="${containerId}">
			<button class="selectSmall spiritFilterTrigger" id="${triggerId}"
			        type="button" aria-haspopup="listbox" aria-expanded="false">
				<span id="${labelId}">All types</span>
			</button>
			<div class="spiritFilterPanel" id="${panelId}"
			     hidden role="listbox" aria-multiselectable="true">
				${opts}
			</div>
		</div>`;
}

/**
 * Attach open/close and checkbox behavior to a rendered spirit filter component.
 *
 * @param {object} params
 * @param {Element}  params.$container  - root .spiritFilter element
 * @param {Element}  params.$trigger    - the trigger <button>
 * @param {Element}  params.$panel      - the dropdown panel
 * @param {Element}  params.$label      - display <span> inside the trigger
 * @param {Set}      params.selectedSet - mutable Set<string> (modified in-place)
 * @param {Function} params.onChange    - called after any selection change
 */
export function installSpiritFilter({ $container, $trigger, $panel, $label, selectedSet, onChange }) {
	// Restore checkboxes to match current selectedSet
	for (const cb of $panel.querySelectorAll('input[type="checkbox"]')) {
		cb.checked = selectedSet.has(cb.value);
	}
	syncLabel();

	function syncLabel() {
		const checked = [...$panel.querySelectorAll('input[type="checkbox"]:checked')];
		if (!checked.length) {
			$label.textContent = "All types";
			$trigger.classList.remove("is-active");
			return;
		}
		const names = checked.map((cb) => {
			const spans = cb.closest(".spiritFilterOption")?.querySelectorAll("span");
			return spans && spans.length >= 2 ? (spans[1].textContent || cb.value) : cb.value;
		});
		$label.textContent = names.length <= 2 ? names.join(", ") : `${names.length} types`;
		$trigger.classList.add("is-active");
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
		if (e.key === "Escape") { close(); $trigger.focus(); }
	});

	$panel.addEventListener("change", (e) => {
		const cb = e.target;
		if (cb.type !== "checkbox") return;
		if (cb.checked) selectedSet.add(cb.value);
		else selectedSet.delete(cb.value);
		syncLabel();
		onChange();
	});
}
