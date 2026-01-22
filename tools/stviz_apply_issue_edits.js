// tools/stviz_apply_issue_edits.js
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function sh(cmd) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim();
}

const ISSUE_BODY = process.env.ISSUE_BODY || "";
const ISSUE_NUMBER = String(process.env.ISSUE_NUMBER || "").trim();
const ISSUE_TITLE = process.env.ISSUE_TITLE || "";
const REPO = process.env.REPO || "";

if (!ISSUE_NUMBER) die("Missing ISSUE_NUMBER");
if (!REPO) die("Missing REPO");

const m = ISSUE_BODY.match(/<!--\s*stviz-sku-edits:BEGIN\s*-->\s*([\s\S]*?)\s*<!--\s*stviz-sku-edits:END\s*-->/);
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
function linkKey(x) {
  const a = normSku(x?.fromSku);
  const b = normSku(x?.toSku);
  return a && b && a !== b ? `${a}→${b}` : "";
}
function pairKey(a, b) {
  const x = normSku(a), y = normSku(b);
  if (!x || !y || x === y) return "";
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

const filePath = path.join("data", "sku_links.json");
let base = { generatedAt: "", links: [], ignores: [] };

if (fs.existsSync(filePath)) {
  try {
    base = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // keep defaults
  }
}

const baseLinks = Array.isArray(base?.links) ? base.links : [];
const baseIgnores = Array.isArray(base?.ignores) ? base.ignores : [];

const seenLinks = new Set(baseLinks.map(linkKey).filter(Boolean));
for (const x of linksIn) {
  const k = linkKey(x);
  if (!k || seenLinks.has(k)) continue;
  seenLinks.add(k);
  baseLinks.push({ fromSku: normSku(x.fromSku), toSku: normSku(x.toSku) });
}

const seenIg = new Set(
  baseIgnores
    .map((x) => pairKey(x?.skuA || x?.a || x?.left, x?.skuB || x?.b || x?.right))
    .filter(Boolean)
);
for (const x of ignoresIn) {
  const k = pairKey(x?.skuA, x?.skuB);
  if (!k || seenIg.has(k)) continue;
  seenIg.add(k);
  baseIgnores.push({ skuA: normSku(x.skuA), skuB: normSku(x.skuB) });
}

const out = {
  generatedAt: new Date().toISOString(),
  links: baseLinks,
  ignores: baseIgnores,
};

fs.mkdirSync(path.dirname(filePath), { recursive: true });
fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + "\n", "utf8");

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const branch = `stviz/issue-${ISSUE_NUMBER}-${ts}`;

sh(`git checkout -b "${branch}"`);
sh(`git add "${filePath}"`);
sh(`git commit -m "stviz: apply sku edits (issue #${ISSUE_NUMBER})"`);

sh(`git push -u origin "${branch}"`);

const prTitle = `STVIZ: SKU link updates (issue #${ISSUE_NUMBER})`;
const prBody = `Automated PR created from issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

sh(`gh -R "${REPO}" pr create --base data --head "${branch}" --title "${prTitle}" --body "${prBody}"`);
