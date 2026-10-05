#!/usr/bin/env node
/* Stamp the PWA build into the site artifact. Run by .github/workflows/pages.yaml just
 * before upload, on the deployed copy only — never commit a stamped file.
 *
 *   node tools/stamp_pwa.js viz
 *
 * - sw.js:      BUILD = hash of the shell, FILES = every shell file to precache
 * - index.html: <meta name="st-build"> = the same hash (app/pwa.js registers only when set)
 *
 * BUILD hashes file CONTENTS, not the commit. Pages redeploys on every scrape (~8x/day);
 * keying on the commit would rotate the shell cache and raise the "new version" prompt on
 * each of them. Data is excluded from the hash for the same reason.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = process.argv[2];
if (root === undefined) throw new Error("usage: node tools/stamp_pwa.js <site-dir>");

// i/ = per-item share pages (tools/build_share_pages.mjs): data, not shell.
const SKIP_DIRS = new Set(["data", "email-assets", "i"]);
// icons/og.png is for link-preview crawlers only; no reason to precache 190 KB.
const SKIP_FILES = new Set(["serve.js", "sw.js", "app/package.json", "icons/og.png"]);
const SHELL_EXT = new Set([".html", ".js", ".css", ".png", ".jpeg", ".jpg", ".svg", ".ico", ".webmanifest"]);

function walk(rel) {
	const out = [];
	for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
		const p = rel === "" ? ent.name : `${rel}/${ent.name}`;
		if (ent.isDirectory()) {
			if (!SKIP_DIRS.has(p)) out.push(...walk(p));
		} else if (SHELL_EXT.has(path.extname(ent.name)) && !SKIP_FILES.has(p)) {
			out.push(p);
		}
	}
	return out;
}

const files = walk("").sort();
for (const f of ["index.html", "manifest.webmanifest", "app/main.js", "app/pwa.js"]) {
	if (!files.includes(f)) throw new Error(`shell is missing ${f}; wrong site dir?`);
}

const swPath = path.join(root, "sw.js");
const indexPath = path.join(root, "index.html");
const swSrc = fs.readFileSync(swPath, "utf8");
const indexSrc = fs.readFileSync(indexPath, "utf8");

const hash = crypto.createHash("sha256");
for (const f of files) {
	hash.update(f);
	hash.update(fs.readFileSync(path.join(root, f)));
}
hash.update(swSrc);
const build = hash.digest("hex").slice(0, 12);

function replaceOnce(src, needle, value, file) {
	const n = src.split(needle).length - 1;
	if (n !== 1) throw new Error(`${file}: expected exactly one ${needle}, found ${n}`);
	return src.replace(needle, () => value);
}

const precache = ["./", ...files.map((f) => `./${f}`)];
let sw = replaceOnce(swSrc, "'__BUILD__'", `'${build}'`, "sw.js");
sw = replaceOnce(sw, "[/*__FILES__*/]", JSON.stringify(precache, null, 2), "sw.js");
const index = replaceOnce(indexSrc, 'content="__BUILD__"', `content="${build}"`, "index.html");

fs.writeFileSync(swPath, sw);
fs.writeFileSync(indexPath, index);

const bytes = files.reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0);
console.log(`stamped PWA build ${build}: ${precache.length} shell files, ${(bytes / 1024).toFixed(0)} KB`);
