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

/* ---------------- Small async helpers ---------------- */

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const n = Math.max(1, Math.floor(limit || 1));
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= list.length) return;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- History helpers ---------------- */

// Precompute synthetic keys for any "u:" skuKeys, so we don’t rebuild rows each call.
function precomputeSyntheticKeys(skuKeys, storeLabel) {
  const res = [];
  for (const skuKey of skuKeys) {
    const k = String(skuKey || "");
    if (!k.startsWith("u:")) continue;
    // Mirror the original matching logic exactly.
    const row = { sku: "", url: "", storeLabel: storeLabel || "", store: "" };
    res.push({ k, storeLabel: storeLabel || "" });
    // Note: url is per item, so we still need to compute keySkuForRow per item.url.
    // We keep the list of keys to try; we’ll compute with item.url cheaply.
  }
  return res;
}

// Returns BOTH mins, so we can show a dot on removal day using removed price.
// Optimized: pass in prebuilt "want" Set for real skus + synthetic u: keys list.
function findMinPricesForSkuGroupInDb(obj, wantRealSkus, skuKeys, storeLabel, uKeys) {
  const items = Array.isArray(obj?.items) ? obj.items : [];
  let liveMin = null;
  let removedMin = null;

  const consider = (isRemoved, priceVal) => {
    const p = parsePriceToNumber(priceVal);
    if (p === null) return;
    if (!isRemoved) liveMin = liveMin === null ? p : Math.min(liveMin, p);
    else removedMin = removedMin === null ? p : Math.min(removedMin, p);
  };

  for (const it of items) {
    if (!it) continue;

    const isRemoved = Boolean(it.removed);
    const real = String(it.sku || "").trim();
    if (real && wantRealSkus.has(real)) {
      consider(isRemoved, it.price);
      continue;
    }

    // synthetic match (only relevant if a caller passes u: keys)
    if (!real && uKeys && uKeys.length) {
      const url = String(it.url || "");
      // We must preserve original behavior: recompute keySkuForRow for each u: key
      // because it embeds storeLabel and url. storeLabel is fixed per dbFile.
      for (const skuKey of skuKeys) {
        const k = String(skuKey || "");
        if (!k.startsWith("u:")) continue;
        const row = { sku: "", url, storeLabel: storeLabel || "", store: "" };
        const kk = keySkuForRow(row);
        if (kk === k) {
          consider(isRemoved, it.price);
          break;
        }
      }
    }
  }

  return { liveMin, removedMin };
}

function computeSuggestedY(values, minRange) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return { suggestedMin: undefined, suggestedMax: undefined };

  let min = nums[0],
    max = nums[0];
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
  }

  const range = max - min;
  const pad = range === 0 ? Math.max(1, min * 0.05) : range * 0.08;

  let suggestedMin = Math.max(0, min - pad);
  let suggestedMax = max + pad;

  if (Number.isFinite(minRange) && minRange > 0) {
    const span = suggestedMax - suggestedMin;
    if (span < minRange) {
      const mid = (suggestedMin + suggestedMax) / 2;
      suggestedMin = mid - minRange / 2;
      suggestedMax = mid + minRange / 2;
      if (suggestedMin < 0) {
        suggestedMax -= suggestedMin;
        suggestedMin = 0;
      }
    }
  }

  return { suggestedMin, suggestedMax };
}

function cacheKeySeries(sku, dbFile, cacheBust) {
  return `stviz:v4:series:${cacheBust}:${sku}:${dbFile}`;
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

function niceStepAtLeast(minStep, span, maxTicks) {
  if (!Number.isFinite(span) || span <= 0) return minStep;

  const target = span / Math.max(1, maxTicks - 1); // desired step to stay under maxTicks
  const raw = Math.max(minStep, target);

  // "nice" steps: 1/2/5 * 10^k, but never below minStep
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const niceM = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return Math.max(minStep, niceM * pow);
}

function cacheBustForDbFile(manifest, dbFile, commits) {
  const arr = manifest?.files?.[dbFile];
  if (Array.isArray(arr) && arr.length) {
    const last = arr[arr.length - 1];
    const sha = String(last?.sha || "");
    if (sha) return sha;
  }
  if (Array.isArray(commits) && commits.length) {
    const sha = String(commits[commits.length - 1]?.sha || "");
    if (sha) return sha;
  }
  return "no-sha";
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
  const fileJsonCache = new Map(); // shared across stores: (sha|path) -> parsed JSON

  const today = dateOnly(idx.generatedAt || new Date().toISOString());

  const skuKeys = [...skuGroup];
  const wantRealSkus = new Set(
    skuKeys
      .map((s) => String(s || "").trim())
      .filter((x) => x)
  );

  const MAX_POINTS = 260;
  const CONCURRENCY = Math.min(6, Math.max(2, (navigator?.hardwareConcurrency || 4) - 2));

  async function processDbFile(dbFile) {
    const rowsAll = byDbFileAll.get(dbFile) || [];
    const rowsLive = rowsAll.filter((r) => !Boolean(r?.removed));
    const storeLabel = String(rowsAll[0]?.storeLabel || rowsAll[0]?.store || dbFile);

    const uKeys = precomputeSyntheticKeys(skuKeys, storeLabel);

    // Build commits list (prefer manifest)
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

    // Chronological sort (handles either manifest or API fallback)
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

    const cacheBust = cacheBustForDbFile(manifest, dbFile, commits);
    const cached = loadSeriesCache(sku, dbFile, cacheBust);
    if (cached && Array.isArray(cached.points) && cached.points.length) {
      const points = new Map();
      const values = [];
      const dates = [];
      for (const p of cached.points) {
        const d = String(p.date || "");
        const v = p.price === null ? null : Number(p.price);
        if (!d) continue;
        const vv = Number.isFinite(v) ? v : null;
        points.set(d, vv);
        if (vv !== null) values.push(vv);
        dates.push(d);
      }
      return { label: storeLabel, points, values, dates };
    }

    // Group commits by day (keep ALL commits per day; needed for add+remove same day)
    const byDay = new Map(); // date -> commits[]
    for (const c of commits) {
      const d = String(c?.date || "");
      if (!d) continue;
      let arr = byDay.get(d);
      if (!arr) byDay.set(d, (arr = []));
      arr.push(c);
    }

    function commitMs(c) {
      const d = String(c?.date || "");
      const t = Date.parse(String(c?.ts || ""));
      if (Number.isFinite(t)) return t;
      return d ? Date.parse(d + "T00:00:00Z") || 0 : 0;
    }

    let dayEntries = Array.from(byDay.entries())
      .map(([date, arr]) => ({ date, commits: arr.slice().sort((a, b) => commitMs(a) - commitMs(b)) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    if (dayEntries.length > MAX_POINTS) dayEntries = dayEntries.slice(dayEntries.length - MAX_POINTS);

    const points = new Map();
    const values = [];
    const compactPoints = [];
    const dates = [];

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
      const dayCommits = Array.isArray(day.commits) ? day.commits : [];
      if (!d || !dayCommits.length) continue;

      const last = dayCommits[dayCommits.length - 1];
      const lastSha = String(last?.sha || "");
      if (!lastSha) continue;

      let objLast;
      try {
        objLast = await loadAtSha(lastSha);
      } catch {
        continue;
      }

      const lastMin = findMinPricesForSkuGroupInDb(objLast, wantRealSkus, skuKeys, storeLabel, uKeys);
      const lastLive = lastMin.liveMin;
      const lastRemoved = lastMin.removedMin;

      // end-of-day removed state: no live but removed exists
      const endIsRemoved = lastLive === null && lastRemoved !== null;

      // If end-of-day is removed, find the LAST live price earlier the same day
      let sameDayLastLive = null;
      if (endIsRemoved && dayCommits.length > 1) {
        // fast reject: if earliest commit already has no live, no need to scan
        const firstSha = String(dayCommits[0]?.sha || "");
        if (firstSha) {
          try {
            const objFirst = await loadAtSha(firstSha);
            const firstMin = findMinPricesForSkuGroupInDb(objFirst, wantRealSkus, skuKeys, storeLabel, uKeys);
            if (firstMin.liveMin !== null) {
              for (let i = dayCommits.length - 2; i >= 0; i--) {
                const sha = String(dayCommits[i]?.sha || "");
                if (!sha) continue;
                try {
                  const obj = await loadAtSha(sha);
                  const m = findMinPricesForSkuGroupInDb(obj, wantRealSkus, skuKeys, storeLabel, uKeys);
                  if (m.liveMin !== null) {
                    sameDayLastLive = m.liveMin;
                    break;
                  }
                } catch {}
              }
            }
          } catch {}
        }
      }

      let v = null;

      if (lastLive !== null) {
        // live at end-of-day
        v = lastLive;
        removedStreak = false;
        prevLive = lastLive;
      } else if (endIsRemoved) {
        // first removed day => show dot (prefer removed price; else last live earlier that day; else prev live)
        if (!removedStreak) {
          v = lastRemoved !== null ? lastRemoved : sameDayLastLive !== null ? sameDayLastLive : prevLive;
          removedStreak = true;
        } else {
          v = null; // days AFTER removal: no dot
        }
      } else {
        v = null;
      }

      points.set(d, v);
      if (v !== null) values.push(v);
      compactPoints.push({ date: d, price: v });
      dates.push(d);
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
        compactPoints.push({ date: today, price: curMin });
        dates.push(today);
      }
    }

    saveSeriesCache(sku, dbFile, cacheBust, compactPoints);
    return { label: storeLabel, points, values, dates };
  }

  // Process stores concurrently (big win vs sequential)
  const results = await mapLimit(dbFiles, CONCURRENCY, async (dbFile) => {
    try {
      return await processDbFile(dbFile);
    } catch {
      return null;
    }
  });

  const allDatesSet = new Set();
  const series = [];
  for (const r of results) {
    if (!r) continue;
    series.push({ label: r.label, points: r.points, values: r.values });
    for (const d of r.dates) allDatesSet.add(d);
  }

  const labels = [...allDatesSet].sort();
  if (!labels.length || !series.length) {
    $status.textContent = "No historical points found.";
    return;
  }

  const allVals = [];
  for (const s of series) for (const v of s.values) allVals.push(v);

  const ySug = computeSuggestedY(allVals);

  const MIN_STEP = 10; // never denser than $10
  const MAX_TICKS = 12; // cap tick count when span is huge

  const span = (ySug.suggestedMax ?? 0) - (ySug.suggestedMin ?? 0);
  const step = niceStepAtLeast(MIN_STEP, span, MAX_TICKS);

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
        y: {
          ...ySug,
          ticks: {
            stepSize: step,
            maxTicksLimit: MAX_TICKS,
            callback: (v) => `$${Number(v).toFixed(0)}`,
          },
        },
      },
    },
  });

  const yScale = CHART.scales?.y;
  const tickCount = yScale?.ticks?.length || 0;

  if (tickCount >= 2) {
    const minRange = (tickCount - 1) * 10; // $10 per gap, same number of gaps as before
    const ySug2 = computeSuggestedY(allVals, minRange);

    CHART.options.scales.y.suggestedMin = ySug2.suggestedMin;
    CHART.options.scales.y.suggestedMax = ySug2.suggestedMax;
    CHART.options.scales.y.ticks.stepSize = 10; // lock spacing at $10 now

    CHART.update();
  }

  $status.textContent = manifest
    ? isRemovedEverywhere
      ? `History loaded (removed everywhere). Source=prebuilt manifest. Points=${labels.length}.`
      : `History loaded from prebuilt manifest (multi-commit/day) + current run. Points=${labels.length}.`
    : isRemovedEverywhere
    ? `History loaded (removed everywhere). Source=GitHub API fallback. Points=${labels.length}.`
    : `History loaded (GitHub API fallback; multi-commit/day) + current run. Points=${labels.length}.`;
}
