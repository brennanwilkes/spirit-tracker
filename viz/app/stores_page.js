// viz/app/stores_page.js
import { esc } from "./dom.js";

/* ===============================
   HARD CODED STORES
   Add public logo URL to `logo`
================================= */

const BC_STORES = [
	{ id: "arc", label: "ARC Liquor", logo: "https://s.barnetnetwork.com/media/f/0e/22/a1/bf/0e22a1bf-1e98-482d-b332-eb0ba0f22722.png" },
	{ id: "bcl", label: "BCL", logo: "https://www.guidedby.ca/img/asset/d3BfdXBsb2Fkcy9sb2dvLWJjLWxpcXVvci1zdG9yZS1pcm9ud29vZC5qcGc=?p=md" },
	{ id: "gull", label: "Gull Liquor", logo: "https://gullliquorstore.com/wp-content/themes/Gull/images/favicon.ico" },
	{ id: "legacyliquor", label: "Legacy Liquor", logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQJsphhKOkacPi-a62RgC76ez05LnkPVp4A5Q&s" },
	{ id: "strath", label: "Strath Liquor", logo: "https://www.strathliquor.com/wp-content/uploads/2025/04/Strath-Text-Logo-Colour.svg" },
	{ id: "tudor", label: "Tudor House", logo: "https://storage.googleapis.com/gulp-project-static/TUDORHOUSE/logo.png" },
	{ id: "vessel", label: "Vessel Liquor", logo: "https://www.go2hr.ca/wp-content/uploads/2023/04/Vessel_Final_logo_wtext-01-e1521483297146.jpg" },
	{ id: "vintage", label: "Vintage Spirits", logo: "https://s.barnetnetwork.com/media/f/d3/0b/23/59/d30b2359-8836-4c75-8bdf-5f93f80554e2.png" },
];

const AB_STORES = [
	{ id: "bsw", label: "BSW", logo: "https://www.bswliquor.com/cdn/shop/files/bsw-logo.png?v=1699261679&width=100" },
	{ id: "coop", label: "Co-op World of Whisky", logo: "https://www.coopwinespiritsbeer.com/wp-content/themes/calgarycoop/src/images/cc-black-desktop-logo.svg" },
	{ id: "craftcellars", label: "Craft Cellars", logo: "https://pbs.twimg.com/profile_images/590644683442884611/K2Pu0S7D.jpg" },
	{ id: "kegncork", label: "Keg N Cork", logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQZIVLtvsg1BP0UWMTe76Qfq4rtRtjBuIxo9w&s" },
	{ id: "kwm", label: "Kensington Wine Market", logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRAJn_7veeZW6RD-DDusNtJVkBTAaskYBzh5g&s" },
	{ id: "maltsandgrains", label: "Malts & Grains", logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcS0q4mKBOfetGovXMiZDXgEPMhubsCzpa1ZuQ&s" },
	{ id: "sierrasprings", label: "Sierra Springs", logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSNrN3pa3sPOTjKjkpjVcqOrQyRaoF7eIl7Xg&s" },
	{ id: "willowpark", label: "Willow Park", logo: "https://pbs.twimg.com/profile_images/1234910564373028864/kGGDvGxQ.jpg" },
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