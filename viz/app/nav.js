// viz/app/nav.js
// The browser already maintains a correct history stack for every
// `location.hash = …` and `<a href="#/…">` click. Don't reinvent it —
// just delegate to window.history.back(). If there's no prior entry,
// the browser silently does nothing, which is a fine "no-op" for the
// edge case of a direct-URL page load.

/** Kept for API compatibility — no-op. */
export function saveCurrentRoute() {}
/** Kept for API compatibility — no-op. */
export function syncStackOnBrowserNav() {}
/** Kept for API compatibility — no-op. */
export function notifyForwardNav() {}
/** Kept for API compatibility — no-op. */
export function notifyBrowserBack() {}

export function goBack(_fallback = "#/") {
	window.history.back();
}

export function navigateTo(hash) {
	if (location.hash === hash) return;
	location.hash = hash;
}

export function peekBack(fallback = "#/") {
	return fallback;
}

export function openOrNavigateTo(e, hash) {
	if (e.ctrlKey || e.metaKey || e.shiftKey) {
		window.open(location.href.replace(/#.*/, "") + hash);
		return;
	}
	navigateTo(hash);
}
