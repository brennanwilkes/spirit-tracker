import { esc } from "../dom.js";

/**
 * Pill toggle switch.
 *
 * @param {string}   id      - unique id for the toggle (used for data-toggle-id)
 * @param {string}   label   - display label
 * @param {boolean}  isOn    - initial state
 * @returns {string} HTML string
 */
export function toggleHtml(id, label, isOn) {
	return `
<label class="toggleWrap" data-toggle-id="${esc(id)}">
  <span>${esc(label)}</span>
  <div class="toggleKnob${isOn ? " toggleOn" : ""}"></div>
</label>`;
}

/**
 * Attach click handler to a toggle element.
 *
 * @param {HTMLElement} el         - element with data-toggle-id, or a parent containing toggles
 * @param {function}    onChange   - called with (id, isOn) when a toggle is clicked
 */
export function toggleInstall(el, onChange) {
	el.addEventListener("click", (e) => {
		const wrap = e.target.closest("[data-toggle-id]");
		if (!wrap) return;
		const id = wrap.getAttribute("data-toggle-id");
		const knob = wrap.querySelector(".toggleKnob");
		if (!knob) return;
		const nowOn = !knob.classList.contains("toggleOn");
		knob.classList.toggle("toggleOn", nowOn);
		onChange?.(id, nowOn);
	});
}
