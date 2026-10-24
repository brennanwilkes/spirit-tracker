/**
 * Exponential price scale shared by every price slider (store, shortlist, stats).
 *
 * Maps a linear 0–SLIDER_RANGE <input type="range"> onto an exponential price
 * scale so low prices get fine control, and snaps prices to "clicky" steps.
 *
 * The two ends are exact: the last thumb position is always `max` (ceil of the
 * real max, so a $2095.10 bottle is never cut off by step rounding) and the
 * first is always `min`. Pages persist "at max" as an absent key, so a cap the
 * user never set follows the data instead of freezing at yesterday's max.
 */
export const SLIDER_RANGE = 1000;

function stepForPrice(p) {
	if (p < 120)  return 5;
	if (p < 250)  return 10;
	if (p < 600)  return 25;
	if (p < 2000) return 100;
	return 1000;
}

export function createPriceScale(minPrice, maxPrice) {
	if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
		throw new Error(`createPriceScale: non-finite bounds ${minPrice}, ${maxPrice}`);
	}
	const min = minPrice;
	const max = Math.max(min, Math.ceil(maxPrice));
	const logRatio = Math.log(max / min);

	function snap(p) {
		if (p >= max) return max;
		if (p <= min) return min;
		const step = stepForPrice(p);
		const r = Math.round(p / step) * step;
		if (r >= max) return max;
		if (r <= min) return min;
		return r;
	}

	function priceFromValue(v) {
		if (v >= SLIDER_RANGE || max <= min) return max;
		if (v <= 0) return min;
		return snap(min * Math.exp(logRatio * (v / SLIDER_RANGE)));
	}

	function valueFromPrice(p) {
		if (p >= max || max <= min) return SLIDER_RANGE;
		if (p <= min) return 0;
		return Math.round((Math.log(p / min) / logRatio) * SLIDER_RANGE);
	}

	return { min, max, snap, priceFromValue, valueFromPrice };
}
