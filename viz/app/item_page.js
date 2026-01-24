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

function findMinPriceForSkuGroupInDb(obj, skuKeys, storeLabel) {
  const items = Array.isArray(obj?.items) ? obj.items : [];
  let best = null;

  // Build quick lookup for real sku entries (cheap)
  const want = new Set();
  for (const s of skuKeys) {
    const x = String(s || "").trim();
    if (x) want.add(x);
  }

  for (const it of items) {
    if (!it || it.removed) continue;

    const real = String(it.sku || "").trim();
    if (real && want.has(real)) {
      const p = parsePriceToNumber(it.price);
      if (p !== null) best = best === null ? p : Math.min(best, p);
      continue;
    }

    // synthetic match (only relevant if a caller passes u: keys)
    if (!real) {
      // if any skuKey is synthetic, match by hashing storeLabel|url
      for (const skuKey of skuKeys) {
        const k = String(skuKey || "");
        if (!k.startsWith("u:")) continue;
        const row = { sku: "", url: String(it.url || ""), storeLabel: storeLabel || "", store: "" };
        const kk = keySkuForRow(row);
        if (kk === k) {
          const p = parsePriceToNumber(it.price);
          if (p !== null) best = best === null ? p : Math.min(best, p);
        }
      }
    }
  }

  return best;
}

function computeSuggestedY(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return { suggestedMin: undefined, suggestedMax: undefined };

  let min = nums[0], max = nums[0];
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  if (min === max) return { suggestedMin: min * 0.95, suggestedMax: max * 1.05 };

  const pad = (max - min) * 0.08;
  return { suggestedMin: Math.max(0, min - pad), suggestedMax: max + pad };
}

// Collapse commit list down to 1 commit per day (keep most recent commit for that day)
function collapseCommitsToDaily(commits) {
  const byDate = new Map();
  for (const c of commits) {
    const d = String(c?.date || "");
    const sha = String(c?.sha || "");
    if (!d || !sha) continue;
    byDate.set(d, { sha, date: d, ts: String(c?.ts || "") });
  }
  return [...byDate.values()];
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

  // IMPORTANT CHANGE:
  // index.json now includes removed rows too. Split live vs all.
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
  // - LIVE stores first (normal)
  // - then removed-history stores with a "(removed)" suffix
  const seenLinks = new Set();
  const linkRows = allRows
    .slice()
    .sort((a, b) => {
      const ar = Boolean(a?.removed) ? 1 : 0;
      const br = Boolean(b?.removed) ? 1 : 0;
      if (ar !== br) return ar - br; // live first
      return String(a.storeLabel || "").localeCompare(String(b.storeLabel || ""));
    })
    .filter((r) => {
      const href = String(r?.url || "").trim();
      const text = String(r?.storeLabel || r?.store || "Store").trim();
      if (!href) return false;
      const suffix = Boolean(r?.removed) ? " (removed)" : "";
      const key = `${href}|${text}${suffix}`;
      if (seenLinks.has(key)) return false;
      seenLinks.add(key);
      return true;
    });

  $links.innerHTML = linkRows
    .map((r) => {
      const href = String(r.url || "").trim();
      const text = String(r.storeLabel || r.store || "Store").trim();
      const suffix = Boolean(r?.removed) ? " (removed)" : "";
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text + suffix)}</a>`;
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
    // (we don't want to add a "today" point if the listing is removed in this store now)
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

    commits = collapseCommitsToDaily(commits);

    const points = new Map();
    const values = [];
    const compactPoints = [];

    const MAX_POINTS = 260;
    if (commits.length > MAX_POINTS) commits = commits.slice(commits.length - MAX_POINTS);

    for (const c of commits) {
      const sha = String(c.sha || "");
      const d = String(c.date || "");
      if (!sha || !d) continue;

      const ck = `${sha}|${dbFile}`;
      let obj = fileJsonCache.get(ck) || null;
      if (!obj) {
        try {
          obj = await githubFetchFileAtSha({ owner, repo, sha, path: dbFile });
          fileJsonCache.set(ck, obj);
        } catch {
          continue;
        }
      }

      // findMinPriceForSkuGroupInDb already ignores removed rows inside each DB snapshot.
      const pNum = findMinPriceForSkuGroupInDb(obj, skuKeys, storeLabel);

      points.set(d, pNum);
      if (pNum !== null) values.push(pNum);
      allDatesSet.add(d);
      compactPoints.push({ date: d, price: pNum });
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
    ? (isRemovedEverywhere
        ? `History loaded (removed everywhere). Source=prebuilt manifest. Points=${labels.length}.`
        : `History loaded from prebuilt manifest (1 point/day) + current run. Points=${labels.length}.`)
    : (isRemovedEverywhere
        ? `History loaded (removed everywhere). Source=GitHub API fallback. Points=${labels.length}.`
        : `History loaded (GitHub API fallback; 1 point/day) + current run. Points=${labels.length}.`);
}
