import { esc } from "./dom.js";
import { fetchJson, inferGithubOwnerRepo, githubFetchFileAtSha } from "./api.js";

let _chart = null;

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
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
    s.async = true;
    s.onload = () => resolve(window.Chart);
    s.onerror = () => reject(new Error("Failed to load Chart.js"));
    document.head.appendChild(s);
  });
}

/* ---------------- small helpers ---------------- */

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

function statsCacheKey(group, size, latestSha) {
  return `stviz:v1:stats:common:${group}:${size}:${latestSha}`;
}

function loadStatsCache(group, size, latestSha) {
  try {
    const raw = localStorage.getItem(statsCacheKey(group, size, latestSha));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.labels) || !Array.isArray(obj.stores) || typeof obj.seriesByStore !== "object") return null;
    const savedAt = Number(obj.savedAt || 0);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > 7 * 24 * 3600 * 1000) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveStatsCache(group, size, latestSha, payload) {
  try {
    localStorage.setItem(
      statsCacheKey(group, size, latestSha),
      JSON.stringify({ savedAt: Date.now(), ...payload })
    );
  } catch {}
}

/* ---------------- data loading ---------------- */

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

function relReportPath(group, size) {
  return `reports/common_listings_${group}_top${size}.json`;
}

// Computes per-store daily metric:
// avg over SKUs that store has a price for: ((storePrice - medianPrice) / medianPrice) * 100
function computeDailyStoreSeriesFromReport(report) {
  const stores = Array.isArray(report?.stores) ? report.stores.map(String) : [];
  const rows = Array.isArray(report?.rows) ? report.rows : [];

  const sum = new Map(); // store -> sumPct
  const cnt = new Map(); // store -> count

  for (const s of stores) {
    sum.set(s, 0);
    cnt.set(s, 0);
  }

  for (const r of rows) {
    const sp = r && typeof r === "object" ? r.storePrices : null;
    if (!sp || typeof sp !== "object") continue;

    const prices = [];
    for (const s of stores) {
      const p = sp[s];
      if (Number.isFinite(p)) prices.push(p);
    }
    prices.sort((a, b) => a - b);

    const med = medianOfSorted(prices);
    if (!isFinitePos(med)) continue;

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
  return { stores, valuesByStore: out };
}

async function buildStatsSeries({ group, size, onStatus }) {
  const manifest = await loadCommonCommitsManifest();
  if (!manifest?.files) throw new Error("Missing common_listings_commits.json (viz/data)");

  const rel = relReportPath(group, size);
  const commits = Array.isArray(manifest.files[rel]) ? manifest.files[rel] : null;
  if (!commits || !commits.length) throw new Error(`No commits tracked for ${rel}`);

  // commits are oldest -> newest in the manifest
  const latest = commits[commits.length - 1];
  const latestSha = String(latest?.sha || "");
  if (!latestSha) throw new Error(`Invalid latest sha for ${rel}`);

  const cached = loadStatsCache(group, size, latestSha);
  if (cached) return { latestSha, labels: cached.labels, stores: cached.stores, seriesByStore: cached.seriesByStore };

  const gh = inferGithubOwnerRepo();
  const owner = gh.owner;
  const repo = gh.repo;

  const NET_CONCURRENCY = 10;
  const limitNet = makeLimiter(NET_CONCURRENCY);

  // Fetch newest report once to get the store list (authoritative for the selected file)
  if (typeof onStatus === "function") onStatus(`Loading stores…`);
  const newestReport = await limitNet(() =>
    githubFetchFileAtSha({ owner, repo, sha: latestSha, path: rel })
  );

  const stores = Array.isArray(newestReport?.stores) ? newestReport.stores.map(String) : [];
  if (!stores.length) throw new Error(`No stores found in ${rel} at ${latestSha.slice(0, 7)}`);

  const labels = commits.map((c) => String(c.date || "")).filter(Boolean);

  const seriesByStore = {};
  for (const s of stores) seriesByStore[s] = new Array(labels.length).fill(null);

  // Load each day's report and compute that day’s per-store average % vs median
  if (typeof onStatus === "function") onStatus(`Loading ${labels.length} day(s)…`);

  // De-dupe by sha (just in case)
  const shaByIdx = commits.map((c) => String(c.sha || ""));
  const fileJsonCache = new Map(); // sha -> report json

  async function loadReportAtSha(sha) {
    if (fileJsonCache.has(sha)) return fileJsonCache.get(sha);
    const obj = await githubFetchFileAtSha({ owner, repo, sha, path: rel });
    fileJsonCache.set(sha, obj);
    return obj;
  }

  // Batch fetch + compute with limited concurrency
  let done = 0;
  await Promise.all(
    shaByIdx.map((sha, idx) =>
      limitNet(async () => {
        try {
          const report = await loadReportAtSha(sha);
          const { valuesByStore } = computeDailyStoreSeriesFromReport(report);

          for (const s of stores) {
            const v = valuesByStore[s];
            seriesByStore[s][idx] = Number.isFinite(v) ? v : null;
          }
        } catch {
          // leave nulls for this day
        } finally {
          done++;
          if (typeof onStatus === "function" && (done % 10 === 0 || done === shaByIdx.length)) {
            onStatus(`Loading ${labels.length} day(s)… ${done}/${labels.length}`);
          }
        }
      })
    )
  );

  saveStatsCache(group, size, latestSha, { labels, stores, seriesByStore });
  return { latestSha, labels, stores, seriesByStore };
}

/* ---------------- render ---------------- */

const LS_GROUP = "stviz:v1:stats:group";
const LS_SIZE = "stviz:v1:stats:size";

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

export async function renderStats($app) {
  destroyStatsChart();

  const pref = loadPrefs();

  $app.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="headerRow1">
          <div class="headerLeft">
            <button id="back" class="btn">← Back</button>
            <h1 class="h1">Store Price Index</h1>
            <div class="small" id="statsStatus">Loading…</div>
          </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
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

  if ($group) $group.value = pref.group;
  if ($size) $size.value = String(pref.size);

  const onStatus = (msg) => {
    if ($status) $status.textContent = String(msg || "");
  };

  document.getElementById("back")?.addEventListener("click", () => {
    const last = sessionStorage.getItem("viz:lastRoute");
    if (last && last !== location.hash) location.hash = last;
    else location.hash = "#/";
  });

  const rerender = async () => {
    destroyStatsChart();

    const group = String($group?.value || "all");
    const size = Number($size?.value || 250);
    savePrefs(group, size);

    try {
      onStatus("Loading chart…");
      const Chart = await ensureChartJs();
      const canvas = document.getElementById("statsChart");
      if (!canvas) return;

      const { labels, stores, seriesByStore, latestSha } = await buildStatsSeries({
        group,
        size,
        onStatus,
      });

      // Build datasets: one per store
      const datasets = stores.map((s) => ({
        label: s,
        data: Array.isArray(seriesByStore[s]) ? seriesByStore[s] : labels.map(() => null),
        spanGaps: false,
        tension: 0.15,
      }));

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
            x: { title: { display: true, text: "Date" }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
            y: {
              title: { display: true, text: "Avg % vs per-SKU median" },
              ticks: { callback: (v) => `${Number(v).toFixed(0)}%`, maxTicksLimit: 12 },
            },
          },
        },
      });

      onStatus(`Loaded ${labels.length} day(s). Source=${esc(relReportPath(group, size))} @ ${esc(latestSha.slice(0, 7))}`);
    } catch (e) {
      const msg = esc(e?.message || String(e));
      onStatus(`Error: ${msg}`);
      const card = $app.querySelector(".card");
      if (card) card.innerHTML = `<div class="small">Chart unavailable: ${msg}</div>`;
    }
  };

  $group?.addEventListener("change", () => rerender());
  $size?.addEventListener("change", () => rerender());

  await rerender();
}
