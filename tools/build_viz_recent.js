#!/usr/bin/env node
"use strict";

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
      stdio: ["ignore", "pipe", "pipe"], // silence git fatal spam
    });
    return JSON.parse(txt);
  } catch {
    return null;
  }
}


function gitListTreeFiles(sha, dirRel) {
  try {
    const out = runGit(["ls-tree", "-r", "--name-only", sha, dirRel]);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readJsonFileOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeCspc(v) {
  const m = String(v ?? "").match(/\b(\d{6})\b/);
  return m ? m[1] : "";
}

function normPriceStr(p) {
  return String(p ?? "").trim();
}

function priceToNumber(v) {
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function dateOnly(iso) {
  const m = String(iso ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function makeSyntheticSku(storeLabel, url) {
  const store = String(storeLabel || "store");
  const u = String(url || "");
  if (!u) return "";
  return `u:${fnv1a32(`${store}|${u}`)}`;
}

function keySkuForItem(it, storeLabel) {
  const real = normalizeCspc(it?.sku);
  if (real) return real;
  return makeSyntheticSku(storeLabel, it?.url);
}

function mapBySku(obj, { includeRemoved } = { includeRemoved: false }) {
  const m = new Map();
  const items = Array.isArray(obj?.items) ? obj.items : [];

  const storeLabel = String(obj?.storeLabel || obj?.store || "");

  for (const it of items) {
    if (!it) continue;

    const sku = keySkuForItem(it, storeLabel);
    if (!sku) continue; // still skip truly keyless rows (no sku + no url)

    const removed = Boolean(it.removed);
    if (!includeRemoved && removed) continue;

    m.set(sku, {
      sku,
      name: String(it.name || ""),
      price: String(it.price || ""),
      url: String(it.url || ""),
      removed,
    });
  }
  return m;
}

function diffDb(prevObj, nextObj) {
  const prevAll = mapBySku(prevObj, { includeRemoved: true });
  const nextAll = mapBySku(nextObj, { includeRemoved: true });

  const prevLive = mapBySku(prevObj, { includeRemoved: false });
  const nextLive = mapBySku(nextObj, { includeRemoved: false });

  const newItems = [];
  const restoredItems = [];
  const removedItems = [];
  const priceChanges = [];

  // NEW + RESTORED
  for (const [sku, now] of nextLive.entries()) {
    const had = prevAll.get(sku);
    if (!had) {
      newItems.push({ ...now });
      continue;
    }
    if (had.removed) {
      restoredItems.push({ ...now });
      continue;
    }
  }

  // REMOVED
  for (const [sku, was] of prevLive.entries()) {
    const nxt = nextAll.get(sku);
    if (!nxt || nxt.removed) {
      removedItems.push({ ...was });
    }
  }

  // PRICE CHANGES
  for (const [sku, now] of nextLive.entries()) {
    const was = prevLive.get(sku);
    if (!was) continue;

    const a = normPriceStr(was.price);
    const b = normPriceStr(now.price);
    if (a === b) continue;

    const aN = priceToNumber(a);
    const bN = priceToNumber(b);

    let kind = "price_change";
    if (aN !== null && bN !== null) {
      if (bN < aN) kind = "price_down";
      else if (bN > aN) kind = "price_up";
      else kind = "price_change";
    }

    priceChanges.push({
      kind,
      sku,
      name: now.name || was.name || "",
      oldPrice: a,
      newPrice: b,
      url: now.url || was.url || "",
    });
  }

  return { newItems, restoredItems, removedItems, priceChanges };
}

function getHeadShaOrEmpty() {
  try {
    return runGit(["rev-parse", "--verify", "HEAD"]);
  } catch {
    return "";
  }
}

function firstParentSha(sha) {
  try {
    const out = runGit(["rev-list", "--parents", "-n", "1", sha]);
    const parts = out.split(/\s+/).filter(Boolean);
    // parts[0] is sha, parts[1] is first parent (if any)
    return parts.length >= 2 ? parts[1] : "";
  } catch {
    return "";
  }
}

function listChangedDbFiles(fromSha, toSha) {
  // toSha can be "WORKTREE"
  if (!fromSha && toSha && toSha !== "WORKTREE") {
    return gitListTreeFiles(toSha, "data/db");
  }

  if (!fromSha && toSha === "WORKTREE") {
    // Fall back: list files on disk
    try {
      return fs
        .readdirSync(path.join(process.cwd(), "data", "db"), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => path.posix.join("data/db", e.name));
    } catch {
      return [];
    }
  }

  try {
    if (toSha === "WORKTREE") {
      const out = runGit(["diff", "--name-only", fromSha, "--", "data/db"]);
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    const out = runGit(["diff", "--name-only", fromSha, toSha, "--", "data/db"]);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function logDbCommitsSince(sinceIso) {
  try {
    const out = runGit(["log", `--since=${sinceIso}`, "--format=%H %cI", "--", "data/db"]);
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const arr = [];
    for (const line of lines) {
      const m = line.match(/^([0-9a-f]{7,40})\s+(.+)$/i);
      if (!m) continue;
      const sha = m[1];
      const ts = m[2];
      const d = dateOnly(ts);
      arr.push({ sha, ts, date: d });
    }
    // newest -> oldest from git; convert to oldest -> newest
    arr.reverse();
    return arr;
  } catch {
    return [];
  }
}

function main() {
  const repoRoot = process.cwd();
  const outDir = path.join(repoRoot, "viz", "data");
  const outFile = path.join(outDir, "recent.json");
  fs.mkdirSync(outDir, { recursive: true });

  const windowDays = Math.max(1, Number(process.env.RECENT_DAYS || 3));
  const maxItems = Math.max(1, Number(process.env.RECENT_MAX_ITEMS || 500));

  const now = new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
  const sinceIso = since.toISOString();

  const headSha = getHeadShaOrEmpty();
  const items = [];

  // Collect committed runs in the last N days (touching data/db)
  const commits = headSha ? logDbCommitsSince(sinceIso) : [];

  // Build diff pairs:
  //   parent(of first in window) -> first
  //   then each consecutive commit -> next
  //   then HEAD -> WORKTREE (so this run shows up before the commit exists)
  const pairs = [];

  if (commits.length) {
    const first = commits[0];
    const parent = firstParentSha(first.sha);
    pairs.push({
      fromSha: parent || "",
      toSha: first.sha,
      ts: first.ts,
      date: first.date,
    });

    for (let i = 1; i < commits.length; i++) {
      pairs.push({
        fromSha: commits[i - 1].sha,
        toSha: commits[i].sha,
        ts: commits[i].ts,
        date: commits[i].date,
      });
    }
  }

  if (headSha) {
    pairs.push({
      fromSha: headSha,
      toSha: "WORKTREE",
      ts: now.toISOString(),
      date: dateOnly(now.toISOString()),
    });
  }

  for (const p of pairs) {
    const fromSha = p.fromSha;
    const toSha = p.toSha;
    const ts = p.ts;
    const d = p.date;

    const files = listChangedDbFiles(fromSha, toSha);
    if (!files.length) continue;

    for (const file of files) {
      let prevObj = null;
      let nextObj = null;

      if (toSha === "WORKTREE") {
        prevObj = fromSha ? gitShowJson(fromSha, file) : null;
        nextObj = readJsonFileOrNull(path.join(repoRoot, file));
      } else {
        prevObj = fromSha ? gitShowJson(fromSha, file) : null;
        nextObj = gitShowJson(toSha, file);
      }

      if (!prevObj && !nextObj) continue;

      const storeLabel = String(
        nextObj?.storeLabel || nextObj?.store || prevObj?.storeLabel || prevObj?.store || ""
      );
      const categoryLabel = String(
        nextObj?.categoryLabel || nextObj?.category || prevObj?.categoryLabel || prevObj?.category || ""
      );

      const { newItems, restoredItems, removedItems, priceChanges } = diffDb(prevObj, nextObj);

      for (const it of newItems) {
        items.push({
          ts,
          date: d,
          fromSha: fromSha || "",
          toSha,
          kind: "new",
          sku: it.sku,
          name: it.name,
          storeLabel,
          categoryLabel,
          price: normPriceStr(it.price),
          url: it.url,
          dbFile: file,
        });
      }

      for (const it of restoredItems) {
        items.push({
          ts,
          date: d,
          fromSha: fromSha || "",
          toSha,
          kind: "restored",
          sku: it.sku,
          name: it.name,
          storeLabel,
          categoryLabel,
          price: normPriceStr(it.price),
          url: it.url,
          dbFile: file,
        });
      }

      for (const it of removedItems) {
        items.push({
          ts,
          date: d,
          fromSha: fromSha || "",
          toSha,
          kind: "removed",
          sku: it.sku,
          name: it.name,
          storeLabel,
          categoryLabel,
          price: normPriceStr(it.price),
          url: it.url,
          dbFile: file,
        });
      }

      for (const u of priceChanges) {
        items.push({
          ts,
          date: d,
          fromSha: fromSha || "",
          toSha,
          kind: u.kind,
          sku: u.sku,
          name: u.name,
          storeLabel,
          categoryLabel,
          oldPrice: normPriceStr(u.oldPrice),
          newPrice: normPriceStr(u.newPrice),
          url: u.url,
          dbFile: file,
        });
      }
    }
  }

  // Newest first
  items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  // Keep file size under control (but still allows multiple runs/day over the window)
  const trimmed = items.slice(0, maxItems);

  const payload = {
    generatedAt: now.toISOString(),
    windowDays,
    since: sinceIso,
    headSha,
    count: trimmed.length,
    items: trimmed,
  };

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${outFile} (${trimmed.length} items)\n`);
}

main();
