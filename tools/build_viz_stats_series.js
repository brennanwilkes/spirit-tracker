#!/usr/bin/env node
"use strict";

// Build the prebuilt series bundles the #/stats page reads.
//
// WHY: the stats page used to reconstruct history in the browser by fetching
// reports/common_listings_<group>_top<size>.json at EVERY commit in the manifest — 214
// separate raw.githubusercontent requests, ~103 MB of JSON parsed for top250 and ~374 MB
// for top1000. That is the entire reason the page takes tens of seconds to open.
//
// Consecutive days of a common-listings report are ~99% identical, so this tool collapses the
// whole history into one change-point bundle per (group, size). Measured over the real
// 214-commit history: all_top250 562 KB (124 KB gzipped), all_top1000 1.67 MB (326 KB gzipped),
// 5.35 MB across all 9 bundles. One request instead of 214. Note GitHub Release assets are
// normally served WITHOUT Content-Encoding: gzip, so prod downloads the raw size — still ~1.7 MB
// for the worst case against ~374 MB of JSON parsed by the old path.
//
// Encoding: every series is a list of [dayIndex, value] pairs recorded only when the value
// CHANGES, where `null` means "absent that day". Absence has to be explicit — the page's
// per-day aggregates count only rows/stores actually present in that day's report, so
// forward-filling a dropped listing would inflate coverage and skew the market median.
//
// Run from the data worktree (.worktrees/data), after build_viz_commits.js has refreshed
// viz/data/common_listings_commits.json. Incremental: re-processes only commits appended
// since the last build.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MANIFEST = path.join("viz", "data", "common_listings_commits.json");
const OUT_DIR = path.join("viz", "data", "stats");

function gitShow(sha, relPath) {
	return execFileSync("git", ["show", `${sha}:${relPath}`], {
		encoding: "utf8",
		maxBuffer: 512 * 1024 * 1024,
	});
}

// Append [dayIdx, value] only when value differs from the last recorded one.
function pushChange(series, key, dayIdx, value) {
	let arr = series[key];
	if (!arr) {
		arr = series[key] = [];
		if (value === null) return; // nothing recorded yet: absent is the implicit default
	}
	const last = arr.length ? arr[arr.length - 1][1] : null;
	if (last === value) return;
	arr.push([dayIdx, value]);
}

// Drop every change point recorded on or after `day` from a { key: [[day, value], …] } map.
// pushChange decides what to append by comparing the LAST RECORDED VALUE, so truncating the
// tail also restores the correct resume state — no separate cursor bookkeeping.
function truncateSeriesFrom(map, day) {
	for (const k of Object.keys(map || {})) {
		const arr = map[k];
		if (!Array.isArray(arr)) continue;
		let n = arr.length;
		while (n > 0 && arr[n - 1][0] >= day) n--;
		if (n !== arr.length) arr.length = n;
	}
}

// Resume point = length of the longest common sha prefix.
//
// It is NOT enough to require an exact prefix. build_viz_commits.js keeps the most recent
// commit for each DATE, so the last entry's sha is rewritten by every run within the same UTC
// day — an exact-prefix test therefore failed on ~7 of 8 runs and silently full-rebuilt every
// time (42s today, and growing with history). Allowing the tail to differ and truncating that
// day's change points makes the incremental path actually work.
function loadExisting(outFile, shas) {
	if (!fs.existsSync(outFile)) return null;
	let prev;
	try {
		prev = JSON.parse(fs.readFileSync(outFile, "utf8"));
	} catch {
		return null;
	}
	const prevShas = Array.isArray(prev.shas) ? prev.shas : [];
	if (!prevShas.length) return null;

	let p = 0;
	const lim = Math.min(prevShas.length, shas.length);
	while (p < lim && prevShas[p] === shas[p]) p++;

	// A squashed/rewritten data branch (or a manifest that has slid past its retention window)
	// shares no prefix at all — rebuild from scratch rather than splice onto foreign history.
	if (p === 0) return null;

	if (p < prevShas.length) {
		truncateSeriesFrom(prev.present, p);
		truncateSeriesFrom(prev.rep, p);
		truncateSeriesFrom(prev.cheap, p);
		for (const sku of Object.keys(prev.sp || {})) truncateSeriesFrom(prev.sp[sku], p);
	}
	prev.resumeFrom = p;
	return prev;
}

function buildOne(rel, commits, { force }) {
	const base = path.basename(rel);
	const outFile = path.join(OUT_DIR, base);
	const shas = commits.map((c) => String(c.sha));
	const dates = commits.map((c) => String(c.date || ""));

	const existing = force ? null : loadExisting(outFile, shas);
	const startIdx = existing ? existing.resumeFrom : 0;

	if (existing && startIdx === shas.length) {
		return { rel, skipped: true, days: shas.length };
	}

	const out = existing || { rel, dates: [], shas: [], stores: [], meta: {}, present: {}, rep: {}, cheap: {}, sp: {} };
	out.rel = rel;
	out.dates = dates;
	out.shas = shas;
	delete out.resumeFrom;

	for (let i = startIdx; i < commits.length; i++) {
		let report;
		try {
			report = JSON.parse(gitShow(shas[i], rel));
		} catch {
			// Missing/unreadable at this sha: mark every known sku absent for the day so the
			// gap reads as a gap rather than a forward-filled plateau.
			for (const sku of Object.keys(out.present)) pushChange(out.present, sku, i, null);
			continue;
		}

		if (Array.isArray(report.stores) && report.stores.length) out.stores = report.stores.map(String);

		const seen = new Set();
		for (const r of Array.isArray(report.rows) ? report.rows : []) {
			const sku = String(r?.canonSku || "").trim();
			if (!sku) continue;
			seen.add(sku);

			const repObj = r.representative || {};
			// Identity/search fields: keep the newest observed values. They drive the text
			// filter only, and a later rename should stay searchable across all history.
			out.meta[sku] = {
				n: String(repObj.name || ""),
				r: String(repObj.skuRaw || ""),
				k: String(repObj.skuKey || ""),
				c: String(repObj.categoryLabel || ""),
				sl: String(repObj.storeLabel || ""),
				sk: String(repObj.storeKey || ""),
			};

			pushChange(out.present, sku, i, 1);
			pushChange(out.rep, sku, i, Number.isFinite(repObj.priceNum) ? repObj.priceNum : null);
			pushChange(out.cheap, sku, i, Number.isFinite(r?.cheapest?.priceNum) ? r.cheapest.priceNum : null);

			let bySt = out.sp[sku];
			if (!bySt) bySt = out.sp[sku] = {};
			const prices = r.storePrices && typeof r.storePrices === "object" ? r.storePrices : {};
			// Union of today's store list, this sku's already-recorded stores, and whatever keys
			// the row itself carries. Iterating only out.stores would forward-fill a store's last
			// price forever if it ever dropped out of report.stores, since the "absent today"
			// pass below only fires for absent SKUs, not absent stores.
			for (const st of new Set([...out.stores, ...Object.keys(bySt), ...Object.keys(prices)])) {
				const v = prices[st];
				pushChange(bySt, st, i, Number.isFinite(v) ? v : null);
			}
		}

		// Rows that existed before but not today.
		for (const sku of Object.keys(out.present)) {
			if (seen.has(sku)) continue;
			pushChange(out.present, sku, i, null);
			pushChange(out.rep, sku, i, null);
			pushChange(out.cheap, sku, i, null);
			const bySt = out.sp[sku];
			if (bySt) for (const st of Object.keys(bySt)) pushChange(bySt, st, i, null);
		}
	}

	out.generatedAt = new Date().toISOString();
	fs.mkdirSync(OUT_DIR, { recursive: true });
	const json = JSON.stringify(out);
	fs.writeFileSync(outFile, json + "\n", "utf8");

	return {
		rel,
		outFile,
		days: shas.length,
		fromIdx: startIdx,
		skus: Object.keys(out.meta).length,
		bytes: json.length,
	};
}

function main() {
	const force = process.argv.includes("--force");

	if (!fs.existsSync(MANIFEST)) {
		throw new Error(`${MANIFEST} not found — run build_viz_commits.js first (and run this from the data worktree).`);
	}
	const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
	const files = manifest?.files && typeof manifest.files === "object" ? manifest.files : {};
	// Only the group/size combinations #/stats can actually request (relReportPath builds
	// common_listings_<all|bc|ab>_top<50|250|1000>). The cohort_* reports carry no rows and
	// are never fetched by the page, so building them is pure waste.
	const rels = Object.keys(files).filter((k) => /common_listings_(all|bc|ab)_top(50|250|1000)\.json$/.test(k));
	if (!rels.length) throw new Error("No common_listings_<group>_top<size> entries in the commits manifest.");

	let totalBytes = 0;
	for (const rel of rels) {
		const commits = Array.isArray(files[rel]) ? files[rel] : [];
		if (!commits.length) {
			console.log(`skip ${rel} (no commits)`);
			continue;
		}
		const res = buildOne(rel, commits, { force });
		if (res.skipped) {
			console.log(`up-to-date ${path.basename(rel)} (${res.days} days)`);
			continue;
		}
		totalBytes += res.bytes;
		console.log(
			`built ${path.basename(res.outFile)}  days=${res.days} (new from ${res.fromIdx})  skus=${res.skus}  ${(res.bytes / 1024).toFixed(0)} KB`,
		);
	}
	console.log(`stats series bundles total ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
}

main();
