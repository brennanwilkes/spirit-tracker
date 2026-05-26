// src/utils/location_rollup.js
"use strict";

/**
 * Roll up per-location stock entries into a single store-level availability.
 *
 * Rule:
 *  - available = OR over locations
 *  - quantity  = SUM of per-location counts IF every location reports a numeric count;
 *                otherwise undefined (we never half-aggregate)
 *
 * Input: array of `{ available: boolean, quantity?: number }`
 * Output: `{ available: boolean, quantity?: number }`
 */
function rollupLocations(perLocationArray) {
	const arr = Array.isArray(perLocationArray) ? perLocationArray : [];
	let available = false;
	let allHaveQty = arr.length > 0;
	let sum = 0;

	for (const loc of arr) {
		if (!loc) { allHaveQty = false; continue; }
		if (loc.available === true) available = true;
		if (typeof loc.quantity === "number" && Number.isFinite(loc.quantity)) {
			sum += loc.quantity;
		} else {
			allHaveQty = false;
		}
	}

	const out = { available };
	if (allHaveQty) out.quantity = sum;
	return out;
}

module.exports = { rollupLocations };
