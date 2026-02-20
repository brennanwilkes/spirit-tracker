// viz/app/settings_page.js
import { esc } from "./dom.js";
import { AuthError, getAuthStatus, getMyDetails, putDetails } from "./cloud.js";

function isAuthErr(e) {
	return e && (e.name === "AuthError" || e instanceof AuthError);
}

function normText(s) {
	return String(s ?? "").trim();
}

function ensureSettingsCssOnce() {
	if (document.getElementById("stSettingsCss")) return;
	const css = document.createElement("style");
	css.id = "stSettingsCss";
	css.textContent = `
	/* Scope font + polish to settings only */
	.settingsWrap{
	  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
	  font-size: 15px;
	}
	.settingsWrap button,
	.settingsWrap input,
	.settingsWrap select,
	.settingsWrap textarea{ font: inherit; }

	.settingsCard{ padding: 16px; border-radius: 14px; }
	.settingsTitle{ font-size: 18px; font-weight: 900; letter-spacing: 0.2px; }

	.settingsSectionTitle{
	  font-weight: 900;
	  letter-spacing: 0.2px;
	  margin: 0 0 10px;
	}

	.hrClean{
	  height: 1px;
	  border: 0;
	  background: var(--border);
	  margin: 14px 0;
	  opacity: 1;
	}

	/* Toggle switch */
	.switchRow{
	  display: grid;
	  grid-template-columns: minmax(220px, 1fr) minmax(240px, 1fr);
	  gap: 14px;
	  align-items: start;
	}
	@media (max-width: 640px){
	  .switchRow{ grid-template-columns: 1fr; }
	}

	.switch{
	  display:flex;
	  align-items:center;
	  justify-content: space-between;
	  gap: 12px;
	  padding: 12px 12px;
	  border-radius: 12px;
	  border: 1px solid var(--border);
	  background: #0f1318;
	  user-select: none;
	}
	.switchLabel{
	  display:flex;
	  flex-direction: column;
	  gap: 2px;
	  min-width: 0;
	}
	.switchLabel b{ font-weight: 800; }
	.switchLabel span{ color: var(--muted); font-size: 12px; }

	.switch input{
	  position:absolute;
	  opacity:0;
	  pointer-events:none;
	}
	.switchPill{
	  width: 44px;
	  height: 26px;
	  border-radius: 999px;
	  border: 1px solid var(--border);
	  background: rgba(255,255,255,0.03);
	  position: relative;
	  flex: 0 0 auto;
	}
	.switchKnob{
	  width: 20px;
	  height: 20px;
	  border-radius: 999px;
	  background: var(--muted);
	  position: absolute;
	  top: 50%;
	  left: 3px;
	  transform: translateY(-50%);
	  transition: left 160ms ease, background 160ms ease;
	}
	.switch.isOn .switchPill{
	  border-color: rgba(125, 211, 252, 0.45);
	  box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.12) inset;
	}
	.switch.isOn .switchKnob{
	  left: 21px;
	  background: var(--accent);
	}

	.fieldTitle{ color: var(--muted); font-size: 12px; margin: 0 0 6px; }
	.fieldHint{ color: var(--muted); font-size: 12px; opacity: .9; margin-top: 6px; }

	/* Public link row */
	.linkRow{
	  display:flex;
	  gap: 10px;
	  align-items: center;
	  flex-wrap: wrap;
	}
	.linkBadge{
	  display:inline-flex;
	  align-items:center;
	  gap: 8px;
	  max-width: 100%;
	  overflow: hidden;
	  text-overflow: ellipsis;
	  white-space: nowrap;
	}
	.linkBadgeDisabled{
	  opacity: 0.55;
	  cursor: not-allowed;
	}

	/* Save button full width */
	.saveBtn{
	  width: 100%;
	  padding: 14px 12px;
	  border-radius: 12px;
	  font-weight: 900;
	  letter-spacing: 0.2px;
	  border-color: rgba(125, 211, 252, 0.28);
	  box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.10) inset;
	}
	`;
	document.head.appendChild(css);
}

export async function renderSettings($app) {
	ensureSettingsCssOnce();

	const auth = getAuthStatus();
	if (!auth.ok || !auth.token) {
		location.hash = "#/login";
		return;
	}

	const accountUuid = String(auth.userId || "").trim();
	const publicUrl = `${window.location.origin}/#/shortlist/${encodeURIComponent(accountUuid)}`;

	$app.innerHTML = `
		<div class="container settingsWrap">
			<div class="topbar">
				<button id="back" class="btn">← Back</button>
				<div class="h1 settingsTitle" style="margin:0;">Settings</div>
			</div>

			<div class="card settingsCard">
				<div style="display:flex; flex-direction:column; gap:14px;">

					<div>
						<div class="settingsSectionTitle">Shortlist settings</div>

						<div class="switchRow">
							<label id="publicSwitch" class="switch" style="cursor:pointer;">
								<input id="isPublic" type="checkbox" />
								<div class="switchLabel">
									<b>Public link</b>
									<span id="publicSub">Private (only you can view it).</span>
								</div>
								<div class="switchPill" aria-hidden="true">
									<div class="switchKnob"></div>
								</div>
							</label>

							<div>
								<div class="fieldTitle">Shortlist name</div>
								<input
									id="shortlistName"
									class="input"
									type="text"
									placeholder="My Bottle Shortlist"
									autocomplete="off"
								/>
								<div class="fieldHint" id="publicHint"></div>
							</div>
						</div>

						<hr class="hrClean" />

						<div>
							<div class="fieldTitle">Your shortlist link</div>
							<div class="linkRow">
								<span
									id="copyLink"
									class="badge mono badgeClick linkBadge"
									role="button"
									tabindex="0"
									title="Copy link"
								>${esc(publicUrl)}</span>
								<span class="small" id="copyStatus"></span>
							</div>
							<div class="fieldHint">Only works when Public link is enabled.</div>
						</div>
					</div>

					<hr class="hrClean" />

					<div>
						<div class="settingsSectionTitle">Email notifications</div>
						<div class="small">Coming soon.</div>
					</div>

					<hr class="hrClean" />

					<div style="display:flex; flex-direction:column; gap:10px;">
						<div class="small" id="status" style="min-height:16px;"></div>
						<button id="save" class="btn saveBtn" type="button">Save</button>
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

	const $switch = document.getElementById("publicSwitch");
	const $isPublic = document.getElementById("isPublic");
	const $name = document.getElementById("shortlistName");
	const $sub = document.getElementById("publicSub");
	const $hint = document.getElementById("publicHint");
	const $status = document.getElementById("status");
	const $save = document.getElementById("save");
	const $copy = document.getElementById("copyLink");
	const $copyStatus = document.getElementById("copyStatus");

	function setNameEnabled(on) {
		$name.disabled = !on;
		$name.style.opacity = on ? "1" : "0.55";
		$hint.textContent = on
			? "Anyone with your link can view your shortlist."
			: "Private (only you can view it).";
		$sub.textContent = on
			? "Anyone with the link can view."
			: "Private (only you can view it).";

		$switch.classList.toggle("isOn", !!on);
		$copy.classList.toggle("linkBadgeDisabled", !on);
		$copy.setAttribute("aria-disabled", on ? "false" : "true");
		$copy.tabIndex = on ? 0 : -1;
	}

	async function doCopy() {
		if (!$isPublic.checked) return;
		try {
			await navigator.clipboard.writeText(publicUrl);
			$copyStatus.textContent = "Copied.";
			setTimeout(() => ($copyStatus.textContent = ""), 1200);
		} catch (e) {
			$copyStatus.textContent = "Copy failed.";
			setTimeout(() => ($copyStatus.textContent = ""), 1200);
		}
	}

	$copy.addEventListener("click", (e) => {
		e.preventDefault();
		doCopy();
	});
	$copy.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			doCopy();
		}
	});

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

	// Make the whole switch clickable (label already does it, but keep state UI synced)
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
			$status.textContent = "Saved. Reloading…";
			setTimeout(() => location.reload(), 150);
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