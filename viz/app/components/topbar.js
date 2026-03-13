import { esc } from "../dom.js";

/**
 * Standard page topbar.
 *
 * @param {object} opts
 * @param {string} [opts.backHref="#/"]     - href for the back button (falsy = no back button)
 * @param {string} [opts.title=""]          - plain-text title shown as .h1
 * @param {string} [opts.titleBadge=""]     - plain-text badge shown next to title
 * @param {string} [opts.rightHtml=""]      - raw HTML inserted at the far right
 * @returns {string} HTML string
 */
export function topbarHtml({ backHref = "#/", title = "", titleBadge = "", rightHtml = "" } = {}) {
	const back = backHref
		? `<a href="${esc(backHref)}" class="btn btnSm">\u2190 Back</a>`
		: "";

	const titlePart = title
		? `<div class="h1" style="margin:0;">${esc(title)}</div>`
		: "";

	const badgePart = titleBadge
		? `<span class="badge">${esc(titleBadge)}</span>`
		: "";

	const right = rightHtml
		? `<div style="margin-left:auto;">${rightHtml}</div>`
		: "";

	return `<div class="topbar">${back}${titlePart}${badgePart}${right}</div>`;
}
