/**
 * Chart utilities and the StaticMarkerLinesPlugin for the item detail page.
 * Extracted from item_page.js.
 *
 * Exports:
 *   - StaticMarkerLinesPlugin    Custom Chart.js plugin that draws reference lines
 *   - isBcStoreLabel             Detect BC stores (for BC vs Alberta median markers)
 *   - weightedMeanByDuration     Time-weighted average for a price series
 *   - meanFinite                 Arithmetic mean, ignoring non-finite values
 *   - minFinite                  Minimum, ignoring non-finite values
 *   - medianFinite               Median, ignoring non-finite values
 *   - computeSuggestedY          Compute Chart.js suggestedMin/suggestedMax
 *   - niceStepAtLeast            Compute a "nice" tick step size
 *   - lastFiniteFromEnd          Last finite value in an array (working from the end)
 *   - monthYearXAxis             Shared x-axis ticks (item + stats charts): Mon YYYY, pinned at both ends
 *   - computeSummarySeries       Province medians/bands + 90-day moving Target for Summary mode
 */

import { normalizeStoreId, storeById, storesByRegion } from "../stores.js";

// ── Province classification ────────────────────────────────────────────────

export function isBcStoreLabel(label) {
	const store = storeById(normalizeStoreId(label));
	if (store === null) throw new Error(`isBcStoreLabel: no store in the registry for label "${label}"`);
	return store.region === "bc";
}

// ── Statistical helpers ────────────────────────────────────────────────────

/**
 * Time-weighted mean: weights each value by the duration until the next date.
 * @param {Map<string, number|null>} pointsMap  dateStr → price
 * @param {string[]} sortedDates                sorted ascending
 */
export function weightedMeanByDuration(pointsMap, sortedDates) {
	let wsum = 0;
	let wtot = 0;

	for (let i = 0; i < sortedDates.length; i++) {
		const d0 = sortedDates[i];
		const v = pointsMap.get(d0);
		if (!Number.isFinite(v)) continue;

		const t0 = Date.parse(d0 + "T00:00:00Z");
		const d1 = sortedDates[i + 1];
		const t1 = d1 ? Date.parse(d1 + "T00:00:00Z") : t0 + 24 * 3600 * 1000;

		const w = Math.max(1, Math.round((t1 - t0) / (24 * 3600 * 1000)));
		wsum += v * w;
		wtot += w;
	}

	return wtot ? wsum / wtot : null;
}

export function meanFinite(arr) {
	if (!Array.isArray(arr)) return null;
	let sum = 0,
		n = 0;
	for (const v of arr) {
		if (Number.isFinite(v)) {
			sum += v;
			n++;
		}
	}
	return n ? sum / n : null;
}

export function minFinite(arr) {
	if (!Array.isArray(arr)) return null;
	let m = null;
	for (const v of arr) {
		if (Number.isFinite(v)) m = m === null ? v : Math.min(m, v);
	}
	return m;
}

export function medianFinite(nums) {
	const a = (Array.isArray(nums) ? nums : [])
		.filter((v) => Number.isFinite(v))
		.slice()
		.sort((x, y) => x - y);
	const n = a.length;
	if (!n) return null;
	const mid = Math.floor(n / 2);
	return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function lastFiniteFromEnd(arr) {
	if (!Array.isArray(arr)) return null;
	for (let i = arr.length - 1; i >= 0; i--) {
		const v = arr[i];
		if (Number.isFinite(v)) return v;
	}
	return null;
}

// ── Summary mode series ────────────────────────────────────────────────────
// Design + measurements: docs/item-chart-summary-mode-feasibility.md.

// A store that goes out of stock keeps its last price in the medians for this many
// days. Without it ~2/3 of median moves were stores leaving/re-entering the set.
export const SUMMARY_HOLD_DAYS = 7;
// A province's line starts the day ONE store carries the item (owner call 2026-10-12: show a
// market the moment it gets a bottle). How thin that support is shows in the line width.
export const SUMMARY_MEDIAN_MIN_STORES = 1;
export const SUMMARY_TARGET_WINDOW_DAYS = 90;
// Summary lines are trends, not price levels (owner call 2026-10-12: day-to-day steps read as
// blocky). A centred 7-day rolling median first drops the 1–3 day flips a median makes as the
// store mix shifts, then a centred 15-day rolling mean turns each remaining step into a ramp.
// Windows shrink at the edges; days with no value stay gaps.
export const SUMMARY_DESPIKE_DAYS = 7;
export const SUMMARY_SMOOTH_DAYS = 15;

function rolling(arr, width, reduce) {
	const half = Math.floor(width / 2);
	return arr.map((v, i) => {
		if (v === null) return null;
		const win = [];
		for (let k = Math.max(0, i - half); k <= Math.min(arr.length - 1, i + half); k++) {
			if (arr[k] !== null) win.push(arr[k]);
		}
		return reduce(win);
	});
}

function smoothTrend(arr) {
	const despiked = rolling(arr, SUMMARY_DESPIKE_DAYS, (w) => quantileSorted(w.sort((a, b) => a - b), 0.5));
	return rolling(despiked, SUMMARY_SMOOTH_DAYS, (w) => w.reduce((a, b) => a + b, 0) / w.length);
}

function quantileSorted(a, q) {
	const pos = (a.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/**
 * Per-day province medians ± a smoothed standard-deviation band, and the 90-day moving Target.
 * labels[] is one entry per calendar day, so an index delta is a day delta.
 *
 * @param {Array<{label:string, merged:{points:Map<string, number|null>}}>} stores
 * @param {string[]} labels
 */
export function computeSummarySeries(stores, labels) {
	const days = labels.length;
	const raw = stores.map((st) => labels.map((d) => {
		const v = st.merged.points.get(d);
		return Number.isFinite(v) ? v : null;
	}));

	const held = raw.map((vals) => {
		const out = vals.slice();
		let last = null;
		let lastIdx = -1;
		for (let i = 0; i < days; i++) {
			if (vals[i] !== null) {
				last = vals[i];
				lastIdx = i;
			} else if (lastIdx >= 0 && i - lastIdx <= SUMMARY_HOLD_DAYS) {
				out[i] = last;
			}
		}
		return out;
	});

	const isBc = stores.map((st) => isBcStoreLabel(st.label));

	// The band is the smoothed median ± one standard deviation of store prices around it.
	// Deviations are taken from each day's own median (so a price move doesn't read as
	// spread) and pooled over a centred SUMMARY_SMOOTH_DAYS window, so the band exists on
	// every day the median does, and a day with only 3 stores borrows from its neighbours
	// instead of cutting the band in and out.
	function region(wantBc) {
		const median = new Array(days).fill(null);
		const stores = new Array(days).fill(null);
		const sqDevs = new Array(days).fill(null);
		for (let i = 0; i < days; i++) {
			const vals = [];
			for (let s = 0; s < stores.length; s++) {
				if (isBc[s] === wantBc && held[s][i] !== null) vals.push(held[s][i]);
			}
			if (vals.length < SUMMARY_MEDIAN_MIN_STORES) continue;
			vals.sort((a, b) => a - b);
			stores[i] = vals.length;
			median[i] = quantileSorted(vals, 0.5);
			sqDevs[i] = vals.map((v) => (v - median[i]) ** 2);
		}
		const half = Math.floor(SUMMARY_SMOOTH_DAYS / 2);
		const sigma = sqDevs.map((dev, i) => {
			if (dev === null) return null;
			let sum = 0;
			let n = 0;
			for (let k = Math.max(0, i - half); k <= Math.min(days - 1, i + half); k++) {
				if (sqDevs[k] === null) continue;
				for (const d of sqDevs[k]) sum += d;
				n += sqDevs[k].length;
			}
			return Math.sqrt(sum / n);
		});
		const mid = smoothTrend(median);
		const spread = smoothTrend(sigma);
		// Share of the province's tracked stores carrying it, smoothed like the lines so the
		// width ramps instead of stepping.
		const tracked = storesByRegion(wantBc ? "bc" : "ab").length;
		return {
			stores,
			coverage: smoothTrend(stores.map((n) => (n === null ? null : n / tracked))),
			median: mid,
			lo: mid.map((m, i) => (m === null ? null : m - spread[i])),
			hi: mid.map((m, i) => (m === null ? null : m + spread[i])),
		};
	}

	// Trailing, not centred, so a drawn value never changes as new days arrive. Always a
	// full window: until 90 days of data exist, every day uses the FIRST 90 days of the
	// item's data (a shrinking window started the line on a handful of early prices).
	// No hold: a sold-out store's low price isn't on offer.
	const target = new Array(days).fill(null);
	const firstData = raw.reduce((lo, vals) => {
		const i = vals.findIndex((v) => v !== null);
		return i >= 0 && (lo === null || i < lo) ? i : lo;
	}, null);
	for (let i = firstData ?? days; i < days; i++) {
		const to = Math.min(days - 1, Math.max(i, firstData + SUMMARY_TARGET_WINDOW_DAYS - 1));
		const from = to - SUMMARY_TARGET_WINDOW_DAYS + 1;
		const mins = [];
		for (const vals of raw) {
			let m = null;
			for (let k = Math.max(0, from); k <= to; k++) {
				if (vals[k] !== null && (m === null || vals[k] < m)) m = vals[k];
			}
			if (m !== null) mins.push(m);
		}
		if (mins.length < 3) continue;
		mins.sort((a, b) => a - b);
		target[i] = (mins[0] + mins[1] + mins[2]) / 3;
	}

	return { bc: region(true), ab: region(false), target: smoothTrend(target) };
}

// ── Y-axis helpers ─────────────────────────────────────────────────────────

/**
 * When many stores are tracked, one or two that price way above the rest stretch
 * the y-axis and squash all the meaningful detail into a thin band. This detects
 * such high outliers and returns a y-axis cap (the highest "normal" price) so the
 * chart fills with the bulk of the data while outlier lines simply clip near the
 * top. Low prices are never capped — this only ever returns an upper bound, and
 * returns null when no capping should apply.
 *
 * @param {Array<{label:string, rep:number, values:number[]}>} stores  per-store label, representative price, data points
 * @param {object} [opts]
 * @param {number} [opts.minStores=5]  only engage past this many stores ("more than 4")
 * @returns {{cap:number, outliers:Set<string>}|null}
 */
export function computeHighOutlierCap(stores, opts = {}) {
	const minStores = Number.isFinite(opts.minStores) ? opts.minStores : 5;
	const list = (Array.isArray(stores) ? stores : []).filter((s) => Number.isFinite(s?.rep));
	if (list.length < minStores) return null;

	const reps = list.map((s) => s.rep);
	const median = medianFinite(reps);
	if (!Number.isFinite(median) || median <= 0) return null;

	const mad = medianFinite(reps.map((r) => Math.abs(r - median)));
	const scaledMad = Number.isFinite(mad) ? mad * 1.4826 : 0;

	// A store is a high outlier only if it clears the median by BOTH a robust
	// statistical margin and a generous relative margin — it must be "way" above.
	const threshold = median + Math.max(3 * scaledMad, median * 0.6);

	const normal = list.filter((s) => s.rep <= threshold);
	if (normal.length === list.length) return null; // nothing way above the pack

	const outliers = new Set(list.filter((s) => s.rep > threshold).map((s) => String(s.label)));

	let cap = null;
	for (const s of normal) {
		for (const v of Array.isArray(s.values) ? s.values : []) {
			if (Number.isFinite(v) && (cap === null || v > cap)) cap = v;
		}
	}
	if (cap === null) return null;
	return { cap, outliers };
}

/**
 * Compute Chart.js suggestedMin / suggestedMax with optional minimum span.
 *
 * @param {number[]} values
 * @param {number} [minRange]  enforce a minimum visible span
 * @param {number} [maxCap]    clamp the upper bound (e.g. from computeHighOutlierCap)
 * @param {number} [padRatio]  fraction of range to add above/below (default 0.08)
 */
export function computeSuggestedY(values, minRange, maxCap, padRatio = 0.08) {
	const nums = values.filter((v) => Number.isFinite(v));
	if (!nums.length) return { suggestedMin: undefined, suggestedMax: undefined };

	let min = nums[0],
		max = nums[0];
	for (const n of nums) {
		if (n < min) min = n;
		if (n > max) max = n;
	}

	if (Number.isFinite(maxCap) && maxCap < max) max = maxCap;

	const range = max - min;
	const pad = range === 0 ? Math.max(1, min * 0.05) : range * padRatio;

	let suggestedMin = Math.max(0, min - pad);
	let suggestedMax = max + pad;

	if (Number.isFinite(minRange) && minRange > 0) {
		const span = suggestedMax - suggestedMin;
		if (span < minRange) {
			const mid = (suggestedMin + suggestedMax) / 2;
			suggestedMin = mid - minRange / 2;
			suggestedMax = mid + minRange / 2;
			if (suggestedMin < 0) {
				suggestedMax -= suggestedMin;
				suggestedMin = 0;
			}
		}
	}

	return { suggestedMin, suggestedMax };
}

/**
 * Compute a "nice" tick step size that is at least minStep.
 */
export function niceStepAtLeast(minStep, span, maxTicks) {
	if (!Number.isFinite(span) || span <= 0) return minStep;
	const target = span / Math.max(1, maxTicks - 1);
	const raw = Math.max(minStep, target);
	const pow = Math.pow(10, Math.floor(Math.log10(raw)));
	const m = raw / pow;
	const niceM = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
	return Math.max(minStep, niceM * pow);
}

// ── X axis: Month Year ticks ───────────────────────────────────────────────

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Room each "Sep 2026" label needs, gap included: a ~290 px plot (360 px phone) gets 3 ticks.
const MONTH_TICK_PX = 95;

function monthYearOf(dateStr) {
	const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateStr));
	if (!m) throw new Error(`monthYearOf: expected YYYY-MM-DD, got "${dateStr}"`);
	return `${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * Category x-axis options (spread into scales.x) for YYYY-MM-DD labels: a tick on the
 * first and last label, pinned flush to the plot edges, plus month ticks between as the
 * width allows, all shown as "Mon YYYY". Middle ticks sit on the first label of their
 * month: an evenly spaced tick could land on Feb 26 and read "Feb" with the next one
 * already "Apr".
 */
export function monthYearXAxis() {
	return {
		afterBuildTicks: (scale) => {
			const labels = scale.chart.data.labels;
			const n = labels.length;
			if (n === 0) return;
			const text = (i) => monthYearOf(labels[i]);
			const last = n - 1;
			const count = Math.max(2, Math.min(8, Math.floor(scale.chart.width / MONTH_TICK_PX)));
			const spacing = last / (count - 1);

			// The end ticks' own months are already labelled; a month start that close to
			// an end would crowd its label.
			const monthStarts = [];
			for (let i = 1; i < last; i++) {
				if (text(i) === text(i - 1) || text(i) === text(last)) continue;
				if (i < spacing / 2 || last - i < spacing / 2) continue;
				monthStarts.push(i);
			}

			// Every month, or every 2nd, 3rd …, whichever fits: a steady cadence never skips
			// one month while showing its neighbours.
			const picked = [0];
			const slots = count - 2;
			if (slots > 0 && monthStarts.length > 0) {
				const step = Math.ceil(monthStarts.length / slots);
				const offset = Math.floor(((monthStarts.length - 1) % step) / 2);
				for (let j = offset; j < monthStarts.length; j += step) picked.push(monthStarts[j]);
			}
			if (last > 0 && text(last) !== text(0)) picked.push(last);
			scale.ticks = picked.map((i) => ({ value: i }));
		},
		ticks: {
			autoSkip: false,
			maxRotation: 0,
			// First label left-aligned to the plot's start, last right-aligned to its end.
			align: "inner",
			callback: function (value) {
				return monthYearOf(this.getLabelForValue(value));
			},
		},
	};
}

// ── Custom Chart.js plugin ─────────────────────────────────────────────────

export const MARKER_LABEL_PX = 11;

/**
 * Where each marker's label is drawn on the y axis. Two markers a few dollars apart
 * would print their labels on top of each other, so labels closer than one line apart
 * are pushed apart (kept inside [top, bottom]); the marker line itself stays at its
 * true value. Shared by the plugin and the y-tick callback, which hides any tick
 * whose label would land on one of these.
 *
 * @returns {Array<{marker:object, py:number, labelY:number}>} markers inside the plot, top to bottom
 */
export function layoutMarkerLabels(markers, yScale, top, bottom) {
	const gap = MARKER_LABEL_PX + 2;
	const out = [];
	for (const m of markers) {
		const py = yScale.getPixelForValue(Number(m.y));
		if (!Number.isFinite(py) || py < top || py > bottom) continue;
		out.push({ marker: m, py, labelY: py });
	}
	out.sort((a, b) => a.py - b.py);
	for (let i = 1; i < out.length; i++) {
		out[i].labelY = Math.max(out[i].labelY, out[i - 1].labelY + gap);
	}
	const half = MARKER_LABEL_PX / 2;
	if (out.length && out[out.length - 1].labelY > bottom - half) {
		out[out.length - 1].labelY = bottom - half;
		for (let i = out.length - 2; i >= 0; i--) {
			out[i].labelY = Math.min(out[i].labelY, out[i + 1].labelY - gap);
		}
	}
	return out;
}

/**
 * StaticMarkerLinesPlugin — draws horizontal reference lines on the chart
 * (e.g. BC median, Alberta median, Target price).
 *
 * Configure via chart options:
 *   plugins.staticMarkerLines.markers = [{ y, text, color, alpha }]
 */
export const StaticMarkerLinesPlugin = {
	id: "staticMarkerLines",
	// Tick labels are formatted before the final layout pass, so a collision test in the
	// tick callback works on stale pixels. Here positions are final and nothing is drawn yet.
	// The item chart always registers this plugin, so the edge-tick cleanup runs in both modes.
	afterLayout(chart) {
		const y = chart.scales.y;
		const tickPx = Chart.helpers.toFont(y.options.ticks.font).size;

		// Chart.js always labels the axis min and max ($63 just above $60); an edge label
		// that close to a step label gives way to it.
		const stepTicks = y.ticks.filter((t) => t.value !== y.min && t.value !== y.max);
		for (const tick of y.ticks) {
			if (tick.value !== y.min && tick.value !== y.max) continue;
			const py = y.getPixelForValue(tick.value);
			if (stepTicks.some((t) => Math.abs(y.getPixelForValue(t.value) - py) < tickPx + 2)) tick.label = "";
		}

		const markers = chart.options.plugins.staticMarkerLines?.markers ?? [];
		if (!markers.length) return;
		const { top, bottom } = chart.chartArea;
		const labelYs = layoutMarkerLabels(markers, y, top, bottom).map((l) => l.labelY);
		const clear = (tickPx + MARKER_LABEL_PX) / 2 + 2;
		for (const tick of y.ticks) {
			const py = y.getPixelForValue(tick.value);
			if (labelYs.some((ly) => Math.abs(py - ly) < clear)) tick.label = "";
		}
	},
	afterDraw(chart, _args, passedOpts) {
		const opts =
			(chart?.options?.plugins && chart.options.plugins.staticMarkerLines) ||
			chart?.options?.staticMarkerLines ||
			passedOpts ||
			{};

		const markers = Array.isArray(opts?.markers) ? opts.markers : [];
		if (!markers.length) return;

		const scalesObj = chart?.scales || {};
		const scales = Object.values(scalesObj);
		const y =
			scalesObj.y ||
			scales.find((s) => s && s.axis === "y") ||
			scales.find(
				(s) => s && typeof s.getPixelForValue === "function" && s.isHorizontal === false,
			) ||
			scales.find(
				(s) =>
					s &&
					typeof s.getPixelForValue === "function" &&
					String(s.id || "")
						.toLowerCase()
						.includes("y"),
			);

		const area = chart?.chartArea;
		if (!y || !area) return;

		const { ctx } = chart;
		const { left, right, top, bottom } = area;

		const lineWidth = Number.isFinite(opts?.lineWidth) ? opts.lineWidth : 1.25;
		const baseAlpha = Number.isFinite(opts?.alpha) ? opts.alpha : 0.38;
		const strokeStyle = String(opts?.color || "#7f8da3");
		const font = `600 ${MARKER_LABEL_PX}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`;
		const labelColor = String(opts?.labelColor || "#556274");

		ctx.save();
		ctx.setLineDash([]);
		ctx.lineWidth = lineWidth;
		ctx.font = font;
		ctx.fillStyle = labelColor;

		for (const { marker: m, py, labelY } of layoutMarkerLabels(markers, y, top, bottom)) {
			ctx.globalAlpha = Number.isFinite(m?.alpha) ? m.alpha : baseAlpha;
			ctx.strokeStyle = String(m?.color || strokeStyle);
			ctx.beginPath();
			ctx.moveTo(left, py);
			ctx.lineTo(right, py);
			ctx.stroke();

			const yLeft = Number.isFinite(y?.left) ? y.left : left;
			const yRight = Number.isFinite(y?.right) ? y.right : left;
			const axisCenterX = Math.max(0, Math.min((yLeft + yRight) / 2, chart.width));

			ctx.beginPath();
			ctx.moveTo(yRight, py);
			ctx.lineTo(yRight + 6, py);
			ctx.stroke();

			const text = String(m?.text || "");
			if (text) {
				ctx.globalAlpha = 0.95;
				ctx.fillStyle = String(m?.labelColor || labelColor);
				ctx.textBaseline = "middle";
				ctx.textAlign = "center";
				ctx.fillText(text, axisCenterX, labelY);
			}
		}

		ctx.restore();
	},
};
