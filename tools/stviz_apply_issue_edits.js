// tools/stviz_apply_issue_edits.js
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function die(msg) {
	console.error(msg);
	process.exit(1);
}

function sh(cmd) {
	return execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim();
}

function ghRun(args) {
	return execFileSync("gh", args, { stdio: "pipe", encoding: "utf8" }).trim();
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
		} catch {}
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
	const out = new Map();
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
				} catch {}
			}

			const candidates = new Set([skuRaw, key].filter(Boolean));
			for (const cand of candidates) {
				if (!need.has(cand)) continue;

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

function pairKey(a, b) {
	const x = normSku(a);
	const y = normSku(b);
	if (!x || !y || x === y) return "";
	return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/* ---------------- Apply edits (simple JSON merge) ---------------- */

const filePath = path.join("data", "sku_links.json");

if (!fs.existsSync(filePath)) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify({ links: [], ignores: [] }) + "\n");
}

const beforeObj = JSON.parse(fs.readFileSync(filePath, "utf8"));
const afterObj = JSON.parse(JSON.stringify(beforeObj));

const beforeLinks = new Set((beforeObj.links || []).map((o) => linkKeyFrom(o.fromSku, o.toSku)));
const beforeIgnores = new Set((beforeObj.ignores || []).map((o) => pairKey(o.skuA, o.skuB)));

for (const l of linksIn) {
	const k = linkKeyFrom(l.fromSku, l.toSku);
	if (k && !beforeLinks.has(k)) afterObj.links.push({ fromSku: normSku(l.fromSku), toSku: normSku(l.toSku) });
}

for (const i of ignoresIn) {
	const k = pairKey(i.skuA, i.skuB);
	if (k && !beforeIgnores.has(k)) {
		const [a, b] = k.split("|");
		afterObj.ignores.push({ skuA: a, skuB: b });
	}
}

fs.writeFileSync(filePath, JSON.stringify({ links: afterObj.links, ignores: afterObj.ignores }) + "\n");

/* ---------------- Build visualization ---------------- */

const addedLinks = afterObj.links.filter((o) => !beforeLinks.has(linkKeyFrom(o.fromSku, o.toSku)));
const addedIgnores = afterObj.ignores.filter((o) => !beforeIgnores.has(pairKey(o.skuA, o.skuB)));

const needed = new Set();
for (const x of addedLinks) {
	needed.add(x.fromSku);
	needed.add(x.toSku);
}
for (const x of addedIgnores) {
	needed.add(x.skuA);
	needed.add(x.skuB);
}

const skuInfo = await collectSkuInfo(needed);

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

/* ---------------- Git + PR ---------------- */

sh(`git config user.name "github-actions[bot]"`);
sh(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`);

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const branch = `stviz/issue-${ISSUE_NUMBER}-${ts}`;

sh(`git checkout -b "${branch}"`);
sh(`git add "${filePath}"`);

if (!sh(`git status --porcelain "${filePath}"`)) {
	console.log("No changes to commit.");
	process.exit(0);
}

sh(`git commit -m "stviz: apply sku edits (issue #${ISSUE_NUMBER})"`);
sh(`git push -u origin "${branch}"`);

const prTitle = `STVIZ: SKU link updates (issue #${ISSUE_NUMBER})`;
const prBody = capBody(
	`Automated PR created from issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}\n\nIssue: #${ISSUE_NUMBER}${vizBlock}`,
);

const prBodyPath = path.join(process.cwd(), ".stviz_pr_body.md");
fs.writeFileSync(prBodyPath, prBody, "utf8");

const prCreateOut = ghRun([
	"-R",
	REPO,
	"pr",
	"create",
	"--base",
	"data",
	"--head",
	branch,
	"--title",
	prTitle,
	"--body-file",
	prBodyPath,
]);

const prUrl = prCreateOut.match(/https?:\/\/\S+\/pull\/\d+/)?.[0];
if (!prUrl) die("Could not extract PR URL");

const prNumber = ghRun(["-R", REPO, "pr", "view", prUrl, "--json", "number", "--jq", ".number"]);

ghRun([
	"-R",
	REPO,
	"issue",
	"close",
	ISSUE_NUMBER,
	"-c",
	`Processed by STVIZ automation. Opened PR #${prNumber}: ${prUrl}`,
]);