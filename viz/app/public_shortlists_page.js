import { esc } from "./dom.js";
import { getShortlists } from "./cloud.js";

function ensureCssOnce() {
	if (document.getElementById("stShortlistsCss")) return;
	const css = document.createElement("style");
	css.id = "stShortlistsCss";
	css.textContent = `
	.shortlistsPage .row{
	  display:flex;
	  align-items:center;
	  justify-content:space-between;
	  gap:12px;
	  padding:12px;
	  border:1px solid var(--border);
	  border-radius:12px;
	  background:#0f1318;
	}
	.shortlistsPage .row:hover{ border-color:#2f3a46; }
	.shortlistsPage .name{
	  font-weight:800;
	  font-size:14px;
	  min-width:0;
	  white-space:nowrap;
	  overflow:hidden;
	  text-overflow:ellipsis;
	}
	.shortlistsPage .openBtn{
	  flex:0 0 auto;
	  border:1px solid var(--border);
	  background: rgba(255,255,255,0.02);
	  color: var(--text);
	  border-radius: 999px;
	  padding: 6px 10px;
	  font-size: 12px;
	  cursor: pointer;
	}
	.shortlistsPage .openBtn:hover{ border-color:#2f3a46; }
	`;
	document.head.appendChild(css);
}

export async function renderPublicShortlists($app) {
	ensureCssOnce();

	$app.innerHTML = `
		<div class="container shortlistsPage">
			<div class="topbar">
				<button id="back" class="btn">← Back</button>
				<div class="h1" style="margin:0;">Public shortlists</div>
			</div>

			<div class="card">
				<div id="list" class="list"><div class="small">Loading…</div></div>
			</div>
		</div>
	`;

	document.getElementById("back").addEventListener("click", () => {
		const last = sessionStorage.getItem("viz:lastRoute");
		if (last && last !== location.hash) location.hash = last;
		else location.hash = "#/";
	});

	const $list = document.getElementById("list");

	let rows = [];
	try {
		const data = await getShortlists({ cacheTtlMs: 6 * 60 * 60 * 1000 }); // 6h cache
		rows = Array.isArray(data) ? data : [];
	} catch (e) {
		$list.innerHTML = `<div class="small">${esc(String(e?.message || "Failed to load shortlists"))}</div>`;
		return;
	}

	if (!rows.length) {
		$list.innerHTML = `<div class="small">No public shortlists yet.</div>`;
		return;
	}

	$list.innerHTML = rows
		.map((r) => {
			const uuid = String(r?.uuid || "");
			const name = String(r?.shortlistName || "").trim() || "(Unnamed)";
			return `
				<div class="row">
					<div class="name">${esc(name)}</div>
					<button class="openBtn" type="button" data-uuid="${esc(uuid)}">Open →</button>
				</div>
			`;
		})
		.join("");

	$list.addEventListener("click", (e) => {
		const btn = e.target.closest(".openBtn");
		if (!btn) return;
		const uuid = String(btn.getAttribute("data-uuid") || "");
		if (!uuid) return;
		sessionStorage.setItem("viz:lastRoute", location.hash);
		location.hash = `#/shortlist/${encodeURIComponent(uuid)}`;
	});
}