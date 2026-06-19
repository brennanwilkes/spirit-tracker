/**
 * Single source of truth for all store metadata.
 * Replaces scattered definitions in stores_page.js and storeColors.js.
 */

export const STORES = [
	// ── BC stores ──────────────────────────────────────────────────────────
	{
		id: "everythingwine",
		label: "Everything Wine",
		region: "bc",
		color: "#3B7A57",
		logo: "https://www.everythingwine.ca/static/version1781781446/frontend/Everythingwine/everythingwine/en_US/images/logo.svg",
		url: "https://www.everythingwine.ca",
		aliases: [],
	},
	{
		id: "arc",
		label: "ARC Liquor",
		region: "bc",
		color: "#9467BD",
		logo: "https://s.barnetnetwork.com/media/f/0e/22/a1/bf/0e22a1bf-1e98-482d-b332-eb0ba0f22722.png",
		url: "",
		aliases: ["arcliquor"],
	},
	{
		id: "bcl",
		label: "BCL",
		region: "bc",
		color: "#1F77B4",
		logo: "https://www.guidedby.ca/img/asset/d3BfdXBsb2Fkcy9sb2dvLWJjLWxpcXVvci1zdG9yZS1pcm9ud29vZC5qcGc=?p=md",
		url: "",
		aliases: [],
	},
	{
		id: "gull",
		label: "Gull Liquor",
		region: "bc",
		color: "#6B0F1A",
		logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQIJA_whsBa8iTXQ-wFxacDBxQxbmXInxkl7Q&s",
		url: "",
		aliases: ["gullliquor"],
	},
	{
		id: "legacyliquor",
		label: "Legacy Liquor",
		region: "bc",
		color: "#7B4A12",
		logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQJsphhKOkacPi-a62RgC76ez05LnkPVp4A5Q&s",
		url: "",
		aliases: ["legacy"],
	},
	{
		id: "strath",
		label: "Strath Liquor",
		region: "bc",
		color: "#76B7FF",
		logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRa7HEM5Ah79hCwEd2nTExFAaab7unm792RBg&s",
		url: "",
		aliases: ["strathliquor"],
	},
	{
		id: "tudor",
		label: "Tudor House",
		region: "bc",
		color: "#FF7F0E",
		logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcT9ON4YVT-GUV0SBZDQrmAXyAXvLp_5xcXicg&s",
		url: "",
		aliases: ["tudorhouse"],
	},
	{
		id: "vessel",
		label: "Vessel Liquor",
		region: "bc",
		color: "#FFFFFF",
		logo: "https://www.go2hr.ca/wp-content/uploads/2023/04/Vessel_Final_logo_wtext-01-e1521483297146.jpg",
		url: "",
		aliases: ["vesselliquor"],
	},
	{
		id: "vintage",
		label: "Vintage Spirits",
		region: "bc",
		color: "#E34A2C",
		logo: "https://s.barnetnetwork.com/media/f/d3/0b/23/59/d30b2359-8836-4c75-8bdf-5f93f80554e2.png",
		url: "",
		aliases: ["vintagespirits"],
	},
	{
		id: "liquorwarehouse",
		label: "Liquor Warehouse",
		region: "bc",
		color: "#C49C94",
		logo: "./img/stores/liquorwarehouse.jpeg",
		url: "",
		aliases: ["liquorwarehouse"],
	},
	{
		id: "liberty",
		label: "Liberty Wine Merchants",
		region: "bc",
		color: "#6B6ECF",
		logo: "./img/stores/liberty.jpeg",
		url: "",
		aliases: ["libertywinemerchants"],
	},
	{
		id: "highpointbws",
		label: "High Point BWS",
		region: "bc",
		color: "#843C39",
		logo: "./img/stores/highpointbws.png",
		url: "",
		aliases: ["highpointbws"],
	},
	{
		id: "newdistrict",
		label: "New District",
		region: "bc",
		color: "#7B4173",
		logo: "./img/stores/newdistrict.png",
		url: "",
		aliases: ["newdistrict"],
	},
	{
		id: "marquis",
		label: "Marquis Wine Cellars",
		region: "bc",
		color: "#CE6DBD",
		logo: "./img/stores/marquis.jpeg",
		url: "",
		aliases: ["marquiswinecellars"],
	},
	// ── AB stores ──────────────────────────────────────────────────────────
	{
		id: "bsw",
		label: "BSW",
		region: "ab",
		color: "#E9DF7A",
		logo: "https://www.bswliquor.com/cdn/shop/files/bsw-logo.png?v=1699261679&width=100",
		url: "",
		aliases: [],
	},
	{
		id: "coop",
		label: "Co-op World of Whisky",
		region: "ab",
		color: "#2CA02C",
		logo: "https://www.coopwinespiritsbeer.com/wp-content/themes/calgarycoop/src/images/cc-black-desktop-logo.svg",
		url: "",
		aliases: ["coopworldofwhisky"],
	},
	{
		id: "craftcellars",
		label: "Craft Cellars",
		region: "ab",
		color: "#E31B23",
		logo: "https://pbs.twimg.com/profile_images/590644683442884611/K2Pu0S7D.jpg",
		url: "",
		aliases: [],
	},
	{
		id: "kegncork",
		label: "Keg N Cork",
		region: "ab",
		color: "#111111",
		logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQZIVLtvsg1BP0UWMTe76Qfq4rtRtjBuIxo9w&s",
		url: "",
		aliases: [],
	},
	{
		id: "kwm",
		label: "Kensington Wine Market",
		region: "ab",
		color: "#F2C200",
		logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRAJn_7veeZW6RD-DDusNtJVkBTAaskYBzh5g&s",
		url: "",
		aliases: ["kensingtonwinemarket"],
	},
	{
		id: "maltsandgrains",
		label: "Malts & Grains",
		region: "ab",
		color: "#A67C52",
		logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcS0q4mKBOfetGovXMiZDXgEPMhubsCzpa1ZuQ&s",
		url: "",
		aliases: ["maltsgrains"],
	},
	{
		id: "sierrasprings",
		label: "Sierra Springs",
		region: "ab",
		color: "#17BECF",
		logo: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSNrN3pa3sPOTjKjkpjVcqOrQyRaoF7eIl7Xg&s",
		url: "",
		aliases: [],
	},
	{
		id: "willowpark",
		label: "Willow Park",
		region: "ab",
		color: "#BCBD22",
		logo: "https://pbs.twimg.com/profile_images/1234910564373028864/kGGDvGxQ.jpg",
		url: "",
		aliases: [],
	},
	{
		id: "clbspirits",
		label: "CLB Spirits",
		region: "ab",
		color: "#8C564B",
		logo: "./img/stores/clbspirits.png",
		url: "",
		aliases: ["clbspirits"],
	},
	{
		id: "whiskydrop",
		label: "Whisky Drop",
		region: "ab",
		color: "#E377C2",
		logo: "./img/stores/whiskydrop.jpeg",
		url: "",
		aliases: ["whiskydrop"],
	},
	{
		id: "lime",
		label: "Lime Liquor",
		region: "ab",
		color: "#7FBF3F",
		logo: "./img/stores/lime.jpeg",
		url: "",
		aliases: ["limeliquor"],
	},
	{
		id: "vinearts",
		label: "Vine Arts",
		region: "ab",
		color: "#9EDAE5",
		logo: "./img/stores/vinearts.jpeg",
		url: "",
		aliases: ["vinearts"],
	},
	{
		id: "canadianliquor",
		label: "Canadian Liquor Store",
		region: "ab",
		color: "#C5B0D5",
		logo: "./img/stores/canadianliquor.jpeg",
		url: "",
		aliases: ["canadianliquorstore"],
	},
	{
		id: "zyn",
		label: "ZYN The Wine Market",
		region: "ab",
		color: "#F7B6D2",
		logo: "./img/stores/zyn.png",
		url: "",
		aliases: ["zynthewinemarket", "zyn"],
	},
	{
		id: "wineandbeyond",
		label: "Wine and Beyond",
		region: "ab",
		color: "#5254A3",
		logo: "./img/stores/wineandbeyond.png",
		url: "",
		aliases: ["wineandbeyond"],
	},
	{
		id: "highlander",
		label: "Highlander Wine & Spirits",
		region: "ab",
		color: "#B5CF6B",
		logo: "./img/stores/highlander.png",
		url: "",
		aliases: ["highlanderwinespirits", "highlanderwine"],
	},
	{
		id: "rmwsb",
		label: "Rocky Mountain Wine Spirits Beer",
		region: "ab",
		color: "#CEDB9C",
		logo: "./img/stores/rmwsb.png",
		url: "",
		aliases: ["rockymountainwinespiritsbeer"],
	},
	{
		id: "sherbrooke",
		label: "Sherbrooke Liquor",
		region: "ab",
		color: "#E7969C",
		logo: "./img/stores/sherbrooke.jpeg",
		url: "",
		aliases: ["sherbrookeliquor"],
	},
	{
		id: "colordevino",
		label: "Color de Vino",
		region: "ab",
		color: "#AD494A",
		logo: "./img/stores/colordevino.jpeg",
		url: "",
		aliases: ["colordevino"],
	},
	{
		id: "liquorama",
		label: "Liquorama",
		region: "ab",
		color: "#A55194",
		logo: "./img/stores/liquorama.png",
		url: "",
		aliases: ["liquorama"],
	},
];

// ── Lookup helpers ──────────────────────────────────────────────────────────

const _byId = new Map(STORES.map((s) => [s.id, s]));

export function storeById(id) {
	return _byId.get(id) ?? null;
}

export function storesByRegion(region) {
	return STORES.filter((s) => s.region === region);
}

function _normalizeRaw(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

// Build alias -> canonical id lookup at module init
const _aliasMap = new Map();
for (const store of STORES) {
	_aliasMap.set(store.id, store.id);
	for (const alias of store.aliases) {
		_aliasMap.set(_normalizeRaw(alias), store.id);
	}
}

/**
 * Convert any raw store label or alias to its canonical id.
 * e.g. "ARC Liquor" → "arc", "kensingtonwinemarket" → "kwm"
 * Returns the normalized input unchanged if no match is found.
 */
export function normalizeStoreId(rawLabel) {
	const norm = _normalizeRaw(rawLabel);
	return _aliasMap.get(norm) ?? norm;
}
