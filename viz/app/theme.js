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
	syncThemeColor();
}

// The browser/OS chrome (Android status bar, desktop PWA title bar) takes its colour from
// <meta name="theme-color">. Read it back from the live --bg so style.css stays the only
// place the palette is written.
function syncThemeColor() {
	const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
	if (bg === "") throw new Error("--bg is not defined; style.css did not load");
	for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", bg);
}

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", syncThemeColor);

// Call this synchronously on load (before any rendering) to avoid FOUC
export function applyStoredColorScheme() {
	const stored = localStorage.getItem(LS_KEY);
	if (stored === "light" || stored === "dark") applyColorScheme(stored);
	else syncThemeColor();
}
