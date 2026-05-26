#!/usr/bin/env node
"use strict";

// One-time backfill: stamp every data/db/*.json with `createdAt` derived from
// its first commit on the `data` branch (git log --diff-filter=A).
//
// Run from the data worktree:
//   cd .worktrees/data
//   node ../../tools/backfill_db_created_at.js
//
// Idempotent: files already carrying a `createdAt` are skipped. Produces ONE
// new commit's worth of file changes — does not rewrite history. Prints
// per-file progress so long runs are visible.
//
// After this runs once, `src/tracker/db.js::buildDbObject` will preserve the
// stamped value forever; the daily run never needs to repeat it.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function firstCommitDate(file) {
	try {
		const out = execFileSync(
			"git",
			["log", "--diff-filter=A", "--follow", "--format=%aI", "--", file],
			{ encoding: "utf8" },
		).trim();
		if (!out) return null;
		// --follow can return multiple A entries if the file was renamed; the
		// last line is the EARLIEST add (git log is newest-first).
		const lines = out.split(/\n+/).filter(Boolean);
		return lines[lines.length - 1] || null;
	} catch {
		return null;
	}
}

function main() {
	const repoRoot = process.cwd();
	const dbDir = path.join(repoRoot, "data", "db");
	if (!fs.existsSync(dbDir)) {
		process.stderr.write(`No data/db dir at ${dbDir}\n`);
		process.exit(1);
	}
	const files = fs.readdirSync(dbDir).filter((f) => f.endsWith(".json")).sort();
	process.stdout.write(`[backfill] scanning ${files.length} db files\n`);

	let stamped = 0;
	let skipped = 0;
	let missing = 0;

	for (let i = 0; i < files.length; i++) {
		const name = files[i];
		const full = path.join(dbDir, name);
		const rel = path.relative(repoRoot, full);
		let obj;
		try {
			obj = JSON.parse(fs.readFileSync(full, "utf8"));
		} catch (e) {
			process.stdout.write(`[backfill] (${i + 1}/${files.length}) ${name}: PARSE FAIL — skipped\n`);
			continue;
		}
		if (typeof obj.createdAt === "string" && obj.createdAt) {
			skipped++;
			process.stdout.write(`[backfill] (${i + 1}/${files.length}) ${name}: already stamped (${obj.createdAt})\n`);
			continue;
		}
		const iso = firstCommitDate(rel);
		if (!iso) {
			missing++;
			// File never committed (probably brand new local file). Stamp with
			// mtime as the conservative best guess.
			const mtime = new Date(fs.statSync(full).mtime).toISOString();
			obj.createdAt = mtime;
			process.stdout.write(`[backfill] (${i + 1}/${files.length}) ${name}: no git history — using mtime ${mtime}\n`);
		} else {
			obj.createdAt = iso;
			process.stdout.write(`[backfill] (${i + 1}/${files.length}) ${name}: ${iso}\n`);
		}
		const tmp = `${full}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
		fs.renameSync(tmp, full);
		stamped++;
	}

	process.stdout.write(
		`[backfill] done — stamped=${stamped} skipped=${skipped} no-git-history=${missing}\n`,
	);
}

main();
