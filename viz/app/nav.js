// viz/app/nav.js
// Centralised back-button / navigation helpers.
// All pages should use these instead of touching sessionStorage directly.

const LAST_ROUTE_KEY = "viz:lastRoute";

/** Save the current hash so goBack() can return here. */
export function saveCurrentRoute() {
	sessionStorage.setItem(LAST_ROUTE_KEY, location.hash);
}

/**
 * Navigate back to wherever saveCurrentRoute() was last called, or to
 * `fallback` (default "#/") if no saved route exists.
 */
export function goBack(fallback = "#/") {
	const last = sessionStorage.getItem(LAST_ROUTE_KEY);
	if (last && last !== location.hash) location.hash = last;
	else location.hash = fallback;
}

/**
 * Save the current route then navigate to `hash`.
 * Use this for any in-app navigation that should be reversible with goBack().
 */
export function navigateTo(hash) {
	saveCurrentRoute();
	location.hash = hash;
}
