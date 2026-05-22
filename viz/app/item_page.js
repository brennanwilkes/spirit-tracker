import { esc, renderThumbHtml, dateOnly } from "./dom.js";
import { goBack, peekBack } from "./nav.js";
import { parsePriceToNumber, keySkuForRow, displaySku } from "./sku.js";
import { loadIndex } from "./state.js";
import { fetchJson } from "./api.js";
import { loadSkuRules } from "./mapping.js";
import { buildStoreColorMap, storeColor, datasetStrokeWidth, lighten } from "./storeColors.js";
import { favStarHtml, loadMyFavouritesSet, installFavStars } from "./fav_star.js";
import { getAuthStatus, getMySampled, getMyScore, setMySampled, setMyScore } from "./cloud.js";
import {
	isBcStoreLabel,
	weightedMeanByDuration,
	minFinite,
	medianFinite,
	lastFiniteFromEnd,
	computeSuggestedY,
	niceStepAtLeast,
	StaticMarkerLinesPlugin,
} from "./item_page/item_chart.js";

/* ---------------- Chart lifecycle ---------------- */

let CHART = null;

export function destroyChart() {
	if (CHART) {
		CHART.destroy();
		CHART = null;
	}
}

/* ---------------- SKU history from pre-built cache files ---------------- */

async function loadSkuHistory(skuGroup, today) {
	const fetches = [...skuGroup].map((sku) =>
		fetchJson(`./data/skus/${encodeURIComponent(sku)}.json`).catch(() => null),
	);
	const results = await Promise.all(fetches);

	const allDatesSet = new Set();
	allDatesSet.add("2026-01-19"); // earliest data branch commit
	allDatesSet.add(today);

	for (const cache of results) {
		if (!cache?.stores) continue;
		for (const store of Object.values(cache.stores)) {
			for (const ev of Array.isArray(store?.events) ? store.events : []) {
				const d = dateOnly(ev.ts);
				if (d) allDatesSet.add(d);
			}
		}
	}

	// Expand to every calendar day so the x-axis has proportional time spacing
	// and forward-fill produces a dot on every in-stock day.
	const allDatesArray = [...allDatesSet].sort();
	const minDate = allDatesArray[0];
	const maxDate = allDatesArray[allDatesArray.length - 1];
	const labels = [];
	const cursor = new Date(minDate + "T12:00:00Z");
	const endMs = new Date(maxDate + "T12:00:00Z").getTime();
	while (cursor.getTime() <= endMs) {
		labels.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	const series = [];

	for (const cache of results) {
		if (!cache?.sku || !cache.stores) continue;
		const sku = cache.sku;

		for (const [dbFile, store] of Object.entries(cache.stores)) {
			const events = Array.isArray(store?.events) ? store.events : [];
			if (!events.length) continue;

			// Per day we track TWO things separately:
			//   - lastEventByDay: end-of-day state, governs forward-fill into subsequent days
			//   - lastPriceByDay: best in-stock observation on that day, governs the plotted point
			// Without this split, an item that appeared and was removed on the same day would
			// render zero points (the removed event would shadow the price event in the map).
			const lastEventByDay = new Map();
			const lastPriceByDay = new Map();
			for (const ev of events) {
				const d = dateOnly(ev.ts);
				if (!d) continue;
				lastEventByDay.set(d, ev);
				if ("p" in ev) lastPriceByDay.set(d, ev);
			}

			const points = new Map();
			const values = [];
			const dates = [];
			let currentPrice = null;
			let isActive = false;

			for (const date of labels) {
				const priceEv = lastPriceByDay.get(date);
				const lastEv = lastEventByDay.get(date);

				// If we observed a price today, plot it (even if a removal followed later that day).
				let v;
				if (priceEv) {
					v = parsePriceToNumber(priceEv.p);
				} else {
					v = isActive ? currentPrice : null;
				}
				points.set(date, v);
				if (v !== null) values.push(v);
				dates.push(date);

				// End-of-day state determines what next days' forward-fill looks like.
				if (lastEv) {
					if ("p" in lastEv) {
						currentPrice = parsePriceToNumber(lastEv.p);
						isActive = true;
					} else {
						currentPrice = null;
						isActive = false;
					}
				}
			}

			series.push({ label: store.label || dbFile, variantKey: sku, points, values, dates });
		}
	}

	return { series, labels };
}

/* ---------------- Page ---------------- */

export async function renderItem($app, skuInput) {
	destroyChart();

	// Kick off independent fetches immediately — no dependency on rules/sku
	const idxPromise = loadIndex();

	const [rules, fav] = await Promise.all([loadSkuRules(), loadMyFavouritesSet()]);

	const sku = rules.canonicalSku(String(skuInput || ""));
	const favSet = new Set();
	for (const k of fav.set) {
		const raw = String(k || "");
		favSet.add(String(rules.canonicalSku(raw) || raw));
	}

	function setSaving(el, on) {
		if (!el) return;
		el.classList.toggle("isSaving", !!on);
	}

	function flashSaved(el) {
		if (!el) return;
		el.classList.remove("isSaved");
		// restart animation
		void el.offsetWidth;
		el.classList.add("isSaved");
		setTimeout(() => el && el.classList.remove("isSaved"), 650);
	}

	$app.innerHTML = `
		<div class="container">
			<div class="topbar">
				<a id="back" class="btn" href="${peekBack()}"><span class="backArrow">← </span>Back</a>
				<span class="badge mono">${esc(displaySku(sku))}</span>
			</div>

			<div class="card detailCard">
				<div class="detailHeader">
				<div id="thumbBox" class="detailThumbBox"></div>

				<div class="detailHeaderText">
					<div class="detailTopRow">
					<div class="detailLeft">
						<div class="detailTitleRow">
						<div id="title" class="h1">Loading…</div>
						</div>

						<!-- DESKTOP links/status stay here -->
						<div id="links" class="links"></div>
						<div class="small" id="status"></div>
						<div class="loadingBar" id="loadingBar"><div class="loadingBarFill"></div></div>
					</div>

					<div class="detailRight">
						<button id="sampledBtn" class="pillBtn" type="button" aria-pressed="false">
						<span class="pillMark pillMarkOff">×</span>
						<span class="pillMark pillMarkOn">✓</span>
						<span>Sampled</span>
						</button>

						${favStarHtml(sku, favSet.has(sku), { cls: "favStarItem" })}

						<div id="scoreWrap" class="pillInput" role="button" tabindex="0" aria-label="Score">
						<span class="pillMarkNum">#</span>
						<input
							id="scoreInput"
							class="pillNumber"
							type="number"
							min="0"
							max="100"
							step="1"
							inputmode="numeric"
							placeholder="Score"
						/>
						</div>
					</div>
					</div>
				</div>
				</div>

				<!-- MOBILE full-width links/status (different ids, no collisions) -->
				<div class="detailMobileLinks">
				<div id="linksMobile" class="links"></div>
				<div class="small" id="statusMobile"></div>
				<div class="loadingBar" id="loadingBarMobile"><div class="loadingBarFill"></div></div>
				</div>

				<div class="chartBox">
				<canvas id="chart"></canvas>
				</div>
			</div>
			</div>
		`;

	installFavStars($app, favSet);

	document.getElementById("back").addEventListener("click", (e) => {
		if (e.ctrlKey || e.metaKey || e.shiftKey) return;
		e.preventDefault();
		goBack();
	});

	const $title = document.getElementById("title");
	const $links = document.getElementById("links");
	const $status = document.getElementById("status");
	const $canvas = document.getElementById("chart");
	const $thumbBox = document.getElementById("thumbBox");

	const $linksMobile = document.getElementById("linksMobile");
	const $statusMobile = document.getElementById("statusMobile");
	const $loadingBar = document.getElementById("loadingBar");
	const $loadingBarMobile = document.getElementById("loadingBarMobile");

	function setProgress(done, total) {
		const pct = total > 0 ? Math.round((done / total) * 100) : 0;
		for (const $bar of [$loadingBar, $loadingBarMobile]) {
			if (!$bar) continue;
			const $fill = $bar.querySelector(".loadingBarFill");
			if ($fill) $fill.style.width = pct + "%";
			$bar.classList.toggle("loadingBarActive", pct > 0 && pct < 100);
		}
	}

	function clearProgress() {
		for (const $bar of [$loadingBar, $loadingBarMobile]) {
			if (!$bar) continue;
			$bar.classList.remove("loadingBarActive");
			const $fill = $bar.querySelector(".loadingBarFill");
			if ($fill) $fill.style.width = "0%";
		}
	}

	const setLinksHtml = (html) => {
		if ($links) $links.innerHTML = html;
		if ($linksMobile) $linksMobile.innerHTML = html;
	};

	const setStatusText = (txt) => {
		if ($status) $status.textContent = txt;
		if ($statusMobile) $statusMobile.textContent = txt;
	};

	// ---- Cloud: sampled + score (per canonical SKU) ----
	const $sampledBtn = document.getElementById("sampledBtn");
	const $scoreWrap = document.getElementById("scoreWrap");
	const $score = document.getElementById("scoreInput");

	const loginUrl = "#/login";
	const openLogin = () => window.open(loginUrl, "_blank", "noopener,noreferrer");

	function setSampledUi(isOn) {
		const on = !!isOn;
		if (!$sampledBtn) return;
		$sampledBtn.classList.toggle("isOn", on);
		$sampledBtn.setAttribute("aria-pressed", on ? "true" : "false");
	}

	function setScoreUi(score) {
		if (!$score) return;
		if (score === null || score === undefined) $score.value = "";
		else if (Number.isFinite(Number(score))) $score.value = String(Math.round(Number(score)));
	}

	// Make the WHOLE score pill clickable -> focuses input
	if ($scoreWrap && $score) {
		const focusAndSelectScore = () => {
			$score.focus();
			// defer so selection sticks (esp. when focus came from a click)
			setTimeout(() => {
				try {
					$score.select();
				} catch {}
			}, 0);
		};

		$scoreWrap.addEventListener("click", (e) => {
			if (e.target !== $score) focusAndSelectScore();
		});
		$scoreWrap.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				focusAndSelectScore();
			}
		});
		// Tab focus into the input -> select current value for quick replace
		$score.addEventListener("focus", () => {
			setTimeout(() => {
				try {
					$score.select();
				} catch {}
			}, 0);
		});
	}

	const auth = getAuthStatus();
	const cloudKey = sku;

	if (!auth.ok) {
		if ($sampledBtn) $sampledBtn.classList.add("isLoginGate");
		if ($scoreWrap) $scoreWrap.classList.add("isLoginGate");
		if ($score) $score.readOnly = true;

		if ($sampledBtn) {
			$sampledBtn.addEventListener("click", (e) => {
				e.preventDefault();
				openLogin();
			});
		}

		if ($scoreWrap) {
			$scoreWrap.addEventListener("click", (e) => {
				e.preventDefault();
				openLogin();
			});
		}

		if ($score) $score.addEventListener("focus", () => $score.blur());
	} else {
		// Auth ok: load initial values
		(async () => {
			try {
				const [sampledArr, scoreMap] = await Promise.all([getMySampled(), getMyScore()]);
				const sampled = Array.isArray(sampledArr) && sampledArr.includes(cloudKey);

				let score = null;
				if (scoreMap && typeof scoreMap === "object") {
					const n = Number(scoreMap[cloudKey]);
					if (Number.isFinite(n)) score = n;
				}

				setSampledUi(sampled);
				setScoreUi(score);
			} catch {
				setSampledUi(false);
				setScoreUi(null);
			}
		})();

		// Sampled toggle
		if ($sampledBtn) {
			$sampledBtn.addEventListener("click", async () => {
				const next = !$sampledBtn.classList.contains("isOn");
				setSampledUi(next);

				setSaving($sampledBtn, true);
				try {
					await setMySampled(cloudKey, next);
					flashSaved($sampledBtn);
				} catch {
					setSampledUi(!next);
				} finally {
					setSaving($sampledBtn, false);
				}
			});
		}

		// Score save
		if ($score) {
			const saveScore = async () => {
				const raw = String($score.value || "").trim();
				let toSend = null;

				if (raw !== "") {
					const n = Number(raw);
					if (Number.isFinite(n)) {
						toSend = Math.max(0, Math.min(100, Math.round(n)));
						$score.value = String(toSend);
					} else {
						$score.value = "";
						toSend = null;
					}
				}

				setSaving($scoreWrap, true);
				try {
					await setMyScore(cloudKey, toSend);
					flashSaved($scoreWrap);
				} catch {
					// keep silent like now
				} finally {
					setSaving($scoreWrap, false);
				}
			};

			$score.addEventListener("change", saveScore);
			$score.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					$score.blur();
				}
			});
		}
	}

	const idx = await idxPromise;
	const all = Array.isArray(idx.items) ? idx.items : [];

	// include toSku + all fromSkus mapped to it
	const skuGroup = rules.groupForCanonical(sku);

	// index.json includes removed rows too. Split live vs all.
	const allRows = all.filter((x) => skuGroup.has(String(keySkuForRow(x) || "")));
	const liveRows = allRows.filter((x) => !Boolean(x?.removed));

	if (!allRows.length) {
		$title.textContent = "Item not found";
		setStatusText("No matching SKU in index.");
		if ($thumbBox) $thumbBox.innerHTML = `<div class="thumbPlaceholder"></div>`;
		return;
	}

	const isRemovedEverywhere = liveRows.length === 0;

	// pick bestName by most common across LIVE rows (fallback to allRows)
	const basisForName = liveRows.length ? liveRows : allRows;

	const nameCounts = new Map();
	for (const r of basisForName) {
		const n = String(r.name || "");
		if (!n) continue;
		nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
	}

	let bestName = basisForName[0].name || `(SKU ${sku})`;
	let bestCount = -1;
	for (const [n, c] of nameCounts.entries()) {
		if (c > bestCount) {
			bestName = n;
			bestCount = c;
		}
	}
	$title.textContent = bestName;

	// choose thumbnail from cheapest LIVE listing (fallback: any matching name; fallback: any)
	let bestImg = "";
	let bestPrice = null;

	const basisForThumb = liveRows.length ? liveRows : allRows;

	for (const r of basisForThumb) {
		const p = parsePriceToNumber(r.price);
		const img = String(r?.img || "").trim();
		if (p !== null && img) {
			if (bestPrice === null || p < bestPrice) {
				bestPrice = p;
				bestImg = img;
			}
		}
	}
	if (!bestImg) {
		for (const r of basisForThumb) {
			if (String(r?.name || "") === String(bestName || "") && String(r?.img || "").trim()) {
				bestImg = String(r.img).trim();
				break;
			}
		}
	}
	if (!bestImg) {
		for (const r of basisForThumb) {
			if (String(r?.img || "").trim()) {
				bestImg = String(r.img).trim();
				break;
			}
		}
	}

	$thumbBox.innerHTML = bestImg
		? renderThumbHtml(bestImg, "detailThumb")
		: `<div class="thumbPlaceholder"></div>`;

	// Render store links:
	// - one link per store label (even if URL differs)
	// - pick most recent row for that store
	function rowMs(r) {
		const t = String(r?.ts || "");
		const ms = t ? Date.parse(t) : NaN;
		if (Number.isFinite(ms)) return ms;

		const d = String(r?.date || "");
		const ms2 = d ? Date.parse(d + "T23:59:59Z") : NaN;
		return Number.isFinite(ms2) ? ms2 : 0;
	}

	const bestByStore = new Map(); // storeLabel -> row
	for (const r of allRows) {
		const href = String(r?.url || "").trim();
		if (!href) continue;

		const store = String(r?.storeLabel || r?.store || "Store").trim() || "Store";
		const prev = bestByStore.get(store);

		if (!prev) {
			bestByStore.set(store, r);
			continue;
		}

		const a = rowMs(prev);
		const b = rowMs(r);
		if (b > a) bestByStore.set(store, r);
		else if (b === a) {
			// tie-break: prefer live over removed
			if (Boolean(prev?.removed) && !Boolean(r?.removed)) bestByStore.set(store, r);
		}
	}

	function rowMinPrice(r) {
		const p = parsePriceToNumber(r?.price);
		return p === null ? Infinity : p;
	}

	const linkRows = Array.from(bestByStore.entries())
		.map(([store, r]) => ({ store, r }))
		.sort((A, B) => {
			// 1) cheapest current price first (Infinity sorts to end)
			const ap = rowMinPrice(A.r);
			const bp = rowMinPrice(B.r);
			if (ap !== bp) return ap - bp;

			// 2) live before removed
			const ar = Boolean(A.r?.removed) ? 1 : 0;
			const br = Boolean(B.r?.removed) ? 1 : 0;
			if (ar !== br) return ar - br;

			// 3) stable fallback
			return A.store.localeCompare(B.store);
		});

	setLinksHtml(
		linkRows
			.map(({ store, r }) => {
				const href = String(r.url || "").trim();
				const suffix = Boolean(r?.removed) ? " (removed)" : "";
				return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(store + suffix)}</a>`;
			})
			.join(""),
	);

	const today = dateOnly(idx.generatedAt || new Date().toISOString());

	setStatusText(isRemovedEverywhere ? "Removed everywhere — loading history…" : "Loading history…");

	const { series, labels } = await loadSkuHistory(skuGroup, today);

	if (!labels.length || !series.length) {
		clearProgress();
		setStatusText("No historical points found.");
		return;
	}

	// Group variants by store
	const variantsByStore = new Map(); // storeLabel -> series[]
	for (const s of series) {
		const k = String(s.label || "Store");
		if (!variantsByStore.has(k)) variantsByStore.set(k, []);
		variantsByStore.get(k).push(s);
	}

	// Merge per-store (min across variants) for sorting + markers
	function mergeStorePoints(vars) {
		const points = new Map();
		const values = [];
		for (const d of labels) {
			let v = null;
			for (const s of vars) {
				const vv = s.points.has(d) ? s.points.get(d) : null;
				if (Number.isFinite(vv)) v = v === null ? vv : Math.min(v, vv);
			}
			points.set(d, v);
			if (v !== null) values.push(v);
		}
		return { points, values };
	}

	const todayKey = today;

	const storeSeries = Array.from(variantsByStore.entries()).map(([label, vars]) => {
		const merged = mergeStorePoints(vars);
		const todayVal = merged.points.has(todayKey) ? merged.points.get(todayKey) : null;
		const lastVal =
			todayVal !== null ? todayVal : lastFiniteFromEnd(labels.map((d) => merged.points.get(d)));
		return { label, vars, merged, sortVal: Number.isFinite(lastVal) ? lastVal : null };
	});

	const storeSeriesSorted = storeSeries.slice().sort((a, b) => {
		const av = a.sortVal,
			bv = b.sortVal;
		if (av === null && bv === null) return a.label.localeCompare(b.label);
		if (av === null) return 1;
		if (bv === null) return -1;
		if (av !== bv) return av - bv;
		return a.label.localeCompare(b.label);
	});

	const colorMap = buildStoreColorMap(storeSeriesSorted.map((x) => x.label));

	// --- If multiple points exist on a given date for the same store, only show the cheapest one ---
	const winnerByStoreDate = new Map(); // `${store}|${date}` -> variantKey
	for (const st of storeSeriesSorted) {
		const vars = st.vars
			.slice()
			.sort((a, b) => String(a.variantKey).localeCompare(String(b.variantKey)));
		for (const d of labels) {
			let bestKey = null;
			let bestVal = Infinity;
			for (const s of vars) {
				const v = s.points.has(d) ? s.points.get(d) : null;
				if (!Number.isFinite(v)) continue;
				if (v < bestVal) {
					bestVal = v;
					bestKey = s.variantKey;
				}
			}
			if (bestKey !== null) winnerByStoreDate.set(`${st.label}|${d}`, bestKey);
		}
	}
	const winKeyFor = (store, date) => winnerByStoreDate.get(`${store}|${date}`) ?? null;

	// Build datasets: multiple lines per store, same label, same color, same stroke
	const datasets = [];
	const suppressDots = window.innerWidth <= 640 && winnerByStoreDate.size > 50;
	for (const st of storeSeriesSorted) {
		const base = storeColor(st.label, colorMap);
		const stroke = lighten(base, 0.25);

		// stable ordering within store so colors don't flicker
		const vars = st.vars
			.slice()
			.sort((a, b) => String(a.variantKey).localeCompare(String(b.variantKey)));

		for (const s of vars) {
			datasets.push({
				label: st.label, // IMPORTANT: no SKU in label
				variantKey: s.variantKey,
				data: labels.map((d) => (s.points.has(d) ? s.points.get(d) : null)),
				spanGaps: false,
				tension: 0.15,
				backgroundColor: base,
				borderColor: stroke,
				pointBackgroundColor: base,
				pointBorderColor: stroke,
				borderWidth: datasetStrokeWidth(base),
				pointRadius: (ctx) => {
					if (suppressDots) return 0;
					const v = ctx.parsed?.y;
					if (!Number.isFinite(v)) return 0;
					const d = labels[ctx.dataIndex];
					return ctx.dataset.variantKey === winKeyFor(ctx.dataset.label, d) ? 3 : 0;
				},
				pointHoverRadius: (ctx) => {
					if (suppressDots) return 0;
					const v = ctx.parsed?.y;
					if (!Number.isFinite(v)) return 0;
					const d = labels[ctx.dataIndex];
					return ctx.dataset.variantKey === winKeyFor(ctx.dataset.label, d) ? 5 : 0;
				},
			});
		}
	}

	// --- Compute marker values (use merged per-store series) ---
	const storeMeans = storeSeriesSorted
		.map((st) => ({ label: st.label, mean: weightedMeanByDuration(st.merged.points, labels) }))
		.filter((x) => Number.isFinite(x.mean));

	const bcMeans = storeMeans.filter((x) => isBcStoreLabel(x.label));
	const abMeans = storeMeans.filter((x) => !isBcStoreLabel(x.label));

	const markers = [];

	if (bcMeans.length >= 3) {
		const y = medianFinite(bcMeans.map((x) => x.mean));
		if (Number.isFinite(y)) markers.push({ y: Math.round(y), text: "BC" });
	}

	if (abMeans.length >= 3) {
		const y = medianFinite(abMeans.map((x) => x.mean));
		if (Number.isFinite(y)) markers.push({ y: Math.round(y), text: "Alberta" });
	}

	// Collect all finite values across ALL lines for y-scale + uniqueness check
	const allVals = [];
	for (const ds of datasets) {
		for (const v of ds.data) if (Number.isFinite(v)) allVals.push(v);
	}

	const ySug = computeSuggestedY(allVals);

	const MIN_STEP = 10; // never denser than $10
	const MAX_TICKS = 12; // cap tick count when span is huge

	const span = (ySug.suggestedMax ?? 0) - (ySug.suggestedMin ?? 0);
	const step = niceStepAtLeast(MIN_STEP, span, MAX_TICKS);

	// Target price: pick 3 lowest per-store mins (distinct stores), then average (>=3 stores)
	// Only show if there are at least 6 total unique price points (finite) across the chart.
	const uniquePricePoints = new Set(
		allVals.filter((v) => Number.isFinite(v)).map((v) => Math.round(v * 100)),
	);
	const hasEnoughUniquePoints = uniquePricePoints.size >= 6;

	const storeMins = storeSeriesSorted
		.map((st) => ({ label: st.label, min: minFinite(st.merged.values) }))
		.filter((x) => Number.isFinite(x.min))
		.sort((a, b) => a.min - b.min);

	if (hasEnoughUniquePoints && storeMins.length >= 3) {
		const t = (storeMins[0].min + storeMins[1].min + storeMins[2].min) / 3;
		if (Number.isFinite(t)) markers.push({ y: Math.round(t), text: "Target" });
	}

	const markerYs = markers.map((m) => Number(m.y)).filter(Number.isFinite);

	// helper: approximate font px size from a CSS font string (Chart uses one)
	function fontPx(font) {
		const m = String(font || "").match(/(\d+(?:\.\d+)?)px/);
		return m ? Number(m[1]) : 12;
	}

	const ctx = $canvas.getContext("2d");
	CHART = new Chart(ctx, {
		type: "line",
		data: { labels, datasets },
		plugins: [StaticMarkerLinesPlugin],
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "nearest", intersect: false },

			// v2 fallback (plugin reads this)
			staticMarkerLines: {
				markers,
				color: "#7f8da3",
				alpha: 0.38,
				lineWidth: 1.25,
				labelColor: "#556274",
				axisInset: 2,
			},

			// v3 fallback (plugin reads this too)
			plugins: {
				// v3+ (plugin reads this too)
				staticMarkerLines: {
					markers,
					color: "#7f8da3",
					alpha: 0.38,
					lineWidth: 1.25,
					labelColor: "#556274",
					axisInset: 2,
				},

				// De-dupe legend items by label WITHOUT changing legend styling.
				legend: {
					display: true,
					labels: {
						generateLabels: (chart) => {
							const gen = Chart?.defaults?.plugins?.legend?.labels?.generateLabels;
							const items = typeof gen === "function" ? gen(chart) : [];

							const seen = new Map(); // text -> { item, idxs }
							for (const it of items) {
								const t = String(it.text || "");
								if (!seen.has(t)) {
									seen.set(t, { item: { ...it, _group: [it.datasetIndex] } });
								} else {
									seen.get(t).item._group.push(it.datasetIndex);
								}
							}

							// make "hidden" reflect ALL datasets in the group
							const out = [];
							for (const { item } of seen.values()) {
								const idxs = item._group || [item.datasetIndex];
								const allHidden = idxs.every((j) => chart.getDatasetMeta(j).hidden === true);
								out.push({ ...item, hidden: allHidden, datasetIndex: idxs[0], _group: idxs });
							}
							return out;
						},
					},
					onClick: (_e, legendItem, legend) => {
						const chart = legend.chart;
						const idxs = legendItem._group || [legendItem.datasetIndex];

						// toggle all as a group
						const anyVisible = idxs.some((j) => chart.getDatasetMeta(j).hidden !== true);
						for (const j of idxs) {
							if (typeof chart.setDatasetVisibility === "function")
								chart.setDatasetVisibility(j, !anyVisible);
							else chart.getDatasetMeta(j).hidden = anyVisible ? true : null;
						}
						chart.update();
					},
				},

				tooltip: {
					filter: (tctx) => {
						const store = String(tctx.dataset?.label || "");
						const date = String(tctx.label || "");
						return tctx.dataset?.variantKey === winKeyFor(store, date);
					},
					callbacks: {
						label: (ctx) => {
							const v = ctx.parsed?.y;
							if (!Number.isFinite(v)) return `${ctx.dataset.label}: (no data)`;
							return `${ctx.dataset.label}: $${v.toFixed(2)}`;
						},
					},
				},
			},
			// layout: {
			// padding: { right: 18 }
			// },
			scales: {
				x: {
					ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: window.innerWidth <= 640 ? 3 : 12 },
					grid: { display: false },
				},
				y: {
					...ySug,
					ticks: {
						stepSize: step,
						maxTicksLimit: MAX_TICKS,
						padding: 10,
						callback: function (v) {
							const val = Number(v);
							if (!Number.isFinite(val)) return "";

							// if no markers, normal label
							if (!markerYs.length || typeof this.getPixelForValue !== "function") {
								return `$${val.toFixed(0)}`;
							}

							const py = this.getPixelForValue(val);
							if (!Number.isFinite(py)) return `$${val.toFixed(0)}`;

							// derive a "collision window" from tick label height
							// Chart.js puts resolved font on ticks.font (v3+), otherwise fall back
							const tickFont = this?.options?.ticks?.font || this?.ctx?.font || "12px system-ui";

							const h = fontPx(
								typeof tickFont === "string"
									? tickFont
									: `${tickFont?.size || 12}px ${tickFont?.family || "system-ui"}`,
							);

							// hide if within 55% of label height (tweak 0.45–0.75)
							const COLLIDE_PX = Math.max(6, h * 0.75);

							for (const my of markerYs) {
								const pmy = this.getPixelForValue(my);
								if (!Number.isFinite(pmy)) continue;
								if (pmy < this.top || pmy > this.bottom) continue;

								if (Math.abs(py - pmy) <= COLLIDE_PX) return "";
							}

							return `$${val.toFixed(0)}`;
						},
					},
				},
			},
		},
	});

	const yScale = CHART.scales?.y;
	const tickCount = yScale?.ticks?.length || 0;

	if (tickCount >= 2) {
		const minRange = (tickCount - 1) * 10; // $10 per gap, same number of gaps as before
		const ySug2 = computeSuggestedY(allVals, minRange);

		CHART.options.scales.y.suggestedMin = ySug2.suggestedMin;
		CHART.options.scales.y.suggestedMax = ySug2.suggestedMax;
		CHART.options.scales.y.ticks.stepSize = 10; // lock spacing at $10 now

		CHART.update();
	}

	clearProgress();
	setStatusText(
		isRemovedEverywhere
			? `History loaded (removed everywhere). Points=${labels.length}.`
			: `History loaded. Points=${labels.length}.`,
	);
}
