#!/usr/bin/env node
"use strict";

// Marks every item in the given DB JSON files as removed:true and bumps updatedAt.
// Use this when a store's category structure changes and the old category DB
// becomes orphaned — without this, the per-SKU history cache will forward-fill
// the last in-stock price indefinitely.
//
// Run from inside the data worktree (.worktrees/data/) so paths are relative
// to that directory, e.g.:
//
//   cd .worktrees/data
//   node ../../tools/finalize_orphan_dbs.js \
//     data/db/sierrasprings__whisky__b81923e1.json \
//     data/db/sierrasprings__fine-rare__aef08fcd.json \
//     data/db/sierrasprings__spirits-liquor__d44c4074.json
//
// Then commit + push the data branch normally.

const fs = require("fs");

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
	process.stderr.write("usage: finalize_orphan_dbs.js <db.json> [<db.json> ...]\n");
	process.exit(2);
}

const nowIso = new Date().toISOString();
let totalItems = 0;
let totalAlreadyRemoved = 0;
let totalFlipped = 0;

for (const file of files) {
	const raw = fs.readFileSync(file, "utf8");
	const db = JSON.parse(raw);
	if (!Array.isArray(db.items)) {
		process.stderr.write(`${file}: no items array — skipping\n`);
		continue;
	}

	let flipped = 0;
	let already = 0;
	for (const it of db.items) {
		totalItems++;
		if (it.removed === true) {
			already++;
			totalAlreadyRemoved++;
			continue;
		}
		it.removed = true;
		flipped++;
		totalFlipped++;
	}

	db.updatedAt = nowIso;
	db.count = db.items.length;
	fs.writeFileSync(file, JSON.stringify(db, null, 2) + "\n", "utf8");
	process.stdout.write(
		`${file}: ${db.items.length} items, ${flipped} flipped to removed, ${already} already removed\n`,
	);
}

process.stdout.write(
	`Total: ${totalItems} items across ${files.length} files; ${totalFlipped} flipped, ${totalAlreadyRemoved} already removed\n`,
);
