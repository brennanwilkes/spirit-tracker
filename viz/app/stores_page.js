// viz/app/stores_page.js
import { esc } from "./dom.js";
import { storesByRegion, FAVOURITE_STORE_IDS } from "./stores.js";
import { goBack, peekBack, openOrNavigateTo } from "./nav.js";

// Favourites first, then everything else, alphabetical within each block. The
// raw STORES order is insertion order (neither alphabetical nor meaningful), so
// a name was only findable by scanning the whole column.
function orderStores(region) {
	return storesByRegion(region)
		.slice()
		.sort((a, b) => {
			const favA = FAVOURITE_STORE_IDS.has(a.id) ? 0 : 1;
			const favB = FAVOURITE_STORE_IDS.has(b.id) ? 0 : 1;
			return favA - favB || a.label.localeCompare(b.label);
		});
}

const BC_STORES = orderStores("bc");
const AB_STORES = orderStores("ab");

/* CSS is in app/stores_page/stores_page.css, loaded via index.html */

/* ===============================
   Rendering
================================= */

function goToStore(e, label) {
	openOrNavigateTo(e, `#/store/${encodeURIComponent(label)}`);
}

function renderStoreRow(store) {
	const src = store.logo || "";

	const logoHtml = src
		? `
			<img 
				src="${esc(src)}" 
				alt=""
				onerror="this.style.display='none'; this.parentElement.querySelector('.logoPlaceholder').style.display='block';"
			/>
			<div class="logoPlaceholder" style="display:none;"></div>
		  `
		: `<div class="logoPlaceholder"></div>`;

	return `
		<div class="row${FAVOURITE_STORE_IDS.has(store.id) ? " favStore" : ""}" role="button" tabindex="0" data-label="${esc(store.label)}">
		  <div class="rowLeft">
		    <div class="logoBox">
		      ${logoHtml}
		    </div>
		    <div class="name">${esc(store.label)}</div>
		  </div>
		  <span class="openPill">Open →</span>
		</div>
	`;
}

export function renderStores($app) {
	$app.innerHTML = `
		<div class="container storesPage">
			<div class="topbar">
				<a id="back" class="btn" href="${peekBack()}"><span class="backArrow">← </span>Back</a>
				<div class="h1" style="margin:0;">Stores</div>
			</div>

			<div class="card">
				<div class="storesGrid">

					<div>
						<div class="storesColTitle">
							<span class="badge">BC</span>
						</div>
						<div class="list">
							${BC_STORES.map(renderStoreRow).join("")}
						</div>
					</div>

					<div>
						<div class="storesColTitle">
							<span class="badge">Alberta</span>
						</div>
						<div class="list">
							${AB_STORES.map(renderStoreRow).join("")}
						</div>
					</div>

				</div>
			</div>
		</div>
	`;

	document.getElementById("back").addEventListener("click", (e) => {
		if (e.ctrlKey || e.metaKey || e.shiftKey) return;
		e.preventDefault();
		goBack();
	});

	$app.addEventListener("click", (e) => {
		const row = e.target.closest(".row");
		if (!row) return;
		const label = row.getAttribute("data-label");
		if (!label) return;
		goToStore(e, label);
	});

	$app.addEventListener("keydown", (e) => {
		const row = e.target.closest(".row");
		if (!row) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			const label = row.getAttribute("data-label");
			if (!label) return;
			goToStore(label);
		}
	});
}
