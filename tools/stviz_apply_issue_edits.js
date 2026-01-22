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

const m = ISSUE_BODY.match(
  /<!--\s*stviz-sku-edits:BEGIN\s*-->\s*([\s\S]*?)\s*<!--\s*stviz-sku-edits:END\s*-->/
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
    return (
      `${a}{\n` +
      `${b}"skuA": ${JSON.stringify(skuA)},\n` +
      `${b}"skuB": ${JSON.stringify(skuB)}\n` +
      `${a}}`
    );
  }

  return `${a}{}`;
}

function applyInsertionsToArrayText({
  src,
  propName,
  incoming,
  keyFn,
  normalizeFn,
}) {
  const span = findJsonArraySpan(src, propName);
  if (!span) die(`Could not find "${propName}" array in ${filePath}`);

  const before = src.slice(0, span.open + 1); // includes '['
  const inner = src.slice(span.open + 1, span.close); // between [ and ]
  const after = src.slice(span.close); // starts with ']'

  const itemIndent = detectItemIndent(inner, span.fieldIndent);

  const rawBlocks = splitArrayObjectBlocks(inner);

  const existing = [];
  const seen = new Set();

  for (const raw of rawBlocks) {
    try {
      const obj = JSON.parse(raw);
      const k = keyFn(obj);
      existing.push({ raw, obj, key: k });
      if (k) seen.add(k);
    } catch {
      // If parsing fails, keep the raw block as-is, but don't use it for keying
      existing.push({ raw, obj: null, key: "" });
    }
  }

  const toAdd = [];
  for (const x of incoming) {
    const nx = normalizeFn(x);
    const k = keyFn(nx);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    toAdd.push({ obj: nx, key: k });
  }

  if (!toAdd.length) return src; // nothing to do

  // Insert each new item into sorted position by key (lex)
  // We rebuild the list of raw blocks but preserve existing raw blocks untouched.
  const outBlocks = existing.slice(); // keep {raw,obj,key}

  function findInsertIndex(k) {
    for (let i = 0; i < outBlocks.length; i++) {
      const kk = outBlocks[i]?.key || "";
      if (!kk) continue; // unknown blocks: keep them where they are
      if (kk > k) return i;
    }
    return outBlocks.length;
  }

  // Sort additions so results are deterministic
  toAdd.sort((a, b) => a.key.localeCompare(b.key));

  for (const add of toAdd) {
    const idx = findInsertIndex(add.key);
    const raw = makePrettyObjBlock(itemIndent, add.obj);
    outBlocks.splice(idx, 0, { raw, obj: add.obj, key: add.key });
  }

  // Rebuild inner text, preserving inline-empty formatting if it was empty
  let newInner = "";
  if (outBlocks.length === 0) {
    newInner = inner; // shouldn't happen, but keep original
  } else {
    // Determine if original was inline empty: "links": []
    const wasInlineEmpty = /^\s*$/.test(inner);
    if (wasInlineEmpty) {
      // Convert to pretty multi-line on first insert (minimal and stable)
      newInner =
        "\n" +
        outBlocks.map((x) => x.raw).join(",\n") +
        "\n" +
        span.fieldIndent;
    } else {
      // Keep pretty multi-line (same join style as JSON.stringify)
      // Ensure leading/trailing newlines similar to original
      const trimmed = inner.replace(/^\s+|\s+$/g, "");
      const hadLeadingNL = /^\s*\n/.test(inner);
      const hadTrailingNL = /\n\s*$/.test(inner);

      const body = outBlocks.map((x) => x.raw).join(",\n");
      newInner =
        (hadLeadingNL ? "\n" : "") +
        body +
        (hadTrailingNL ? "\n" + span.fieldIndent : "");
      // If original didn't have trailing newline before ']', keep it tight
      if (!hadTrailingNL) newInner = "\n" + body + "\n" + span.fieldIndent;
    }
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
const prBody = `Automated PR created from issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

// Create PR and capture URL/number deterministically (no search/index lag)
const prUrl = sh(
  `gh -R "${REPO}" pr create --base data --head "${branch}" --title "${prTitle}" --body "${prBody}" --json url --jq .url`
);
const prNumber = sh(`gh -R "${REPO}" pr view "${prUrl}" --json number --jq .number`);

sh(
  `gh -R "${REPO}" issue close "${ISSUE_NUMBER}" -c "Processed by STVIZ automation. Opened PR #${prNumber}: ${prUrl}"`
);
