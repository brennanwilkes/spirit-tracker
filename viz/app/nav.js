// viz/app/nav.js
// Centralised back-button / navigation helpers.
//
// We rely on the browser's native history stack rather than maintaining our own
// in sessionStorage — every `location.hash = ...` already pushes a real history
// entry, and any custom stack drifts out of sync with browser back/forward.
// `_inAppEntries` counts how many forward navigations our app has made since
// load, so goBack() knows whether history.back() will stay inside the app.

let _inAppEntries = 0;

/** Save the current hash so goBack() can return here. Kept for API compatibility — no-op. */
export function saveCurrentRoute() {}

/** Kept for API compatibility — no-op. */
export function syncStackOnBrowserNav() {}

/**
 * Navigate back through the browser's native history if we have an in-app
 * forward navigation to undo, otherwise jump to `fallback`.
 */
export function goBack(fallback = "#/") {
	if (_inAppEntries > 0) {
		// Don't decrement here — history.back() fires popstate + hashchange,
		// which routes through notifyBrowserBack() and does the decrement.
		window.history.back();
		return;
	}
	location.hash = fallback;
}

/**
 * Navigate to `hash`. Records that we've pushed a real browser history entry
 * so goBack() knows it can use history.back().
 */
export function navigateTo(hash) {
	if (location.hash === hash) return;
	// Don't increment here — main.js's hashchange listener calls notifyForwardNav
	// for every non-browser-back hash change, including this one. Incrementing
	// here too would double-count.
	location.hash = hash;
}

/**
 * Called by main.js for every hashchange that wasn't triggered by browser
 * back/forward — that means a forward navigation that pushed a new history
 * entry, whether via navigateTo() or via an `<a href="#/...">` click.
 */
export function notifyForwardNav() {
	_inAppEntries++;
}

/**
 * Called by main.js when the browser's back/forward buttons cause a hashchange.
 * Decrement our forward counter so we don't try to history.back() into entries
 * the user has already reversed.
 */
export function notifyBrowserBack() {
	if (_inAppEntries > 0) _inAppEntries--;
}

/**
 * Return the hash that goBack() would navigate to. With the history-based
 * approach we don't know the actual target without inspecting history.state,
 * so just return the fallback — the back button's href is only used for
 * Ctrl+click "open in new tab".
 */
export function peekBack(fallback = "#/") {
	return fallback;
}

/**
 * Navigate to `hash`, but if a modifier key (Ctrl/Meta/Shift) is held, open
 * in a new tab instead. Pass the originating click event as `e`.
 */
export function openOrNavigateTo(e, hash) {
	if (e.ctrlKey || e.metaKey || e.shiftKey) {
		window.open(location.href.replace(/#.*/, "") + hash);
		return;
	}
	navigateTo(hash);
}
