/**
 * Hash routes:
 *   #/                search
 *   #/item/<sku>      detail
 *   #/link            sku linker (local-write only)
 */

import { destroyChart } from "./item_page.js";
import { renderSearch } from "./search_page.js";
import { renderItem } from "./item_page.js";
import { renderSkuLinker } from "./linker_page.js";

function route() {
  const $app = document.getElementById("app");
  if (!$app) return;

  // always clean up chart when navigating
  destroyChart();

  const h = location.hash || "#/";
  const parts = h.replace(/^#\/?/, "").split("/").filter(Boolean);

  if (parts.length === 0) return renderSearch($app);
  if (parts[0] === "item" && parts[1]) return renderItem($app, decodeURIComponent(parts[1]));
  if (parts[0] === "link") return renderSkuLinker($app);

  return renderSearch($app);
}

window.addEventListener("hashchange", route);
route();
