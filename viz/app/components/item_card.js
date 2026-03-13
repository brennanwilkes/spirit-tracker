import { esc, renderThumbHtml } from "../dom.js";
import { displaySku } from "../sku.js";
import { favStarHtml } from "./fav_star.js";

/**
 * Shared item card HTML builder.
 *
 * @param {object} item - aggregated item from catalog.aggregateBySku()
 * @param {object} opts
 * @param {boolean} [opts.showFavStar=false]  - show the favourite star button
 * @param {boolean} [opts.favOn=false]         - whether the star is active
 * @param {string}  [opts.priceStr=""]         - formatted price string (e.g. "$42.99")
 * @param {string}  [opts.badgesHtml=""]       - raw HTML for meta-row badges slot
 * @param {boolean} [opts.showSkuBadge=true]   - show the SKU mono badge
 * @param {string}  [opts.skuHref=""]          - href for the SKU badge link
 * @returns {string} HTML string
 */
export function itemCardHtml(item, {
	showFavStar = false,
	favOn = false,
	priceStr = "",
	badgesHtml = "",
	showSkuBadge = true,
	skuHref = "",
} = {}) {
	const sku = String(item?.sku || "");
	const name = String(item?.name || "(no name)");
	const img = item?.img || "";

	const star = showFavStar && sku ? favStarHtml(sku, favOn) : "";

	const skuBadge = showSkuBadge && sku
		? skuHref
			? `<a style="margin-right: 18px;" class="badge mono skuLink" target="_blank" rel="noopener noreferrer" href="${esc(skuHref)}" onclick="event.stopPropagation()">${esc(displaySku(sku))}</a>`
			: `<span class="badge mono" style="margin-right: 18px;">${esc(displaySku(sku))}</span>`
		: "";

	const priceSpan = priceStr
		? `<span class="mono price">${esc(priceStr)}</span>`
		: "";

	return `
<div class="item${showFavStar ? " itemHasStar" : ""}" data-sku="${esc(sku)}">
  ${star}
  <div class="itemRow">
    <div class="thumbBox">${renderThumbHtml(img)}</div>
    <div class="itemBody">
      <div class="itemTop">
        <div class="itemName">${esc(name)}</div>
        ${skuBadge}
      </div>
      <div class="metaRow">
        ${badgesHtml}
        ${priceSpan}
      </div>
    </div>
  </div>
</div>`;
}
