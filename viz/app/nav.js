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
 */
export function goBack(fallback = "#/") {
	const stack = getStack();
	const prev = stack.pop();
	setStack(stack);
	location.hash = prev ?? fallback;
}

/**
 * Save the current route then navigate to `hash`.
 * Use this for any in-app navigation that should be reversible with goBack().
 */
export function navigateTo(hash) {
	saveCurrentRoute();
	location.hash = hash;
}
