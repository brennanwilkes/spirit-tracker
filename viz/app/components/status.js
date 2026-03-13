/**
 * Shared loading, empty, and spinner state helpers.
 * Use these instead of inline one-off div patterns.
 */

export function loadingHtml(msg = "Loading\u2026") {
	return `<div class="small muted">${msg}</div>`;
}

export function emptyHtml(msg = "No results.") {
	return `<div class="small muted">${msg}</div>`;
}

/**
 * Animated spinner button (e.g. for auth flows).
 * Renders a <button> with a CSS spin icon while work is in progress.
 */
export function spinnerBtnHtml(label = "Working\u2026") {
	return `<button class="btn btnWide" disabled><i class="fa fa-spinner fa-spin"></i> ${label}</button>`;
}
