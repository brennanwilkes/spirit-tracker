/**
 * Chart utilities and the StaticMarkerLinesPlugin for the item detail page.
 * Extracted from item_page.js.
 *
 * Exports:
 *   - StaticMarkerLinesPlugin    Custom Chart.js plugin that draws reference lines
 *   - BC_STORE_NAMES             Set of normalized BC store name keys
 *   - isBcStoreLabel             Detect BC stores (for BC vs Alberta median markers)
 *   - weightedMeanByDuration     Time-weighted average for a price series
 *   - meanFinite                 Arithmetic mean, ignoring non-finite values
 *   - minFinite                  Minimum, ignoring non-finite values
 *   - medianFinite               Median, ignoring non-finite values
 *   - computeSuggestedY          Compute Chart.js suggestedMin/suggestedMax
 *   - niceStepAtLeast            Compute a "nice" tick step size
 *   - lastFiniteFromEnd          Last finite value in an array (working from the end)
 */

// ── Province classification ────────────────────────────────────────────────

export const BC_STORE_NAMES = new Set([
	"bcl",
	"tudorhouse",
	"vesselliquor",
	"strathliquor",
	"gullliquor",
	"vintagespirits",
	"legacyliquor",
	"arc",
]);

function _normForProvince(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, "");
}

export function isBcStoreLabel(label) {
	const n = _normForProvince(label);
	if (BC_STORE_NAMES.has(n)) return true;
	if (n.includes("vessel")) return true;
	if (n.includes("tudor")) return true;
	if (n === "bcl") return true;
	if (n.includes("strath")) return true;
	if (n.includes("gull")) return true;
	if (n.includes("vintagespirits")) return true;
	if (n.includes("legacy")) return true;
	if (n.includes("arc")) return true;
	return false;
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
	let sum = 0, n = 0;
	for (const v of arr) {
		if (Number.isFinite(v)) { sum += v; n++; }
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

// ── Y-axis helpers ─────────────────────────────────────────────────────────

/**
 * Compute Chart.js suggestedMin / suggestedMax with optional minimum span.
 */
export function computeSuggestedY(values, minRange) {
	const nums = values.filter((v) => Number.isFinite(v));
	if (!nums.length) return { suggestedMin: undefined, suggestedMax: undefined };

	let min = nums[0], max = nums[0];
	for (const n of nums) {
		if (n < min) min = n;
		if (n > max) max = n;
	}

	const range = max - min;
	const pad = range === 0 ? Math.max(1, min * 0.05) : range * 0.08;

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

// ── Custom Chart.js plugin ─────────────────────────────────────────────────

/**
 * StaticMarkerLinesPlugin — draws horizontal reference lines on the chart
 * (e.g. BC median, Alberta median, Target price).
 *
 * Configure via chart options:
 *   plugins.staticMarkerLines.markers = [{ y, text, color, alpha }]
 */
export const StaticMarkerLinesPlugin = {
	id: "staticMarkerLines",
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
			scales.find((s) => s && typeof s.getPixelForValue === "function" && s.isHorizontal === false) ||
			scales.find(
				(s) =>
					s &&
					typeof s.getPixelForValue === "function" &&
					String(s.id || "").toLowerCase().includes("y"),
			);

		const area = chart?.chartArea;
		if (!y || !area) return;

		const { ctx } = chart;
		const { left, right, top, bottom } = area;

		const lineWidth = Number.isFinite(opts?.lineWidth) ? opts.lineWidth : 1.25;
		const baseAlpha = Number.isFinite(opts?.alpha) ? opts.alpha : 0.38;
		const strokeStyle = String(opts?.color || "#7f8da3");
		const font = opts?.font || "600 11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
		const labelColor = String(opts?.labelColor || "#556274");

		ctx.save();
		ctx.setLineDash([]);
		ctx.lineWidth = lineWidth;
		ctx.font = font;
		ctx.fillStyle = labelColor;

		for (const m of markers) {
			const yVal = Number(m?.y);
			if (!Number.isFinite(yVal)) continue;

			const py = y.getPixelForValue(yVal);
			if (!Number.isFinite(py) || py < top || py > bottom) continue;

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
				ctx.fillText(text, axisCenterX, py);
			}
		}

		ctx.restore();
	},
};
