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
	.settingsWrap{
	  font-family: ui-sans-serif, system-ui, -apple-system, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
	  font-size: 15px;
	}
	.settingsWrap button,
	.settingsWrap input,
	.settingsWrap select,
	.settingsWrap textarea{ font: inherit; }

	.settingsCard{ padding: 16px; border-radius: 14px; }

	.settingsTitle{
	  font-size: 19px;
	  font-weight: 900;
	  letter-spacing: 0.2px;
	}

	.settingsSectionTitle{
	  font-size: 16px;
	  font-weight: 900;
	  letter-spacing: 0.2px;
	  margin: 0 0 10px;
	}

	.hrClean{
	  height: 1px;
	  border: 0;
	  background: var(--border);
	  margin: 12px 0;
	}

	.switchRow{
	  display: grid;
	  grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr);
	  gap: 14px;
	  align-items: start;
	}
	@media (max-width: 640px){
	  .switchRow{ grid-template-columns: 1fr; }
	}

	.fieldTitle{ color: var(--muted); font-size: 12px; margin: 0 0 6px; }

	.nameBlock .input{ height: 50px; }
	.switchWrap{ display:flex; flex-direction:column; padding-top: 2px; }

	.switch{
	  display:flex;
	  align-items:center;
	  justify-content: space-between;
	  gap: 12px;
	  padding: 0 12px;
	  height: 50px;
	  border-radius: 12px;
	  border: 1px solid var(--border);
	  background: #0f1318;
	  user-select: none;
	}
	.switch input{
	  position:absolute;
	  opacity:0;
	  pointer-events:none;
	}

	.switchLabel{
	  display:flex;
	  align-items:center;
	  min-width: 0;
	  height: 100%;
	}
	.switchStatus{
	  font-size: 14px;
	  line-height: 1.2;
	  color: var(--text);
	  opacity: 0.92;
	  font-weight: 750;
	  white-space: nowrap;
	  overflow: hidden;
	  text-overflow: ellipsis;
	  max-width: 100%;
	}
	.switchStatus.muted{
	  color: var(--muted);
	  opacity: 1;
	  font-weight: 750;
	}

	.switchPill{
	  width: 46px;
	  height: 28px;
	  border-radius: 999px;
	  border: 1px solid rgba(125, 211, 252, 0.22);
	  background: rgba(125, 211, 252, 0.10);
	  box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.07) inset;
	  position: relative;
	  flex: 0 0 auto;
	}
	.switchKnob{
	  width: 22px;
	  height: 22px;
	  border-radius: 999px;
	  background: rgba(154, 166, 178, 0.95);
	  position: absolute;
	  top: 50%;
	  left: 3px;
	  transform: translateY(-50%);
	  transition: left 160ms ease, background 160ms ease, box-shadow 160ms ease;
	  box-shadow: 0 1px 0 rgba(0,0,0,0.35);
	}
	.switch.isOn .switchPill{
	  border-color: rgba(125, 211, 252, 0.55);
	  background: rgba(125, 211, 252, 0.22);
	  box-shadow:
	    0 0 0 1px rgba(125, 211, 252, 0.12) inset,
	    0 0 0 4px rgba(125, 211, 252, 0.07);
	}
	.switch.isOn .switchKnob{
	  left: 21px;
	  background: rgba(125, 211, 252, 0.98);
	  box-shadow:
	    0 0 0 3px rgba(125, 211, 252, 0.16),
	    0 1px 0 rgba(0,0,0,0.28);
	}

	.subtleNote{
	  font-size: 12px;
	  color: var(--muted);
	  margin-top: 6px;
	  line-height: 1.25;
	}

	.nameBlock{ padding-top: 2px; }

	.linkSection{
	  display:flex;
	  flex-direction: column;
	  gap: 8px;
	  padding: 0;
	  margin-top: 20px;
	}
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
	  font-size: 14px;
	  padding: 6px 12px;
	  line-height: 1.2;
	}
	.linkBadgeDisabled{
	  opacity: 0.55;
	  cursor: not-allowed;
	}

	.saveArea{
	  display:flex;
	  flex-direction:column;
	  gap: 8px;
	}
	.saveStatus{
	  margin-top: -2px;
	  margin-bottom: -2px;
	  min-height: 0;
	  display: none;
	}
	.saveStatus.isOn{ display: block; }

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
						<div class="settingsSectionTitle">Shortlist</div>

						<div class="switchRow">

							<div class="switchWrap">
								<div class="fieldTitle">Public link</div>
								<label id="publicSwitch" class="switch" style="cursor:pointer;">
									<input id="isPublic" type="checkbox" />
									<div class="switchLabel">
										<div id="publicSub" class="switchStatus muted">Private (only you can view it).</div>
									</div>
									<div class="switchPill" aria-hidden="true">
										<div class="switchKnob"></div>
									</div>
								</label>
								<div id="publicNote" class="subtleNote" style="display:none;">
                                    Privacy changes may take up to 15 minutes to take effect.
								</div>
							</div>

							<div class="nameBlock">
								<div class="fieldTitle">Shortlist name</div>
								<input
									id="shortlistName"
									class="input"
									type="text"
									placeholder="My Bottle Shortlist"
									autocomplete="off"
								/>
							</div>
						</div>

						<hr class="hrClean" />

						<div class="linkSection">
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
						</div>
					</div>

					<hr class="hrClean" />

					<div>
                        <div class="settingsSectionTitle">Email notifications</div>

                        <div class="small" style="margin-bottom:10px; color:var(--muted);">
                            Add rules to get email alerts (ASAP). Saved on the same Settings “Save” button below.
                        </div>

                        <div id="rulesWrap" style="display:flex; flex-direction:column; gap:10px;"></div>

                        <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
                            <button id="addRule" class="btn" type="button">+ Add rule</button>
                        </div>

                        <div class="subtleNote" style="margin-top:8px;">
                            Keywords are optional. Separate with commas.
                        </div>
                    </div>

					<hr class="hrClean" />

					<div class="saveArea">
						<div class="small saveStatus" id="status"></div>
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
	const $note = document.getElementById("publicNote");
	const $status = document.getElementById("status");
	const $save = document.getElementById("save");
	const $copy = document.getElementById("copyLink");
	const $copyStatus = document.getElementById("copyStatus");

	function setStatusText(t) {
		const text = String(t || "").trim();
		$status.textContent = text;
		$status.classList.toggle("isOn", !!text);
	}

	function setUiForPublic(on) {
		$switch.classList.toggle("isOn", !!on);

		if (on) {
			$sub.textContent = "Anyone with the link can view.";
			$sub.classList.remove("muted");
		} else {
			$sub.textContent = "Private (only you can view it).";
			$sub.classList.add("muted");
		}

		$name.disabled = !on;
		$name.style.opacity = on ? "1" : "0.55";

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
		} catch {
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
	setUiForPublic(initialPublic);


    const $rulesWrap = document.getElementById("rulesWrap");
	const $addRule = document.getElementById("addRule");

	function getEmailNotifications(detailsObj) {
		const n = detailsObj?.emailNotifications;
		if (n && typeof n === "object" && Number(n.version) === 1 && Array.isArray(n.rules)) return n;
		return { version: 1, rules: [] };
	}

	function parseCsvKeywords(s) {
		return String(s || "")
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean);
	}

	function csvKeywords(arr) {
		return Array.isArray(arr) ? arr.join(", ") : "";
	}

	let emailNotifications = getEmailNotifications(details);
	let rules = Array.isArray(emailNotifications.rules) ? emailNotifications.rules.slice() : [];

	function renderRules() {
		if (!rules.length) {
			$rulesWrap.innerHTML = `<div class="small" style="color:var(--muted);">No rules yet.</div>`;
			return;
		}

		$rulesWrap.innerHTML = rules.map((r, i) => {
			const isDrop = r.eventType === "PRICE_DROP";
			const f = r.filters || {};
			return `
				<div class="card" style="padding:12px; border-radius:12px;">
					<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
						<label class="small" style="display:flex; align-items:center; gap:8px;">
							<input data-i="${i}" data-k="enabled" type="checkbox" ${r.enabled ? "checked" : ""}/>
							Enabled
						</label>

						<select data-i="${i}" data-k="scope" class="input" style="height:38px; max-width:160px;">
							<option value="all" ${r.scope === "all" ? "selected" : ""}>All bottles</option>
							<option value="shortlist" ${r.scope === "shortlist" ? "selected" : ""}>Shortlist only</option>
						</select>

						<select data-i="${i}" data-k="eventType" class="input" style="height:38px; max-width:180px;">
							<option value="IN_STOCK" ${r.eventType === "IN_STOCK" ? "selected" : ""}>In stock</option>
							<option value="OUT_OF_STOCK" ${r.eventType === "OUT_OF_STOCK" ? "selected" : ""}>Out of stock</option>
							<option value="PRICE_DROP" ${r.eventType === "PRICE_DROP" ? "selected" : ""}>Price drop</option>
							<option value="GLOBAL_NEW" ${r.eventType === "GLOBAL_NEW" ? "selected" : ""}>Global new SKU</option>
							<option value="GLOBAL_RETURN" ${r.eventType === "GLOBAL_RETURN" ? "selected" : ""}>Global return</option>
						</select>

						<button data-i="${i}" data-k="delete" class="btn" type="button">Delete</button>
					</div>

					<div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px;">
						<div>
							<div class="fieldTitle">Keywords include</div>
							<input data-i="${i}" data-k="keywordsAny" class="input" style="height:40px;"
								value="${esc(csvKeywords(f.keywordsAny))}" placeholder="e.g. Springbank, Benromach" />
						</div>
						<div>
							<div class="fieldTitle">Keywords exclude</div>
							<input data-i="${i}" data-k="keywordsNone" class="input" style="height:40px;"
								value="${esc(csvKeywords(f.keywordsNone))}" placeholder="e.g. 50ml, mini" />
						</div>
					</div>

					${isDrop ? `
					<div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; margin-top:10px;">
						<div>
							<div class="fieldTitle">Min $ drop</div>
							<input data-i="${i}" data-k="minDropAbs" class="input" style="height:40px;" type="number" min="0" step="0.01"
								value="${Number.isFinite(Number(f.minDropAbs)) ? String(f.minDropAbs) : ""}" placeholder="0" />
						</div>
						<div>
							<div class="fieldTitle">Min % drop</div>
							<input data-i="${i}" data-k="minDropPct" class="input" style="height:40px;" type="number" min="0" max="100" step="0.1"
								value="${Number.isFinite(Number(f.minDropPct)) ? String(f.minDropPct) : ""}" placeholder="0" />
						</div>
						<div style="display:flex; align-items:end;">
							<label class="small" style="display:flex; gap:8px; align-items:center;">
								<input data-i="${i}" data-k="requireCheapestNow" type="checkbox" ${f.requireCheapestNow ? "checked" : ""}/>
								Cheapest now
							</label>
						</div>
					</div>
					` : ""}
				</div>
			`;
		}).join("");
	}

	function newRule() {
		const id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
		return {
			id,
			enabled: true,
			scope: "shortlist",
			eventType: "IN_STOCK",
			filters: { keywordsAny: [], keywordsNone: [] },
		};
	}

	function normalizeRule(r) {
		const out = { ...r };
		out.enabled = !!out.enabled;
		out.scope = out.scope === "all" ? "all" : "shortlist";
		const et = String(out.eventType || "IN_STOCK");
		out.eventType = ["IN_STOCK","OUT_OF_STOCK","PRICE_DROP","GLOBAL_NEW","GLOBAL_RETURN"].includes(et) ? et : "IN_STOCK";

		const f = out.filters && typeof out.filters === "object" ? { ...out.filters } : {};
		f.keywordsAny = Array.isArray(f.keywordsAny) ? f.keywordsAny : [];
		f.keywordsNone = Array.isArray(f.keywordsNone) ? f.keywordsNone : [];

		if (out.eventType === "PRICE_DROP") {
			if (f.minDropAbs != null && f.minDropAbs !== "") f.minDropAbs = Number(f.minDropAbs);
			else delete f.minDropAbs;
			if (f.minDropPct != null && f.minDropPct !== "") f.minDropPct = Number(f.minDropPct);
			else delete f.minDropPct;
			f.requireCheapestNow = !!f.requireCheapestNow;
		} else {
			delete f.minDropAbs;
			delete f.minDropPct;
			delete f.requireCheapestNow;
		}

		// drop empty filters
		if (!f.keywordsAny.length) delete f.keywordsAny;
		if (!f.keywordsNone.length) delete f.keywordsNone;
		if (Object.keys(f).length) out.filters = f;
		else delete out.filters;

		return out;
	}

	$addRule.addEventListener("click", () => {
		rules = rules.concat([newRule()]);
		renderRules();
	});

	$rulesWrap.addEventListener("input", (e) => {
		const el = e.target;
		const i = Number(el?.dataset?.i);
		const k = String(el?.dataset?.k || "");
		if (!Number.isFinite(i) || i < 0 || i >= rules.length) return;

		const r = { ...rules[i] };
		r.filters = r.filters && typeof r.filters === "object" ? { ...r.filters } : {};

		if (k === "enabled") r.enabled = !!el.checked;
		else if (k === "scope") r.scope = String(el.value || "");
		else if (k === "eventType") r.eventType = String(el.value || "");
		else if (k === "keywordsAny") r.filters.keywordsAny = parseCsvKeywords(el.value);
		else if (k === "keywordsNone") r.filters.keywordsNone = parseCsvKeywords(el.value);
		else if (k === "minDropAbs") r.filters.minDropAbs = el.value === "" ? undefined : Number(el.value);
		else if (k === "minDropPct") r.filters.minDropPct = el.value === "" ? undefined : Number(el.value);
		else if (k === "requireCheapestNow") r.filters.requireCheapestNow = !!el.checked;

		rules[i] = normalizeRule(r);
		// eventType switch affects visible fields
		if (k === "eventType") renderRules();
	});

	$rulesWrap.addEventListener("click", (e) => {
		const el = e.target;
		const i = Number(el?.dataset?.i);
		const k = String(el?.dataset?.k || "");
		if (k !== "delete") return;
		if (!Number.isFinite(i) || i < 0 || i >= rules.length) return;
		rules = rules.filter((_, idx) => idx !== i);
		renderRules();
	});

	renderRules();



	let prevPublic = initialPublic;

    $isPublic.addEventListener("change", () => {
        const next = $isPublic.checked;
        setUiForPublic(next);
    
        // show note for BOTH directions
        const changed = prevPublic !== next;
        $note.style.display = changed ? "block" : "none";
    
        prevPublic = next;
    
        if (next) {
            $name.focus();
            $name.select?.();
        }
    });

    async function doSave() {
		setStatusText("");
		$save.disabled = true;

		const nextPublic = !!$isPublic.checked;
		const nextName = nextPublic ? normText($name.value) : "";

		const nextDetails = {
			...details,
			public: nextPublic,
			shortlistName: nextName,
			emailNotifications: { version: 1, rules: rules.slice() },
		};

		try {
			await putDetails(auth.userId, nextDetails);
			setStatusText("Saved. Reloading…");
			setTimeout(() => location.reload(), 150);
		} catch (e) {
			if (isAuthErr(e)) {
				location.hash = "#/login";
				return;
			}
			setStatusText(`Save failed: ${String(e?.message || e)}`);
		} finally {
			$save.disabled = false;
		}
	}

	$save.addEventListener("click", doSave);

	$name.addEventListener("keydown", (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doSave();
	});
}