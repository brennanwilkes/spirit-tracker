"use strict";

const fs = require("fs");
const path = require("path");

const {
	normalizeImplicitSkuKey,
	buildGroupsAndCanonicalMap,
} = require("./sku_canonical");

/* ---------------- File discovery ---------------- */

function tryReadJson(file) {
	try {
		const txt = fs.readFileSync(file, "utf8");
		return JSON.parse(txt);
	} catch {
		return null;
	}
}

function defaultSkuLinksCandidates(dbDir, filename) {
	const out = [];
	if (dbDir) out.push(path.join(dbDir, "..", filename));
	out.push(path.join(process.cwd(), "data", filename));
	out.push(path.join(process.cwd(), ".worktrees", "data", "data", filename));
	return out;
}

function findFile(candidates) {
	for (const f of candidates) {
		if (!f) continue;
		try {
			if (fs.existsSync(f)) return f;
		} catch {
			// ignore
		}
	}
	return "";
}

function findSkuLinksFile({ dbDir, mappingFile } = {}) {
	const env = String(process.env.SPIRIT_TRACKER_SKU_LINKS || "").trim();
	if (env) return env;
	if (mappingFile) return mappingFile;
	return findFile(defaultSkuLinksCandidates(dbDir, "sku_links.json"));
}

function findSkuLinksAutoFile({ dbDir } = {}) {
	const env = String(process.env.SPIRIT_TRACKER_SKU_LINKS_AUTO || "").trim();
	if (env) return env;
	return findFile(defaultSkuLinksCandidates(dbDir, "sku_links_auto.json"));
}

/* ---------------- Public API ---------------- */

function buildSkuMapFromLinksArray(links) {
	const { canonBySku } = buildGroupsAndCanonicalMap(links);

	function canonicalSku(sku) {
		const s = normalizeImplicitSkuKey(sku);
		if (!s) return s;
		return canonBySku.get(s) || s;
	}

	return { canonicalSku, _canonBySku: canonBySku };
}

function readLinksFromFile(file) {
	if (!file) return [];
	const obj = tryReadJson(file);
	return Array.isArray(obj?.links) ? obj.links : [];
}

// Loads BOTH manually curated (data/sku_links.json) and auto-generated
// (data/sku_links_auto.json) link records and unions them. Every consumer
// downstream sees one canonical map regardless of link origin.
function loadSkuMap({ dbDir, mappingFile } = {}) {
	const manualFile = findSkuLinksFile({ dbDir, mappingFile });
	const autoFile = findSkuLinksAutoFile({ dbDir });

	const manualLinks = readLinksFromFile(manualFile);
	const autoLinks = readLinksFromFile(autoFile);

	return buildSkuMapFromLinksArray([...manualLinks, ...autoLinks]);
}

module.exports = { loadSkuMap };
