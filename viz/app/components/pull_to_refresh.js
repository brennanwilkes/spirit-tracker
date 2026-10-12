/**
 * Pull-to-refresh for the installed app (main.js installs it only there). A browser tab has
 * its own; the installed app has none, and style.css turns its overscroll bounce off because
 * the bounce dragged the tab bar along. Without this the top of every page felt nailed down.
 *
 * Pulling down from the top slides #app after the finger (rubber-banded) and reveals a
 * spinner; letting go past the threshold reloads, which fetches data network-first.
 * Listeners stay passive, so scrolling never waits on them.
 */

/* Rubber band, like iOS: content travel = MAX_PULL * (1 - 1 / (1 + finger / STRETCH)), stiffening
 * smoothly toward MAX_PULL instead of hitting a hard cap. THRESHOLD is reached at ~240px of finger
 * travel (a linear half-speed pull capped at 110px felt "crunchy" and fired at 128px). */
const THRESHOLD = 100; // px of content travel
const MAX_PULL = 160;
const STRETCH = 144;
const SETTLE_MS = 400; // outlasts show()'s 0.35s snap to THRESHOLD

export function installPullToRefresh() {
	const $app = document.getElementById("app");
	const $ptr = document.createElement("div");
	$ptr.className = "ptr";
	$ptr.setAttribute("aria-hidden", "true");
	$ptr.innerHTML = '<i class="fa-solid fa-arrow-rotate-right"></i>';
	document.body.appendChild($ptr);
	const $icon = $ptr.firstElementChild;

	let start = null;
	let pull = 0;
	let refreshing = false;

	function show(px, animate) {
		const transition = animate ? "transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.35s ease" : "none";
		$app.style.transition = transition;
		$ptr.style.transition = transition;
		$app.style.transform = px === 0 ? "" : `translateY(${px}px)`;
		$ptr.style.transform = `translateY(${px / 2 - 16}px)`;
		$ptr.style.opacity = String(Math.min(1, px / THRESHOLD));
		$icon.style.transform = `rotate(${(px / THRESHOLD) * 270}deg)`;
		$ptr.classList.toggle("ptrArmed", px >= THRESHOLD);
	}

	// Not from inside something that scrolls or drags on its own: a dropdown panel, the chart,
	// the price slider, a dialog, the fixed bars.
	function startsOnOwnGesture(el) {
		for (let n = el; n !== null && n !== document.body; n = n.parentElement) {
			if (n.matches("canvas, input[type=range], .swal2-container, .bottomNav, .pwaBar, .installHint")) return true;
			const oy = getComputedStyle(n).overflowY;
			if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return true;
		}
		return false;
	}

	window.addEventListener(
		"touchstart",
		(e) => {
			if (refreshing || e.touches.length !== 1 || window.scrollY > 0) return;
			if (startsOnOwnGesture(e.target)) return;
			start = { x: e.touches[0].clientX, y: e.touches[0].clientY, vertical: null };
		},
		{ passive: true },
	);

	window.addEventListener(
		"touchmove",
		(e) => {
			if (start === null) return;
			const dx = e.touches[0].clientX - start.x;
			const dy = e.touches[0].clientY - start.y;
			if (start.vertical === null) {
				if (Math.hypot(dx, dy) < 8) return;
				start.vertical = dy > Math.abs(dx);
			}
			if (!start.vertical || window.scrollY > 0) {
				start = null;
				if (pull !== 0) show(0, true);
				pull = 0;
				return;
			}
			pull = dy <= 0 ? 0 : MAX_PULL * (1 - 1 / (1 + dy / STRETCH));
			show(pull, false);
		},
		{ passive: true },
	);

	function release(e) {
		if (start === null) return;
		start = null;
		if (e.type === "touchend" && pull >= THRESHOLD) {
			refreshing = true;
			show(THRESHOLD, true);
			$ptr.classList.add("ptrBusy");
			// Not synchronously in touchend: iOS is still ending the pan on its scroll view, and a
			// page loaded mid-gesture inherits that offset, leaving the fixed tab bar floating above
			// a strip of background until something re-lays out (never, on a short item page).
			setTimeout(() => location.reload(), SETTLE_MS);
		} else if (pull > 0) {
			show(0, true);
		}
		pull = 0;
	}
	window.addEventListener("touchend", release, { passive: true });
	window.addEventListener("touchcancel", release, { passive: true });
}
