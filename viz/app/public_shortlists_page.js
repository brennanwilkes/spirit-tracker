import { esc } from "./dom.js";
import { getShortlists } from "./cloud.js";

function ensureCssOnce() {
	if (document.getElementById("stShortlistsCss")) return;
	const css = document.createElement("style");
	css.id = "stShortlistsCss";
	css.textContent = `
	.shortlistsPage .dirGrid{
	  display:grid;
	  grid-template-columns: 1fr;
	  gap:10px;
	  margin-top: 12px;
	}
	.shortlistsPage .dirItem{
	  border:1px solid var(--border);
	  border-radius: 12px;
	  padding: 12px;
	  background:#0f1318;
	  cursor:pointer;
	  display:flex;
	  align-items:center;
	  justify-content:space-between;
	  gap:12px;
	}
	.shortlistsPage .dirItem:hover{ border-color:#2f3a46; }
	.shortlistsPage .dirLeft{ min-width:0; display:flex; flex-direction:column; gap:6px; }
	.shortlistsPage .dirName{
	  font-weight:800;
	  font-size:14px;
	  white-space:nowrap;
	  overflow:hidden;
	  text-overflow:ellipsis;
	}
	.shortlistsPage .dirMeta{
	  display:flex;
	  gap:8px;
	  flex-wrap:wrap;
	  align-items:center;
	  min-width:0;
	}
	.shortlistsPage .dirRight{
	  flex:0 0 auto;
	  display:flex;
	  gap:8px;
	  align-items:center;
	}
	.shortlistsPage .ghostBtn{
	  border:1px solid var(--border);
	  background: rgba(255,255,255,0.02);
	  color: var(--muted);
	  border-radius: 999px;
	  padding: 6px 10px;
	  font-size:12px;
	  cursor:pointer;
	}
	.shortlistsPage .ghostBtn:hover{ border-color:#2f3a46; color: var(--text); }
	.shortlistsPage .kpiRow{
	  display:flex; gap:10px; flex-wrap:wrap; align-items:center;
	  margin-top: 10px;
	}
	.shortlistsPage .hint{
	  margin-top: 10px;
	  color: var(--muted);
	  font-size: 12px;
	}
	`;
	document.head.appendChild(css);
}

function norm(s) {
	return String(s || "").trim().toLowerCase();
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
				<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
					<input id="q" class="input" placeholder="Search shortlists..." autocomplete="off" style="flex: 1 1 320px;" />
					<select id="sort" class="selectSmall" aria-label="Sort">
						<option value="nameAsc">Name (A→Z)</option>
						<option value="nameDesc">Name (Z→A)</option>
					</select>
				</div>

				<div class="kpiRow">
					<span class="badge badgeNeutral" id="countBadge">Loading…</span>
					<button id="refresh" class="ghostBtn" type="button">Refresh</button>
				</div>

				<div id="status" class="hint"></div>
				<div id="list" class="dirGrid"></div>
			</div>
		</div>
	`;

	document.getElementById("back").addEventListener("click", () => {
		const last = sessionStorage.getItem("viz:lastRoute");
		if (last && last !== location.hash) location.hash = last;
		else location.hash = "#/";
	});

	const $q = document.getElementById("q");
	const $sort = document.getElementById("sort");
	const $list = document.getElementById("list");
	const $count = document.getElementById("countBadge");
	const $status = document.getElementById("status");
	const $refresh = document.getElementById("refresh");

	let all = [];

	function renderRows() {
		const query = norm($q.value);
		const mode = String($sort.value || "nameAsc");

		let rows = Array.isArray(all) ? all.slice() : [];

		if (query) {
			rows = rows.filter((r) => {
				const n = norm(r?.shortlistName);
				const u = norm(r?.uuid);
				return n.includes(query) || u.includes(query);
			});
		}

		rows.sort((a, b) => {
			const an = String(a?.shortlistName || "");
			const bn = String(b?.shortlistName || "");
			const cmp = an.localeCompare(bn);
			return mode === "nameDesc" ? -cmp : cmp;
		});

		$count.textContent = `${rows.length} shortlist${rows.length === 1 ? "" : "s"}`;
		$status.textContent = rows.length ? "Click a shortlist to open it." : (query ? "No matches." : "No public shortlists yet.");

		$list.innerHTML = rows
			.map((r) => {
				const uuid = String(r?.uuid || "");
				const name = String(r?.shortlistName || "");
				const shortUuid = uuid ? `${(uuid.split("-")[0] || uuid)}…` : "";
				return `
					<div class="dirItem" data-uuid="${esc(uuid)}" role="button" tabindex="0">
						<div class="dirLeft">
							<div class="dirName">${esc(name || "(Unnamed shortlist)")}</div>
							<div class="dirMeta">
								<span class="badge mono badgeNeutral" title="${esc(uuid)}">${esc(shortUuid)}</span>
							</div>
						</div>
						<div class="dirRight">
							<span class="badge">Open →</span>
						</div>
					</div>
				`;
			})
			.join("");
	}

	async function load({ bustCache = false } = {}) {
		$list.innerHTML = `<div class="small">Loading…</div>`;
		$count.textContent = "Loading…";
		$status.textContent = "";

		try {
			// “refresh” bypasses cache by forcing ttl=0
			const data = await getShortlists({ cacheTtlMs: bustCache ? 0 : 6 * 60 * 60 * 1000 });
			all = Array.isArray(data) ? data : [];
			renderRows();
		} catch (e) {
			all = [];
			$list.innerHTML = "";
			$count.textContent = "0 shortlists";
			$status.textContent = String(e?.message || "Failed to load shortlists");
		}
	}

	// click/keyboard -> open shortlist
	$list.addEventListener("click", (e) => {
		const el = e.target.closest(".dirItem");
		if (!el) return;
		const uuid = String(el.getAttribute("data-uuid") || "");
		if (!uuid) return;
		sessionStorage.setItem("viz:lastRoute", location.hash);
		location.hash = `#/shortlist/${encodeURIComponent(uuid)}`;
	});
	$list.addEventListener("keydown", (e) => {
		const el = e.target.closest(".dirItem");
		if (!el) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			const uuid = String(el.getAttribute("data-uuid") || "");
			if (!uuid) return;
			sessionStorage.setItem("viz:lastRoute", location.hash);
			location.hash = `#/shortlist/${encodeURIComponent(uuid)}`;
		}
	});

	let t = null;
	$q.addEventListener("input", () => {
		if (t) clearTimeout(t);
		t = setTimeout(renderRows, 60);
	});
	$sort.addEventListener("change", renderRows);
	$refresh.addEventListener("click", () => load({ bustCache: true }));

	await load();
}