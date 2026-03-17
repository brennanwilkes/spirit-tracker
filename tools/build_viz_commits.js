#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { runGit } = require("./lib/git");
const { listDbFiles } = require("./lib/db");
const { dateOnly } = require("./lib/sku");

function listCommonListingReportFiles(reportsDir) {
	try {
		return fs
			.readdirSync(reportsDir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith(".json"))
			.map((e) => e.name)
			.filter((name) => /^common_listings_.*_top\d+\.json$/i.test(name))
			.map((name) => path.join(reportsDir, name));
	} catch {
		return [];
	}
}

function buildCommitPayloadForFiles({ repoRoot, relFiles, maxRawPerFile, maxDaysPerFile }) {
	const payload = {
		generatedAt: new Date().toISOString(),
		branch: "data",
		files: {},
	};

	for (const rel of relFiles.sort()) {
		let txt = "";
		try {
			// %H = sha, %cI = committer date strict ISO 8601 (includes time + tz)
			txt = runGit(["log", "--format=%H %cI", `-${maxRawPerFile}`, "--", rel]);
		} catch {
			continue;
		}

		const lines = txt
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);

		// git log is newest -> oldest.
		// Keep the FIRST commit we see for each date (that is the most recent commit for that date).
		const byDate = new Map(); // date -> { sha, date, ts }
		for (const line of lines) {
			const m = line.match(/^([0-9a-f]{7,40})\s+(.+)$/i);
			if (!m) continue;

			const sha = m[1];
			const ts = m[2];
			const d = dateOnly(ts);
			if (!d) continue;

			if (!byDate.has(d)) byDate.set(d, { sha, date: d, ts });
		}

		// Convert to oldest -> newest
		let arr = [...byDate.values()].reverse();

		// Keep only the newest MAX_DAYS_PER_FILE (still oldest -> newest)
		if (arr.length > maxDaysPerFile) {
			arr = arr.slice(arr.length - maxDaysPerFile);
		}

		payload.files[rel] = arr;
	}

	return payload;
}

function main() {
	const repoRoot = process.cwd();
	const dbDir = path.join(repoRoot, "data", "db");
	const reportsDir = path.join(repoRoot, "reports");
	const outDir = path.join(repoRoot, "viz", "data");

	fs.mkdirSync(outDir, { recursive: true });

	// ---- Existing output (UNCHANGED): db_commits.json ----
	const outFileDb = path.join(outDir, "db_commits.json");

	const dbFiles = listDbFiles(dbDir).map((abs) => path.posix.join("data/db", path.basename(abs)));

	// We want the viz to show ONE point per day (the most recent run that day).
	// So we collapse multiple commits per day down to the newest commit for that date.
	//
	// With multiple runs/day, we also want to keep a long-ish daily history.
	// Raw commits per day could be ~4, so grab a larger raw window and then collapse.
	const MAX_RAW_PER_FILE = 2400; // ~600 days @ 4 runs/day
	const MAX_DAYS_PER_FILE = 600; // daily points kept after collapsing

	const payloadDb = buildCommitPayloadForFiles({
		repoRoot,
		relFiles: dbFiles,
		maxRawPerFile: MAX_RAW_PER_FILE,
		maxDaysPerFile: MAX_DAYS_PER_FILE,
	});

	fs.writeFileSync(outFileDb, JSON.stringify(payloadDb, null, 2) + "\n", "utf8");
	process.stdout.write(`Wrote ${outFileDb} (${Object.keys(payloadDb.files).length} files)\n`);

	// ---- New output: common listings report commits ----
	const outFileCommon = path.join(outDir, "common_listings_commits.json");

	const reportFilesAbs = listCommonListingReportFiles(reportsDir);
	const reportFilesRel = reportFilesAbs.map((abs) => path.posix.join("reports", path.basename(abs)));

	const payloadCommon = buildCommitPayloadForFiles({
		repoRoot,
		relFiles: reportFilesRel,
		maxRawPerFile: MAX_RAW_PER_FILE,
		maxDaysPerFile: MAX_DAYS_PER_FILE,
	});

	fs.writeFileSync(outFileCommon, JSON.stringify(payloadCommon, null, 2) + "\n", "utf8");
	process.stdout.write(`Wrote ${outFileCommon} (${Object.keys(payloadCommon.files).length} files)\n`);
}

main();
