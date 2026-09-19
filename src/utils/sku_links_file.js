"use strict";

// Shared read/write + dedup for `data/sku_links.json` (manual links + ignores).
//
// Single source of truth for the on-disk shape so the local dev server (viz/serve.js) and the
// offline audit-apply tool (tools/apply_audit_proposal.js) can never drift. The file is a single
// line: {"links":[…],"ignores":[…]}\n.

const fs = require("fs");
const path = require("path");

function linksFile(root) {
	return path.join(root, "data", "sku_links.json");
}

function readLinks(root) {
	try {
		const obj = JSON.parse(fs.readFileSync(linksFile(root), "utf8"));
		return {
			links: obj && Array.isArray(obj.links) ? obj.links : [],
			ignores: obj && Array.isArray(obj.ignores) ? obj.ignores : [],
		};
	} catch {
		return { links: [], ignores: [] };
	}
}

// Union-find dedup: keep only links that actually merge two distinct components.
// Also dedupes ignores by unordered pair.
function dedupeLinks(links, ignores) {
	const parent = new Map();
	function find(x) {
		if (!parent.has(x)) parent.set(x, x);
		if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
		return parent.get(x);
	}
	const kept = [];
	for (const link of links) {
		const ra = find(link.fromSku), rb = find(link.toSku);
		if (ra !== rb) {
			parent.set(ra, rb);
			// Preserve the WHOLE link object (not just fromSku/toSku) so auto-classify metadata
			// — status:"pending", confidence, source, ts — survives any local write. The review
			// page (#/link-review) keys off `status`, so stripping it here would silently mark
			// every pending link confirmed on the next unrelated edit.
			kept.push(link);
		}
	}

	const seenIgnores = new Set();
	const keptIgnores = [];
	for (const ig of ignores) {
		const key = [ig.skuA, ig.skuB].sort().join("\0");
		if (!seenIgnores.has(key)) {
			seenIgnores.add(key);
			keptIgnores.push(ig);
		}
	}

	return { links: kept, ignores: keptIgnores };
}

// Unordered pair key (order-independent identity for a link/ignore pair).
function pairKey(a, b) {
	return [String(a), String(b)].sort().join("\0");
}

// True when a link object joins the given unordered pair.
function matchLink(link, a, b) {
	const lf = String(link.fromSku || "").trim();
	const lt = String(link.toSku || "").trim();
	const [x, y] = [String(a), String(b)];
	return (lf === x && lt === y) || (lf === y && lt === x);
}

function writeLinks(root, obj) {
	const deduped = dedupeLinks(obj.links, obj.ignores);
	const file = linksFile(root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ links: deduped.links, ignores: deduped.ignores }) + "\n", "utf8");
	return deduped;
}

module.exports = { linksFile, readLinks, writeLinks, dedupeLinks, pairKey, matchLink };
