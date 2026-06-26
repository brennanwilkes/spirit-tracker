/**
 * Chart drawing utilities for the stats page.
 * Extracted from stats_page.js.
 *
 * Exports:
 *   - destroyStatsChart   Tear down the current Chart.js instance
 *   - drawOrUpdateChart   Create or update the stats line chart
 */

import { buildStoreColorMap, storeColor, lighten } from "../storeColors.js";
import { storeById } from "../stores.js";

let _chart = null;

function displayStoreName(storeKey) {
	const store = storeById(String(storeKey || ""));
	return store ? store.label : storeKey;
}

// ── Chart.js loader ───────────────────────────────────────────────────────

function ensureChartJs() {
	if (window.Chart) return Promise.resolve(window.Chart);

	return new Promise((resolve, reject) => {
		const s = document.createElement("script");
		// UMD build -> window.Chart
		s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
		s.async = true;
		s.onload = () => resolve(window.Chart);
		s.onerror = () => reject(new Error("Failed to load Chart.js"));
		document.head.appendChild(s);
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────

function lastFiniteFromEnd(arr) {
	if (!Array.isArray(arr)) return null;
	for (let i = arr.length - 1; i >= 0; i--) {
		const v = arr[i];
		if (Number.isFinite(v)) return v;
	}
	return null;
}

function borderWidthFromCoverage(c) {
	const x = Math.max(0, Math.min(Number(c) || 0, 1));
	// much less in the middle, big jump near high coverage
	return 1.0 + 4.5 * Math.pow(x, 2.4); // 1.0px .. 5.5px
}

export function stepForDollarsSpan(span) {
	const s = Math.abs(Number(span) || 0);
	if (s <= 10) return 1;
	if (s <= 25) return 2;
	if (s <= 60) return 5;
	if (s <= 150) return 10;
	if (s <= 300) return 25;
	return 50;
}

function formatSignedDollars(n) {
	if (!Number.isFinite(n)) return "";
	const v = Math.round(n);
	if (v === 0) return "$0";
	return v < 0 ? `-$${Math.abs(v)}` : `+$${v}`;
}

// ── Chart lifecycle ───────────────────────────────────────────────────────

export function destroyStatsChart() {
	try {
		if (_chart) _chart.destroy();
	} catch {}
	_chart = null;
}

export function resizeStatsChart() {
	try {
		if (!_chart) return;
		_chart.resize();
		const canvas = document.getElementById("statsChart");
		const hPx = canvas?.clientHeight || canvas?.parentElement?.clientHeight || 320;
		const maxTicks = Math.max(4, Math.min(10, Math.round(hPx / 44)));
		const yt = _chart.options?.scales?.y?.ticks;
		if (yt && yt.maxTicksLimit !== maxTicks) {
			yt.maxTicksLimit = maxTicks;
			_chart.update("none");
		}
	} catch {}
}

export async function drawOrUpdateChart(series, yBounds) {
	const {
		labels,
		stores,
		seriesByStore,
		coverageSeriesByStore,
		marketMedianTrend,
		marketFloorTrend,
		valueMode,
		marketOnly,
	} = series;

	const Chart = await ensureChartJs();
	const canvas = document.getElementById("statsChart");
	if (!canvas) return;

	const order = stores
		.map((s) => ({ s, v: lastFiniteFromEnd(seriesByStore[s]) }))
		.sort((a, b) => {
			const av = a.v,
				bv = b.v;
			if (av === null && bv === null)
				return displayStoreName(a.s).localeCompare(displayStoreName(b.s));
			if (av === null) return 1;
			if (bv === null) return -1;
			if (av !== bv) return av - bv; // cheapest (lowest index) first
			return displayStoreName(a.s).localeCompare(displayStoreName(b.s));
		})
		.map((x) => x.s);

	const colorMap = buildStoreColorMap(order);

	const storeDatasets = marketOnly ? [] : order.map((s) => {
		const base = storeColor(s, colorMap);
		const stroke = lighten(base, 0.25);

		const covArr = Array.isArray(coverageSeriesByStore?.[s]) ? coverageSeriesByStore[s] : [];
		const lastCov = covArr.length ? covArr[covArr.length - 1] : 0;

		return {
			label: displayStoreName(s),
			data: Array.isArray(seriesByStore[s]) ? seriesByStore[s] : labels.map(() => null),
			spanGaps: true,
			tension: 0.15,
			backgroundColor: base,
			borderColor: stroke,
			pointBackgroundColor: base,
			pointBorderColor: stroke,
			pointRadius: 0,
			pointHoverRadius: 0,
			pointHitRadius: 6,

			// legend / fallback width
			borderWidth: borderWidthFromCoverage(lastCov),

			// width and dash vary per segment; dashed + faded when spanning a gap
			segment: {
				borderWidth: (ctx3) => {
					if (ctx3.p0.skip || ctx3.p1.skip) return 1;
					const i = ctx3.p1DataIndex ?? ctx3.p0DataIndex ?? 0;
					return borderWidthFromCoverage(covArr[i] ?? 0);
				},
				borderDash: (ctx3) => (ctx3.p0.skip || ctx3.p1.skip ? [4, 4] : []),
				borderColor: (ctx3) => {
					if (!(ctx3.p0.skip || ctx3.p1.skip)) return stroke;
					const m = stroke.replace("#", "");
					if (m.length !== 6) return stroke;
					const n = parseInt(m, 16);
					return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.25)`;
				},
			},
		};
	});

	const datasets = [...storeDatasets];

	datasets.push({
		label: "Market Median",
		data: Array.isArray(marketMedianTrend) ? marketMedianTrend : labels.map(() => null),
		spanGaps: true,
		tension: 0.15,
		backgroundColor: "rgba(160,160,160,0.9)",
		borderColor: "rgba(160,160,160,0.9)",
		borderDash: [6, 4],
		pointRadius: 0,
		pointHoverRadius: 0,
		pointHitRadius: 6,
		borderWidth: 1.75,
		segment: {
			borderColor: (ctx3) =>
				ctx3.p0.skip || ctx3.p1.skip ? "rgba(160,160,160,0.2)" : "rgba(160,160,160,0.9)",
			borderDash: (ctx3) => (ctx3.p0.skip || ctx3.p1.skip ? [2, 6] : [6, 4]),
		},
	});

	datasets.push({
		label: "Market Floor",
		data: Array.isArray(marketFloorTrend) ? marketFloorTrend : labels.map(() => null),
		spanGaps: true,
		tension: 0.15,
		backgroundColor: "rgba(160,160,160,0.9)",
		borderColor: "rgba(160,160,160,0.9)",
		borderDash: [6, 4],
		pointRadius: 0,
		pointHoverRadius: 0,
		pointHitRadius: 6,
		borderWidth: 1.75,
		segment: {
			borderColor: (ctx3) =>
				ctx3.p0.skip || ctx3.p1.skip ? "rgba(160,160,160,0.2)" : "rgba(160,160,160,0.9)",
			borderDash: (ctx3) => (ctx3.p0.skip || ctx3.p1.skip ? [2, 6] : [6, 4]),
		},
	});

	const isDollars = valueMode === "dollars";

	// y tick step for $ mode
	let yStep = 1;
	if (isDollars && yBounds) {
		const span = (yBounds.max ?? 0) - (yBounds.min ?? 0);
		yStep = stepForDollarsSpan(span);

		// snap bounds to step so ticks land nicely
		yBounds = {
			min: Math.floor((yBounds.min ?? 0) / yStep) * yStep,
			max: Math.ceil((yBounds.max ?? 0) / yStep) * yStep,
		};
	}

	const yTitle = isDollars ? "Avg Δ$ vs per-SKU baseline" : "Avg % vs per-SKU baseline";

	const tooltipLabel = (ctx2) => {
		const v = ctx2.parsed?.y;
		if (!Number.isFinite(v)) return `${ctx2.dataset.label}: (no data)`;
		return isDollars
			? `${ctx2.dataset.label}: ${formatSignedDollars(v)}`
			: `${ctx2.dataset.label}: ${v.toFixed(2)}%`;
	};

	const yTickCallback = (v) => {
		const n = Number(v);
		if (!Number.isFinite(n)) return "";
		if (isDollars) {
			const r = Math.round(n);
			if (r === 0) return "$0";
			return r < 0 ? `-$${Math.abs(r)}` : `$${r}`;
		}
		return `${n.toFixed(0)}%`;
	};

	// Tick density follows available pixel height so a tall range doesn't bunch up
	// on a short mobile chart (~44px min spacing per label).
	const hPx = canvas.clientHeight || canvas.parentElement?.clientHeight || 320;
	const maxTicks = Math.max(4, Math.min(10, Math.round(hPx / 44)));

	const yTicks = isDollars
		? {
				stepSize: yStep,
				precision: 0,
				autoSkip: true,
				maxTicksLimit: maxTicks,
				callback: yTickCallback,
			}
		: {
				precision: 0,
				autoSkip: true,
				maxTicksLimit: maxTicks,
				callback: yTickCallback,
			};

	if (_chart) {
		_chart.data.labels = labels;
		_chart.data.datasets = datasets;

		if (yBounds) {
			_chart.options.scales.y.min = yBounds.min;
			_chart.options.scales.y.max = yBounds.max;
		}

		_chart.options.scales.y.title.text = yTitle;
		_chart.options.scales.y.ticks = yTicks;
		_chart.options.plugins.tooltip.callbacks.label = tooltipLabel;

		_chart.update("none");
		buildStatsLegend(_chart);
		return;
	}

	const ctx = canvas.getContext("2d");
	_chart = new Chart(ctx, {
		type: "line",
		data: { labels, datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			interaction: { mode: "nearest", intersect: false },
			plugins: {
				// On-canvas legend replaced by the collapsible HTML panel (#statsLegend)
				// below the chart — see buildStatsLegend().
				legend: { display: false },
				tooltip: {
					callbacks: { label: tooltipLabel },
				},
			},
			scales: {
				x: {
					title: { display: true, text: "Date" },
					ticks: {
						maxRotation: 0,
						autoSkip: true,
						maxTicksLimit: window.innerWidth <= 640 ? 4 : 12,
					},
				},
				y: {
					min: yBounds?.min,
					max: yBounds?.max,
					title: { display: true, text: yTitle },
					ticks: yTicks,
					grid: {
						drawBorder: false,
						color: (ctx) =>
							ctx.tick.value === 0 ? "rgba(154,166,178,0.35)" : "rgba(154,166,178,0.18)",
						lineWidth: 1,
					},
				},
			},
		},
	});
	buildStatsLegend(_chart);
}

// Off-canvas collapsible legend (#statsLegend) — one entry per dataset (store
// series + market lines). Click toggles that series' visibility. Mirrors the
// item page's chart legend; rebuilt on every draw since filters change datasets.
function buildStatsLegend(chart) {
	const panel = document.getElementById("statsLegend");
	const list = document.getElementById("statsLegendList");
	const countEl = document.getElementById("statsLegendCount");
	if (!panel || !list || !countEl) return;

	const datasets = chart.data.datasets || [];
	if (datasets.length === 0) {
		panel.hidden = true;
		return;
	}

	panel.hidden = false;
	countEl.textContent = `Series (${datasets.length})`;

	const frag = document.createDocumentFragment();
	datasets.forEach((ds, i) => {
		const label = String(ds.label || `Series ${i + 1}`);
		const hidden = chart.getDatasetMeta(i).hidden === true;
		const item = document.createElement("button");
		item.type = "button";
		item.className = "chartLegendItem" + (hidden ? " dimmed" : "");
		const swatch = typeof ds.borderColor === "string" ? ds.borderColor : "var(--muted)";
		item.innerHTML = `<span class="chartLegendSwatch" style="background:${swatch}"></span><span class="chartLegendLabel"></span>`;
		item.querySelector(".chartLegendLabel").textContent = label;
		item.addEventListener("click", () => {
			const nowHidden = chart.getDatasetMeta(i).hidden !== true;
			chart.setDatasetVisibility(i, !nowHidden);
			chart.update();
			item.classList.toggle("dimmed", nowHidden);
		});
		frag.appendChild(item);
	});
	list.replaceChildren(frag);
}
