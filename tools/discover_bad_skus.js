#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DB_DIR = path.join(__dirname, "../data/db");
const LINKS_FILE = path.join(__dirname, "../data/sku_links.json");

const includeKegNCork = process.argv.includes("--include-kegncork");
const includeCoop = process.argv.includes("--include-coop");
const includeLinked = process.argv.includes("--include-linked");

// load linked SKUs
const linkedSkus = new Set();
if (!includeLinked && fs.existsSync(LINKS_FILE)) {
	const { links } = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
	for (const { fromSku, toSku } of links) {
		linkedSkus.add(String(fromSku));
		linkedSkus.add(String(toSku));
	}
}

for (const file of fs.readdirSync(DB_DIR)) {
	if (!file.endsWith(".json")) continue;

	if (!includeKegNCork && file.startsWith("kegncork__")) continue;
	if (!includeCoop && file.startsWith("coop__")) continue;

	const data = JSON.parse(fs.readFileSync(path.join(DB_DIR, file), "utf8"));
	if (!Array.isArray(data.items)) continue;

	for (const { sku, url, removed } of data.items) {
		if (
			removed === false &&
			typeof sku === "string" &&
			sku.startsWith("u:") &&
			url &&
			(includeLinked || !linkedSkus.has(sku))
		) {
			console.log(url);
		}
	}
}
