import { esc, renderThumbHtml } from "../dom.js";
import { displaySku } from "../sku.js";
import { favStarHtml } from "./fav_star.js";

/**
 * Shared item card HTML builder.
 *
 * Two-zone layout:
 *   .itemTitle  — full-width name row with border-bottom
 *   .itemRow    — thumbnail + body (store label, price, badges)
 *
 * @param {object} item - aggregated item from catalog.aggregateBySku()
 * @param {object} opts
 * @param {boolean} [opts.showFavStar=false]  - show the favourite star button
 * @param {boolean} [opts.favOn=false]         - whether the star is active
 * @param {string}  [opts.priceStr=""]         - formatted price string (e.g. "$42.99")
 * @param {string}  [opts.storeLabel=""]       - store display name
 * @param {string}  [opts.storeUrl=""]         - store URL (makes storeLabel a link)
 * @param {string}  [opts.badgesHtml=""]       - raw HTML for meta-row badges slot
 * @param {boolean} [opts.showSkuBadge=true]   - show the SKU mono badge in title row
 * @param {string}  [opts.skuHref=""]          - href for the SKU badge link
 * @param {string}  [opts.rarityTier=""]       - "staple" | "rare" | "" (no special styling)
 * @returns {string} HTML string
 */
export function itemCardHtml(
	item,
	{
		showFavStar = false,
		favOn = false,
		priceStr = "",
		storeLabel = "",
		storeUrl = "",
		badgesHtml = "",
		showSkuBadge = true,
		skuHref = "",
		rarityTier = "",
	} = {},
) {
	const sku = String(item?.sku || "");
	const name = String(item?.name || "(no name)");
	const img = item?.img || "";

	const star = showFavStar && sku ? favStarHtml(sku, favOn) : "";

	const skuBadge =
		showSkuBadge && sku
			? skuHref
				? `<a class="badge mono skuLink" target="_blank" rel="noopener noreferrer" href="${esc(skuHref)}" onclick="event.stopPropagation()">${esc(displaySku(sku))}</a>`
				: `<span class="badge mono">${esc(displaySku(sku))}</span>`
			: "";

	const storeEl = storeLabel
		? storeUrl
			? `<a class="itemStore" title="${esc(storeLabel)}" href="${esc(storeUrl)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(storeLabel)}</a>`
			: `<span class="itemStore" title="${esc(storeLabel)}">${esc(storeLabel)}</span>`
		: "";

	const priceEl = priceStr ? `<span class="price">${esc(priceStr)}</span>` : "";

	const tierClass =
		rarityTier === "staple" ? " rarity-staple" : rarityTier === "rare" ? " rarity-rare" : "";

	return `
<div class="item${showFavStar ? " itemHasStar" : ""}${tierClass}" data-sku="${esc(sku)}">
  <div class="itemTitle">
    <div class="itemName" title="${esc(name)}">${esc(name)}</div>
    ${skuBadge}
    ${star}
  </div>
  <div class="itemRow">
    <div class="thumbBox">${renderThumbHtml(img)}</div>
    <div class="itemBody">
      <div class="itemLine1">${storeEl}${priceEl}</div>
      <div class="metaRow">${badgesHtml}</div>
    </div>
  </div>
</div>`;
}
