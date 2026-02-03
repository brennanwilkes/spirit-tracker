import { esc } from "./dom.js";
import {
  fetchJson,
  inferGithubOwnerRepo,
  githubFetchFileAtSha,
  githubListCommits,
} from "./api.js";
import { storeColor, isWhite } from "./storeColors.js";

let _chart = null;

const STORE_LABELS = {
  bcl: "BCL",
  bsw: "BSW",
  coop: "Co-op World of Whisky",
  craftcellars: "Craft Cellars",
  gull: "Gull Liquor",
  kegncork: "Keg N Cork",
  kwm: "Kensington Wine Market",
  legacy: "Legacy Liquor",
  legacyliquor: "Legacy Liquor",
  maltsandgrains: "Malts & Grains",
  sierrasprings: "Sierra Springs",
  strath: "Strath Liquor",
  tudor: "Tudor House",
  vessel: "Vessel Liquor",
  vintage: "Vintage Spirits",
  willowpark: "Willow Park",
};

function displayStoreName(storeKey) {
  const k = String(storeKey || "").toLowerCase();
  return STORE_LABELS[k] || storeKey;
}

export function destroyStatsChart() {
  try {
    if (_chart) _chart.destroy();
  } catch {}
  _chart = null;
}

function ensureChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);

  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    // UMD build -> window.Chart
    s.src =
      "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
    s.async = true;
    s.onload = () => resolve(window.Chart);
    s.onerror = () => reject(new Error("Failed to load Chart.js"));
    document.head.appendChild(s);
  });
}

/* ---------------- helpers ---------------- */

function dateOnly(iso) {
  const m = String(iso ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function medianOfSorted(nums) {
  const n = nums.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function isFinitePos(n) {
  return Number.isFinite(n) && n > 0;
}

function makeLimiter(max) {
  let active = 0;
  const q = [];
  const runNext = () => {
    while (active < max && q.length) {
      active++;
      const { fn, resolve, reject } = q.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          runNext();
        });
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      q.push({ fn, resolve, reject });
      runNext();
    });
}

function tokenizeQuery(q) {
  return String(q || "")
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesAllTokens(haystack, tokens) {
  if (!tokens.length) return true;
  const h = String(haystack || "").toLowerCase();
  for (const t of tokens) {
    if (!h.includes(t)) return false;
  }
  return true;
}

function rowSearchText(r) {
  const rep = r?.representative || {};
  return [
    r?.canonSku,
    rep?.name,
    rep?.skuRaw,
    rep?.skuKey,
    rep?.categoryLabel,
    rep?.storeLabel,
    rep?.storeKey,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
}

// Prefer representative.priceNum; else cheapest.priceNum; else median(storePrices)
function rowPriceNum(r, stores) {
  const rep = r?.representative;
  const ch = r?.cheapest;

  const a = rep && Number.isFinite(rep.priceNum) ? rep.priceNum : null;
  if (a !== null) return a;

  const b = ch && Number.isFinite(ch.priceNum) ? ch.priceNum : null;
  if (b !== null) return b;

  const sp = r && typeof r === "object" ? r.storePrices : null;
  if (!sp || typeof sp !== "object") return null;

  const prices = [];
  for (const s of stores) {
    const p = sp[s];
    if (Number.isFinite(p)) prices.push(p);
  }
  prices.sort((x, y) => x - y);
  const med = medianOfSorted(prices);
  return Number.isFinite(med) ? med : null;
}

/* ---------------- price slider mapping (store-page-ish, but faster low-end) ---------------- */

// faster low-end: coarser step sizes early so you jump past $10/$20 quickly
function stepForPrice(p, boundMax) {
  const x = Number.isFinite(p) ? p : boundMax;
  if (x < 50) return 10;
  if (x < 120) return 25;
  if (x < 250) return 25;
  if (x < 600) return 50;
  return 100;
}
function roundToStep(p, boundMax) {
  const step = stepForPrice(p, boundMax);
  return Math.round(p / step) * step;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function formatDollars(p) {
  if (!Number.isFinite(p)) return "";
  return `$${Math.round(p)}`;
}

/* ---------------- report filtering + series ---------------- */

// avg over SKUs that store has a price for: ((storePrice - medianPrice) / medianPrice) * 100
function computeDailyStoreSeriesFromReport(report, filter) {
  const stores = Array.isArray(filter?.stores)
    ? filter.stores.map(String)
    : Array.isArray(report?.stores)
    ? report.stores.map(String)
    : [];

  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const tokens = Array.isArray(filter?.tokens) ? filter.tokens : [];
  const minP = Number.isFinite(filter?.minPrice) ? filter.minPrice : null;
  const maxP = Number.isFinite(filter?.maxPrice) ? filter.maxPrice : null;

  const sum = new Map();
  const cnt = new Map();
  for (const s of stores) {
    sum.set(s, 0);
    cnt.set(s, 0);
  }

  let usedRows = 0;

  for (const r of rows) {
    if (!r || typeof r !== "object") continue;

    if (tokens.length) {
      if (!matchesAllTokens(rowSearchText(r), tokens)) continue;
    }

    if (minP !== null || maxP !== null) {
      const rp = rowPriceNum(r, stores);
      // "no price" rows pass the filter (they won't contribute anyway)
      if (rp !== null) {
        if (minP !== null && rp < minP) continue;
        if (maxP !== null && rp > maxP) continue;
      }
    }

    const sp = r.storePrices;
    if (!sp || typeof sp !== "object") continue;

    const prices = [];
    for (const s of stores) {
      const p = sp[s];
      if (Number.isFinite(p)) prices.push(p);
    }
    prices.sort((a, b) => a - b);

    const med = medianOfSorted(prices);
    if (!isFinitePos(med)) continue;

    usedRows++;

    for (const s of stores) {
      const p = sp[s];
      if (!Number.isFinite(p)) continue;
      const pct = ((p - med) / med) * 100;
      sum.set(s, (sum.get(s) || 0) + pct);
      cnt.set(s, (cnt.get(s) || 0) + 1);
    }
  }

  const out = {};
  for (const s of stores) {
    const c = cnt.get(s) || 0;
    out[s] = c > 0 ? (sum.get(s) || 0) / c : null;
  }
  return { stores, valuesByStore: out, usedRows, totalRows: rows.length };
}

function relReportPath(group, size) {
  return `reports/common_listings_${group}_top${size}.json`;
}

/* ---------------- commits manifest ---------------- */

let COMMON_COMMITS = null;

async function loadCommonCommitsManifest() {
  if (COMMON_COMMITS) return COMMON_COMMITS;
  try {
    COMMON_COMMITS = await fetchJson("./data/common_listings_commits.json");
    return COMMON_COMMITS;
  } catch {
    COMMON_COMMITS = null;
    return null;
  }
}

// Fallback: GitHub API commits for a path, collapsed to one commit per day (newest that day),
// returned oldest -> newest, same shape as manifest entries.
async function loadCommitsFallback({ owner, repo, branch, relPath }) {
  let apiCommits = await githubListCommits({
    owner,
    repo,
    branch,
    path: relPath,
  });
  apiCommits = Array.isArray(apiCommits) ? apiCommits : [];

  const byDate = new Map();
  for (const c of apiCommits) {
    const sha = String(c?.sha || "");
    const ts = String(
      c?.commit?.committer?.date || c?.commit?.author?.date || ""
    );
    const d = dateOnly(ts);
    if (!sha || !d) continue;
    if (!byDate.has(d)) byDate.set(d, { sha, date: d, ts });
  }

  return [...byDate.values()].reverse();
}

/* ---------------- raw series cache ---------------- */

const RAW_SERIES_CACHE = new Map(); // key: `${group}:${size}` -> { latestSha, labels, stores, commits, reportsByIdx }

async function loadRawSeries({ group, size, onStatus }) {
  const rel = relReportPath(group, size);
  const gh = inferGithubOwnerRepo();
  const owner = gh.owner;
  const repo = gh.repo;
  const branch = "data";

  const manifest = await loadCommonCommitsManifest();

  let commits = Array.isArray(manifest?.files?.[rel])
    ? manifest.files[rel]
    : null;

  if (!commits || !commits.length) {
    if (typeof onStatus === "function")
      onStatus(`Commits manifest missing for ${rel}; using GitHub API fallback…`);
    commits = await loadCommitsFallback({ owner, repo, branch, relPath: rel });
  }

  if (!commits || !commits.length) throw new Error(`No commits tracked for ${rel}`);

  const latest = commits[commits.length - 1];
  const latestSha = String(latest?.sha || "");
  if (!latestSha) throw new Error(`Invalid latest sha for ${rel}`);

  const cacheKey = `${group}:${size}`;
  const cached = RAW_SERIES_CACHE.get(cacheKey);
  if (
    cached &&
    cached.latestSha === latestSha &&
    cached.labels?.length === commits.length
  ) {
    return cached;
  }

  const NET_CONCURRENCY = 10;
  const limitNet = makeLimiter(NET_CONCURRENCY);

  if (typeof onStatus === "function") onStatus(`Loading stores…`);
  const newestReport = await limitNet(() =>
    githubFetchFileAtSha({ owner, repo, sha: latestSha, path: rel })
  );

  const stores = Array.isArray(newestReport?.stores)
    ? newestReport.stores.map(String)
    : [];
  if (!stores.length)
    throw new Error(`No stores found in ${rel} at ${latestSha.slice(0, 7)}`);

  const labels = commits.map((c) => String(c.date || "")).filter(Boolean);
  const shaByIdx = commits.map((c) => String(c.sha || ""));

  if (typeof onStatus === "function")
    onStatus(`Loading ${labels.length} day(s)…`);

  const reportsByIdx = new Array(shaByIdx.length).fill(null);

  let done = 0;
  await Promise.all(
    shaByIdx.map((sha, idx) =>
      limitNet(async () => {
        try {
          reportsByIdx[idx] = await githubFetchFileAtSha({
            owner,
            repo,
            sha,
            path: rel,
          });
        } catch {
          reportsByIdx[idx] = null;
        } finally {
          done++;
          if (
            typeof onStatus === "function" &&
            (done % 10 === 0 || done === shaByIdx.length)
          ) {
            onStatus(`Loading ${labels.length} day(s)… ${done}/${labels.length}`);
          }
        }
      })
    )
  );

  const out = { latestSha, labels, stores, commits, reportsByIdx };
  RAW_SERIES_CACHE.set(cacheKey, out);
  return out;
}

function computePriceBoundsFromReport(report, stores) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  let mn = null;
  let mx = null;

  for (const r of rows) {
    const p = rowPriceNum(r, stores);
    if (!Number.isFinite(p) || p <= 0) continue;
    mn = mn === null ? p : Math.min(mn, p);
    mx = mx === null ? p : Math.max(mx, p);
  }
  return { min: mn, max: mx };
}

function computeSeriesFromRaw(raw, filter) {
  const labels = raw.labels;
  const stores = raw.stores;
  const reportsByIdx = raw.reportsByIdx;

  const seriesByStore = {};
  for (const s of stores) seriesByStore[s] = new Array(labels.length).fill(null);

  let newestUsed = 0;
  let newestTotal = 0;

  for (let i = 0; i < reportsByIdx.length; i++) {
    const rep = reportsByIdx[i];
    if (!rep) continue;

    const daily = computeDailyStoreSeriesFromReport(rep, {
      ...filter,
      stores,
    });

    for (const s of stores) {
      const v = daily.valuesByStore[s];
      seriesByStore[s][i] = Number.isFinite(v) ? v : null;
    }

    if (i === reportsByIdx.length - 1) {
      newestUsed = daily.usedRows;
      newestTotal = daily.totalRows;
    }
  }

  return { labels, stores, seriesByStore, newestUsed, newestTotal };
}

/* ---------------- y-axis bounds ---------------- */

function computeYBounds(seriesByStore, defaultAbs) {
  let mn = Infinity;
  let mx = -Infinity;

  for (const arr of Object.values(seriesByStore || {})) {
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      if (!Number.isFinite(v)) continue;
      mn = Math.min(mn, v);
      mx = Math.max(mx, v);
    }
  }

  if (mn === Infinity) return { min: -defaultAbs, max: defaultAbs };

  const min = Math.min(-defaultAbs, Math.floor(mn));
  const max = Math.max(defaultAbs, Math.ceil(mx));
  return { min, max };
}

/* ---------------- prefs ---------------- */

const LS_GROUP = "stviz:v1:stats:group";
const LS_SIZE = "stviz:v1:stats:size";

const LS_Q = "stviz:v1:stats:q";
function lsMinKey(group, size) {
  return `stviz:v1:stats:minPrice:${group}:${size}`;
}
function lsMaxKey(group, size) {
  return `stviz:v1:stats:maxPrice:${group}:${size}`;
}

function loadPrefs() {
  let group = "all";
  let size = "250";
  try {
    group = String(localStorage.getItem(LS_GROUP) || "all");
    size = String(localStorage.getItem(LS_SIZE) || "250");
  } catch {}
  group = group === "bc" || group === "ab" || group === "all" ? group : "all";
  size = size === "50" || size === "250" || size === "1000" ? size : "250";
  return { group, size: Number(size) };
}

function savePrefs(group, size) {
  try {
    localStorage.setItem(LS_GROUP, String(group));
    localStorage.setItem(LS_SIZE, String(size));
  } catch {}
}

/* ---------------- render ---------------- */

export async function renderStats($app) {
  destroyStatsChart();

  const pref = loadPrefs();

  $app.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="headerRow1">
          <div class="statsHeaderLeft">
            <button id="back" class="btn">← Back</button>
            <div class="statsTitleStack">
              <h1 class="h1">Store Price Index</h1>
              <div class="small" id="statsStatus">Loading…</div>
            </div>
          </div>

          <div class="headerRight">
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:flex-end;">
              <label class="small" style="display:flex; gap:8px; align-items:center;">
                Stores
                <select id="statsGroup" class="selectSmall" aria-label="Store group">
                  <option value="all">All Stores</option>
                  <option value="bc">BC Only</option>
                  <option value="ab">Alberta Only</option>
                </select>
              </label>

              <label class="small" style="display:flex; gap:8px; align-items:center;">
                Index Size
                <select id="statsSize" class="selectSmall" aria-label="Index size">
                  <option value="50">50</option>
                  <option value="250">250</option>
                  <option value="1000">1000</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div class="headerRow2">
          <div class="card" style="padding:12px;">
            <div style="display:flex; flex-direction:column; gap:10px;">
              <div style="display:flex; gap:10px; align-items:center; width:100%;">
                <input id="statsQ" class="input" placeholder="Filter SKUs (name, sku, category…)" autocomplete="off" style="flex: 1 1 auto;" />
                <button id="statsClear" class="btn btnSm" type="button" style="flex: 0 0 auto;">Clear</button>
              </div>

              <div id="statsPriceWrap" style="display:flex; align-items:center; gap:10px; width:100%;">
                <div class="small" style="white-space:nowrap; opacity:.75;">Price</div>

                <div class="rangeDual" aria-label="Price range">
                  <div class="rangeTrack"></div>
                  <div class="rangeFill" id="statsRangeFill"></div>
                  <input id="statsMinPrice" type="range" min="0" max="1000" step="1" value="0" />
                  <input id="statsMaxPrice" type="range" min="0" max="1000" step="1" value="1000" />
                </div>

                <div class="badge mono" id="statsPriceLabel" style="width: 160px; text-align:right; white-space:nowrap; opacity:.9; flex: 0 0 auto;"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div style="height:420px;">
          <canvas id="statsChart" aria-label="Statistics chart" role="img"></canvas>
        </div>
      </div>
    </div>
  `;

  const $status = document.getElementById("statsStatus");
  const $group = document.getElementById("statsGroup");
  const $size = document.getElementById("statsSize");

  const $q = document.getElementById("statsQ");
  const $clear = document.getElementById("statsClear");

  const $minR = document.getElementById("statsMinPrice");
  const $maxR = document.getElementById("statsMaxPrice");
  const $fill = document.getElementById("statsRangeFill");
  const $priceLabel = document.getElementById("statsPriceLabel");
  const $priceWrap = document.getElementById("statsPriceWrap");

  if ($group) $group.value = pref.group;
  if ($size) $size.value = String(pref.size);

  const onStatus = (msg) => {
    if ($status) $status.textContent = String(msg || "");
  };

  document.getElementById("back")?.addEventListener("click", () => {
    location.hash = "#/";
  });

  // allow 0 as the floor
  let boundMin = 0;
  let boundMax = 1000;

  let selectedMinPrice = boundMin;
  let selectedMaxPrice = boundMax;

  // faster early ramp: use sqrt easing so early motion moves faster up the range
  function priceFromT(t) {
    t = clamp(t, 0, 1);
    if (boundMax <= boundMin) return boundMin;
    // sqrt easing (fast early)
    const te = Math.sqrt(t);
    return boundMin + (boundMax - boundMin) * te;
  }

  function tFromPrice(price) {
    if (!Number.isFinite(price)) return 1;
    if (boundMax <= boundMin) return 1;
    const p = clamp(price, boundMin, boundMax);
    const lin = (p - boundMin) / (boundMax - boundMin);
    // inverse of sqrt easing
    return lin * lin;
  }

  function clampAndRound(p) {
    const c = clamp(p, boundMin, boundMax);
    const r = roundToStep(c, boundMax);
    return clamp(r, boundMin, boundMax);
  }

  function setSliderFromPrice($el, price) {
    const t = tFromPrice(price);
    $el.value = String(Math.round(t * 1000));
  }

  function priceFromSlider($el) {
    const v = Number($el.value);
    const t = Number.isFinite(v) ? v / 1000 : 1;
    return priceFromT(t);
  }

  function updateRangeZ() {
    const a = Number($minR.value);
    const b = Number($maxR.value);
    if (a >= b - 10) {
      $minR.style.zIndex = "5";
      $maxR.style.zIndex = "4";
    } else {
      $minR.style.zIndex = "4";
      $maxR.style.zIndex = "5";
    }
  }

  function updateRangeFill() {
    if (!$fill) return;
    const a = Number($minR.value) || 0;
    const b = Number($maxR.value) || 1000;
    const lo = Math.min(a, b) / 1000;
    const hi = Math.max(a, b) / 1000;
    $fill.style.left = `${(lo * 100).toFixed(2)}%`;
    $fill.style.right = `${((1 - hi) * 100).toFixed(2)}%`;
  }

  function updatePriceLabel() {
    if (!$priceLabel) return;
    $priceLabel.textContent = `${formatDollars(selectedMinPrice)} – ${formatDollars(
      selectedMaxPrice
    )}`;
  }

  function saveFilterPrefs(group, size) {
    try {
      localStorage.setItem(LS_Q, String($q?.value || ""));
      localStorage.setItem(lsMinKey(group, size), String(selectedMinPrice));
      localStorage.setItem(lsMaxKey(group, size), String(selectedMaxPrice));
    } catch {}
  }

  function loadFilterPrefs(group, size) {
    let q = "";
    let minP = null;
    let maxP = null;

    try {
      q = String(localStorage.getItem(LS_Q) || "");
      const a = localStorage.getItem(lsMinKey(group, size));
      const b = localStorage.getItem(lsMaxKey(group, size));
      minP = a !== null ? Number(a) : null;
      maxP = b !== null ? Number(b) : null;
      if (!Number.isFinite(minP)) minP = null;
      if (!Number.isFinite(maxP)) maxP = null;
    } catch {}

    return { q, minP, maxP };
  }

  async function drawOrUpdateChart(series, yBounds) {
    const { labels, stores, seriesByStore } = series;

    const Chart = await ensureChartJs();
    const canvas = document.getElementById("statsChart");
    if (!canvas) return;

    const datasets = stores.map((s) => {
        const c = storeColor(s); // store key
      
        return {
          label: displayStoreName(s),
          data: Array.isArray(seriesByStore[s]) ? seriesByStore[s] : labels.map(() => null),
          spanGaps: false,
          tension: 0.15,
      
          borderColor: c,
          backgroundColor: c,
          pointBackgroundColor: c,
          pointBorderColor: c,
          borderWidth: isWhite(c) ? 2 : 1.5,
        };
      });
      

    if (_chart) {
      _chart.data.labels = labels;
      _chart.data.datasets = datasets;
      if (yBounds) {
        _chart.options.scales.y.min = yBounds.min;
        _chart.options.scales.y.max = yBounds.max;
      }
      _chart.update("none");
      return;
    }

    const ctx = canvas.getContext("2d");
    _chart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: {
              label: (ctx2) => {
                const v = ctx2.parsed?.y;
                if (!Number.isFinite(v)) return `${ctx2.dataset.label}: (no data)`;
                return `${ctx2.dataset.label}: ${v.toFixed(2)}%`;
              },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: "Date" },
            ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          },
          y: {
            min: yBounds?.min,
            max: yBounds?.max,
            title: { display: true, text: "Avg % vs per-SKU median" },
            ticks: {
              callback: (v) => `${Number(v).toFixed(0)}%`,
              maxTicksLimit: 12,
            },
          },
        },
      },
    });
  }

  let raw = null;
  let applyTimer = null;

  async function rerender() {
    destroyStatsChart();

    const group = String($group?.value || "all");
    const size = Number($size?.value || 250);
    savePrefs(group, size);

    try {
      onStatus("Loading…");
      raw = await loadRawSeries({ group, size, onStatus });

      const newestReport = raw.reportsByIdx[raw.reportsByIdx.length - 1];
      const b = computePriceBoundsFromReport(newestReport, raw.stores);

      // floor is ALWAYS 0 now
      boundMin = 0;
      boundMax =
        Number.isFinite(b.max) && b.max > 0 ? Math.ceil(b.max) : 1000;

      const saved = loadFilterPrefs(group, size);
      if ($q) $q.value = saved.q || "";

      if (!Number.isFinite(b.max)) {
        $minR.disabled = true;
        $maxR.disabled = true;
        $priceWrap.title = "No priced items in this dataset.";
        selectedMinPrice = boundMin;
        selectedMaxPrice = boundMax;
      } else {
        $minR.disabled = false;
        $maxR.disabled = false;
        $priceWrap.title = "";

        const wantMin = saved.minP !== null ? saved.minP : boundMin;
        const wantMax = saved.maxP !== null ? saved.maxP : boundMax;

        selectedMinPrice = clampAndRound(wantMin);
        selectedMaxPrice = clampAndRound(wantMax);

        if (selectedMinPrice > selectedMaxPrice)
          selectedMinPrice = selectedMaxPrice;
      }

      setSliderFromPrice($minR, selectedMinPrice);
      setSliderFromPrice($maxR, selectedMaxPrice);
      updateRangeZ();
      updateRangeFill();
      updatePriceLabel();

      const tokens = tokenizeQuery($q?.value || "");
      const series = computeSeriesFromRaw(raw, {
        tokens,
        minPrice: selectedMinPrice,
        maxPrice: selectedMaxPrice,
      });

      const abs = group === "all" ? 12 : 8;
      const yBounds = computeYBounds(series.seriesByStore, abs);

      await drawOrUpdateChart(series, yBounds);

      const short = `Loaded ${series.labels.length} day(s). Filtered SKUs: ${series.newestUsed}/${series.newestTotal}.`;
      onStatus(short);
      if ($status) {
        $status.title = `Source: ${relReportPath(group, size)} @ ${raw.latestSha.slice(0, 7)}`;
      }

      saveFilterPrefs(group, size);
    } catch (e) {
      const msg = esc(e?.message || String(e));
      onStatus(`Error: ${msg}`);
      const card = $app.querySelector(".card");
      if (card) card.innerHTML = `<div class="small">Chart unavailable: ${msg}</div>`;
    }
  }

  function applyFiltersDebounced(ms) {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(async () => {
      if (!raw) return;

      const group = String($group?.value || "all");
      const size = Number($size?.value || 250);

      const tokens = tokenizeQuery($q?.value || "");

      const series = computeSeriesFromRaw(raw, {
        tokens,
        minPrice: selectedMinPrice,
        maxPrice: selectedMaxPrice,
      });

      const abs = group === "all" ? 12 : 8;
      const yBounds = computeYBounds(series.seriesByStore, abs);

      await drawOrUpdateChart(series, yBounds);

      const short = `Loaded ${series.labels.length} day(s). Filtered SKUs: ${series.newestUsed}/${series.newestTotal}.`;
      onStatus(short);
      if ($status) {
        $status.title = `Source: ${relReportPath(group, size)} @ ${raw.latestSha.slice(0, 7)}`;
      }

      saveFilterPrefs(group, size);
    }, ms);
  }

  function setSelectedRangeFromSliders(which) {
    if ($minR.disabled || $maxR.disabled) return;

    const rawMin = priceFromSlider($minR);
    const rawMax = priceFromSlider($maxR);

    let nextMin = clampAndRound(rawMin);
    let nextMax = clampAndRound(rawMax);

    if (nextMin > nextMax) {
      if (which === "min") nextMax = nextMin;
      else nextMin = nextMax;
    }

    selectedMinPrice = nextMin;
    selectedMaxPrice = nextMax;

    setSliderFromPrice($minR, selectedMinPrice);
    setSliderFromPrice($maxR, selectedMaxPrice);
    updateRangeZ();
    updateRangeFill();
    updatePriceLabel();
  }

  await rerender();

  $group?.addEventListener("change", async () => {
    onStatus("Loading…");
    await rerender();
  });
  $size?.addEventListener("change", async () => {
    onStatus("Loading…");
    await rerender();
  });

  let tq = null;
  $q?.addEventListener("input", () => {
    if (tq) clearTimeout(tq);
    tq = setTimeout(() => applyFiltersDebounced(0), 60);
  });

  let tp = null;
  $minR?.addEventListener("input", () => {
    setSelectedRangeFromSliders("min");
    if (tp) clearTimeout(tp);
    tp = setTimeout(() => applyFiltersDebounced(0), 40);
  });
  $maxR?.addEventListener("input", () => {
    setSelectedRangeFromSliders("max");
    if (tp) clearTimeout(tp);
    tp = setTimeout(() => applyFiltersDebounced(0), 40);
  });

  $minR?.addEventListener("change", () => {
    setSelectedRangeFromSliders("min");
    applyFiltersDebounced(0);
  });
  $maxR?.addEventListener("change", () => {
    setSelectedRangeFromSliders("max");
    applyFiltersDebounced(0);
  });

  $clear?.addEventListener("click", () => {
    if ($q) $q.value = "";

    selectedMinPrice = boundMin;
    selectedMaxPrice = boundMax;

    setSliderFromPrice($minR, selectedMinPrice);
    setSliderFromPrice($maxR, selectedMaxPrice);
    updateRangeZ();
    updateRangeFill();
    updatePriceLabel();

    applyFiltersDebounced(0);
    $q?.focus();
  });

  updateRangeZ();
  updateRangeFill();
}
