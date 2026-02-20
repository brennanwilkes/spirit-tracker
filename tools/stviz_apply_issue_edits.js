// tools/stviz_apply_issue_edits.js
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function die(msg) {
	console.error(msg);
	process.exit(1);
}

function sh(cmd) {
	return execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim();
}

/* ---------------- PR visualization helpers ---------------- */

function escHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const SPIRIT_ITEM_BASE = "https://spirit.codexwilkes.com/#/item/";

function spiritItemUrl(skuKey) {
	return `${SPIRIT_ITEM_BASE}${encodeURIComponent(String(skuKey || ""))}`;
}

async function loadNormalizeSkuKeyOrNull() {
	// Best-effort: if your repo exposes normalizeSkuKey, use it so "u:..." keys resolve.
	const candidates = [
		path.join(process.cwd(), "src", "utils", "sku.js"),
		path.join(process.cwd(), "src", "utils", "sku"),
	];
	for (const p of candidates) {
		try {
			if (!fs.existsSync(p) && !fs.existsSync(`${p}.js`)) continue;
			const modPath = fs.existsSync(p) ? p : `${p}.js`;
			const mod = await import(pathToFileURL(modPath).href);
			if (typeof mod?.normalizeSkuKey === "function") return mod.normalizeSkuKey;
		} catch {
			// ignore
		}
	}
	return null;
}

function listDbFilesOnDisk() {
	const dir = path.join(process.cwd(), "data", "db");
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith(".json"))
			.map((e) => path.join(dir, e.name));
	} catch {
		return [];
	}
}

function readJsonFile(p) {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

async function collectSkuInfo(neededSkuKeys) {
	const need = new Set([...neededSkuKeys].map((x) => String(x || "").trim()).filter(Boolean));
	const out = new Map(); // skuKey -> info
	if (!need.size) return out;

	const normalizeSkuKey = await loadNormalizeSkuKeyOrNull();
	const files = listDbFilesOnDisk();

	for (const file of files) {
		const obj = readJsonFile(file);
		if (!obj) continue;

		const storeLabel = String(obj.storeLabel || obj.store || "");
		const categoryLabel = String(obj.categoryLabel || obj.category || "");
		const items = Array.isArray(obj.items) ? obj.items : [];

		for (const it of items) {
			if (!it) continue;
			const skuRaw = String(it.sku || "").trim();
			const url = String(it.url || "");

			let key = "";
			if (normalizeSkuKey) {
				try {
					key = String(normalizeSkuKey(skuRaw, { storeLabel, url }) || "");
				} catch {
					key = "";
				}
			}

			const candidates = new Set([skuRaw, key].filter(Boolean));
			for (const cand of candidates) {
				if (!need.has(cand)) continue;

				// Prefer an entry with an image; otherwise first hit wins.
				const prev = out.get(cand);
				const img = String(it.img || it.image || it.thumb || "");
				if (prev && prev.img) continue;

				out.set(cand, {
					skuKey: cand,
					name: String(it.name || ""),
					img,
					storeLabel,
					categoryLabel,
					productUrl: url,
				});

				if (out.size >= need.size) return out;
			}
		}
	}

	return out;
}

function renderSkuCard(skuKey, info) {
	const viewUrl = spiritItemUrl(skuKey);
	const name = escHtml(info?.name || "(unknown item)");
	const img = info?.img
		? `<a href="${escHtml(viewUrl)}"><img src="${escHtml(info.img)}" width="84" height="84" style="object-fit:contain;border-radius:10px;border:1px solid #e5e5e5;background:#fff" /></a>`
		: "";
	const meta = [info?.storeLabel, info?.categoryLabel].filter(Boolean).map(escHtml).join(" · ");
	const productUrl = info?.productUrl ? escHtml(info.productUrl) : "";

	return `
<div style="display:flex;gap:12px;align-items:flex-start">
  <div style="width:88px;min-width:88px">${img}</div>
  <div>
    <div style="font-weight:700;line-height:1.2"><a href="${escHtml(viewUrl)}">${name}</a></div>
    <div style="margin-top:4px;color:#666;font-size:12px"><code>${escHtml(skuKey)}</code>${meta ? ` · ${meta}` : ""}</div>
    ${productUrl ? `<div style="margin-top:6px;font-size:12px"><a href="${productUrl}">Store page</a></div>` : ""}
  </div>
</div>`;
}

function renderPairsTable({ title, headers, rows }) {
	if (!rows.length) return `### ${title}\n\nNone.\n`;
	const head = `<tr>${headers.map((h) => `<th align="left">${escHtml(h)}</th>`).join("")}</tr>`;
	const body = rows
		.map((r) => `<tr>${r.map((cell) => `<td valign="top">${cell}</td>`).join("")}</tr>`)
		.join("\n");
	return `### ${title}\n\n<table>\n${head}\n${body}\n</table>\n`;
}

function capBody(s, max = 60000) {
	const t = String(s || "");
	if (t.length <= max) return t;
	return t.slice(0, max - 2000) + `\n\n> (Trimmed preview: body exceeded ${max} chars.)\n`;
}

/* ---------------- Parse issue payload ---------------- */

const ISSUE_BODY = process.env.ISSUE_BODY || "";
const ISSUE_NUMBER = String(process.env.ISSUE_NUMBER || "").trim();
const ISSUE_TITLE = process.env.ISSUE_TITLE || "";
const REPO = process.env.REPO || "";

if (!ISSUE_NUMBER) die("Missing ISSUE_NUMBER");
if (!REPO) die("Missing REPO");

const m = ISSUE_BODY.match(
	/<!--\s*stviz-sku-edits:BEGIN\s*-->\s*([\s\S]*?)\s*<!--\s*stviz-sku-edits:END\s*-->/,
);
if (!m) die("No stviz payload found in issue body.");

let payload;
try {
	payload = JSON.parse(m[1]);
} catch (e) {
	die(`Invalid JSON payload: ${e?.message || e}`);
}

if (payload?.schema !== "stviz-sku-edits-v1") die("Unsupported payload schema.");

const linksIn = Array.isArray(payload?.links) ? payload.links : [];
const ignoresIn = Array.isArray(payload?.ignores) ? payload.ignores : [];

function normSku(s) {
	return String(s || "").trim();
}

function linkKeyFrom(a, b) {
	const x = normSku(a);
	const y = normSku(b);
	return x && y && x !== y ? `${x}→${y}` : "";
}

function linkKey(x) {
	return linkKeyFrom(x?.fromSku, x?.toSku);
}

function pairKey(a, b) {
	const x = normSku(a),
		y = normSku(b);
	if (!x || !y || x === y) return "";
	return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/* ---------------- Minimal, merge-friendly JSON array insertion ---------------- */

function findJsonArraySpan(src, propName) {
	// Finds the [ ... ] span for `"propName": [ ... ]` and returns { start, end, open, close, fieldIndent }
	const re = new RegExp(`(^[ \\t]*)"${propName}"\\s*:\\s*\\[`, "m");
	const mm = src.match(re);
	if (!mm) return null;

	const fieldIndent = mm[1] || "";
	const at = mm.index || 0;
	const open = src.indexOf("[", at);
	if (open < 0) return null;

	// scan to matching ']'
	let i = open;
	let depth = 0;
	let inStr = false;
	let esc = false;

	for (; i < src.length; i++) {
		const ch = src[i];

		if (inStr) {
			if (esc) {
				esc = false;
			} else if (ch === "\\") {
				esc = true;
			} else if (ch === '"') {
				inStr = false;
			}
			continue;
		}

		if (ch === '"') {
			inStr = true;
			continue;
		}

		if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) {
				const close = i;
				return { start: at, open, close, end: close + 1, fieldIndent };
			}
		}
	}

	return null;
}

function splitArrayObjectBlocks(arrayInnerText) {
	// arrayInnerText is text between '[' and ']' (can include whitespace/newlines/commas)
	// returns raw blocks (each block is the exact text for a JSON object, preserving formatting)
	const blocks = [];

	let i = 0;
	const s = arrayInnerText;

	function skipWsAndCommas() {
		while (i < s.length) {
			const ch = s[i];
			if (ch === "," || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") i++;
			else break;
		}
	}

	skipWsAndCommas();

	while (i < s.length) {
		if (s[i] !== "{") {
			// if something unexpected, advance a bit
			i++;
			skipWsAndCommas();
			continue;
		}

		const start = i;
		let depth = 0;
		let inStr = false;
		let esc = false;

		for (; i < s.length; i++) {
			const ch = s[i];

			if (inStr) {
				if (esc) {
					esc = false;
				} else if (ch === "\\") {
					esc = true;
				} else if (ch === '"') {
					inStr = false;
				}
				continue;
			}

			if (ch === '"') {
				inStr = true;
				continue;
			}

			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					i++; // include '}'
					const raw = s.slice(start, i);
					blocks.push(raw);
					break;
				}
			}
		}

		skipWsAndCommas();
	}

	return blocks;
}

function detectItemIndent(arrayInnerText, fieldIndent) {
	// Try to infer indentation for the '{' line inside the array.
	// If empty array, default to fieldIndent + 2 spaces.
	const m = arrayInnerText.match(/\n([ \t]*)\{/);
	if (m) return m[1];
	return fieldIndent + "  ";
}

function makePrettyObjBlock(objIndent, obj) {
	// Match JSON.stringify(..., 2) object formatting inside arrays
	const a = objIndent;
	const b = objIndent + "  ";
	const fromSku = normSku(obj?.fromSku);
	const toSku = normSku(obj?.toSku);
	const skuA = normSku(obj?.skuA);
	const skuB = normSku(obj?.skuB);

	if (fromSku && toSku) {
		return (
			`${a}{\n` +
			`${b}"fromSku": ${JSON.stringify(fromSku)},\n` +
			`${b}"toSku": ${JSON.stringify(toSku)}\n` +
			`${a}}`
		);
	}

	if (skuA && skuB) {
		return `${a}{\n` + `${b}"skuA": ${JSON.stringify(skuA)},\n` + `${b}"skuB": ${JSON.stringify(skuB)}\n` + `${a}}`;
	}

	return `${a}{}`;
}

function applyInsertionsToArrayText({ src, propName, incoming, keyFn, normalizeFn }) {
	const span = findJsonArraySpan(src, propName);
	if (!span) die(`Could not find "${propName}" array in ${filePath}`);

	const before = src.slice(0, span.open + 1); // includes '['
	const inner = src.slice(span.open + 1, span.close); // between [ and ]
	const after = src.slice(span.close); // starts with ']'

	const itemIndent = detectItemIndent(inner, span.fieldIndent);

	// Parse existing objects to build a dedupe set (does NOT modify inner text)
	const rawBlocks = splitArrayObjectBlocks(inner);
	const seen = new Set();
	for (const raw of rawBlocks) {
		try {
			const obj = JSON.parse(raw);
			const k = keyFn(obj);
			if (k) seen.add(k);
		} catch {
			// ignore unparsable blocks for dedupe purposes
		}
	}

	const toAdd = [];
	for (const x of incoming) {
		const nx = normalizeFn(x);
		const k = keyFn(nx);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		toAdd.push(nx);
	}

	if (!toAdd.length) return src;

	// Deterministic order for new items only (doesn't reorder existing)
	const addBlocks = toAdd
		.map((obj) => ({ obj, key: keyFn(obj) }))
		.sort((a, b) => String(a.key).localeCompare(String(b.key)))
		.map((x) => makePrettyObjBlock(itemIndent, x.obj));

	const wasInlineEmpty = /^\s*$/.test(inner);

	let newInner;
	if (wasInlineEmpty) {
		// "links": []  -> pretty multiline
		newInner = "\n" + addBlocks.join(",\n") + "\n" + span.fieldIndent;
	} else {
		// Keep existing whitespace EXACTLY; append before trailing whitespace
		const m = inner.match(/\s*$/);
		const tail = m ? m[0] : "";
		const body = inner.slice(0, inner.length - tail.length).replace(/\s*$/, ""); // end at last non-ws

		newInner = body + ",\n" + addBlocks.join(",\n") + tail;
	}

	return before + newInner + after;
}

/* ---------------- Apply edits ---------------- */

const filePath = path.join("data", "sku_links.json");

function ensureFileExists() {
	if (fs.existsSync(filePath)) return;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	// Create with stable formatting; generatedAt intentionally blank (we do not mutate it later)
	const seed = { generatedAt: "", links: [], ignores: [] };
	fs.writeFileSync(filePath, JSON.stringify(seed, null, 2) + "\n", "utf8");
}

ensureFileExists();

let text = fs.readFileSync(filePath, "utf8");
let beforeObj = null;
try {
	beforeObj = JSON.parse(text);
} catch {
	beforeObj = { links: [], ignores: [] };
}

// IMPORTANT: do NOT touch generatedAt at all.
// Also: do NOT re-stringify entire JSON; we only surgically insert into arrays.

const normLinksIn = linksIn.map((x) => ({
	fromSku: normSku(x?.fromSku),
	toSku: normSku(x?.toSku),
}));

const normIgnoresIn = ignoresIn.map((x) => {
	const a = normSku(x?.skuA);
	const b = normSku(x?.skuB);
	const k = pairKey(a, b);
	if (!k) return { skuA: "", skuB: "" };
	const [p, q] = k.split("|");
	return { skuA: p, skuB: q };
});

// Insert links (sorted by from→to)
text = applyInsertionsToArrayText({
	src: text,
	propName: "links",
	incoming: normLinksIn,
	keyFn: (o) => linkKeyFrom(o?.fromSku, o?.toSku),
	normalizeFn: (o) => ({ fromSku: normSku(o?.fromSku), toSku: normSku(o?.toSku) }),
});

// Insert ignores (sorted by canonical pair)
text = applyInsertionsToArrayText({
	src: text,
	propName: "ignores",
	incoming: normIgnoresIn,
	keyFn: (o) => pairKey(o?.skuA, o?.skuB),
	normalizeFn: (o) => {
		const a = normSku(o?.skuA);
		const b = normSku(o?.skuB);
		const k = pairKey(a, b);
		if (!k) return { skuA: "", skuB: "" };
		const [p, q] = k.split("|");
		return { skuA: p, skuB: q };
	},
});

fs.writeFileSync(filePath, text, "utf8");

// Compute which pairs were actually added (for the PR preview)
let afterObj = null;
try {
	afterObj = JSON.parse(text);
} catch {
	afterObj = { links: [], ignores: [] };
}

const beforeLinks = new Set((beforeObj?.links || []).map((o) => linkKeyFrom(o?.fromSku, o?.toSku)).filter(Boolean));
const beforeIgnores = new Set((beforeObj?.ignores || []).map((o) => pairKey(o?.skuA, o?.skuB)).filter(Boolean));

const addedLinks = (afterObj?.links || [])
	.map((o) => ({ fromSku: normSku(o?.fromSku), toSku: normSku(o?.toSku) }))
	.filter((o) => {
		const k = linkKeyFrom(o.fromSku, o.toSku);
		return k && !beforeLinks.has(k);
	});

const addedIgnores = (afterObj?.ignores || [])
	.map((o) => ({ skuA: normSku(o?.skuA), skuB: normSku(o?.skuB) }))
	.filter((o) => {
		const k = pairKey(o.skuA, o.skuB);
		return k && !beforeIgnores.has(k);
	});

const neededSkuKeys = new Set();
for (const x of addedLinks) {
	neededSkuKeys.add(x.fromSku);
	neededSkuKeys.add(x.toSku);
}
for (const x of addedIgnores) {
	neededSkuKeys.add(x.skuA);
	neededSkuKeys.add(x.skuB);
}

const skuInfo = await collectSkuInfo(neededSkuKeys);

const vizLinks = renderPairsTable({
	title: `Requested links (${addedLinks.length})`,
	headers: ["From", "To"],
	rows: addedLinks.map((p) => [renderSkuCard(p.fromSku, skuInfo.get(p.fromSku)), renderSkuCard(p.toSku, skuInfo.get(p.toSku))]),
});

const vizIgnores = renderPairsTable({
	title: `Requested ignores (${addedIgnores.length})`,
	headers: ["SKU A", "SKU B"],
	rows: addedIgnores.map((p) => [renderSkuCard(p.skuA, skuInfo.get(p.skuA)), renderSkuCard(p.skuB, skuInfo.get(p.skuB))]),
});

const vizBlock =
	`\n\n---\n\n## STVIZ preview\n\n` +
	`<details open>\n<summary>Show linked / ignored SKUs</summary>\n\n` +
	vizLinks +
	"\n" +
	vizIgnores +
	`\n</details>\n`;

/* ---------------- Git ops + PR + close issue ---------------- */

// Ensure git identity is set for commit (Actions runners often lack it)
try {
	sh(`git config user.name "github-actions[bot]"`);
	sh(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`);
} catch {
	// ignore
}

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const branch = `stviz/issue-${ISSUE_NUMBER}-${ts}`;

sh(`git checkout -b "${branch}"`);
sh(`git add "${filePath}"`);

// If no diffs (all edits were duplicates), don't create PR or close issue.
const diff = sh(`git status --porcelain "${filePath}"`);
if (!diff) {
	console.log("No changes to commit (all edits already present). Leaving issue open.");
	process.exit(0);
}

sh(`git commit -m "stviz: apply sku edits (issue #${ISSUE_NUMBER})"`);
sh(`git push -u origin "${branch}"`);

const prTitle = `STVIZ: SKU link updates (issue #${ISSUE_NUMBER})`;
const prBody = capBody(
	`Automated PR created from issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}\n\nIssue: #${ISSUE_NUMBER}${vizBlock}`,
);

function extractPrUrl(out) {
	// gh pr create usually prints the PR URL to stdout; be robust in case extra text appears.
	const m = String(out || "").match(/https?:\/\/\S+\/pull\/\d+\S*/);
	if (!m) die(`Could not find PR URL in gh output:\n${out}`);
	return m[0];
}

// Create PR and capture URL/number without relying on unsupported flags
const prCreateOut = sh(
	`gh -R "${REPO}" pr create --base data --head "${branch}" --title "${prTitle}" --body "${prBody}"`,
);
const prUrl = extractPrUrl(prCreateOut);

const prNumber = sh(`gh -R "${REPO}" pr view "${prUrl}" --json number --jq .number`);

sh(
	`gh -R "${REPO}" issue close "${ISSUE_NUMBER}" -c "Processed by STVIZ automation. Opened PR #${prNumber}: ${prUrl}"`,
);