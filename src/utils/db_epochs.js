"use strict";

// Loads { dbFileBasename -> createdAt epoch ms } from data/db/*.json.
// Used by rarity scoring so each DB file's "tracker epoch" is its own
// first-tracked moment rather than a single global launch date — items in
// categories added later (e.g. gin) don't get flagged as rare just because
// they sold out shortly after we started tracking that DB file.
//
// If a DB file has no createdAt yet (pre-backfill), it is omitted from the
// map and callers fall back to the global TRACKER_EPOCH_MS.

const fs = require("fs");
const path = require("path");

function loadDbEpochs(dbDir) {
	const out = new Map();
	let entries;
	try {
		entries = fs.readdirSync(dbDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
		try {
			const obj = JSON.parse(fs.readFileSync(path.join(dbDir, ent.name), "utf8"));
			if (obj && typeof obj.createdAt === "string") {
				const t = Date.parse(obj.createdAt);
				if (Number.isFinite(t)) out.set(ent.name, t);
			}
		} catch {
			// skip unparseable
		}
	}
	return out;
}

module.exports = { loadDbEpochs };
