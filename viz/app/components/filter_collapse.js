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
// Collapsed state is deliberately NOT persisted: every page load and every
// route change starts collapsed. A filter panel left open from an earlier visit
// pushes the results off a phone screen before you have asked for it, so the
// open state lives only as long as the render that opened it.

import { esc } from "../dom.js";

/**
 * Markup for the toggle. Render immediately before the filter container.
 * @param {string} [label]  button text when nothing is summarised
 */
export function filterToggleHtml(label = "Filters") {
	return `
<button class="filterToggle" type="button" aria-expanded="false">
  <i class="fa-solid fa-sliders filterToggleIcon" aria-hidden="true"></i>
  <span class="filterToggleLabel">${esc(label)}</span>
  <span class="filterToggleSummary"></span>
  <span class="filterToggleChevron" aria-hidden="true">
    <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
  </span>
</button>`;
}

/**
 * @param {object}   opts
 * @param {Element}  opts.$toggle     the .filterToggle button
 * @param {Element}  opts.$panel      the filter container to show/hide
 * @param {Function} [opts.summarize] () => string — compact active-filter text
 *                   shown on the button while collapsed. Without it the button
 *                   reads just "Filters", which hides what is currently applied,
 *                   so pass one wherever the state isn't obvious from results.
 */
export function installFilterCollapse({ $toggle, $panel, summarize }) {
	if (!$toggle || !$panel) return { refresh() {} };

	let open = false;

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
		apply();
	});

	apply();

	return { refresh: refreshSummary };
}
