const LS_KEY = "st:colorScheme"; // null | "light" | "dark"

export function applyColorScheme(scheme) {
	const html = document.documentElement;
	if (scheme === "light" || scheme === "dark") {
		html.setAttribute("data-theme", scheme);
	} else {
		html.removeAttribute("data-theme");
	}
	if (scheme) localStorage.setItem(LS_KEY, scheme);
	else localStorage.removeItem(LS_KEY);
}

// Call this synchronously on load (before any rendering) to avoid FOUC
export function applyStoredColorScheme() {
	const stored = localStorage.getItem(LS_KEY);
	if (stored === "light" || stored === "dark") applyColorScheme(stored);
}
