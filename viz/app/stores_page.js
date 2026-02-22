// viz/app/stores_page.js
import { esc } from "./dom.js";

/* ===============================
   HARD CODED STORES
   Add public logo URL to `logo`
================================= */

const BC_STORES = [
	{ id: "arc", label: "ARC Liquor", logo: "" },
	{ id: "bcl", label: "BCL", logo: "" },
	{ id: "gull", label: "Gull Liquor", logo: "" },
	{ id: "legacyliquor", label: "Legacy Liquor", logo: "" },
	{ id: "strath", label: "Strath Liquor", logo: "" },
	{ id: "tudor", label: "Tudor House", logo: "" },
	{ id: "vessel", label: "Vessel Liquor", logo: "" },
	{ id: "vintage", label: "Vintage Spirits", logo: "" },
];

const AB_STORES = [
	{ id: "bsw", label: "BSW", logo: "" },
	{ id: "coop", label: "Co-op World of Whisky", logo: "" },
	{ id: "craftcellars", label: "Craft Cellars", logo: "" },
	{ id: "kegncork", label: "Keg N Cork", logo: "" },
	{ id: "kwm", label: "Kensington Wine Market", logo: "" },
	{ id: "maltsandgrains", label: "Malts & Grains", logo: "" },
	{ id: "sierrasprings", label: "Sierra Springs", logo: "" },
	{ id: "willowpark", label: "Willow Park", logo: "" },
];

/* ===============================
   CSS
================================= */

function ensureCssOnce() {
	if (document.getElementById("stStoresCss")) return;

	const css = document.createElement("style");
	css.id = "stStoresCss";
	css.textContent = `
	.storesPage .list{ margin-top: 0; }

	.storesGrid{
	  display:grid;
	  grid-template-columns: 1fr 1fr;
	  gap: 12px;
	  align-items: start;
	}

	@media (max-width: 640px){
	  .storesGrid{ grid-template-columns: 1fr; }
	}

	.storesColTitle{
	  display:flex;
	  align-items:center;
	  justify-content: space-between;
	  gap: 10px;
	  padding: 2px 2px 10px 2px;
	}

	.storesPage .row{
	  display:flex;
	  align-items:center;
	  justify-content:space-between;
	  gap:12px;
	  padding:12px;
	  border:1px solid var(--border);
	  border-radius:12px;
	  background:#0f1318;
	  cursor:pointer;
	}
	.storesPage .row:hover{ border-color:#2f3a46; }

	.storesPage .rowLeft{
	  display:flex;
	  align-items:center;
	  gap:12px;
	  min-width:0;
	}

	.storesPage .logoBox{
	  width:40px;
	  height:40px;
	  border-radius:10px;
	  border:1px solid var(--border);
	  background:#0b0d10;
	  overflow:hidden;
	  flex: 0 0 40px;
	  display:flex;
	  align-items:center;
	  justify-content:center;
	  position:relative;
	}

	.storesPage .logoBox img{
	  width:100%;
	  height:100%;
	  object-fit: contain;
	  display:block;
	}

	.storesPage .logoPlaceholder{
	  position:absolute;
	  inset:0;
	  background: rgba(255,255,255,0.03);
	}

	.storesPage .name{
	  font-weight:800;
	  font-size:14px;
	  min-width:0;
	  white-space:nowrap;
	  overflow:hidden;
	  text-overflow:ellipsis;
	}

	.storesPage .openPill{
	  flex:0 0 auto;
	  border:1px solid var(--border);
	  background: rgba(255,255,255,0.02);
	  color: var(--text);
	  border-radius: 999px;
	  padding: 6px 10px;
	  font-size: 12px;
	  pointer-events: none;
	  user-select: none;
	}
	`;
	document.head.appendChild(css);
}

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
	ensureCssOnce();

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