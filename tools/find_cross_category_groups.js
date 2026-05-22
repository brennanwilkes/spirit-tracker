"use strict";

// Find canonical SKU groups that span more than one spirit type
// (rum / whisky / gin). These usually indicate either a SKU collision (two
// unrelated products sharing the same numeric SKU at different stores) or an
// incorrect entry in sku_links.json.
//
// Usage:
//   node tools/find_cross_category_groups.js [--db <dir>] [--json]
//
// Default --db is `.worktrees/data/data/db` if present, else `data/db`.

const fs = require("fs");
const path = require("path");

const { loadSkuMap } = require("../src/utils/sku_map");
const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");

/* ---------------- Args ---------------- */

const argv = process.argv.slice(2);
function argVal(name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : "";
}
const asJson = argv.includes("--json");

function pickDbDir() {
	const explicit = argVal("--db");
	if (explicit) return explicit;
	const wt = path.resolve(process.cwd(), ".worktrees/data/data/db");
	if (fs.existsSync(wt)) return wt;
	return path.resolve(process.cwd(), "data/db");
}
const dbDir = pickDbDir();
const dataDir = path.resolve(dbDir, "..");

/* ---------------- Spirit-type taxonomy (mirrored from viz/app/spirit_types.js) ---------------- */

const CATEGORY_TO_TYPES = {
	"rum":                          ["rum"],
	"rum-cane-spirit":              ["rum"],
	"spirits-rum":                  ["rum"],

	"whisky":                       ["whisky"],
	"whisky-whiskey":               ["whisky"],
	"spirits-whiskey":              ["whisky"],
	"american-whiskey":             ["whisky"],
	"bourbon-whiskey":              ["whisky"],
	"canadian-whisky":              ["whisky"],
	"canadian-whiskey":             ["whisky"],
	"irish-whiskey":                ["whisky"],
	"world-whisky":                 ["whisky"],
	"scotch":                       ["whisky"],
	"scotch-whisky":                ["whisky"],
	"scotch-whisky-single-malt":    ["whisky"],
	"scotch-selections":            ["whisky"],
	"scottish-blends":              ["whisky"],
	"scottish-single-malts":        ["whisky"],
	"single-malt-whisky":           ["whisky"],
	"spirits-scotch":               ["whisky"],
	"whiskey-scotch":               ["whisky"],

	"gin":                          ["gin"],
	"spirits-gin":                  ["gin"],

	"spirits-liquor":               ["rum", "whisky"],
	"all-minus-gin-tequila-mezcal": ["rum", "whisky"],

	"fine-rare":                    ["whisky"],
	"other":                        ["whisky"],

	"spirits":                      [],
};

const _RUM_FINISH = /\b(rum|rhum)\b.{0,25}\b(cask|finish(?:ed)?|fnsh|barrel|barrique)\b/i;
const _RUM = /\b(rum|rhum)\b/i;
const _WHISKY_CO = /\b(whisk(?:e)?y|scotch|single malt|blended malt|bourbon|rye|peated|islay|speyside|highland|lowland|campbeltown|irish|japanese)\b/i;
const _RUM_BRANDS = /\b(appleton|mount gay|doorly'?s|foursquare|worthy park|hampden|long pond|river antoine|clairin|angostura|paranubes|el dorado|diplomatico|zacapa|plantation|planteray|velier|rum sponge|bumbu|brugal|bacardi|black tot|sailor jerry|kraken|zaya|lamb'?s|dictador|navy island|smith\s*&\s*cross|asta morris|valinch\s*&\s*mallet|boutique-?y rum|alambique|dram mor|quarterdeck|maman brigitte|twin fin|bedford park)\b/i;
const _RUM_ORIGIN = /\b(jamaica|jamaican|guyana|guyanese|trinidad|trinidadian|barbados|fiji|fijian|haiti|haitian|grenada|nicaragua|venezuela|cuban|guadeloupe|martinique|st\.?\s*lucia|panama(?:nian)?|antigua|mauritius|dominican|south pacific)\b/i;
const _RUM_KEYWORDS = /\b(aguardiente|rhum agricole|agricole|solera|cachaca|caña|cana de azucar)\b/i;

const _GIN_NAME      = /\bgin\b/i;
const _GIN_AS_FINISH = /\bgin\b\s*(?:cask|finish|barrel)/i;
const _WHISKY_NAME   = /\b(whisk(?:e)?y|scotch|single malt|bourbon|rye whisk|aqua vitae)\b/i;
const _RUM_NAME      = /\b(rum|rhum)\b/i;

function applyNameOverride(types, name) {
	if (!Array.isArray(types) || types.length !== 1) return types;
	const nm = String(name || "");
	if (!nm) return types;

	const rumFinish = _RUM_FINISH.test(nm);
	const isRumName    = _RUM_NAME.test(nm) && !rumFinish;
	const isWhiskyName = _WHISKY_NAME.test(nm);
	const isGinName    = _GIN_NAME.test(nm) && !_GIN_AS_FINISH.test(nm);

	const signals = (isRumName ? 1 : 0) + (isWhiskyName ? 1 : 0) + (isGinName ? 1 : 0);
	if (signals !== 1) return types;

	if (isRumName)    return ["rum"];
	if (isWhiskyName) return ["whisky"];
	if (isGinName)    return ["gin"];
	return types;
}

function resolveItemSpiritTypes(categoryKey, url, name) {
	const k = String(categoryKey || "").toLowerCase().trim();

	if (k === "all-minus-gin-tequila-mezcal") {
		const t = `${String(name || "")} ${String(url || "")}`.toLowerCase();
		const hasRumPrimary   = _RUM.test(t) || _RUM_BRANDS.test(t);
		const hasRumSecondary = _RUM_ORIGIN.test(t) || _RUM_KEYWORDS.test(t);
		const hasRumFinish    = _RUM_FINISH.test(t);
		const hasWhiskyCo     = _WHISKY_CO.test(t);
		const rumFinishOnly   = (hasRumPrimary || hasRumSecondary) && hasRumFinish && hasWhiskyCo;
		const isRum = (hasRumPrimary && !rumFinishOnly)
		           || (hasRumSecondary && !hasWhiskyCo);
		return applyNameOverride(isRum ? ["rum"] : ["whisky"], name);
	}

	if (k === "spirits") {
		const u = String(url || "").toLowerCase();
		const m = u.match(/\/shop\/spirits\/([^/]+)\//);
		const slug = m ? m[1] : "";
		if (!slug) return applyNameOverride(null, name);
		let base = null;
		if (/^rum\b|^rum-/.test(slug)) base = ["rum"];
		else if (/^gin\b|^gin-/.test(slug)) base = ["gin"];
		else if (/whisky|whiskey|scotch|bourbon|rye/.test(slug)) base = ["whisky"];
		return applyNameOverride(base, name);
	}

	if (k === "spirits-liquor") {
		const u = String(url || "").toLowerCase();
		const hasRum    = /\brum\b/.test(u);
		const hasWhisky = /\bwhisk/.test(u);
		if (hasRum && !hasWhisky) return applyNameOverride(["rum"], name);
		if (hasWhisky && !hasRum) return applyNameOverride(["whisky"], name);
		return ["rum", "whisky"];
	}

	return applyNameOverride(CATEGORY_TO_TYPES[k] || null, name);
}

/* ---------------- Walk DBs ---------------- */

const { canonicalSku } = loadSkuMap({ dbDir });

// canonical sku -> { types: Set, members: [{store, sku, name, url, category, types:[]}] }
const groups = new Map();

const files = fs.readdirSync(dbDir).filter(f => f.endsWith(".json"));
for (const fname of files) {
	const full = path.join(dbDir, fname);
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(full, "utf8"));
	} catch {
		continue;
	}
	const store = parsed.store || fname.split("__")[0];
	const category = parsed.category || fname.split("__")[1] || "";
	const items = Array.isArray(parsed.items) ? parsed.items : [];

	for (const it of items) {
		if (!it || it.removed) continue;
		const rawSku = String(it.sku || "").trim();
		if (!rawSku) continue;

		const types = resolveItemSpiritTypes(category, it.url, it.name);
		if (!types || types.length === 0) continue;

		const normalized = normalizeImplicitSkuKey(rawSku);
		const canon = canonicalSku(normalized);
		if (!canon) continue;

		let g = groups.get(canon);
		if (!g) {
			g = { types: new Set(), members: [] };
			groups.set(canon, g);
		}
		for (const t of types) g.types.add(t);
		g.members.push({
			store,
			category,
			sku: rawSku,
			name: it.name || "",
			url: it.url || "",
			types,
		});
	}
}

/* ---------------- Filter cross-category groups ---------------- */

const crossCategory = [];
for (const [canon, g] of groups.entries()) {
	if (g.types.size < 2) continue;
	// Per-member types must actually disagree — a single mixed-DB row that
	// itself contributes ["rum","whisky"] (e.g. one ambiguous sierrasprings
	// item) should not flag a group on its own.
	const seenSingleTypes = new Set();
	for (const m of g.members) {
		if (m.types.length === 1) seenSingleTypes.add(m.types[0]);
	}
	if (seenSingleTypes.size < 2) continue;

	crossCategory.push({ canon, types: [...g.types].sort(), members: g.members });
}

crossCategory.sort((a, b) => {
	if (a.types.length !== b.types.length) return b.types.length - a.types.length;
	if (b.members.length !== a.members.length) return b.members.length - a.members.length;
	return a.canon.localeCompare(b.canon);
});

/* ---------------- Output ---------------- */

if (asJson) {
	process.stdout.write(JSON.stringify({ dbDir, dataDir, count: crossCategory.length, groups: crossCategory }, null, 2) + "\n");
} else {
	console.log(`Scanned ${files.length} DB files in ${dbDir}`);
	console.log(`Found ${crossCategory.length} cross-category canonical groups\n`);
	for (const g of crossCategory) {
		console.log(`── canonical=${g.canon}   types=[${g.types.join(", ")}]   members=${g.members.length}`);
		for (const m of g.members) {
			const t = m.types.join("/");
			console.log(`   [${t.padEnd(11)}] ${m.store.padEnd(15)} sku=${m.sku.padEnd(12)} ${m.name}`);
		}
		console.log("");
	}
}
