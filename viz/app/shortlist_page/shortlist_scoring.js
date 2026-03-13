/**
 * Shortlist scoring formula and sort logic.
 * Extracted from shortlist_page.js for testability and reuse.
 */

export const MEDIAN_PRICE = 202.74;
export const LOG_PENALTY = 7;
export const LOG_SAMPLE_BONUS = 0.1;

/**
 * Compute a weighted score for an item on the shortlist.
 * Adjusts the raw user score by:
 *   - adding a small bonus if the user has sampled the item
 *   - subtracting a penalty proportional to how much the price exceeds the median
 *
 * @param {object} opts
 * @param {number|null} opts.priceNum  - item price as a number
 * @param {number|null} opts.scoreNum  - user's raw score (0–10)
 * @param {boolean}     opts.sampled   - whether the user has marked it as sampled
 * @returns {number|null} rounded weighted score, or null if inputs are invalid
 */
export function computeScore({ priceNum, scoreNum, sampled }) {
	if (!Number.isFinite(scoreNum)) return null;
	if (!Number.isFinite(priceNum)) return null;

	const base = scoreNum * (1 + (sampled ? LOG_SAMPLE_BONUS : 0));
	const penalty = LOG_PENALTY * Math.log(Math.max(1, priceNum) / MEDIAN_PRICE);
	const w = Math.round(base - penalty);
	return Number.isFinite(w) ? w : null;
}

/**
 * Sort a shortlist items array in-place by the given mode.
 *
 * @param {object[]} items - array of shortlist items (each must have _weightedScore, _storePrice, name, sku)
 * @param {"score"|"price"|"name"} [mode="score"]
 * @returns {object[]} the same array (sorted in-place)
 */
export function sortShortlist(items, mode = "score") {
	if (mode === "price") {
		items.sort((a, b) => {
			const ap = Number.isFinite(a._storePrice) ? a._storePrice : 9e15;
			const bp = Number.isFinite(b._storePrice) ? b._storePrice : 9e15;
			if (ap !== bp) return ap - bp;
			return (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku);
		});
	} else if (mode === "name") {
		items.sort((a, b) =>
			(String(a.name) + a.sku).localeCompare(String(b.name) + b.sku),
		);
	} else {
		// default: sort by weighted score descending (higher = better)
		items.sort((a, b) => {
			const as = Number.isFinite(a._weightedScore) ? a._weightedScore : -9e15;
			const bs = Number.isFinite(b._weightedScore) ? b._weightedScore : -9e15;
			if (as !== bs) return bs - as;
			return (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku);
		});
	}
	return items;
}
