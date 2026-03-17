"use strict";

const fs = require("fs");
const path = require("path");

function readJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function listJsonFiles(dir) {
	const out = [];
	try {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!ent.isFile()) continue;
			if (!String(ent.name || "").endsWith(".json")) continue;
			out.push(path.join(dir, ent.name));
		}
	} catch {
		// ignore
	}
	return out;
}

function listDbFiles(dbDir) {
	try {
		return fs
			.readdirSync(dbDir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith(".json"))
			.map((e) => path.join(dbDir, e.name));
	} catch {
		return [];
	}
}

function storeKeyFromDbPath(abs) {
	const base = path.basename(abs);
	const m = base.match(/^([^_]+)__.+\.json$/i);
	const k = m ? m[1] : base.replace(/\.json$/i, "");
	return String(k || "").toLowerCase();
}

module.exports = {
	readJson,
	ensureDir,
	listJsonFiles,
	listDbFiles,
	storeKeyFromDbPath,
};
