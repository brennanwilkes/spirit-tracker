/**
 * Pull-to-refresh for the installed app (main.js installs it only there). A browser tab has
 * its own; the installed app has none, and style.css turns its overscroll bounce off because
 * the bounce dragged the tab bar along. Without this the top of every page felt nailed down.
 *
 * Pulling down from the top slides #app after the finger (with resistance) and reveals a
 * spinner; letting go past the threshold reloads, which fetches data network-first.
 * Listeners stay passive, so scrolling never waits on them.
 */

const THRESHOLD = 64; // px of content travel; the finger travels twice that
const MAX_PULL = 110;

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
		const transition = animate ? "transform 0.25s ease, opacity 0.25s ease" : "none";
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
			pull = Math.min(MAX_PULL, Math.max(0, dy / 2));
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
			location.reload();
		} else if (pull > 0) {
			show(0, true);
		}
		pull = 0;
	}
	window.addEventListener("touchend", release, { passive: true });
	window.addEventListener("touchcancel", release, { passive: true });
}
