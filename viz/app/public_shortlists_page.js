// viz/app/public_shortlists_page.js
// CSS is in app/public_shortlists_page/public_shortlists_page.css, loaded via index.html
import { esc } from "./dom.js";
import { getShortlists } from "./cloud.js";

function goTo(uuid) {
	sessionStorage.setItem("viz:lastRoute", location.hash);
	location.hash = `#/shortlist/${encodeURIComponent(uuid)}`;
}

export async function renderPublicShortlists($app) {
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
		const data = await getShortlists({ cacheTtlMs: 6 * 60 * 60 * 1000 });
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
				<div class="row" role="button" tabindex="0" data-uuid="${esc(uuid)}">
					<div class="name">${esc(name)}</div>
					<span class="openPill">Open →</span>
				</div>
			`;
		})
		.join("");

	$list.addEventListener("click", (e) => {
		const row = e.target.closest(".row");
		if (!row) return;
		const uuid = String(row.getAttribute("data-uuid") || "");
		if (!uuid) return;
		goTo(uuid);
	});

	$list.addEventListener("keydown", (e) => {
		const row = e.target.closest(".row");
		if (!row) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			const uuid = String(row.getAttribute("data-uuid") || "");
			if (!uuid) return;
			goTo(uuid);
		}
	});
}
