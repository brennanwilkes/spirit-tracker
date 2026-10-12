/**
 * TEMPORARY: on-screen viewport readout for the installed iOS app, to diagnose the tab bar
 * floating above the bottom after pull-to-refresh on the item page. Tap it to collapse.
 * The event log survives reloads (sessionStorage), so the pre-reload state is visible.
 * Remove once that bug is fixed.
 */

const LOG_KEY = "st:vpdebug:log";
const LOG_MAX = 14;

function probe(css) {
	const el = document.createElement("div");
	el.style.cssText = `position:fixed;left:-10px;width:1px;visibility:hidden;pointer-events:none;${css}`;
	document.documentElement.appendChild(el);
	return el;
}

export function installViewportDebug() {
	const log = JSON.parse(sessionStorage.getItem(LOG_KEY) ?? "[]");
	const t0 = performance.now();
	function note(msg) {
		log.push(`${new Date().toISOString().slice(14, 23)} ${msg}`);
		while (log.length > LOG_MAX) log.shift();
		sessionStorage.setItem(LOG_KEY, JSON.stringify(log));
	}
	note(`--- load ${location.hash}`);

	const probes = {
		fixedCB: probe("top:0;bottom:0"),
		vh: probe("top:0;height:100vh"),
		dvh: probe("top:0;height:100dvh"),
		svh: probe("top:0;height:100svh"),
		lvh: probe("top:0;height:100lvh"),
		insets: probe(
			"top:0;height:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);box-sizing:content-box",
		),
	};

	const $box = document.createElement("pre");
	$box.style.cssText =
		"position:fixed;top:calc(env(safe-area-inset-top) + 4px);left:4px;z-index:99999;margin:0;padding:4px 6px;" +
		"font:10px/1.25 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,0.82);border-radius:4px;" +
		"max-width:calc(100vw - 8px);white-space:pre-wrap;pointer-events:auto";
	let collapsed = false;
	$box.addEventListener("click", () => {
		collapsed = !collapsed;
		render();
	});
	document.documentElement.appendChild($box);

	const r = (n) => Math.round(n * 10) / 10;
	function snapshot() {
		const vv = window.visualViewport;
		const de = document.documentElement;
		const nav = document.querySelector(".bottomNav");
		const navR = nav === null ? null : nav.getBoundingClientRect();
		const body = document.body.getBoundingClientRect();
		const insetTop = probes.insets.getBoundingClientRect().height;
		const insetBot = parseFloat(getComputedStyle(probes.insets).paddingBottom);
		return {
			screen: `${screen.width}x${screen.height}`,
			inner: `${window.innerWidth}x${window.innerHeight}`,
			outerH: window.outerHeight,
			deClient: de.clientHeight,
			vv: `h${r(vv.height)} offTop${r(vv.offsetTop)} pageTop${r(vv.pageTop)} s${r(vv.scale)}`,
			fixedCB: r(probes.fixedCB.getBoundingClientRect().height),
			units: `vh${r(probes.vh.offsetHeight)} dvh${r(probes.dvh.offsetHeight)} svh${r(probes.svh.offsetHeight)} lvh${r(probes.lvh.offsetHeight)}`,
			insets: `top${r(insetTop)} bot${r(insetBot)}`,
			scrollY: r(window.scrollY),
			docH: de.scrollHeight,
			body: `top${r(body.top)} h${r(body.height)}`,
			nav: navR === null ? "none" : `top${r(navR.top)} bot${r(navR.bottom)} h${r(navR.height)} gap${r(window.innerHeight - navR.bottom)}`,
			app: document.getElementById("app")?.style.transform || "-",
		};
	}

	function render() {
		if (collapsed) {
			$box.textContent = "vp";
			return;
		}
		const s = snapshot();
		const lines = Object.entries(s).map(([k, v]) => `${k}: ${v}`);
		$box.textContent = `${lines.join("\n")}\nt+${Math.round((performance.now() - t0) / 1000)}s\n${log.join("\n")}`;
	}

	let last = "";
	function tick() {
		const s = snapshot();
		const key = `${s.inner}|${s.vv}|${s.fixedCB}|${s.nav}|${s.docH}|${s.units}`;
		if (key !== last) {
			if (last !== "") note(`chg inner${s.inner} cb${s.fixedCB} docH${s.docH} nav[${s.nav}]`);
			last = key;
		}
		render();
	}
	setInterval(tick, 500);
	for (const ev of ["load", "pageshow", "pagehide", "resize", "orientationchange"]) {
		window.addEventListener(ev, () => {
			note(ev);
			tick();
		});
	}
	window.visualViewport.addEventListener("resize", () => {
		note("vv-resize");
		tick();
	});
	window.addEventListener("beforeunload", () => {
		const s = snapshot();
		note(`unload inner${s.inner} cb${s.fixedCB} nav[${s.nav}] app${s.app}`);
	});
	tick();
}
