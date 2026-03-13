// viz/app/stores_page.js
import { esc } from "./dom.js";
import { storesByRegion } from "./stores.js";

const BC_STORES = storesByRegion("bc");
const AB_STORES = storesByRegion("ab");

/* CSS is in app/stores_page/stores_page.css, loaded via index.html */

/* ===============================
   Rendering
================================= */

function goToStore(label) {
	sessionStorage.setItem("viz:lastRoute", location.hash);
	location.hash = `#/store/${encodeURIComponent(label)}`;
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
		<div class="row" role="button" tabindex="0" data-label="${esc(store.label)}">
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
				<button id="back" class="btn">← Back</button>
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

	document.getElementById("back").addEventListener("click", () => {
		const last = sessionStorage.getItem("viz:lastRoute");
		if (last && last !== location.hash) location.hash = last;
		else location.hash = "#/";
	});

	$app.addEventListener("click", (e) => {
		const row = e.target.closest(".row");
		if (!row) return;
		const label = row.getAttribute("data-label");
		if (!label) return;
		goToStore(label);
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