// viz/app/nav.js
// Centralised back-button / navigation helpers.
//
// We rely on the browser's native history stack rather than maintaining our own
// in sessionStorage — every `location.hash = ...` already pushes a real history
// entry, and any custom stack drifts out of sync with browser back/forward.
// `_inAppEntries` counts how many forward navigations our app has made since
// load, so goBack() knows whether history.back() will stay inside the app.

const STATE_KEY = "__stvizIdx";

function readIdx() {
	const s = window.history.state;
	return s && typeof s[STATE_KEY] === "number" ? s[STATE_KEY] : null;
}

function writeIdx(idx) {
	try { window.history.replaceState({ [STATE_KEY]: idx }, ""); } catch {}
}

// Tracks the idx of the entry we last saw. We mirror this onto the current
// history entry's state, so it survives page reloads and stays correct after
// any browser back/forward (we just re-read the entry's idx on popstate).
let _lastIdx = readIdx() ?? 0;
if (readIdx() === null) writeIdx(_lastIdx);

/** Kept for API compatibility — no-op. */
export function saveCurrentRoute() {}

/** Kept for API compatibility — no-op. */
export function syncStackOnBrowserNav() {}

/**
 * Navigate back through browser history if the current entry isn't the first
 * one tagged by our app, otherwise jump to `fallback`.
 */
export function goBack(fallback = "#/") {
	if (_lastIdx > 0) {
		window.history.back();
		return;
	}
	location.hash = fallback;
}

export function navigateTo(hash) {
	if (location.hash === hash) return;
	location.hash = hash;
}

/**
 * Called by main.js after every hashchange that wasn't a browser back/forward.
 * The browser just pushed a fresh history entry whose state is null — tag it
 * with idx = _lastIdx + 1.
 */
export function notifyForwardNav() {
	const existing = readIdx();
	if (existing !== null) {
		_lastIdx = existing;
		return;
	}
	_lastIdx += 1;
	writeIdx(_lastIdx);
}

/**
 * Called by main.js when popstate fired — i.e., the user used browser
 * back/forward. The new current entry already has its idx baked in, so we
 * just refresh _lastIdx from it.
 */
export function notifyBrowserBack() {
	const idx = readIdx();
	_lastIdx = idx === null ? 0 : idx;
	if (idx === null) writeIdx(0);
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
