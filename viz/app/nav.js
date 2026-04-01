// viz/app/nav.js
// Centralised back-button / navigation helpers.
// All pages should use these instead of touching sessionStorage directly.

const STACK_KEY = "viz:navStack";

function getStack() {
	try { return JSON.parse(sessionStorage.getItem(STACK_KEY) || "[]"); }
	catch { return []; }
}
function setStack(arr) {
	sessionStorage.setItem(STACK_KEY, JSON.stringify(arr));
}

/** Save the current hash so goBack() can return here. */
export function saveCurrentRoute() {
	const stack = getStack();
	stack.push(location.hash);
	setStack(stack);
}

/**
 * Navigate back to wherever saveCurrentRoute() was last called, or to
 * `fallback` (default "#/") if no saved route exists.
 * Skips stale entries that match the current hash (can happen when the
 * browser's native back button was used before this is called).
 */
export function goBack(fallback = "#/") {
	const stack = getStack();
	let prev = stack.pop();
	setStack(stack);
	// Skip entries that are already the current page (stale from browser back).
	while (prev === location.hash && stack.length > 0) {
		prev = stack.pop();
		setStack(stack);
	}
	location.hash = (prev && prev !== location.hash) ? prev : fallback;
}

/**
 * Called by main.js when a browser-initiated hashchange is detected (via
 * popstate). Pops the top of the stack if it matches the hash we just left,
 * keeping our custom stack in sync with browser history.
 */
export function syncStackOnBrowserNav(oldHash) {
	const stack = getStack();
	if (stack.length > 0 && stack[stack.length - 1] === oldHash) {
		stack.pop();
		setStack(stack);
	}
}

/**
 * Save the current route then navigate to `hash`.
 * Use this for any in-app navigation that should be reversible with goBack().
 */
export function navigateTo(hash) {
	saveCurrentRoute();
	location.hash = hash;
}

/**
 * Return the hash that goBack() would navigate to, without modifying the stack.
 * Use this to set the `href` on a back-button anchor at render time.
 */
export function peekBack(fallback = "#/") {
	const stack = getStack();
	return stack[stack.length - 1] ?? fallback;
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
