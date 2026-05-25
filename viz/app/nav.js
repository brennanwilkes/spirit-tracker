// viz/app/nav.js
// The browser already maintains a correct history stack for every
// `location.hash = …` and `<a href="#/…">` click. Don't reinvent it —
// just delegate to window.history.back(). If there's no prior entry
// (direct URL load), fall back to the home route.

/** Kept for API compatibility — no-op. */
export function saveCurrentRoute() {}
/** Kept for API compatibility — no-op. */
export function syncStackOnBrowserNav() {}
/** Kept for API compatibility — no-op. */
export function notifyForwardNav() {}
/** Kept for API compatibility — no-op. */
export function notifyBrowserBack() {}

export function goBack(fallback = "#/") {
	// history.back() has no return value and silently no-ops when there's
	// nothing to go back to (e.g. direct URL load). Listen for a popstate
	// event; if none fires within 150ms, we're at the top of the stack.
	const onPop = () => {
		clearTimeout(timer);
		window.removeEventListener("popstate", onPop);
	};
	const timer = setTimeout(() => {
		window.removeEventListener("popstate", onPop);
		location.hash = fallback;
	}, 150);
	window.addEventListener("popstate", onPop);
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
