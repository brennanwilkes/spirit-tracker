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

	/* --- mini switch (for rule field toggles) --- */
	.switch.mini{
	  height: 40px;
	  border-radius: 12px;
	  padding: 0 10px;
	}
	.switch.mini .switchStatus{ font-size: 13px; font-weight: 850; }
	.switch.mini .switchPill{ width: 42px; height: 26px; }
	.switch.mini .switchKnob{ width: 20px; height: 20px; }
	.switch.mini.isOn .switchKnob{ left: 19px; }

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

	/* --- rule editor --- */
	.stRuleCard{
	  padding: 12px;
	  border-radius: 12px;
	}
	.stRuleHeader{
	  display:grid;
	  grid-template-columns: 1fr 1fr 40px;
	  gap: 10px;
	  align-items:center;
	}
	.stRuleEvent{ grid-column: 1; }
	.stRuleScope{ grid-column: 2; }
	.ruleTrashBtn{ grid-column: 3; justify-self: end; }

	@media (max-width: 640px){
	  .stRuleHeader{ grid-template-columns: 1fr 40px; }
	  .stRuleEvent{ grid-column: 1; grid-row: 1; }
	  .ruleTrashBtn{ grid-column: 2; grid-row: 1; justify-self: end; }
	  .stRuleHeader .stRuleScope{ grid-column: 1 / -1; grid-row: 2; }
	}

	/* --- rule editor --- */
	.stRuleCard{
	  padding: 12px;
	  border-radius: 12px;
	
	  /* make it stand out from the parent .card */
	  background: #0f1318;
	  border: 1px solid rgba(125, 211, 252, 0.18);
	  box-shadow:
		0 0 0 1px rgba(0,0,0,0.35) inset,
		0 10px 18px rgba(0,0,0,0.22);
	}
	
	/* divider between rules */
	.hrRule{
	  height: 2px;
	  border: 0;
	  margin: 12px 2px;
	  background: linear-gradient(
		90deg,
		rgba(125,211,252,0.00),
		rgba(125,211,252,0.55),
		rgba(125,211,252,0.00)
	  );
	  opacity: 0.95;
	}
	
	/* remove the flex gap so the HR does the separation */
	#rulesWrap{ gap: 0 !important; }
	
	@media (max-width: 640px){
	  .hrRule{ margin: 14px 0; }
	}

	/* custom select to avoid .input padding issues */
	.stSelect{
	  width: 100%;
	  height: 40px;
	  border: 1px solid var(--border);
	  background: #0f1318;
	  color: var(--text);
	  border-radius: 10px;

	  -webkit-appearance: none;
	  -moz-appearance: none;
	  appearance: none;
	  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239aa6b2' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
	  background-repeat: no-repeat;
	  background-position: right 10px center;
	  background-size: 12px 12px;

	  padding: 6px 28px 6px 10px;
	  font-size: 13px;
	  line-height: 1;
	  outline: none;
	}
	.stSelect:hover{ border-color: #2f3a46; cursor:pointer; }
	.stSelect:focus{ border-color: #37566b; outline: 1px solid #37566b; }
	.stSelect:disabled{ opacity: 0.55; cursor:not-allowed; }

	.stRuleRows{
	  display:flex;
	  flex-direction:column;
	  gap: 10px;
	  margin-top: 10px;
	}

	.stRuleRow{
	  display:grid;
	  grid-template-columns: minmax(220px, 300px) 1fr;
	  gap: 10px;
	  align-items:center;
	}
	@media (max-width: 640px){
	  .stRuleRow{ grid-template-columns: 1fr; }
	}

	.stRuleInput{
	  height: 40px;
	  padding: 10px 12px;
	}
	.stRuleInput:disabled{ opacity: 0.55; }

	.stRuleNote{
	  margin-top: 2px;
	}

	.ruleTrashBtn{
	  width:40px;
	  height:40px;
	  padding:0;
	  display:inline-flex;
	  align-items:center;
	  justify-content:center;
	}
	.ruleTrashBtn svg{
	  width: 18px;
	  height: 18px;
	  stroke: currentColor;
	  fill: none;
	  stroke-width: 2;
	  stroke-linecap: round;
	  stroke-linejoin: round;
	}

	/* Add rule button area */
	.addRuleRow{ margin-top: 12px; }
	.addRuleBtn{ width: 100%; }
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

						<div id="rulesWrap" style="display:flex; flex-direction:column; gap:10px;"></div>

						<div class="addRuleRow">
							<button id="addRule" class="btn addRuleBtn" type="button">+ Add rule</button>
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

	/* ---------------- Email rules UI ---------------- */

	const STORES = [
		{ id: "arc", label: "ARC Liquor" },
		{ id: "bcl", label: "BCL" },
		{ id: "bsw", label: "BSW" },
		{ id: "coop", label: "Co-op World of Whisky" },
		{ id: "craftcellars", label: "Craft Cellars" },
		{ id: "gull", label: "Gull Liquor" },
		{ id: "kegncork", label: "Keg N Cork" },
		{ id: "kwm", label: "Kensington Wine Market" },
		{ id: "legacyliquor", label: "Legacy Liquor" },
		{ id: "maltsandgrains", label: "Malts & Grains" },
		{ id: "sierrasprings", label: "Sierra Springs" },
		{ id: "strath", label: "Strath Liquor" },
		{ id: "tudor", label: "Tudor House" },
		{ id: "vessel", label: "Vessel Liquor" },
		{ id: "vintage", label: "Vintage Spirits" },
		{ id: "willowpark", label: "Willow Park" },
	];

	const $rulesWrap = document.getElementById("rulesWrap");
	const $addRule = document.getElementById("addRule");

	function getEmailNotifications(detailsObj) {
		const n = detailsObj && detailsObj.emailNotifications;
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

	function trashIconSvg() {
		return `
			<svg viewBox="0 0 24 24" aria-hidden="true">
			  <path d="M3 6h18"></path>
			  <path d="M8 6V4h8v2"></path>
			  <path d="M6 6l1 16h10l1-16"></path>
			  <path d="M10 11v6"></path>
			  <path d="M14 11v6"></path>
			</svg>
		`;
	}

	let emailNotifications = getEmailNotifications(details);
	let rules = Array.isArray(emailNotifications.rules) ? emailNotifications.rules.slice() : [];
    rules = rules.map(normalizeRule);

	function ensureFilters(r) {
		return (r && r.filters && typeof r.filters === "object") ? { ...r.filters } : {};
	}

	function dropEmptyFilters(r) {
		const f = ensureFilters(r);

		if (f.keywordsAny !== undefined && !Array.isArray(f.keywordsAny)) delete f.keywordsAny;
		if (f.keywordsNone !== undefined && !Array.isArray(f.keywordsNone)) delete f.keywordsNone;

		if (typeof f.storeId === "string" && !String(f.storeId).trim()) delete f.storeId;

		if (f.acrossMarket !== undefined && typeof f.acrossMarket !== "boolean") delete f.acrossMarket;

		if (f.requireCheapestNow !== true) delete f.requireCheapestNow;

		if (!(typeof f.minDropAbs === "number" && Number.isFinite(f.minDropAbs) && f.minDropAbs >= 0)) delete f.minDropAbs;
		if (!(typeof f.minDropPct === "number" && Number.isFinite(f.minDropPct) && f.minDropPct >= 0 && f.minDropPct <= 100)) delete f.minDropPct;

		const out = { ...r };
		if (Object.keys(f).length) out.filters = f;
		else delete out.filters;
		return out;
	}

	function normalizeRule(r) {
		const out = { ...r };
		out.enabled = true;

		out.scope = out.scope === "all" ? "all" : "shortlist";

		const et = String(out.eventType || "GLOBAL_NEW");
		out.eventType = ["GLOBAL_NEW", "GLOBAL_RETURN", "OUT_OF_STOCK", "PRICE_DROP"].includes(et) ? et : "GLOBAL_NEW";

		const f = ensureFilters(out);

		if (out.eventType === "GLOBAL_NEW" && typeof f.acrossMarket !== "boolean") {
			f.acrossMarket = true;
		}

		if (!(out.eventType === "GLOBAL_NEW" || out.eventType === "GLOBAL_RETURN" || out.eventType === "OUT_OF_STOCK")) {
			delete f.acrossMarket;
		}

		if (out.eventType !== "PRICE_DROP") {
			delete f.minDropAbs;
			delete f.minDropPct;
			delete f.requireCheapestNow;
		}

		out.filters = f;
		return dropEmptyFilters(out);
	}

	function newRule() {
		const id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
		return normalizeRule({
			id,
			enabled: true,
			scope: "all",
			eventType: "GLOBAL_NEW",
			filters: { acrossMarket: true },
		});
	}

	function storeOptionsHtml(selected) {
		return STORES.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? "selected" : ""}>${esc(s.label)}</option>`).join("");
	}

	function labelForEventType(et) {
		switch (et) {
			case "GLOBAL_NEW": return "New bottle";
			case "GLOBAL_RETURN": return "Back in stock";
			case "OUT_OF_STOCK": return "Out of stock";
			case "PRICE_DROP": return "Price drop";
			default: return "New bottle";
		}
	}

	function renderRules() {
		if (!rules.length) {
			$rulesWrap.innerHTML = `<div class="small" style="color:var(--muted);">No rules yet.</div>`;
			return;
		}

		$rulesWrap.innerHTML = rules.map((r, i) => {
			const f = ensureFilters(r);

			const useStore = typeof f.storeId === "string" && !!String(f.storeId).trim();

			const useKwAny = Array.isArray(f.keywordsAny);
			const useKwNone = Array.isArray(f.keywordsNone);

			const isDrop = r.eventType === "PRICE_DROP";
			const useMinAbs = isDrop && typeof f.minDropAbs === "number" && Number.isFinite(f.minDropAbs);
			const useMinPct = isDrop && typeof f.minDropPct === "number" && Number.isFinite(f.minDropPct);
			const useCheapest = isDrop && f.requireCheapestNow === true;

			const showAcrossMarket = (r.eventType === "GLOBAL_NEW" || r.eventType === "GLOBAL_RETURN" || r.eventType === "OUT_OF_STOCK");
			const useAcrossMarket = showAcrossMarket && f.acrossMarket === true;

			const storeSel = useStore ? String(f.storeId) : (STORES[0] ? STORES[0].id : "");

            let acrossTitle = "Across market (same SKU)";
            let acrossHelp = "";
            
            if (r.eventType === "GLOBAL_NEW") {
                acrossHelp =
                    "On = alert only when this SKU is brand new to the market (no store had it). " +
                    "Off = alert when any store adds it.";
            } else if (r.eventType === "GLOBAL_RETURN") {
                acrossHelp =
                    "On = alert only when this SKU returns to the market (was out everywhere). " +
                    "Off = alert when a store restocks it.";
            } else if (r.eventType === "OUT_OF_STOCK") {
                acrossHelp =
                    "On = alert only when this SKU disappears from the market (no store has it). " +
                    "Off = alert when a store goes out of stock.";
            }


			return `
				<div class="card stRuleCard" data-rule="${esc(r.id)}">
					<div class="stRuleHeader">
						<select data-i="${i}" data-k="eventType" class="stSelect stRuleEvent" aria-label="Alert type">
							${["GLOBAL_NEW","GLOBAL_RETURN","OUT_OF_STOCK","PRICE_DROP"].map((et) =>
								`<option value="${et}" ${r.eventType === et ? "selected" : ""}>${esc(labelForEventType(et))}</option>`
							).join("")}
						</select>

						<select data-i="${i}" data-k="scope" class="stSelect stRuleScope" aria-label="Scope">
							<option value="all" ${r.scope === "all" ? "selected" : ""}>All bottles</option>
							<option value="shortlist" ${r.scope === "shortlist" ? "selected" : ""}>Shortlist only</option>
						</select>

						<button data-i="${i}" data-k="delete" class="favStarBtn ruleTrashBtn" type="button" title="Delete rule" aria-label="Delete rule">
							${trashIconSvg()}
						</button>
					</div>

					<div class="stRuleRows">

						<div class="stRuleRow">
							<label data-i="${i}" data-k="useStore" class="switch mini ${useStore ? "isOn" : ""}" style="cursor:pointer;">
								<input type="checkbox" ${useStore ? "checked" : ""} />
								<div class="switchLabel">
									<div class="switchStatus ${useStore ? "" : "muted"}">Filter by store</div>
								</div>
								<div class="switchPill" aria-hidden="true"><div class="switchKnob"></div></div>
							</label>
							<select data-i="${i}" data-k="storeId" class="stSelect" ${useStore ? "" : "disabled"}>
								${storeOptionsHtml(storeSel)}
							</select>
						</div>

						<div class="stRuleRow">
							<label data-i="${i}" data-k="useKwAny" class="switch mini ${useKwAny ? "isOn" : ""}" style="cursor:pointer;">
								<input type="checkbox" ${useKwAny ? "checked" : ""} />
								<div class="switchLabel">
									<div class="switchStatus ${useKwAny ? "" : "muted"}">Include keywords</div>
								</div>
								<div class="switchPill" aria-hidden="true"><div class="switchKnob"></div></div>
							</label>
							<input
								data-i="${i}"
								data-k="keywordsAny"
								class="input stRuleInput"
								type="text"
								placeholder="Comma-separated. e.g. Springbank, Benromach"
								autocomplete="off"
								value="${esc(useKwAny ? csvKeywords(f.keywordsAny) : "")}"
								${useKwAny ? "" : "disabled"}
							/>
						</div>

						<div class="stRuleRow">
							<label data-i="${i}" data-k="useKwNone" class="switch mini ${useKwNone ? "isOn" : ""}" style="cursor:pointer;">
								<input type="checkbox" ${useKwNone ? "checked" : ""} />
								<div class="switchLabel">
									<div class="switchStatus ${useKwNone ? "" : "muted"}">Exclude keywords</div>
								</div>
								<div class="switchPill" aria-hidden="true"><div class="switchKnob"></div></div>
							</label>
							<input
								data-i="${i}"
								data-k="keywordsNone"
								class="input stRuleInput"
								type="text"
								placeholder="Comma-separated. e.g. 50ml, mini"
								autocomplete="off"
								value="${esc(useKwNone ? csvKeywords(f.keywordsNone) : "")}"
								${useKwNone ? "" : "disabled"}
							/>
						</div>

						<div class="subtleNote stRuleNote">
							Keywords match the bottle name. Use commas to list multiple.
						</div>

						${showAcrossMarket ? `
						<div class="stRuleRow">
							<label data-i="${i}" data-k="useAcrossMarket" class="switch mini ${useAcrossMarket ? "isOn" : ""}" style="cursor:pointer;">
								<input type="checkbox" ${useAcrossMarket ? "checked" : ""} />
								<div class="switchLabel">
									<div class="switchStatus ${useAcrossMarket ? "" : "muted"}">${esc(acrossTitle)}</div>
								</div>
								<div class="switchPill" aria-hidden="true"><div class="switchKnob"></div></div>
							</label>
							<div class="small" style="text-align:left;">
								${esc(acrossHelp)}
							</div>
						</div>
						` : ""}

						${isDrop ? `
						<div class="stRuleRow">
							<label data-i="${i}" data-k="useMinAbs" class="switch mini ${useMinAbs ? "isOn" : ""}" style="cursor:pointer;">
								<input type="checkbox" ${useMinAbs ? "checked" : ""} />
								<div class="switchLabel">
									<div class="switchStatus ${useMinAbs ? "" : "muted"}">Min $ drop</div>
								</div>
								<div class="switchPill" aria-hidden="true"><div class="switchKnob"></div></div>
							</label>
							<input
								data-i="${i}"
								data-k="minDropAbs"
								class="input stRuleInput"
								type="number"
								min="0"
								step="0.01"
								placeholder="0"
								value="${useMinAbs ? esc(String(f.minDropAbs)) : ""}"
								${useMinAbs ? "" : "disabled"}
							/>
						</div>

						<div class="stRuleRow">
							<label data-i="${i}" data-k="useMinPct" class="switch mini ${useMinPct ? "isOn" : ""}" style="cursor:pointer;">
								<input type="checkbox" ${useMinPct ? "checked" : ""} />
								<div class="switchLabel">
									<div class="switchStatus ${useMinPct ? "" : "muted"}">Min % drop</div>
								</div>
								<div class="switchPill" aria-hidden="true"><div class="switchKnob"></div></div>
							</label>
							<input
								data-i="${i}"
								data-k="minDropPct"
								class="input stRuleInput"
								type="number"
								min="0"
								max="100"
								step="0.1"
								placeholder="0"
								value="${useMinPct ? esc(String(f.minDropPct)) : ""}"
								${useMinPct ? "" : "disabled"}
							/>
						</div>

						<div class="stRuleRow">
							<label data-i="${i}" data-k="useCheapest" class="switch mini ${useCheapest ? "isOn" : ""}" style="cursor:pointer;">
								<input type="checkbox" ${useCheapest ? "checked" : ""} />
								<div class="switchLabel">
									<div class="switchStatus ${useCheapest ? "" : "muted"}">Cheapest across market (same SKU)</div>
								</div>
								<div class="switchPill" aria-hidden="true"><div class="switchKnob"></div></div>
							</label>
							<div class="small" style="text-align:left;">Cheapest price across all stores (SKU-matched).</div>
						</div>
						` : ""}

					</div>
				</div>
				${i < rules.length - 1 ? `<hr class="hrRule" />` : ``}
			`;
		}).join("");
	}

	function setRuleAt(i, nextRule) {
		rules[i] = normalizeRule(nextRule);
	}

	$addRule.addEventListener("click", () => {
		rules = rules.concat([newRule()]);
		renderRules();
	});

	$rulesWrap.addEventListener("click", (e) => {
		const btn = e.target?.closest?.("button[data-k]");
		if (btn) {
			const k = String(btn.getAttribute("data-k") || "");
			if (k === "delete") {
				const i = Number(btn.getAttribute("data-i"));
				if (!Number.isFinite(i) || i < 0 || i >= rules.length) return;
				rules = rules.filter((_, idx) => idx !== i);
				renderRules();
				return;
			}
		}

		const lab = e.target?.closest?.("label.switch.mini");
		if (!lab) return;

		const i = Number(lab.getAttribute("data-i"));
		const dk = String(lab.getAttribute("data-k") || "");
		if (!Number.isFinite(i) || i < 0 || i >= rules.length) return;

		const cb = lab.querySelector("input[type='checkbox']");
		if (!cb) return;

		cb.checked = !cb.checked;

		const cur = { ...rules[i] };
		const f = ensureFilters(cur);

		if (dk === "useStore") {
			if (cb.checked) f.storeId = f.storeId || (STORES[0] ? STORES[0].id : "kwm");
			else delete f.storeId;
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}

		if (dk === "useKwAny") {
			if (cb.checked) f.keywordsAny = Array.isArray(f.keywordsAny) ? f.keywordsAny : [];
			else delete f.keywordsAny;
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}

		if (dk === "useKwNone") {
			if (cb.checked) f.keywordsNone = Array.isArray(f.keywordsNone) ? f.keywordsNone : [];
			else delete f.keywordsNone;
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}

		if (dk === "useAcrossMarket") {
			f.acrossMarket = cb.checked ? true : false;
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}

		if (dk === "useMinAbs") {
			if (cb.checked) f.minDropAbs = typeof f.minDropAbs === "number" && Number.isFinite(f.minDropAbs) ? f.minDropAbs : 0;
			else delete f.minDropAbs;
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}

		if (dk === "useMinPct") {
			if (cb.checked) f.minDropPct = typeof f.minDropPct === "number" && Number.isFinite(f.minDropPct) ? f.minDropPct : 0;
			else delete f.minDropPct;
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}

		if (dk === "useCheapest") {
			if (cb.checked) f.requireCheapestNow = true;
			else delete f.requireCheapestNow;
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}
	}, true);

	$rulesWrap.addEventListener("change", (e) => {
		const el = e.target;
		const i = Number(el?.getAttribute?.("data-i"));
		const k = String(el?.getAttribute?.("data-k") || "");
		if (!Number.isFinite(i) || i < 0 || i >= rules.length) return;

		const cur = { ...rules[i] };
		const f = ensureFilters(cur);

		if (k === "scope") {
			cur.scope = String(el.value || "");
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}
		if (k === "eventType") {
			cur.eventType = String(el.value || "");
			setRuleAt(i, { ...cur, filters: f });
			renderRules();
			return;
		}
		if (k === "storeId") {
			f.storeId = String(el.value || "").trim();
			setRuleAt(i, { ...cur, filters: f });
			return;
		}
	});

	$rulesWrap.addEventListener("input", (e) => {
		const el = e.target;
		const i = Number(el?.getAttribute?.("data-i"));
		const k = String(el?.getAttribute?.("data-k") || "");
		if (!Number.isFinite(i) || i < 0 || i >= rules.length) return;

		const cur = { ...rules[i] };
		const f = ensureFilters(cur);

		if (k === "keywordsAny") {
			f.keywordsAny = parseCsvKeywords(el.value);
			setRuleAt(i, { ...cur, filters: f });
			return;
		}
		if (k === "keywordsNone") {
			f.keywordsNone = parseCsvKeywords(el.value);
			setRuleAt(i, { ...cur, filters: f });
			return;
		}
		if (k === "minDropAbs") {
			const v = String(el.value || "");
			const n = v === "" ? NaN : Number(v);
			f.minDropAbs = Number.isFinite(n) && n >= 0 ? n : 0;
			setRuleAt(i, { ...cur, filters: f });
			return;
		}
		if (k === "minDropPct") {
			const v = String(el.value || "");
			const n = v === "" ? NaN : Number(v);
			f.minDropPct = Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
			setRuleAt(i, { ...cur, filters: f });
			return;
		}
	});

	renderRules();

	/* ---------------- public switch wiring ---------------- */

	let prevPublic = initialPublic;

	$isPublic.addEventListener("change", () => {
		const next = $isPublic.checked;
		setUiForPublic(next);

		const changed = prevPublic !== next;
		$note.style.display = changed ? "block" : "none";

		prevPublic = next;

		if (next) {
			$name.focus();
			$name.select?.();
		}
	});

	/* ---------------- Save ---------------- */

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