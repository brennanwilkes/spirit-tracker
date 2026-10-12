/**
 * Heals the iOS standalone viewport that a keyboard leaves shrunk (main.js installs it only in
 * the installed iOS app).
 *
 * WebKit bug: in a home-screen app the first software-keyboard open shrinks the layout viewport
 * (innerHeight, visualViewport.height and 100dvh all drop) and it never grows back. The fixed tab
 * bar is anchored to that short viewport, so it floats above a band of scrolling content. It
 * survives location.reload() (same web view), which is why pull-to-refresh did not fix it and
 * relaunching the app did. Hiding and re-showing a full-height element (body, min-height 100dvh)
 * forces WebKit to re-measure. https://dev.to/cederhook/fixing-the-ios-standalone-pwa-keyboard-bug-that-shrinks-your-viewport-for-good-63d
 *
 * The baseline is the screen, not the tallest height seen since load: after a reload the page
 * starts out shrunk, so it has never seen the real height.
 *
 * A second variant leaves innerHeight alone, so heal() never fires: after pull-to-refresh on the
 * item page the tab bar floats a varying gap above the bottom, surviving scrolls and further
 * reloads, until a tab switch. What a tab switch does is change the document height, so
 * nudge() does the same: once the body's size settles, a spacer after it makes the document
 * taller for two frames. It sits outside body so it doesn't retrigger the observer.
 */

const SLACK_PX = 4;
const AFTER_BLUR_MS = 150; // let the keyboard finish closing before measuring
const MIN_GAP_MS = 1000; // a heal that changes nothing (e.g. an iPad split window) must not loop
const NUDGE_SETTLE_MS = 250; // a page renders in bursts (shell, data, chart); nudge after the last

// An open keyboard covers the visual viewport, not the layout one. Not document.activeElement:
// search focuses its box on load, and on iOS a programmatic focus shows no keyboard.
const KEYBOARD_MIN_PX = 120;

function keyboardOpen() {
	return window.innerHeight - window.visualViewport.height > KEYBOARD_MIN_PX;
}

export function installViewportHeal() {
	let lastHeal = 0;

	function heal() {
		if (keyboardOpen() || Date.now() - lastHeal < MIN_GAP_MS) return;
		// iOS reports screen in portrait terms whatever the orientation.
		const portrait = window.matchMedia("(orientation: portrait)").matches;
		const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
		if (full - window.innerHeight <= SLACK_PX) return;
		lastHeal = Date.now();
		const y = window.scrollY;
		document.body.style.display = "none";
		void document.body.offsetHeight;
		document.body.style.display = "";
		window.scrollTo(0, y);
	}

	let nudgeTimer = null;
	function nudge() {
		const $spacer = document.createElement("div");
		$spacer.style.height = `${window.innerHeight}px`;
		document.documentElement.appendChild($spacer);
		requestAnimationFrame(() => requestAnimationFrame(() => $spacer.remove()));
	}
	new ResizeObserver(() => {
		clearTimeout(nudgeTimer);
		nudgeTimer = setTimeout(nudge, NUDGE_SETTLE_MS);
	}).observe(document.body);

	document.addEventListener("focusout", () => setTimeout(heal, AFTER_BLUR_MS));
	window.visualViewport.addEventListener("resize", heal);
	window.addEventListener("pageshow", heal);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") heal();
	});
	heal();
}
