#!/usr/bin/env node
"use strict";

// Backfills historical SKU upgrades into data/sku_links_auto.json by walking the
// full git history of every data/db/*.json file. For each URL, when the SKU
// recorded at that URL changes between commits, emit an upgrade link.
//
// Read-only on git history; ONLY writes a single new (or merged) data/sku_links_auto.json.
//
// Run from inside .worktrees/data/ so git history queries hit the data branch:
//   cd .worktrees/data
//   node ../../tools/backfill_sku_transitions.js
//
// Optional flags:
//   --dry-run        Compute and print summary, don't write the file
//   --limit-files=N  Only process the first N db files (testing aid)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { listDbFiles } = require("./lib/db");
const {
	normalizeImplicitSkuKey,
} = require("../src/utils/sku_canonical");
const {
	mergeUpgradesIntoAutoLinks,
	pairKey,
} = require("../src/tracker/sku_auto_links");

const DRY_RUN = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit-files="));
const FILE_LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

function gitShowJson(sha, relPath) {
	try {
		const txt = execFileSync("git", ["show", `${sha}:${relPath}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
		if (txt.trimStart().startsWith("version https://git-lfs.github.com/spec/v1")) return null;
		return JSON.parse(txt);
	} catch {
		return null;
	}
}

function getCommitsForFile(relPath) {
	try {
		const txt = execFileSync("git", ["log", "--format=%H %cI", "--", relPath], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trimEnd();
		if (!txt) return [];
		return txt
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				const m = line.match(/^([0-9a-f]{7,40})\s+(.+)$/i);
				return m ? { sha: m[1], ts: m[2].trim() } : null;
			})
			.filter(Boolean)
			.reverse();
	} catch {
		return [];
	}
}

function itemsByUrl(items) {
	const result = new Map();
	for (const item of Array.isArray(items) ? items : []) {
		if (!item?.url || !item?.sku) continue;
		// If multiple rows share a URL within one snapshot, prefer live > removed
		const cur = result.get(item.url);
		if (!cur) {
			result.set(item.url, { sku: String(item.sku), removed: Boolean(item.removed) });
		} else if (cur.removed && !item.removed) {
			result.set(item.url, { sku: String(item.sku), removed: false });
		}
	}
	return result;
}

function main() {
	const repoRoot = process.cwd();
	const dbDir = path.join(repoRoot, "data", "db");
	const dbFilePaths = listDbFiles(dbDir).map((abs) =>
		path.posix.join("data/db", path.basename(abs)),
	);

	if (!dbFilePaths.length) {
		process.stderr.write("No db files found in data/db/. Run from .worktrees/data/.\n");
		process.exit(1);
	}

	const total = Math.min(dbFilePaths.length, FILE_LIMIT);
	process.stdout.write(`Backfill: walking git history of ${total} db files...\n`);

	const upgrades = []; // accumulated across all files
	const seenPairKeys = new Set(); // global dedupe across files
	let totalCommits = 0;
	let totalTransitions = 0;

	for (let fi = 0; fi < total; fi++) {
		const relPath = dbFilePaths[fi];
		const basename = path.basename(relPath);

		const commits = getCommitsForFile(relPath);
		totalCommits += commits.length;

		process.stdout.write(
			`[${fi + 1}/${total}] ${basename} — ${commits.length} commits` +
				(commits.length === 0 ? " (no history)\n" : "\n"),
		);

		if (commits.length < 2) continue;

		let prevByUrl = new Map();
		let fileTransitions = 0;

		for (let ci = 0; ci < commits.length; ci++) {
			const { sha, ts } = commits[ci];

			if ((ci + 1) % 50 === 0 || ci === commits.length - 1) {
				process.stdout.write(
					`    commit ${ci + 1}/${commits.length}  transitions+${fileTransitions}\r`,
				);
			}

			const data = gitShowJson(sha, relPath);
			if (!data) continue;

			const curByUrl = itemsByUrl(data.items);

			for (const [url, cur] of curByUrl) {
				const prev = prevByUrl.get(url);
				if (!prev) continue;
				if (prev.sku === cur.sku) continue;

				const fromSku = normalizeImplicitSkuKey(prev.sku);
				const toSku = normalizeImplicitSkuKey(cur.sku);
				if (!fromSku || !toSku || fromSku === toSku) continue;

				const k = pairKey(fromSku, toSku);
				if (!k || seenPairKeys.has(k)) continue;
				seenPairKeys.add(k);

				upgrades.push({
					fromSku,
					toSku,
					url,
					ts,
					dbFile: relPath,
				});
				fileTransitions++;
				totalTransitions++;
			}

			prevByUrl = curByUrl;
		}

		if (commits.length >= 50) process.stdout.write("\n");
		if (fileTransitions > 0) {
			process.stdout.write(`    -> ${fileTransitions} transitions\n`);
		}
	}

	process.stdout.write(
		`\nWalked ${totalCommits} commits across ${total} files. ` +
			`Detected ${totalTransitions} unique SKU transitions.\n`,
	);

	if (DRY_RUN) {
		process.stdout.write("Dry run: not writing sku_links_auto.json. Sample:\n");
		for (const u of upgrades.slice(0, 10)) {
			process.stdout.write(`  ${u.fromSku} -> ${u.toSku}  (${u.dbFile})\n`);
		}
		return;
	}

	const result = mergeUpgradesIntoAutoLinks({ dbDir, upgrades });
	process.stdout.write(
		`Wrote ${result.file}: +${result.added} new links (total ${result.total})\n`,
	);
}

main();
