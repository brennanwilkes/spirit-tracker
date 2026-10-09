/* Service worker registration, code updates, and data freshness.
 *
 * NO DOM ACCESS AT MODULE TOP LEVEL. api.js and cloud.js import this module, and Node tools
 * (auto_link_classify, featurize, the audit) import api.js; a top-level `document` here
 * crashes every one of them, and run_daily.sh runs them best-effort, so CI would go quiet.
 *
 * FRESHNESS CONTRACT: cached data is for when there is no network, never instead of it.
 * - sw.js serves ./data/** network-first and tags a cache answer `x-st-offline` +
 *   `x-st-saved-at`; noteDataResponse() turns that into the offline bar.
 * - The ETag of the index.json on screen (live or cached) is compared with the server's by a
 *   HEAD on resume, on `online`, and every 5 min while visible. Different => reload (while
 *   visible and live, only a tap-to-refresh bar). Same while showing a cached copy => the copy
 *   is current, so the offline bar clears without reloading.
 * - Account data (cloud.js) has its own bar and never drives a reload: the accounts API being
 *   unreachable says nothing about the catalog, and reloading cannot fix it.
 * - Code updates apply on launch and resume; one that lands mid-use offers the update bar.
 * - The tap-to-reload bars (update, fresh) are installed-app only. A browser tab has its own
 *   reload button, and the automatic launch/resume paths above still apply there.
 *
 * Only a deploy-stamped build registers the worker (tools/stamp_pwa.js fills st-build).
 */

const INDEX_URL = "./data/index.json";
const FOREGROUND_CHECK_MS = 5 * 60 * 1000;
const BAR_RANK = { account: 1, offline: 2, fresh: 3, update: 4 };
// An automatic swap reloads only if it lands this soon after being asked for. Activation
// waits for the old worker's in-flight events, which can take tens of seconds; a reload that
// late would yank a page the user is already using.
const AUTO_APPLY_RELOAD_MS = 5000;

let active = false;
let autoApplyAt = null;
let installPrompt = null;
const LS_INSTALL_HINT_DISMISSED = "st:pwa:installHintDismissed";
let shownIndexEtag = null;
let dataOfflineAsOf = null;
let accountOfflineAsOf = null;
// Data this page fetched before any worker controlled it (first visit), so not cached.
const uncachedData = new Set();

/** Running as the installed app. iOS reports it only through navigator.standalone. */
export function isStandalone() {
	return navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

export function register() {
	if (navigator.serviceWorker === undefined) return;

	if (document.querySelector('meta[name="st-build"]').content === "__BUILD__") {
		navigator.serviceWorker.getRegistrations().then((regs) => {
			for (const r of regs) r.unregister();
		});
		return;
	}
	active = true;
	// Chrome/Android fires this once, early, when the site is installable; keep it for the hint.
	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		installPrompt = e;
	});

	const registered = navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { scope: "./" });
	registered
		.then((reg) => {
			// Launch: nothing is on screen yet that a reload could lose.
			if (reg.waiting !== null) {
				autoApplyAt = Date.now();
				reg.waiting.postMessage("SKIP_WAITING");
			}
			reg.addEventListener("updatefound", () => {
				const sw = reg.installing;
				if (sw === null) return;
				sw.addEventListener("statechange", () => {
					// A controller already exists => this is an update, not a first install.
					if (sw.state === "installed" && navigator.serviceWorker.controller !== null) {
						showBar("update", "A new version is ready — tap to reload", () => {
							autoApplyAt = null;
							sw.postMessage("SKIP_WAITING");
						});
					}
				});
			});
		})
		.catch((err) => console.error("[pwa] registration failed:", err));

	// The first install's clients.claim() also fires controllerchange. That is not an update,
	// and reloading on it would make every first visit load twice (wiping anything typed).
	// Instead the data this page already loaded is fetched again THROUGH the worker, so the
	// offline copy exists from the first visit on.
	let controlled = navigator.serviceWorker.controller !== null;
	let reloading = false;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!controlled) {
			controlled = true;
			for (const url of uncachedData) {
				fetch(url, { cache: "no-store" })
					.then((r) => r.arrayBuffer())
					.catch((err) => console.warn("[pwa] could not cache", url, err));
			}
			uncachedData.clear();
			return;
		}
		if (autoApplyAt !== null && Date.now() - autoApplyAt > AUTO_APPLY_RELOAD_MS) {
			showBar("update", "A new version is ready — tap to reload", () => location.reload());
			return;
		}
		if (reloading) return;
		reloading = true;
		location.reload();
	});

	document.addEventListener("visibilitychange", async () => {
		if (document.visibilityState !== "visible") return;
		const reg = await registered;
		if (reg.waiting !== null) {
			autoApplyAt = Date.now();
			reg.waiting.postMessage("SKIP_WAITING");
			return;
		}
		reg.update();
		checkFreshness(true);
	});
	window.addEventListener("online", () => {
		if (accountOfflineAsOf !== null) location.reload();
		else checkFreshness(true);
	});
	setInterval(() => {
		if (document.visibilityState === "visible") checkFreshness(false);
	}, FOREGROUND_CHECK_MS);

	// Without persistence the browser may evict the offline copy under storage pressure.
	// Asked only when installed: desktop Firefox turns persist() into a permission prompt.
	if (isStandalone() && navigator.storage?.persist !== undefined) {
		navigator.storage.persist().then((ok) => {
			if (!ok) console.warn("[pwa] storage is NOT persisted; the offline copy may be evicted");
		});
	}
}

/** Mobile browser tab, signed in: suggest installing, until dismissed once, ever (per browser). */
export function offerInstall(authed) {
	if (!active || !authed) return;
	if (isStandalone()) return;
	if (!window.matchMedia("(pointer: coarse)").matches) return;
	if (localStorage.getItem(LS_INSTALL_HINT_DISMISSED) !== null) return;

	const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
	const card = document.createElement("div");
	card.className = "installHint";
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-label", "Install Spirit Tracker");
	card.innerHTML = `
		<img class="installHintIcon" src="./icons/icon-192.png" alt="">
		<div class="installHintText">
			<div class="installHintTitle">Try the Spirit Tracker app</div>
			<div class="installHintHow"></div>
		</div>
		<button class="installHintClose" type="button" aria-label="Don't show again"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
	const $how = card.querySelector(".installHintHow");
	if (ios) {
		$how.innerHTML = 'Tap <i class="fa-solid fa-arrow-up-from-bracket" aria-label="Share"></i> Share, then <b>Add to Home Screen</b>.';
	} else {
		$how.innerHTML = "Open your browser menu, then <b>Add to Home screen</b>.";
		// Wait a beat for beforeinstallprompt; where it exists, a real Install button beats instructions.
		setTimeout(() => {
			if (installPrompt === null || !card.isConnected) return;
			$how.innerHTML = '<button class="btn btnSm installHintInstall" type="button">Install</button>';
			$how.querySelector("button").addEventListener("click", async () => {
				installPrompt.prompt();
				const { outcome } = await installPrompt.userChoice;
				if (outcome === "accepted") card.remove();
			});
		}, 1500);
	}
	card.querySelector(".installHintClose").addEventListener("click", () => {
		localStorage.setItem(LS_INSTALL_HINT_DISMISSED, String(Date.now()));
		card.remove();
	});
	document.body.appendChild(card);
}

/** Called by api.js fetchJson for every OK response, before its body is read. */
export function noteDataResponse(url, res) {
	if (!active) return;
	if (navigator.serviceWorker.controller === null && url.startsWith("./data/")) uncachedData.add(url);
	const offline = res.headers.get("x-st-offline") === "1";
	if (offline) {
		const raw = res.headers.get("x-st-saved-at");
		if (raw === null) throw new Error(`[pwa] cached ${url} has no x-st-saved-at`);
		const savedAt = Number(raw);
		if (!Number.isFinite(savedAt)) throw new Error(`[pwa] cached ${url} has x-st-saved-at ${raw}`);
		dataOfflineAsOf = dataOfflineAsOf === null ? savedAt : Math.min(dataOfflineAsOf, savedAt);
	}
	if (url === INDEX_URL) {
		const etag = res.headers.get("etag");
		if (etag === null) throw new Error(`[pwa] ${url} has no ETag; freshness checks cannot work`);
		shownIndexEtag = etag;
	}
	if (offline) renderOfflineBar();
}

/** cloud.js is showing account data saved at `savedAtMs` because the API was unreachable. */
export function markAccountOffline(savedAtMs) {
	if (!active) return;
	if (!Number.isFinite(savedAtMs)) throw new Error(`[pwa] account copy saved at ${savedAtMs}`);
	accountOfflineAsOf = accountOfflineAsOf === null ? savedAtMs : Math.min(accountOfflineAsOf, savedAtMs);
	renderOfflineBar();
}

async function checkFreshness(resumed) {
	if (shownIndexEtag === null) return; // nothing on screen came from index.json

	let res;
	try {
		res = await fetch(INDEX_URL, { method: "HEAD", cache: "no-store" });
	} catch {
		return; // still offline
	}
	if (!res.ok) throw new Error(`[pwa] HEAD ${INDEX_URL} returned ${res.status}`);
	const etag = res.headers.get("etag");
	if (etag === null) throw new Error(`[pwa] HEAD ${INDEX_URL} has no ETag`);

	if (etag === shownIndexEtag) {
		if (dataOfflineAsOf !== null) {
			dataOfflineAsOf = null;
			renderOfflineBar();
		}
		return;
	}
	if (resumed || dataOfflineAsOf !== null) location.reload();
	else showBar("fresh", "New prices are in — tap to refresh", () => location.reload());
}

function renderOfflineBar() {
	const when = (ms) =>
		new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
	const cur = document.getElementById("pwaBar");
	if (cur !== null && (cur.dataset.kind === "offline" || cur.dataset.kind === "account")) cur.remove();
	if (dataOfflineAsOf !== null) {
		showBar("offline", `Offline — data as of ${when(dataOfflineAsOf)}`, null);
	} else if (accountOfflineAsOf !== null) {
		showBar("account", `Can't reach your account — showing your copy from ${when(accountOfflineAsOf)}`, null);
	}
}

function showBar(kind, text, onTap) {
	if (onTap !== null && !isStandalone()) return;
	const cur = document.getElementById("pwaBar");
	if (cur !== null) {
		if (BAR_RANK[cur.dataset.kind] > BAR_RANK[kind]) return;
		cur.remove();
	}
	const bar = document.createElement(onTap === null ? "div" : "button");
	bar.id = "pwaBar";
	bar.className = `pwaBar pwaBar-${kind}`;
	bar.dataset.kind = kind;
	bar.textContent = text;
	if (onTap === null) {
		bar.setAttribute("role", "status");
	} else {
		bar.type = "button";
		bar.addEventListener("click", () => {
			bar.disabled = true;
			onTap();
		});
	}
	document.body.appendChild(bar);
}
