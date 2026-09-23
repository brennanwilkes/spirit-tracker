#!/usr/bin/env node
"use strict";

// Apply an audit proposal to data/sku_links.json.
//
// Write-only and offline: validates the proposal against the live file, applies it to a working
// copy, prints a structured diff + per-op status, and — only with --apply — rewrites the file.
// It NEVER commits or pushes (the human commits by hand, which is also the review-watermark
// signal). Dry-run is the default.
//
// Usage:
//   node tools/apply_audit_proposal.js --proposal audit/proposal-<ts>.json [--root .worktrees/data]
//   node tools/apply_audit_proposal.js --proposal … --apply      # actually write
//
// Flags:
//   --proposal <file>   the agent's proposal (required)
//   --root <path>       data worktree (default .worktrees/data)
//   --apply             write data/sku_links.json (default: dry-run)
//   --force             allow a link op on a currently-ignored pair (drops the ignore), and allow
//                       --apply when the new links would transitively group an ignored pair
//   --json              emit a machine-readable report instead of the human table
//
// Proposal shape (see docs/audit-runbook.md):
//   { generatedAt, auditRef, ops: [ {op:"link"|"unlink"|"ignore"|"remove-ignore",
//      a, b, confidence?, ignore?, noTrain?, why?} ], coverage }
// Accepted aliases for a/b: fromSku/toSku, skuA/skuB, from/to.

const fs = require("fs");
const path = require("path");
const { readLinks, writeLinks, dedupeLinks, pairKey, linksFile } = require("../src/utils/sku_links_file");
const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");

// The link file names `id:`-sourced listings in both forms (`id:1049495` and bare `1049495`), and
// every canonical loader folds them together. Compare the same way here, or an ignore/link stored
// in the other form is invisible: on 2026-09-23 this let 13 links through that contradicted
// bare-form curated ignores, all reported "ok" by the dry-run.
const nk = (s) => normalizeImplicitSkuKey(String(s || "").trim());
const npairKey = (a, b) => pairKey(nk(a), nk(b));
const matchLink = (link, a, b) => npairKey(link.fromSku, link.toSku) === npairKey(a, b);

const REPO_ROOT = path.resolve(__dirname, "..");

const OPS = new Set(["link", "unlink", "unlink-auto", "ignore", "remove-ignore"]);
// pair "polarity": positive ops add a link; negative ops remove/deny one. A pair with both is a
// contradiction and refuses to apply (fail closed).
const POSITIVE = new Set(["link"]);
const NEGATIVE = new Set(["unlink", "unlink-auto", "ignore", "remove-ignore"]);

function parseArgs(argv) {
	const args = new Map();
	const flags = new Set();
	const BOOLEAN = new Set(["--apply", "--force", "--json", "--verbose", "--help"]);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (BOOLEAN.has(a)) {
			flags.add(a);
			continue;
		}
		args.set(a, argv[++i]);
	}
	return { args, flags };
}

const USAGE = `apply_audit_proposal — apply an audit proposal to data/sku_links.json (write-only)

  node tools/apply_audit_proposal.js --proposal <file> [--root <worktree>] [--apply] [--force] [--json] [--verbose]

  --proposal <file>  proposal JSON (required)
  --root <path>      data worktree (default .worktrees/data)
  --apply            write the file (default: dry-run, prints the diff)
  --force            allow a link op on an ignored pair (drops the ignore); never overrides
                     the refusal of a link touching a sku in data/sku_collisions.json
  --json             machine-readable report
  --verbose          print every diff line instead of the first 40

Ops: link | unlink | unlink-auto | ignore | remove-ignore. unlink-auto removes a wrong edge from
sku_links_auto.json (an in-place sku upgrade that joined two different products) and, like unlink,
writes an ignore unless "ignore": false — the scraper's merge skips ignored pairs, so it cannot return.

A proposal may also carry "review" and "dataQuality" arrays — decisions the agent deliberately did NOT act on
and wants a human to make. It is never applied; it is echoed back so it cannot be lost.

Never commits or pushes — commit data/sku_links.json by hand.`;

function firstDefined(...vals) {
	for (const v of vals) if (v !== undefined && v !== null) return v;
	return undefined;
}

function normalizeOp(raw, index) {
	if (!raw || typeof raw !== "object") return { index, error: "op is not an object" };
	const op = String(raw.op || raw.kind || "").toLowerCase();
	const a = String(firstDefined(raw.a, raw.fromSku, raw.skuA, raw.from, "")).trim();
	const b = String(firstDefined(raw.b, raw.toSku, raw.skuB, raw.to, "")).trim();
	const out = { index, op, a, b, why: raw.why || raw.reason || "" };
	if (op === "link") {
		if (typeof raw.confidence === "number" && Number.isFinite(raw.confidence)) out.confidence = raw.confidence;
	} else if (op === "unlink" || op === "unlink-auto") {
		out.ignore = raw.ignore === undefined ? true : !!raw.ignore;
	} else if (op === "ignore") {
		if (raw.noTrain) out.noTrain = true;
	}
	return out;
}

function validateOp(o) {
	if (!OPS.has(o.op)) return `unknown op "${o.op}"`;
	if (!o.a || !o.b) return "missing a/b sku";
	if (o.a === o.b) return `a === b ("${o.a}")`;
	return null;
}

// True when a and b are already in the same union-find component of the link set.
function sameComponent(links, a, b) {
	const parent = new Map();
	const find = (x) => {
		if (!parent.has(x)) parent.set(x, x);
		let r = x;
		while (parent.get(r) !== r) r = parent.get(r);
		while (parent.get(x) !== r) {
			const nx = parent.get(x);
			parent.set(x, r);
			x = nx;
		}
		return r;
	};
	for (const l of links) {
		const ra = find(nk(l.fromSku)), rb = find(nk(l.toSku));
		if (ra !== rb) parent.set(ra, rb);
	}
	return find(nk(a)) === find(nk(b));
}

function hasIgnore(ignores, a, b) {
	const k = npairKey(a, b);
	return ignores.some((ig) => npairKey(ig.skuA, ig.skuB) === k);
}

function removeIgnore(ignores, a, b) {
	const k = npairKey(a, b);
	return ignores.filter((ig) => npairKey(ig.skuA, ig.skuB) !== k);
}

// Ignored pairs that `links` puts in one component. A link A–B can merge an ignored pair C–D it
// never names (A~C, B~D already), so the direct hasIgnore check alone cannot see it.
function groupedIgnores(links, ignores) {
	const parent = new Map();
	const find = (x) => {
		while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
		return x;
	};
	for (const l of links) {
		const ra = find(nk(l.fromSku)), rb = find(nk(l.toSku));
		if (ra !== rb) parent.set(ra, rb);
	}
	return new Set(ignores.filter((ig) => find(nk(ig.skuA)) === find(nk(ig.skuB))).map((ig) => npairKey(ig.skuA, ig.skuB)));
}

function main() {
	const { args, flags } = parseArgs(process.argv.slice(2));
	if (flags.has("--help") || !args.get("--proposal")) {
		console.log(USAGE);
		process.exit(args.get("--proposal") ? 0 : 2);
	}

	const proposalFile = path.isAbsolute(args.get("--proposal"))
		? args.get("--proposal")
		: path.join(REPO_ROOT, args.get("--proposal"));
	if (!fs.existsSync(proposalFile)) {
		console.error(`apply_audit_proposal: proposal not found: ${proposalFile}`);
		process.exit(2);
	}

	const rootArg = args.get("--root") || path.join(REPO_ROOT, ".worktrees", "data");
	const root = path.isAbsolute(rootArg) ? rootArg : path.join(REPO_ROOT, rootArg);
	const file = linksFile(root);
	if (!fs.existsSync(file)) {
		console.error(`apply_audit_proposal: no sku_links.json at ${file} (pass --root <data-worktree>).`);
		process.exit(2);
	}

	let proposal;
	try {
		proposal = JSON.parse(fs.readFileSync(proposalFile, "utf8"));
	} catch (e) {
		console.error(`apply_audit_proposal: proposal is not valid JSON: ${e.message}`);
		process.exit(2);
	}
	const rawOps = Array.isArray(proposal) ? proposal : Array.isArray(proposal.ops) ? proposal.ops : null;
	if (!rawOps) {
		console.error('apply_audit_proposal: proposal has no "ops" array.');
		process.exit(2);
	}

	const ops = rawOps.map(normalizeOp);

	// The needs-human channel. An agent that finds a pair it cannot responsibly decide must
	// have somewhere to put it, or the finding survives only in chat scrollback — which is
	// how the first trial run nearly lost a live auto-linker false positive.
	const review = Array.isArray(proposal.review) ? proposal.review : [];
	// A bad RECORD is not a link decision. Without its own channel these end up abusing
	// review[] ("this store's price is wrong"), which buries real link questions.
	const dataQuality = Array.isArray(proposal.dataQuality) ? proposal.dataQuality : [];
	const deferredErrors = [];
	dataQuality.forEach((d, i) => {
		if (!d || typeof d !== "object") deferredErrors.push(`dataQuality[${i}]: not an object`);
		else if (!d.sku || !d.issue) deferredErrors.push(`dataQuality[${i}]: needs "sku" and "issue"`);
	});
	const reviewErrors = deferredErrors;
	review.forEach((r, i) => {
		if (!r || typeof r !== "object") reviewErrors.push(`review[${i}]: not an object`);
		else if (!r.a || !r.b) reviewErrors.push(`review[${i}]: needs both "a" and "b"`);
		else if (!r.why) reviewErrors.push(`review[${i}]: needs a "why" — an unexplained referral is not reviewable`);
	});

	// ---- hard validation ---------------------------------------------------
	const errors = [];
	for (const o of ops) {
		const err = validateOp(o);
		if (err) errors.push(`op[${o.index}]: ${err}`);
	}

	// pair contradictions (link + unlink/ignore on the same unordered pair) refuse to apply.
	const pairOps = new Map();
	for (const o of ops) {
		if (validateOp(o) || !o.a || !o.b) continue;
		const k = npairKey(o.a, o.b);
		if (!pairOps.has(k)) pairOps.set(k, []);
		pairOps.get(k).push(o);
	}
	for (const [k, group] of pairOps) {
		const hasPos = group.some((o) => POSITIVE.has(o.op));
		const hasNeg = group.some((o) => NEGATIVE.has(o.op));
		const addsIgnore = group.some((o) => o.op === "ignore");
		const dropsIgnore = group.some((o) => o.op === "remove-ignore");
		if (hasPos && hasNeg) {
			errors.push(`conflicting ops on pair ${group.map((o) => `${o.op}(${o.a}↔${o.b})`).join(", ")}`);
		} else if (addsIgnore && dropsIgnore) {
			errors.push(`conflicting ignore/remove-ignore on pair ${group.map((o) => o.op).join(", ")} (${group[0].a}↔${group[0].b})`);
		}
	}

	// A collided sku carries two different products, so linking it spreads the other product into a
	// clean group. Same guard as auto_link_classify.mjs; the file is curated, so a missing one throws.
	const collided = new Set(JSON.parse(fs.readFileSync(path.join(root, "data", "sku_collisions.json"), "utf8")).collisions.map((c) => nk(c.sku)));
	for (const o of ops) {
		if (o.op === "link" && (collided.has(nk(o.a)) || collided.has(nk(o.b)))) {
			errors.push(`op[${o.index}]: link ${o.a}↔${o.b} touches a verified collision sku (data/sku_collisions.json)`);
		}
	}

	if (reviewErrors.length) errors.push(...reviewErrors);
	if (errors.length) {
		console.error(`apply_audit_proposal: ${errors.length} validation error(s) — nothing written:`);
		for (const e of errors) console.error(`  ✗ ${e}`);
		process.exit(1);
	}

	// ---- apply to a working copy ------------------------------------------
	const cur = readLinks(root);
	// Every canonical loader also unions sku_links_auto.json, so the component checks must see its
	// edges or an unlink bridged by an auto edge reports as a split. Only `unlink-auto` edits it.
	const autoFile = path.join(root, "data", "sku_links_auto.json");
	const autoObj = fs.existsSync(autoFile) ? JSON.parse(fs.readFileSync(autoFile, "utf8")) : { links: [] };
	if (!Array.isArray(autoObj.links)) throw new Error(`${autoFile}: expected {links:[]}`);
	const sourceAuto = autoObj.links;
	let autoLinks = sourceAuto.slice();
	const withAuto = (ls) => ls.concat(autoLinks);
	const beforeLinks = cur.links.length;
	const beforeIgnores = cur.ignores.length;
	// The committed file is appended by auto_link_classify WITHOUT union-find dedup, so it can hold
	// links that duplicate an existing component. Any writeLinks() re-serializes with dedupe, so the
	// first write prunes them. Surface that separately or the diff looks like phantom unlinks.
	const redundantLinksInSource = cur.links.length - dedupeLinks(cur.links, []).links.length;
	let links = cur.links.slice();
	const ignoresAddedByUnlink = new Set();
	let ignores = cur.ignores.slice();
	// Snapshot of the ORIGINAL source links, to tell "this pair was already linked before we
	// started" apart from "an earlier op in THIS proposal already linked them" — both hit the
	// same union-find check but mean very different things to the reviewing agent.
	const sourceLinks = cur.links.slice();

	const ts = new Date().toISOString();
	const results = [];
	for (const o of ops) {
		const r = { index: o.index, op: o.op, a: o.a, b: o.b, status: "ok", note: "", why: o.why };
		if (o.op === "link") {
			if (hasIgnore(ignores, o.a, o.b)) {
				if (!flags.has("--force")) {
					r.status = "skipped";
					r.note = "pair is ignored (pass --force to override)";
					results.push(r);
					continue;
				}
				ignores = removeIgnore(ignores, o.a, o.b);
				r.note = "dropped existing ignore";
			}
			if (sameComponent(withAuto(links), o.a, o.b)) {
				r.status = "skipped";
				const inSource = sameComponent(sourceLinks.concat(sourceAuto), o.a, o.b);
				const reason = inSource ? "already linked in source" : "redundant — an earlier op in this proposal already links them";
				r.note = r.note ? `${r.note}; ${reason}` : reason;
				results.push(r);
				continue;
			}
			const entry = { fromSku: o.a, toSku: o.b, status: "pending", source: "agent-audit", ts };
			if (o.confidence !== undefined) entry.confidence = o.confidence;
			links.push(entry);
		} else if (o.op === "unlink" || o.op === "unlink-auto") {
			const pool = o.op === "unlink" ? links : autoLinks;
			const matched = pool.filter((l) => matchLink(l, o.a, o.b));
			if (!matched.length) {
				r.status = "skipped";
				r.note = `no ${o.op === "unlink" ? "sku_links.json" : "sku_links_auto.json"} entry for this pair`;
				results.push(r);
				continue;
			}
			if (o.op === "unlink") links = links.filter((l) => !matchLink(l, o.a, o.b));
			else autoLinks = autoLinks.filter((l) => !matchLink(l, o.a, o.b));
			r.note = `removed ${matched.length} link entr${matched.length === 1 ? "y" : "ies"}`;
			if (o.ignore) {
				if (hasIgnore(ignores, o.a, o.b)) {
					r.note += "; ignore already present";
				} else {
					ignores.push({ skuA: o.a, skuB: o.b });
					ignoresAddedByUnlink.add(pairKey(o.a, o.b));
					r.note += "; +ignore";
				}
			}
		} else if (o.op === "ignore") {
			if (hasIgnore(ignores, o.a, o.b)) {
				r.status = "skipped";
				r.note = "already ignored";
				results.push(r);
				continue;
			}
			ignores.push({ skuA: o.a, skuB: o.b, ...(o.noTrain ? { noTrain: true } : {}) });
		} else if (o.op === "remove-ignore") {
			if (!hasIgnore(ignores, o.a, o.b)) {
				r.status = "skipped";
				r.note = "not ignored";
				results.push(r);
				continue;
			}
			ignores = removeIgnore(ignores, o.a, o.b);
		}
		results.push(r);
	}

	const ineffectiveKeys = new Set();
	for (const r of results) {
		if ((r.op === "unlink" || r.op === "unlink-auto") && r.status === "ok" && sameComponent(withAuto(links), r.a, r.b)) {
			ineffectiveKeys.add(pairKey(r.a, r.b));
		}
	}
	// An ineffective unlink must NOT leave behind the hard negative it would normally write.
	// `ignores` is mined as training data and is consulted to suppress candidate pairs, so
	// recording "these are different" for a pair the link file still groups as ONE product is
	// both incoherent and unrecoverable (ignored pairs never re-enter the pool). Only drop the
	// ignore when THIS run created it; a pre-existing one is the human's and is left alone.
	if (ineffectiveKeys.size) {
		ignores = ignores.filter(
			(ig) => !(ineffectiveKeys.has(pairKey(ig.skuA, ig.skuB)) && ignoresAddedByUnlink.has(pairKey(ig.skuA, ig.skuB))),
		);
	}

	const final = dedupeLinks(links, ignores);

	// An `unlink` that removes the A-B entry but leaves A and B in the same union-find
	// component (via A-C-B) changes nothing any consumer can observe: the two listings stay
	// in one canonical group. A precision audit produces these routinely — the agent judges
	// one pair at a time and cannot see the whole component — so report it instead of saying
	// "ok". Checked against the FINAL link set, after every op, not mid-loop.
	const ineffectiveUnlinks = [];
	for (const r of results) {
		if ((r.op !== "unlink" && r.op !== "unlink-auto") || r.status !== "ok") continue;
		if (!ineffectiveKeys.has(pairKey(r.a, r.b))) continue;
		r.note = `${r.note ? `${r.note}; ` : ""}STILL LINKED transitively — canonical group NOT split; ignore withheld`;
		ineffectiveUnlinks.push({ a: r.a, b: r.b });
	}

	const groupedBefore = groupedIgnores(withAuto(cur.links), cur.ignores);
	const newlyGroupedIgnores = final.ignores
		.filter((ig) => !groupedBefore.has(npairKey(ig.skuA, ig.skuB)) && groupedIgnores(withAuto(final.links), [ig]).size)
		.map((ig) => ({ skuA: ig.skuA, skuB: ig.skuB }));

	// ---- structured diff (pair-keyed) -------------------------------------
	const linkKeysBefore = new Set(cur.links.map((l) => pairKey(l.fromSku, l.toSku)));
	const linkKeysAfter = new Set(final.links.map((l) => pairKey(l.fromSku, l.toSku)));
	const ignoreKeysBefore = new Set(cur.ignores.map((ig) => pairKey(ig.skuA, ig.skuB)));
	const ignoreKeysAfter = new Set(final.ignores.map((ig) => pairKey(ig.skuA, ig.skuB)));

	const addedLinks = final.links.filter((l) => !linkKeysBefore.has(pairKey(l.fromSku, l.toSku)));
	const removedLinks = cur.links.filter((l) => !linkKeysAfter.has(pairKey(l.fromSku, l.toSku)));
	const addedIgnores = final.ignores.filter((ig) => !ignoreKeysBefore.has(pairKey(ig.skuA, ig.skuB)));
	const removedIgnores = cur.ignores.filter((ig) => !ignoreKeysAfter.has(pairKey(ig.skuA, ig.skuB)));

	const report = {
		proposal: path.relative(REPO_ROOT, proposalFile),
		auditRef: proposal.auditRef || null,
		root: path.relative(REPO_ROOT, root),
		file: path.relative(REPO_ROOT, file),
		mode: flags.has("--apply") ? "apply" : "dry-run",
		ops: results,
		summary: {
			ok: results.filter((r) => r.status === "ok").length,
			skipped: results.filter((r) => r.status === "skipped").length,
			conflicts: 0, // contradictory ops abort before this point (exit 1)
			skippedReasons: results.filter((r) => r.status === "skipped").map((r) => `op[${r.index}] ${r.op} ${r.a}↔${r.b}: ${r.note}`),
		},
		redundantLinksInSource,
		autoLinksRemoved: sourceAuto.length - autoLinks.length,
		ineffectiveUnlinks,
		newlyGroupedIgnores,
		review,
		dataQuality,
		counts: {
			ops: ops.length,
			applied: results.filter((r) => r.status === "ok").length,
			skipped: results.filter((r) => r.status === "skipped").length,
			linksBefore: beforeLinks,
			linksAfter: final.links.length,
			ignoresBefore: beforeIgnores,
			ignoresAfter: final.ignores.length,
		},
		diff: {
			addedLinks: addedLinks.map((l) => ({ fromSku: l.fromSku, toSku: l.toSku, status: l.status || null })),
			removedLinks: removedLinks.map((l) => ({ fromSku: l.fromSku, toSku: l.toSku })),
			addedIgnores: addedIgnores.map((ig) => ({ skuA: ig.skuA, skuB: ig.skuB })),
			removedIgnores: removedIgnores.map((ig) => ({ skuA: ig.skuA, skuB: ig.skuB })),
		},
	};

	if (flags.has("--apply") && newlyGroupedIgnores.length && !flags.has("--force")) {
		console.error(`apply_audit_proposal: REFUSING --apply — the new link set would put ${newlyGroupedIgnores.length} ignored pair(s) in one canonical group (see dry-run). Resolve them (remove the wrong ignore or drop the link), or pass --force.`);
		process.exit(1);
	}
	if (flags.has("--apply")) {
		writeLinks(root, { links, ignores });
		// Same 2-space shape src/tracker/sku_auto_links.js writes; its merge skips ignored pairs, so
		// the ignore an unlink-auto writes keeps the scraper from re-adding the edge.
		if (autoLinks.length !== sourceAuto.length) fs.writeFileSync(autoFile, JSON.stringify({ ...autoObj, links: autoLinks }, null, 2) + "\n", "utf8");
		report.wrote = true;
	} else {
		report.wrote = false;
	}

	if (flags.has("--json")) {
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	} else {
		const c = report.counts;
		console.log(`apply_audit_proposal [${report.mode}]  ${report.proposal}`);
		if (report.auditRef) console.log(`  audit: ${JSON.stringify(report.auditRef)}`);
		console.log(`  file:  ${report.file}`);
		console.log(`  ops:   ${c.ops} — applied ${c.applied}, skipped ${c.skipped}`);
		console.log(`  links:   ${c.linksBefore} → ${c.linksAfter}  (+${report.diff.addedLinks.length} / -${report.diff.removedLinks.length})`);
		if (report.autoLinksRemoved) console.log(`  sku_links_auto.json: -${report.autoLinksRemoved} edge(s) via unlink-auto`);
		if (report.redundantLinksInSource) {
			console.log(`           note: ${report.redundantLinksInSource} of the removed links were pre-existing duplicates (auto_link_classify appends undeduped); only explicit unlinks are real.`);
		}
		console.log(`  ignores: ${c.ignoresBefore} → ${c.ignoresAfter}  (+${report.diff.addedIgnores.length} / -${report.diff.removedIgnores.length})`);
		if (report.ineffectiveUnlinks.length) {
			console.log(`  WARN: ${report.ineffectiveUnlinks.length} unlink(s) removed an entry but left the pair in ONE canonical group (linked transitively via another SKU) — no observable change:`);
			for (const u of report.ineffectiveUnlinks.slice(0, flags.has("--verbose") ? Infinity : 20)) {
				console.log(`        ${u.a} ↔ ${u.b}`);
			}
		}
		if (report.newlyGroupedIgnores.length) {
			console.log(`  WARN: ${report.newlyGroupedIgnores.length} ignored pair(s) would end up in ONE canonical group via the new links (transitively — the direct pair check cannot see these). --apply refuses without --force:`);
			for (const g of report.newlyGroupedIgnores.slice(0, flags.has("--verbose") ? Infinity : 20)) console.log(`        ${g.skuA} ↔ ${g.skuB}`);
		}
		const show = (label, arr, fmt) => {
			if (!arr.length) return;
			console.log(`  ${label}:`);
			const cap = flags.has("--verbose") ? Infinity : 40;
			for (const x of arr.slice(0, cap)) console.log(`    ${fmt(x)}`);
			if (arr.length > cap) console.log(`    … ${arr.length - cap} more (--verbose to list all)`);
		};
		show("+links", report.diff.addedLinks, (x) => `${x.fromSku} ↔ ${x.toSku}${x.status ? ` [${x.status}]` : ""}`);
		show("-links", report.diff.removedLinks, (x) => `${x.fromSku} ↔ ${x.toSku}`);
		show("+ignores", report.diff.addedIgnores, (x) => `${x.skuA} ↔ ${x.skuB}`);
		show("-ignores", report.diff.removedIgnores, (x) => `${x.skuA} ↔ ${x.skuB}`);
		const skipped = results.filter((r) => r.status === "skipped");
		show("skipped", skipped, (x) => `op[${x.index}] ${x.op} ${x.a} ↔ ${x.b} — ${x.note}`);
		if (review.length) {
			console.log(`  review (${review.length}) — NOT applied, for a human:`);
			for (const r of review) console.log(`    ${r.a} ↔ ${r.b} — ${r.why}`);
		}
		if (dataQuality.length) {
			console.log(`  dataQuality (${dataQuality.length}) — suspect RECORDS, not link decisions:`);
			for (const d of dataQuality) console.log(`    ${d.sku}${d.store ? ` @ ${d.store}` : ""} — ${d.issue}`);
		}
		if (report.wrote) {
			console.log(`  WROTE ${report.file} — commit data/sku_links.json by hand (the tool never commits).`);
		} else {
			console.log("  dry-run — nothing written. Re-run with --apply to write.");
		}
	}
}

main();
