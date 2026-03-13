import { esc } from "../dom.js";

/**
 * Shared badge HTML builders.
 * All functions return HTML strings safe to insert into innerHTML.
 * Text values are always passed through esc().
 */

/**
 * Price comparison badge — shows how much cheaper/more expensive vs other stores.
 * @param {number|null} delta   - difference vs comparison price (negative = this store is cheaper)
 * @param {"dollar"|"percent"} mode
 * @param {number} [threshold=5] - within-threshold amount ($5 or 5%)
 */
export function compareBadgeHtml(delta, mode, threshold = 5) {
	if (delta === null || !Number.isFinite(delta)) return "";

	const abs = Math.abs(delta);

	if (mode === "percent") {
		if (abs <= threshold) {
			return `<span class="badge badgeNeutral">within ${threshold}%</span>`;
		}
		const pct = Math.round(abs);
		if (delta < 0) return `<span class="badge badgeGood">${esc(pct)}% lower</span>`;
		return `<span class="badge badgeBad">${esc(pct)}% higher</span>`;
	}

	// dollar mode
	if (abs <= threshold) {
		return `<span class="badge badgeNeutral">within $${threshold}</span>`;
	}
	const dollars = Math.round(abs);
	if (delta < 0) return `<span class="badge badgeGood">$${esc(dollars)} lower</span>`;
	return `<span class="badge badgeBad">$${esc(dollars)} higher</span>`;
}

/**
 * Sale badge — shows % off or $ off.
 * @param {number|null} pctOff    - percentage off (positive = discount)
 * @param {number|null} dollarOff - dollar amount off (positive = discount)
 * @param {"pct"|"abs"} [mode="pct"]
 */
export function priceBadgeHtml(pctOff, dollarOff, mode = "pct") {
	if (mode === "abs") {
		const d = Number.isFinite(dollarOff) ? dollarOff : 0;
		if (!d) return "";
		const abs = Math.round(Math.abs(d));
		if (!abs) return "";
		if (d < 0) return `<span class="badge badgeGood">$${esc(abs)} off</span>`;
		return `<span class="badge badgeBad">+$${esc(abs)}</span>`;
	}

	// pct mode
	const p = Number.isFinite(pctOff) ? pctOff : 0;
	if (!p) return "";
	const abs = Math.abs(p);
	if (p < 0) return `<span class="badge badgeGood">${esc(abs)}% off</span>`;
	return `<span class="badge badgeBad">+${esc(abs)}%</span>`;
}

/**
 * Store name badge, optionally as a link.
 * @param {string} label  - display name
 * @param {string} [url]  - if provided, wraps in <a>
 */
export function storeBadgeHtml(label, url = "") {
	if (!label) return "";
	if (url) {
		return `<a class="badge" href="${esc(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(label)}</a>`;
	}
	return `<span class="badge">${esc(label)}</span>`;
}

/**
 * Stock-status badge.
 * @param {"exclusive"|"lastStock"|"best"|""} status
 */
export function stockBadgeHtml(status) {
	switch (status) {
		case "exclusive":
			return `<span class="badge badgeExclusive">Exclusive</span>`;
		case "lastStock":
			return `<span class="badge badgeLastStock">Last Stock</span>`;
		case "best":
			return `<span class="badge badgeBest">Best Price</span>`;
		default:
			return "";
	}
}

/**
 * SKU mono badge (links to the linker page).
 * @param {string} sku        - display SKU text
 * @param {string} [href=""]  - link href; if empty, renders as plain span
 */
export function skuBadgeHtml(sku, href = "") {
	if (!sku) return "";
	if (href) {
		return `<a class="badge mono skuLink" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(sku)}</a>`;
	}
	return `<span class="badge mono">${esc(sku)}</span>`;
}
