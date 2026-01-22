#!/usr/bin/env node
"use strict";

/*
  Build an HTML email alert for the latest data-branch commit.

  Criteria (per your spec):
  - NEW listings: include only if the canonical SKU is available at exactly 1 store (this one).
  - SALES: include only if
      A) >= 20% off (old->new)
      B) this store is currently the cheapest for that canonical SKU (ties allowed)
  - If nothing matches, do not send email.

  Outputs:
    reports/alert.html
    reports/alert_subject.txt
    reports/alert_should_send.txt ("1" or "0")
  If GITHUB_OUTPUT is set, also writes:
    should_send=0/1
    subject=...
    html_path=...
*/

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function gitShowJson(sha, filePath) {
  try {
    const txt = execFileSync("git", ["show", `${sha}:${filePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function priceToNumber(v) {
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pctOff(oldStr, newStr) {
  const a = priceToNumber(oldStr);
  const b = priceToNumber(newStr);
  if (a === null || b === null) return null;
  if (a <= 0) return null;
  if (b >= a) return 0;
  return Math.round(((a - b) / a) * 100);
}

function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normToken(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w:./-]+/g, "");
}

function getFirstParentSha(headSha) {
  try {
    const out = runGit(["rev-list", "--parents", "-n", "1", headSha]);
    const parts = out.split(/\s+/).filter(Boolean);
    return parts.length >= 2 ? parts[1] : "";
  } catch {
    return "";
  }
}

function listChangedDbFiles(fromSha, toSha) {
  try {
    const out = runGit(["diff", "--name-only", fromSha, toSha, "--", "data/db"]);
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && s.endsWith(".json"));
  } catch {
    return [];
  }
}

function listDbFilesOnDisk() {
  const dir = path.join(process.cwd(), "data", "db");
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.posix.join("data/db", e.name));
  } catch {
    return [];
  }
}

// We reuse your existing canonical SKU mapping logic.
function loadSkuMapOrNull() {
  try {
    // exists on data branch because you merge main -> data before committing runs
    // eslint-disable-next-line node/no-missing-require
    const { loadSkuMap } = require(path.join(process.cwd(), "src", "utils", "sku_map"));
    return loadSkuMap({ dbDir: path.join(process.cwd(), "data", "db") });
  } catch {
    return null;
  }
}

function normalizeSkuKeyOrEmpty({ skuRaw, storeLabel, url }) {
  try {
    // eslint-disable-next-line node/no-missing-require
    const { normalizeSkuKey } = require(path.join(process.cwd(), "src", "utils", "sku"));
    const k = normalizeSkuKey(skuRaw, { storeLabel, url });
    return k ? String(k) : "";
  } catch {
    // fallback: use 6-digit SKU if present; else url hash-ish (still stable enough for 1 run)
    const m = String(skuRaw ?? "").match(/\b(\d{6})\b/);
    if (m) return m[1];
    if (url) return `u:${normToken(storeLabel)}:${normToken(url)}`;
    return "";
  }
}

function canonicalize(skuKey, skuMap) {
  if (!skuKey) return "";
  if (skuMap && typeof skuMap.canonicalSku === "function") return String(skuMap.canonicalSku(skuKey) || skuKey);
  return skuKey;
}

function mapDbItems(obj, skuMap, { includeRemoved }) {
  const storeLabel = String(obj?.storeLabel || obj?.store || "");
  const categoryLabel = String(obj?.categoryLabel || obj?.category || "");
  const items = Array.isArray(obj?.items) ? obj.items : [];

  const m = new Map(); // canonSku -> item (for this store+category db)
  for (const it of items) {
    if (!it) continue;
    const removed = Boolean(it.removed);
    if (!includeRemoved && removed) continue;

    const skuKey = normalizeSkuKeyOrEmpty({ skuRaw: it.sku, storeLabel, url: it.url });
    const canon = canonicalize(skuKey, skuMap);
    if (!canon) continue;

    m.set(canon, {
      canonSku: canon,
      skuRaw: String(it.sku || ""),
      name: String(it.name || ""),
      price: String(it.price || ""),
      url: String(it.url || ""),
      img: String(it.img || it.image || it.thumb || ""),
      removed,
      storeLabel,
      categoryLabel,
    });
  }
  return m;
}

function diffDb(prevObj, nextObj, skuMap) {
  const prevAll = mapDbItems(prevObj, skuMap, { includeRemoved: true });
  const nextAll = mapDbItems(nextObj, skuMap, { includeRemoved: true });
  const prevLive = mapDbItems(prevObj, skuMap, { includeRemoved: false });
  const nextLive = mapDbItems(nextObj, skuMap, { includeRemoved: false });

  const newItems = [];
  const priceDown = [];

  for (const [canon, now] of nextLive.entries()) {
    const had = prevAll.get(canon);
    if (!had) {
      newItems.push(now);
      continue;
    }
    // restored not used for now (you didn’t request it)
  }

  for (const [canon, now] of nextLive.entries()) {
    const was = prevLive.get(canon);
    if (!was) continue;
    const a = String(was.price || "");
    const b = String(now.price || "");
    if (a === b) continue;

    const aN = priceToNumber(a);
    const bN = priceToNumber(b);
    if (aN === null || bN === null) continue;
    if (bN >= aN) continue;

    priceDown.push({
      ...now,
      oldPrice: a,
      newPrice: b,
      pct: pctOff(a, b),
    });
  }

  return { newItems, priceDown };
}

function buildCurrentIndexes(skuMap) {
  const files = listDbFilesOnDisk();
  const availability = new Map(); // canonSku -> Set(storeLabel)
  const cheapest = new Map(); // canonSku -> { priceNum, stores:Set, example:{name,url,img,categoryLabel} }
  const byStoreCanon = new Map(); // storeLabel -> Map(canonSku -> item)

  for (const file of files) {
    const obj = readJson(file);
    if (!obj) continue;
    const storeLabel = String(obj.storeLabel || obj.store || "");
    if (!storeLabel) continue;

    const live = mapDbItems(obj, skuMap, { includeRemoved: false });
    if (!byStoreCanon.has(storeLabel)) byStoreCanon.set(storeLabel, new Map());

    for (const it of live.values()) {
      // availability
      if (!availability.has(it.canonSku)) availability.set(it.canonSku, new Set());
      availability.get(it.canonSku).add(storeLabel);

      // per-store lookup
      byStoreCanon.get(storeLabel).set(it.canonSku, it);

      // cheapest
      const p = priceToNumber(it.price);
      if (p === null) continue;

      const cur = cheapest.get(it.canonSku);
      if (!cur) {
        cheapest.set(it.canonSku, {
          priceNum: p,
          stores: new Set([storeLabel]),
          example: { name: it.name, url: it.url, img: it.img, categoryLabel: it.categoryLabel },
        });
      } else if (p < cur.priceNum) {
        cheapest.set(it.canonSku, {
          priceNum: p,
          stores: new Set([storeLabel]),
          example: { name: it.name, url: it.url, img: it.img, categoryLabel: it.categoryLabel },
        });
      } else if (p === cur.priceNum) {
        cur.stores.add(storeLabel);
      }
    }
  }

  return { availability, cheapest, byStoreCanon };
}

function renderHtml({ title, subtitle, uniqueNews, bigSales, commitUrl, pagesUrl }) {
  const now = new Date().toISOString();

  function section(titleText, rowsHtml) {
    return `
      <div style="margin:16px 0 6px 0;font-weight:700;font-size:16px">${htmlEscape(titleText)}</div>
      ${rowsHtml || `<div style="color:#666">None</div>`}
    `;
  }

  function card(it, extraHtml) {
    const img = it.img ? `<img src="${htmlEscape(it.img)}" width="84" height="84" style="object-fit:contain;border-radius:8px;border:1px solid #eee;background:#fff" />` : "";
    const name = htmlEscape(it.name || "");
    const store = htmlEscape(it.storeLabel || "");
    const cat = htmlEscape(it.categoryLabel || "");
    const price = htmlEscape(it.price || it.newPrice || "");
    const url = htmlEscape(it.url || "");
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:12px;margin:10px 0">
        <tr>
          <td style="padding:12px;vertical-align:top;width:96px">${img || ""}</td>
          <td style="padding:12px;vertical-align:top">
            <div style="font-weight:700;font-size:14px;line-height:1.3">${name}</div>
            <div style="color:#666;font-size:12px;margin-top:2px">${store}${cat ? " · " + cat : ""}</div>
            <div style="margin-top:8px;font-size:13px"><span style="font-weight:700">${price}</span></div>
            ${extraHtml || ""}
            ${url ? `<div style="margin-top:8px"><a href="${url}" style="color:#0b57d0;text-decoration:none">View item</a></div>` : ""}
          </td>
        </tr>
      </table>
    `;
  }

  const uniqueHtml = uniqueNews.map((it) => card(it)).join("");
  const salesHtml = bigSales
    .map((it) => {
      const pct = Number.isFinite(it.pct) ? it.pct : null;
      const oldP = htmlEscape(it.oldPrice || "");
      const newP = htmlEscape(it.newPrice || "");
      const extra = `
        <div style="margin-top:6px;font-size:13px">
          <span style="color:#b00020;text-decoration:line-through">${oldP}</span>
          <span style="margin:0 6px;color:#666">→</span>
          <span style="font-weight:700;color:#137333">${newP}</span>
          ${pct !== null ? `<span style="margin-left:8px;color:#137333;font-weight:700">(${pct}% off)</span>` : ""}
        </div>
      `;
      return card({ ...it, price: it.newPrice }, extra);
    })
    .join("");

  const links = `
    <div style="margin-top:10px;font-size:12px;color:#666">
      ${commitUrl ? `Commit: <a href="${htmlEscape(commitUrl)}" style="color:#0b57d0;text-decoration:none">${htmlEscape(commitUrl)}</a><br/>` : ""}
      ${pagesUrl ? `Visualizer: <a href="${htmlEscape(pagesUrl)}" style="color:#0b57d0;text-decoration:none">${htmlEscape(pagesUrl)}</a>` : ""}
      <div style="margin-top:6px;color:#999">Generated at ${htmlEscape(now)}</div>
    </div>
  `;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width" />
  <title>${htmlEscape(title)}</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:720px;margin:0 auto;padding:18px;">
    <div style="background:#fff;border:1px solid #eee;border-radius:14px;padding:16px;">
      <div style="font-weight:800;font-size:18px">${htmlEscape(title)}</div>
      <div style="color:#666;margin-top:4px">${htmlEscape(subtitle || "")}</div>
      ${section("Unique new listings", uniqueHtml)}
      ${section("Big sales (>= 20% and cheapest)", salesHtml)}
      ${links}
    </div>
  </div>
</body>
</html>`;
}

function writeGithubOutput(kv) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  const lines = [];
  for (const [k, v] of Object.entries(kv)) {
    lines.push(`${k}=${String(v)}`);
  }
  fs.appendFileSync(outPath, lines.join("\n") + "\n", "utf8");
}

function main() {
  const repoRoot = process.cwd();
  const reportsDir = path.join(repoRoot, "reports");
  ensureDir(reportsDir);

  const headSha = runGit(["rev-parse", "HEAD"]);
  const parentSha = getFirstParentSha(headSha);
  if (!parentSha) {
    fs.writeFileSync(path.join(reportsDir, "alert_should_send.txt"), "0\n", "utf8");
    writeGithubOutput({ should_send: 0 });
    return;
  }

  const skuMap = loadSkuMapOrNull();

  const changed = listChangedDbFiles(parentSha, headSha);
  if (!changed.length) {
    fs.writeFileSync(path.join(reportsDir, "alert_should_send.txt"), "0\n", "utf8");
    writeGithubOutput({ should_send: 0 });
    return;
  }

  // Current-state indexes (across ALL stores) from disk
  const { availability, cheapest, byStoreCanon } = buildCurrentIndexes(skuMap);

  const uniqueNews = [];
  const bigSales = [];

  for (const file of changed) {
    const prevObj = gitShowJson(parentSha, file);
    const nextObj = gitShowJson(headSha, file);
    if (!prevObj && !nextObj) continue;

    const { newItems, priceDown } = diffDb(prevObj, nextObj, skuMap);

    // New unique listings (canon sku available at exactly 1 store)
    for (const it of newItems) {
      const stores = availability.get(it.canonSku);
      const storeCount = stores ? stores.size : 0;
      if (storeCount !== 1) continue;

      // ensure the only store is this one
      if (!stores.has(it.storeLabel)) continue;

      // refresh with current item to get img if present now
      const cur = (byStoreCanon.get(it.storeLabel) || new Map()).get(it.canonSku) || it;
      uniqueNews.push(cur);
    }

    // Sales: >=20% and cheapest store currently (ties allowed)
    for (const it of priceDown) {
      const pct = it.pct;
      if (!Number.isFinite(pct) || pct < 20) continue;

      const best = cheapest.get(it.canonSku);
      if (!best) continue;

      const newN = priceToNumber(it.newPrice);
      if (newN === null) continue;

      // must be at cheapest price, and this store among cheapest stores
      if (best.priceNum !== newN) continue;
      if (!best.stores.has(it.storeLabel)) continue;

      // refresh with current item for img/name/category if needed
      const cur = (byStoreCanon.get(it.storeLabel) || new Map()).get(it.canonSku) || it;

      bigSales.push({
        ...cur,
        oldPrice: it.oldPrice,
        newPrice: it.newPrice,
        pct,
      });
    }
  }

  // de-dupe by (canonSku, storeLabel)
  function dedupe(arr) {
    const out = [];
    const seen = new Set();
    for (const it of arr) {
      const k = `${it.canonSku}|${it.storeLabel}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
    return out;
  }

  const uniqueFinal = dedupe(uniqueNews).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const salesFinal = dedupe(bigSales).sort((a, b) => (b.pct || 0) - (a.pct || 0));

  const shouldSend = uniqueFinal.length > 0 || salesFinal.length > 0;

  const subject = shouldSend
    ? `Spirit Tracker: ${uniqueFinal.length} unique new · ${salesFinal.length} big sales`
    : `Spirit Tracker: (no alert)`;

  const ghRepo = process.env.GITHUB_REPOSITORY || "";
  const ghUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const commitUrl = ghRepo ? `${ghUrl}/${ghRepo}/commit/${headSha}` : "";
  const pagesUrl = process.env.PAGES_URL || "";

  const html = renderHtml({
    title: "Spirit Tracker Alert",
    subtitle: subject,
    uniqueNews: uniqueFinal,
    bigSales: salesFinal,
    commitUrl,
    pagesUrl,
  });

  const htmlPath = path.join(reportsDir, "alert.html");
  const subjPath = path.join(reportsDir, "alert_subject.txt");
  const sendPath = path.join(reportsDir, "alert_should_send.txt");

  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(subjPath, subject + "\n", "utf8");
  fs.writeFileSync(sendPath, (shouldSend ? "1\n" : "0\n"), "utf8");

  writeGithubOutput({
    should_send: shouldSend ? 1 : 0,
    subject,
    html_path: htmlPath,
  });
}

main();
