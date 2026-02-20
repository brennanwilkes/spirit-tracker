// viz/app/settings_page.js
import { esc } from "./dom.js";
import { AuthError, getAuthStatus, getMyDetails, putDetails } from "./cloud.js";

function isAuthErr(e) {
	return e && (e.name === "AuthError" || e instanceof AuthError);
}

function normText(s) {
	return String(s ?? "").trim();
}

export async function renderSettings($app) {
	const auth = getAuthStatus();
	if (!auth.ok || !auth.token) {
		location.hash = "#/login";
		return;
	}

	$app.innerHTML = `
		<div class="container">
			<div class="topbar">
				<button id="back" class="btn">← Back</button>
				<div class="h1" style="margin:0;">Settings</div>
			</div>

			<div class="card">
				<div style="display:flex; flex-direction:column; gap:18px;">
					<!-- Shortlist settings -->
					<div>
						<div style="font-weight:700; margin-bottom:10px;">Shortlist settings</div>

						<label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
							<input id="isPublic" type="checkbox" />
							<span>Make publicly viewable</span>
						</label>

						<div style="margin-top:12px; display:flex; flex-direction:column; gap:6px;">
							<div class="small" style="opacity:.9;">Shortlist name</div>
							<input
								id="shortlistName"
								class="input"
								type="text"
								placeholder="My Bottle Shortlist"
								autocomplete="off"
							/>
							<div class="small" id="publicHint" style="opacity:.85;"></div>
						</div>
					</div>

					<!-- Email notifications -->
					<div>
						<div style="font-weight:700; margin-bottom:8px;">Email notifications</div>
						<div class="small">Coming soon.</div>
					</div>

					<!-- Save row -->
					<div style="display:flex; align-items:center; gap:10px; justify-content:space-between;">
						<div class="small" id="status" style="min-height:16px;"></div>
						<button id="save" class="btn btnWide" type="button">Save</button>
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

	const $isPublic = document.getElementById("isPublic");
	const $name = document.getElementById("shortlistName");
	const $hint = document.getElementById("publicHint");
	const $status = document.getElementById("status");
	const $save = document.getElementById("save");

	function setNameEnabled(on) {
		$name.disabled = !on;
		$name.style.opacity = on ? "1" : "0.55";
		$hint.textContent = on
			? "Anyone with your shortlist link can view it."
			: "Private (only you can view it).";
	}

	// Load details
	let details = await getMyDetails().catch((e) => e);
	if (isAuthErr(details)) {
		location.hash = "#/login";
		return;
	}
	if (!(details && typeof details === "object")) details = { public: false };

	const initialPublic = !!details.public;
	const initialName = normText(details.shortlistName);

	$isPublic.checked = initialPublic;
	$name.value = initialName;
	setNameEnabled(initialPublic);

	$isPublic.addEventListener("change", () => {
		setNameEnabled($isPublic.checked);
		if ($isPublic.checked) {
			$name.focus();
			$name.select?.();
		}
	});

	async function doSave() {
		$status.textContent = "";
		$save.disabled = true;

		const nextPublic = !!$isPublic.checked;
		const nextName = nextPublic ? normText($name.value) : "";

		try {
			await putDetails(auth.userId, { public: nextPublic, shortlistName: nextName });
			$status.textContent = "Saved.";
		} catch (e) {
			if (isAuthErr(e)) {
				location.hash = "#/login";
				return;
			}
			$status.textContent = `Save failed: ${String(e?.message || e)}`;
		} finally {
			$save.disabled = false;
		}
	}

	$save.addEventListener("click", doSave);

	// Cmd/Ctrl+Enter to save from the name input
	$name.addEventListener("keydown", (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doSave();
	});
}