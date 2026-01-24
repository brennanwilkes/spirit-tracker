import { esc, renderThumbHtml, dateOnly } from "./dom.js";
import { parsePriceToNumber, keySkuForRow, displaySku } from "./sku.js";
import { loadIndex } from "./state.js";
import { inferGithubOwnerRepo, githubListCommits, githubFetchFileAtSha, fetchJson } from "./api.js";
import { loadSkuRules } from "./mapping.js";

/* ---------------- Chart lifecycle ---------------- */

let CHART = null;

export function destroyChart() {
  if (CHART) {
    CHART.destroy();
    CHART = null;
  }
}

/* ---------------- History helpers ---------------- */

// Returns BOTH mins, so we can show a dot on removal day using removed price.
function findMinPricesForSkuGroupInDb(obj, skuKeys, storeLabel) {
  const items = Array.isArray(obj?.items) ? obj.items : [];
  let liveMin = null;
  let removedMin = null;

  // Build quick lookup for real sku entries (cheap)
  const want = new Set();
  for (const s of skuKeys) {
    const x = String(s || "").trim();
    if (x) want.add(x);
  }

  for (const it of items) {
    if (!it) continue;

    const isRemoved = Boolean(it.removed);

    const consider = (priceVal) => {
      const p = parsePriceToNumber(priceVal);
      if (p === null) return;
      if (!isRemoved) liveMin = liveMin === null ? p : Math.min(liveMin, p);
      else removedMin = removedMin === null ? p : Math.min(removedMin, p);
    };

    const real = String(it.sku || "").trim();
    if (real && want.has(real)) {
      consider(it.price);
      continue;
    }

    // synthetic match (only relevant if a caller passes u: keys)
    if (!real) {
      for (const skuKey of skuKeys) {
        const k = String(skuKey || "");
        if (!k.startsWith("u:")) continue;
        const row = { sku: "", url: String(it.url || ""), storeLabel: storeLabel || "", store: "" };
        const kk = keySkuForRow(row);
        if (kk === k) consider(it.price);
      }
    }
  }

  return { liveMin, removedMin };
}

function computeSuggestedY(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return { suggestedMin: undefined, suggestedMax: undefined };

  let min = nums[0],
    max = nums[0];
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  if (min === max) return { suggestedMin: min * 0.95, suggestedMax: max * 1.05 };

  const pad = (max - min) * 0.08;
  return { suggestedMin: Math.max(0, min - pad), suggestedMax: max + pad };
}

function cacheKeySeries(sku, dbFile, cacheBust) {
  return `stviz:v3:series:${cacheBust}:${sku}:${dbFile}`;
}

function loadSeriesCache(sku, dbFile, cacheBust) {
  try {
    const raw = localStorage.getItem(cacheKeySeries(sku, dbFile, cacheBust));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.points)) return null;
    const savedAt = Number(obj.savedAt || 0);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > 7 * 24 * 3600 * 1000) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveSeriesCache(sku, dbFile, cacheBust, points) {
  try {
    localStorage.setItem(cacheKeySeries(sku, dbFile, cacheBust), JSON.stringify({ savedAt: Date.now(), points }));
  } catch {}
}

let DB_COMMITS = null;

async function loadDbCommitsManifest() {
  if (DB_COMMITS) return DB_COMMITS;
  try {
    DB_COMMITS = await fetchJson("./data/db_commits.json");
    return DB_COMMITS;
  } catch {
    DB_COMMITS = null;
    return null;
  }
}

/* ---------------- Page ---------------- */

export async function renderItem($app, skuInput) {
  destroyChart();

  const rules = await loadSkuRules();
  const sku = rules.canonicalSku(String(skuInput || ""));

  $app.innerHTML = `
    <div class="container">
      <div class="topbar">
        <button id="back" class="btn">← Back</button>
        <span class="badge mono">${esc(displaySku(sku))}</span>
        </div>

      <div class="card detailCard">
        <div class="detailHeader">
          <div id="thumbBox" class="detailThumbBox"></div>
          <div class="detailHeaderText">
            <div id="title" class="h1">Loading…</div>
            <div id="links" class="links"></div>
            <div class="small" id="status"></div>
          </div>
        </div>

        <div class="chartBox">
          <canvas id="chart"></canvas>
        </div>
      </div>
    </div>
  `;

  document.getElementById("back").addEventListener("click", () => {
    location.hash = "#/";
  });

  const $title = document.getElementById("title");
  const $links = document.getElementById("links");
  const $status = document.getElementById("status");
  const $canvas = document.getElementById("chart");
  const $thumbBox = document.getElementById("thumbBox");

  const idx = await loadIndex();
  const all = Array.isArray(idx.items) ? idx.items : [];

  // include toSku + all fromSkus mapped to it
  const skuGroup = rules.groupForCanonical(sku);

  // index.json includes removed rows too. Split live vs all.
  const allRows = all.filter((x) => skuGroup.has(String(keySkuForRow(x) || "")));
  const liveRows = allRows.filter((x) => !Boolean(x?.removed));

  if (!allRows.length) {
    $title.textContent = "Item not found";
    $status.textContent = "No matching SKU in index.";
    if ($thumbBox) $thumbBox.innerHTML = `<div class="thumbPlaceholder"></div>`;
    return;
  }

  const isRemovedEverywhere = liveRows.length === 0;

  // pick bestName by most common across LIVE rows (fallback to allRows)
  const basisForName = liveRows.length ? liveRows : allRows;

  const nameCounts = new Map();
  for (const r of basisForName) {
    const n = String(r.name || "");
    if (!n) continue;
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }

  let bestName = basisForName[0].name || `(SKU ${sku})`;
  let bestCount = -1;
  for (const [n, c] of nameCounts.entries()) {
    if (c > bestCount) {
      bestName = n;
      bestCount = c;
    }
  }
  $title.textContent = bestName;

  // choose thumbnail from cheapest LIVE listing (fallback: any matching name; fallback: any)
  let bestImg = "";
  let bestPrice = null;

  const basisForThumb = liveRows.length ? liveRows : allRows;

  for (const r of basisForThumb) {
    const p = parsePriceToNumber(r.price);
    const img = String(r?.img || "").trim();
    if (p !== null && img) {
      if (bestPrice === null || p < bestPrice) {
        bestPrice = p;
        bestImg = img;
      }
    }
  }
  if (!bestImg) {
    for (const r of basisForThumb) {
      if (String(r?.name || "") === String(bestName || "") && String(r?.img || "").trim()) {
        bestImg = String(r.img).trim();
        break;
      }
    }
  }
  if (!bestImg) {
    for (const r of basisForThumb) {
      if (String(r?.img || "").trim()) {
        bestImg = String(r.img).trim();
        break;
      }
    }
  }

  $thumbBox.innerHTML = bestImg ? renderThumbHtml(bestImg, "detailThumb") : `<div class="thumbPlaceholder"></div>`;

  // Render store links:
  // - one link per store label (even if URL differs)
  // - pick most recent row for that store
  function rowMs(r) {
    const t = String(r?.ts || "");
    const ms = t ? Date.parse(t) : NaN;
    if (Number.isFinite(ms)) return ms;

    const d = String(r?.date || "");
    const ms2 = d ? Date.parse(d + "T23:59:59Z") : NaN;
    return Number.isFinite(ms2) ? ms2 : 0;
  }

  const bestByStore = new Map(); // storeLabel -> row
  for (const r of allRows) {
    const href = String(r?.url || "").trim();
    if (!href) continue;

    const store = String(r?.storeLabel || r?.store || "Store").trim() || "Store";
    const prev = bestByStore.get(store);

    if (!prev) {
      bestByStore.set(store, r);
      continue;
    }

    const a = rowMs(prev);
    const b = rowMs(r);
    if (b > a) bestByStore.set(store, r);
    else if (b === a) {
      // tie-break: prefer live over removed
      if (Boolean(prev?.removed) && !Boolean(r?.removed)) bestByStore.set(store, r);
    }
  }

  const linkRows = Array.from(bestByStore.entries())
    .map(([store, r]) => ({ store, r }))
    .sort((A, B) => {
      const ar = Boolean(A.r?.removed) ? 1 : 0;
      const br = Boolean(B.r?.removed) ? 1 : 0;
      if (ar !== br) return ar - br; // live first
      return A.store.localeCompare(B.store);
    });

  $links.innerHTML = linkRows
    .map(({ store, r }) => {
      const href = String(r.url || "").trim();
      const suffix = Boolean(r?.removed) ? " (removed)" : "";
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(store + suffix)}</a>`;
    })
    .join("");

  const gh = inferGithubOwnerRepo();
  const owner = gh.owner;
  const repo = gh.repo;
  const branch = "data";

  // Group DB files by historical presence (LIVE or REMOVED rows).
  const byDbFileAll = new Map();
  for (const r of allRows) {
    if (!r.dbFile) continue;
    const k = String(r.dbFile);
    if (!byDbFileAll.has(k)) byDbFileAll.set(k, []);
    byDbFileAll.get(k).push(r);
  }
  const dbFiles = [...byDbFileAll.keys()].sort();

  $status.textContent = isRemovedEverywhere
    ? `Item is removed everywhere (showing historical chart across ${dbFiles.length} store file(s))…`
    : `Loading history for ${dbFiles.length} store file(s)…`;

  const manifest = await loadDbCommitsManifest();
  const allDatesSet = new Set();
  const series = [];
  const fileJsonCache = new Map();

  const cacheBust = String(idx.generatedAt || new Date().toISOString());
  const today = dateOnly(idx.generatedAt || new Date().toISOString());

  const skuKeys = [...skuGroup];

  for (const dbFile of dbFiles) {
    const rowsAll = byDbFileAll.get(dbFile) || [];

    // Determine current LIVE rows for this dbFile:
    const rowsLive = rowsAll.filter((r) => !Boolean(r?.removed));

    const storeLabel = String(rowsAll[0]?.storeLabel || rowsAll[0]?.store || dbFile);

    const cached = loadSeriesCache(sku, dbFile, cacheBust);
    if (cached && Array.isArray(cached.points) && cached.points.length) {
      const points = new Map();
      const values = [];
      for (const p of cached.points) {
        const d = String(p.date || "");
        const v = p.price === null ? null : Number(p.price);
        if (!d) continue;
        points.set(d, Number.isFinite(v) ? v : null);
        if (Number.isFinite(v)) values.push(v);
        allDatesSet.add(d);
      }
      series.push({ label: storeLabel, points, values });
      continue;
    }

    let commits = [];
    if (manifest && manifest.files && Array.isArray(manifest.files[dbFile])) {
      commits = manifest.files[dbFile];
    } else {
      try {
        let apiCommits = await githubListCommits({ owner, repo, branch, path: dbFile });
        apiCommits = apiCommits.slice().reverse();
        commits = apiCommits
          .map((c) => {
            const sha = String(c?.sha || "");
            const dIso = c?.commit?.committer?.date || c?.commit?.author?.date || "";
            const d = dateOnly(dIso);
            return sha && d ? { sha, date: d, ts: String(dIso || "") } : null;
          })
          .filter(Boolean);
      } catch {
        commits = [];
      }
    }

    // Ensure chronological
    commits = commits
      .slice()
      .filter((c) => c && c.date && c.sha)
      .sort((a, b) => {
        const da = String(a.date || "");
        const db = String(b.date || "");
        const ta = Date.parse(String(a.ts || "")) || (da ? Date.parse(da + "T00:00:00Z") : 0) || 0;
        const tb = Date.parse(String(b.ts || "")) || (db ? Date.parse(db + "T00:00:00Z") : 0) || 0;
        return ta - tb;
      });

    // Group per day: keep first+last commit for that day (so add+remove same day still yields a dot)
    const byDay = new Map();
    for (const c of commits) {
      const d = String(c.date || "");
      if (!d) continue;

      const t = Date.parse(String(c.ts || "")) || Date.parse(d + "T00:00:00Z") || 0;

      let e = byDay.get(d);
      if (!e) {
        e = { date: d, first: c, last: c, firstT: t, lastT: t };
        byDay.set(d, e);
      } else {
        if (t < e.firstT) {
          e.first = c;
          e.firstT = t;
        }
        if (t > e.lastT) {
          e.last = c;
          e.lastT = t;
        }
      }
    }

    let dayEntries = Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? -1 : 1));

    const points = new Map();
    const values = [];
    const compactPoints = [];

    const MAX_POINTS = 260;
    if (dayEntries.length > MAX_POINTS) dayEntries = dayEntries.slice(dayEntries.length - MAX_POINTS);

    let removedStreak = false;
    let prevLive = null;

    async function loadAtSha(sha) {
      const ck = `${sha}|${dbFile}`;
      let obj = fileJsonCache.get(ck) || null;
      if (!obj) {
        obj = await githubFetchFileAtSha({ owner, repo, sha, path: dbFile });
        fileJsonCache.set(ck, obj);
      }
      return obj;
    }

    for (const day of dayEntries) {
      const d = String(day.date || "");
      const firstSha = String(day.first?.sha || "");
      const lastSha = String(day.last?.sha || "");
      if (!d || !lastSha) continue;

      let objLast;
      try {
        objLast = await loadAtSha(lastSha);
      } catch {
        continue;
      }

      const lastMin = findMinPricesForSkuGroupInDb(objLast, skuKeys, storeLabel);
      const lastLive = lastMin.liveMin;
      const lastRemoved = lastMin.removedMin;

      // "removed state" at end of day: no live price but removed price exists
      const isRemovedDayState = lastLive === null && lastRemoved !== null;

      // If removed at end-of-day, try to find a live price earlier the same day
      let sameDayLive = null;
      if (isRemovedDayState && firstSha && firstSha !== lastSha) {
        try {
          const objFirst = await loadAtSha(firstSha);
          const firstMin = findMinPricesForSkuGroupInDb(objFirst, skuKeys, storeLabel);
          if (firstMin.liveMin !== null) sameDayLive = firstMin.liveMin;
        } catch {}
      }

      let v = null;

      if (lastLive !== null) {
        // live exists at end of day
        v = lastLive;
        removedStreak = false;
        prevLive = lastLive;
      } else if (isRemovedDayState) {
        // show a dot ONLY on the first day it becomes removed
        if (!removedStreak) {
          // Prefer removed snapshot price (price at removal time), else earlier same-day live, else last known live
          v = lastRemoved !== null ? lastRemoved : sameDayLive !== null ? sameDayLive : prevLive;
          removedStreak = true;
        } else {
          v = null; // days after removal: no dot
        }
      } else {
        v = null;
      }

      points.set(d, v);
      if (v !== null) values.push(v);
      allDatesSet.add(d);
      compactPoints.push({ date: d, price: v });
    }

    // Add "today" point ONLY if listing currently exists in this store/dbFile (live rows present)
    if (rowsLive.length) {
      let curMin = null;
      for (const r of rowsLive) {
        const p = parsePriceToNumber(r.price);
        if (p !== null) curMin = curMin === null ? p : Math.min(curMin, p);
      }
      if (curMin !== null) {
        points.set(today, curMin);
        values.push(curMin);
        allDatesSet.add(today);
        compactPoints.push({ date: today, price: curMin });
      }
    }

    saveSeriesCache(sku, dbFile, cacheBust, compactPoints);
    series.push({ label: storeLabel, points, values });
  }

  const labels = [...allDatesSet].sort();
  if (!labels.length) {
    $status.textContent = "No historical points found.";
    return;
  }

  const allVals = [];
  for (const s of series) for (const v of s.values) allVals.push(v);
  const ySug = computeSuggestedY(allVals);

  const datasets = series.map((s) => ({
    label: s.label,
    data: labels.map((d) => (s.points.has(d) ? s.points.get(d) : null)),
    spanGaps: false,
    tension: 0.15,
  }));

  const ctx = $canvas.getContext("2d");
  CHART = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: true },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed?.y;
              if (!Number.isFinite(v)) return `${ctx.dataset.label}: (no data)`;
              return `${ctx.dataset.label}: $${v.toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
        y: { ...ySug, ticks: { callback: (v) => `$${Number(v).toFixed(0)}` } },
      },
    },
  });

  $status.textContent = manifest
    ? isRemovedEverywhere
      ? `History loaded (removed everywhere). Source=prebuilt manifest. Points=${labels.length}.`
      : `History loaded from prebuilt manifest (1+ commit/day) + current run. Points=${labels.length}.`
    : isRemovedEverywhere
    ? `History loaded (removed everywhere). Source=GitHub API fallback. Points=${labels.length}.`
    : `History loaded (GitHub API fallback; 1+ commit/day) + current run. Points=${labels.length}.`;
}
