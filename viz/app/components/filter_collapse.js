// Collapsible filter block — shared by the search / store / shortlist pages.
//
// FORM-FACTOR CONTRACT (the whole point of this component):
//   phone   (<=640px) — collapsed by default, toggled by the button. Filters are
//                       the tallest non-content block on a phone; stacking their
//                       labels made that worse, so they start out of the way.
//   tablet + desktop  — ALWAYS expanded, toggle button hidden. There is room for
//                       them, and hiding filters behind a tap on a device that
//                       can show them is a regression, not a feature.
//
// Deliberately NOT a <details>: a closed <details> hides its content at the UA
// level in a way author CSS can't reliably reverse, so the "always open on
// desktop" half of the contract would depend on JS running. Here the desktop
// state is pure CSS — if the script never runs, filters are visible everywhere,
// which is the safe failure.
//
// Collapsed state is per-page and remembered, so someone who opens filters and
// keeps browsing doesn't have to reopen them on every render.

import { esc } from "../dom.js";

const KEY_PREFIX = "viz:filtersOpen:";

/**
 * Markup for the toggle. Render immediately before the filter container.
 * @param {string} [label]  button text when nothing is summarised
 */
export function filterToggleHtml(label = "Filters") {
	return `
<button class="filterToggle" type="button" aria-expanded="false">
  <span class="filterToggleLabel">${esc(label)}</span>
  <span class="filterToggleSummary"></span>
  <span class="filterToggleChevron" aria-hidden="true">▾</span>
</button>`;
}

/**
 * @param {object}   opts
 * @param {Element}  opts.$toggle     the .filterToggle button
 * @param {Element}  opts.$panel      the filter container to show/hide
 * @param {string}   opts.pageKey     storage key suffix, e.g. "search"
 * @param {Function} [opts.summarize] () => string — compact active-filter text
 *                   shown on the button while collapsed. Without it the button
 *                   reads just "Filters", which hides what is currently applied,
 *                   so pass one wherever the state isn't obvious from results.
 */
export function installFilterCollapse({ $toggle, $panel, pageKey, summarize }) {
	if (!$toggle || !$panel) return { refresh() {} };

	const storeKey = KEY_PREFIX + pageKey;
	let open = false;
	try {
		open = localStorage.getItem(storeKey) === "1";
	} catch {}

	const $summary = $toggle.querySelector(".filterToggleSummary");

	function apply() {
		$panel.classList.toggle("filtersCollapsed", !open);
		$toggle.classList.toggle("isOpen", open);
		$toggle.setAttribute("aria-expanded", open ? "true" : "false");
		refreshSummary();
	}

	function refreshSummary() {
		if (!$summary) return;
		// The summary only earns its space while the panel is shut.
		$summary.textContent = !open && typeof summarize === "function" ? summarize() : "";
	}

	$toggle.addEventListener("click", () => {
		open = !open;
		try {
			localStorage.setItem(storeKey, open ? "1" : "0");
		} catch {}
		apply();
	});

	apply();

	return { refresh: refreshSummary };
}
