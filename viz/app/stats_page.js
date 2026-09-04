import { esc } from "./dom.js";
import { goBack, peekBack } from "./nav.js";
import { fetchJson, inferGithubOwnerRepo, githubFetchFileAtSha, githubListCommits } from "./api.js";
import {
	destroyStatsChart,
	drawOrUpdateChart,
	resizeStatsChart,
} from "./stats_page/stats_chart.js";

export { destroyStatsChart };

/* ---------------- helpers ---------------- */

function rowKey(r) {
	const rep = r?.representative || {};
	return String(r?.canonSku || rep?.skuKey || rep?.skuRaw || rep?.sku || "").trim();
}

// Baseline for each SKU = median(storePrices) on the *first report* where the SKU has any prices.
function buildSkuBaselinesFromRaw(raw) {
	const stores = Array.isArray(raw?.stores) ? raw.stores.map(String) : [];
	const reportsByIdx = Array.isArray(raw?.reportsByIdx) ? raw.reportsByIdx : [];
	const baselines = new Map();

	for (let i = 0; i < reportsByIdx.length; i++) {
		const rep = reportsByIdx[i];
		const rows = Array.isArray(rep?.rows) ? rep.rows : [];
		for (const r of rows) {
			const k = rowKey(r);
			if (!k || baselines.has(k)) continue;

			const sp = r?.storePrices;
			if (!sp || typeof sp !== "object") continue;

			const prices = [];
			for (const s of stores) {
				const p = sp[s];
				if (Number.isFinite(p)) prices.push(p);
			}
			prices.sort((a, b) => a - b);

			const med = medianOfSorted(prices);
			if (isFinitePos(med)) baselines.set(k, med);
		}
	}

	return baselines;
}

// Floor for each SKU = minimum(storePrices) across *all reports* and *all stores*.
function buildSkuFloorsFromRaw(raw) {
	const stores = Array.isArray(raw?.stores) ? raw.stores.map(String) : [];
	const reportsByIdx = Array.isArray(raw?.reportsByIdx) ? raw.reportsByIdx : [];
	const floors = new Map();

	for (let i = 0; i < reportsByIdx.length; i++) {
		const rep = reportsByIdx[i];
		const rows = Array.isArray(rep?.rows) ? rep.rows : [];
		for (const r of rows) {
			const k = rowKey(r);
			if (!k) continue;

			const sp = r?.storePrices;
			if (!sp || typeof sp !== "object") continue;

			let mn = null;
			for (const s of stores) {
				const p = sp[s];
				if (Number.isFinite(p) && p > 0) mn = mn === null ? p : Math.min(mn, p);
			}
			if (!isFinitePos(mn)) continue;

			const prev = floors.get(k);
			if (!isFinitePos(prev) || mn < prev) floors.set(k, mn);
		}
	}

	return floors;
}

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

function stepForPrice(p, boundMax) {
	const x = Number.isFinite(p) ? p : boundMax;
	if (x < 120)  return 5;
	if (x < 250)  return 10;
	if (x < 600)  return 25;
	if (x < 2000) return 100;
	return 1000;
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

// Store series:
//   avg over SKUs that store has a price for.
// Market series:
//   SKU-centric: for each SKU/day, take median across stores (one vote per SKU),
//   then average across SKUs.
//
// valueMode:
//   "percent" => value = ((p - base) / base) * 100
//   "dollars" => value = (p - base)  (only used when eligibleSkus===1, i.e. single bottle)
function computeDailyStoreSeriesFromReport(report, filter, skuBaselines, skuFloors) {
	const stores = Array.isArray(filter?.stores)
		? filter.stores.map(String)
		: Array.isArray(report?.stores)
			? report.stores.map(String)
			: [];

	const rows = Array.isArray(report?.rows) ? report.rows : [];
	const tokens = Array.isArray(filter?.tokens) ? filter.tokens : [];
	const minP = Number.isFinite(filter?.minPrice) ? filter.minPrice : null;
	const maxP = Number.isFinite(filter?.maxPrice) ? filter.maxPrice : null;
	const valueMode = String(filter?.valueMode || "percent");

	const sum = new Map();
	const cnt = new Map();
	for (const s of stores) {
		sum.set(s, 0);
		cnt.set(s, 0);
	}

	// SKU-centric market accumulators (one value per SKU/day)
	let marketMedSkuSum = 0;
	let marketMedSkuCnt = 0;

	let marketFloorSkuSum = 0;
	let marketFloorSkuCnt = 0;

	let usedRows = 0; // rows that had at least one store price (so they actually contribute)
	let eligibleSkus = 0; // rows after filters + baseline (even if some stores don't carry)

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

		const k = rowKey(r);
		const base = k ? skuBaselines?.get(k) : null;
		if (!isFinitePos(base)) continue;

		const floorBase = k ? skuFloors?.get(k) : null;
		const hasFloor = isFinitePos(floorBase);

		const sp = r.storePrices;
		if (!sp || typeof sp !== "object") continue;

		eligibleSkus++;

		let contributed = false;
		const skuVals = [];
		let skuMinV = null;

		for (const s of stores) {
			const p = sp[s];
			if (!Number.isFinite(p)) continue;

			const v = valueMode === "dollars" ? p - base : ((p - base) / base) * 100;

			sum.set(s, (sum.get(s) || 0) + v);
			cnt.set(s, (cnt.get(s) || 0) + 1);

			skuVals.push(v);

			// Market floor: per-SKU/day minimum across stores (same baseline as v)
			if (skuMinV === null || v < skuMinV) skuMinV = v;

			contributed = true;
		}

		if (contributed) {
			usedRows++;

			skuVals.sort((a, b) => a - b);
			const skuMed = medianOfSorted(skuVals);
			if (Number.isFinite(skuMed)) {
				marketMedSkuSum += skuMed;
				marketMedSkuCnt += 1;
			}

			if (Number.isFinite(skuMinV)) {
				marketFloorSkuSum += skuMinV;
				marketFloorSkuCnt += 1;
			}
		}
	}

	const out = {};
	const coverageByStore = {};
	for (const s of stores) {
		const c = cnt.get(s) || 0;
		out[s] = c > 0 ? (sum.get(s) || 0) / c : null;
		coverageByStore[s] = eligibleSkus > 0 ? c / eligibleSkus : 0;
	}

	const marketMedianValue = marketMedSkuCnt > 0 ? marketMedSkuSum / marketMedSkuCnt : null;
	const marketFloorValue = marketFloorSkuCnt > 0 ? marketFloorSkuSum / marketFloorSkuCnt : null;

	return {
		stores,
		valuesByStore: out,
		marketMedianValue,
		marketFloorValue,
		usedRows,
		totalRows: rows.length,
		eligibleSkus,
		coverageByStore,
		valueMode,
	};
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
		const ts = String(c?.commit?.committer?.date || c?.commit?.author?.date || "");
		const d = dateOnly(ts);
		if (!sha || !d) continue;
		if (!byDate.has(d)) byDate.set(d, { sha, date: d, ts });
	}

	return [...byDate.values()].reverse();
}

/* ---------------- raw series cache ---------------- */

const RAW_SERIES_CACHE = new Map(); // key: `${group}:${size}` -> { latestSha, labels, stores, commits, reportsByIdx }

// The series bundles are NOT committed to the data branch. Measured: they add ~455 KB per run
// even after an aggressive repack (thousands of scattered change-point insertions delta badly),
// which is ~106 MB/month on a repo already growing ~180 MB/month. So they ship as GitHub Release
// assets on a fixed tag, overwritten each scrape — the same trade already made for
// sku_embeddings.json (see CLAUDE.md "LFS removal").
//
// `./data/stats/<name>` is the path that actually serves prod: `.github/workflows/pages.yaml`
// downloads the Release assets into the site artifact at deploy time, so they are same-origin.
// It also covers a server rooted at the data worktree (scripts/serve_viz.sh).
//
// The STATS_RELEASE_BASE fetch below is only a best-effort secondary and CANNOT work in a
// browser: the Release download 302s to release-assets.githubusercontent.com, which sends no
// access-control-allow-origin, so the cross-origin fetch is blocked. It is kept because it costs
// one failed request, works for non-browser consumers, and would start working if GitHub ever
// sends CORS. When BOTH miss, loadRawSeriesFromCommits still renders the page, just slowly — so a
// broken staging step degrades instead of breaking.
const STATS_RELEASE_BASE =
	"https://github.com/brennanwilkes/spirit-tracker/releases/download/stats-series-latest";

function statsBundleName(group, size) {
	return `common_listings_${group}_top${size}.json`;
}

// Rebuild the per-day report shape from the change-point bundle written by
// tools/build_viz_stats_series.js. The bundle stores a value only on the days it CHANGES
// (null = the row/store price is absent that day), so one cursor per series walks forward
// with the day loop instead of materialising a value per sku per store per day.
//
// The output is deliberately shaped exactly like the per-commit reports this page used to
// download, so every consumer below (baselines, floors, computeDailyStoreSeriesFromReport,
// computePriceBoundsFromReport) is untouched.
function expandStatsBundle(bundle) {
	const dates = Array.isArray(bundle?.dates) ? bundle.dates.map(String) : [];
	const shas = Array.isArray(bundle?.shas) ? bundle.shas.map(String) : [];
	const stores = Array.isArray(bundle?.stores) ? bundle.stores.map(String) : [];
	const n = dates.length;

	const cursors = Object.keys(bundle?.meta || {}).map((sku) => {
		const sp = (bundle.sp && bundle.sp[sku]) || {};
		const spKeys = Object.keys(sp);
		return {
			sku,
			meta: bundle.meta[sku] || {},
			present: (bundle.present && bundle.present[sku]) || [],
			rep: (bundle.rep && bundle.rep[sku]) || [],
			cheap: (bundle.cheap && bundle.cheap[sku]) || [],
			sp,
			spKeys,
			pi: 0,
			ri: 0,
			ci: 0,
			spi: spKeys.map(() => 0),
			pv: null,
			rv: null,
			cv: null,
			spv: spKeys.map(() => null),
		};
	});

	const reportsByIdx = new Array(n);
	for (let d = 0; d < n; d++) {
		const rows = [];
		for (const c of cursors) {
			while (c.pi < c.present.length && c.present[c.pi][0] === d) c.pv = c.present[c.pi++][1];
			while (c.ri < c.rep.length && c.rep[c.ri][0] === d) c.rv = c.rep[c.ri++][1];
			while (c.ci < c.cheap.length && c.cheap[c.ci][0] === d) c.cv = c.cheap[c.ci++][1];
			for (let k = 0; k < c.spKeys.length; k++) {
				const arr = c.sp[c.spKeys[k]];
				let i = c.spi[k];
				while (i < arr.length && arr[i][0] === d) c.spv[k] = arr[i++][1];
				c.spi[k] = i;
			}

			if (c.pv !== 1) continue;

			const storePrices = {};
			for (let k = 0; k < c.spKeys.length; k++) {
				const v = c.spv[k];
				if (Number.isFinite(v)) storePrices[c.spKeys[k]] = v;
			}
			const m = c.meta;
			rows.push({
				canonSku: c.sku,
				storePrices,
				representative: {
					name: m.n || "",
					skuRaw: m.r || "",
					skuKey: m.k || "",
					categoryLabel: m.c || "",
					storeLabel: m.sl || "",
					storeKey: m.sk || "",
					priceNum: Number.isFinite(c.rv) ? c.rv : null,
				},
				cheapest: { priceNum: Number.isFinite(c.cv) ? c.cv : null },
			});
		}
		reportsByIdx[d] = { stores, rows };
	}

	return {
		latestSha: shas.length ? shas[shas.length - 1] : "",
		labels: dates,
		stores,
		commits: shas.map((sha, i) => ({ sha, date: dates[i] || "" })),
		reportsByIdx,
	};
}

async function loadRawSeries({ group, size, onStatus }) {
	const cacheKey = `${group}:${size}`;

	// Serve an already-expanded series straight from the session cache. This has to happen
	// BEFORE the fetch: fetchJson sends `cache: "no-store"`, so consulting the cache afterwards
	// still re-downloaded the whole bundle (up to ~1.7 MB for all_top1000) on every group/size
	// toggle. Bundles are rebuilt a few times a day, so a session-lifetime cache is the right
	// granularity — a reload picks up a newer one.
	const cachedBundle = RAW_SERIES_CACHE.get(cacheKey);
	if (cachedBundle) return cachedBundle;

	// Fast path: one prebuilt bundle instead of one request per commit. Falls through to the
	// per-commit walk when the bundle is missing (older data branch, or a checkout that has not
	// run build_viz_stats_series.js yet).
	try {
		if (typeof onStatus === "function") onStatus("Loading series…");
		const name = statsBundleName(group, size);
		let bundle = await fetchJson(`./data/stats/${name}`).catch(() => null);
		if (!bundle) bundle = await fetchJson(`${STATS_RELEASE_BASE}/${name}`);
		if (Array.isArray(bundle?.dates) && bundle.dates.length) {
			const expanded = expandStatsBundle(bundle);
			RAW_SERIES_CACHE.set(cacheKey, expanded);
			return expanded;
		}
	} catch {
		// fall through to the per-commit path
	}

	return await loadRawSeriesFromCommits({ group, size, onStatus });
}

async function loadRawSeriesFromCommits({ group, size, onStatus }) {
	const rel = relReportPath(group, size);
	const gh = inferGithubOwnerRepo();
	const owner = gh.owner;
	const repo = gh.repo;
	const branch = "data";

	const manifest = await loadCommonCommitsManifest();

	let commits = Array.isArray(manifest?.files?.[rel]) ? manifest.files[rel] : null;

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
	if (cached && cached.latestSha === latestSha && cached.labels?.length === commits.length) {
		return cached;
	}

	const NET_CONCURRENCY = 10;
	const limitNet = makeLimiter(NET_CONCURRENCY);

	// Find stores from the newest commit that isn't an LFS pointer (older commits may still be LFS-tracked).
	if (typeof onStatus === "function") onStatus(`Loading stores…`);
	let stores = [];
	for (let i = commits.length - 1; i >= 0 && !stores.length; i--) {
		try {
			const rep = await githubFetchFileAtSha({ owner, repo, sha: commits[i].sha, path: rel });
			stores = Array.isArray(rep?.stores) ? rep.stores.map(String) : [];
		} catch {}
	}
	if (!stores.length) throw new Error(`No stores found in ${rel} — all commits may be LFS-tracked`);

	const labels = commits.map((c) => String(c.date || "")).filter(Boolean);
	const shaByIdx = commits.map((c) => String(c.sha || ""));

	if (typeof onStatus === "function") onStatus(`Loading ${labels.length} day(s)…`);

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
					if (typeof onStatus === "function" && (done % 10 === 0 || done === shaByIdx.length)) {
						onStatus(`Loading ${labels.length} day(s)… ${done}/${labels.length}`);
					}
				}
			}),
		),
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

// Edge-preserving smoothing with hard boundaries at large day-over-day swings.
//
// Algorithm:
//   1. Window grows with sqrt(N), capped — longer histories smooth more.
//   2. Any day-over-day delta of >= JUMP_THRESH (5 units = 5% or $5) flags
//      both adjacent points as "anchored". Anchored points keep their original
//      value AND act as hard barriers: the smoothing window for neighbouring
//      points will not reach past them. That preserves dramatic spikes
//      (e.g. 3-day 10% storewide sale) as solid boundaries between otherwise
//      smoothed segments.
function adaptiveSmooth(arr) {
	if (!Array.isArray(arr) || arr.length === 0) return arr;
	const n = arr.length;
	const window = Math.max(3, Math.min(31, Math.round(Math.sqrt(n))));
	const half = Math.floor(window / 2);

	const JUMP_THRESH = 2;
	const anchored = new Array(n).fill(false);
	for (let i = 1; i < n; i++) {
		const a = arr[i - 1];
		const b = arr[i];
		if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) >= JUMP_THRESH) {
			anchored[i - 1] = true;
			anchored[i] = true;
		}
	}

	const out = new Array(n).fill(null);
	for (let i = 0; i < n; i++) {
		const v = arr[i];
		if (anchored[i]) {
			out[i] = Number.isFinite(v) ? v : null;
			continue;
		}
		let sum = 0;
		let cnt = 0;
		if (Number.isFinite(v)) {
			sum += v;
			cnt++;
		}
		// walk left until we hit a boundary or the window edge
		for (let j = i - 1; j >= Math.max(0, i - half); j--) {
			if (anchored[j]) break;
			const x = arr[j];
			if (Number.isFinite(x)) {
				sum += x;
				cnt++;
			}
		}
		// walk right symmetrically
		for (let j = i + 1; j <= Math.min(n - 1, i + half); j++) {
			if (anchored[j]) break;
			const x = arr[j];
			if (Number.isFinite(x)) {
				sum += x;
				cnt++;
			}
		}
		out[i] = cnt ? sum / cnt : Number.isFinite(v) ? v : null;
	}
	return out;
}

function applySmoothingToSeries(series) {
	if (series.seriesByStore && typeof series.seriesByStore === "object") {
		for (const k of Object.keys(series.seriesByStore)) {
			series.seriesByStore[k] = adaptiveSmooth(series.seriesByStore[k]);
		}
	}
	if (Array.isArray(series.marketMedianTrend)) {
		series.marketMedianTrend = adaptiveSmooth(series.marketMedianTrend);
	}
	if (Array.isArray(series.marketFloorTrend)) {
		series.marketFloorTrend = adaptiveSmooth(series.marketFloorTrend);
	}
}

function movingAverage(arr, window = 5) {
	const out = new Array(Array.isArray(arr) ? arr.length : 0).fill(null);
	for (let i = 0; i < out.length; i++) {
		let sum = 0;
		let cnt = 0;
		const j0 = Math.max(0, i - window + 1);
		for (let j = j0; j <= i; j++) {
			const v = arr[j];
			if (Number.isFinite(v)) {
				sum += v;
				cnt++;
			}
		}
		out[i] = cnt ? sum / cnt : null;
	}
	return out;
}

function computeSeriesFromRaw(raw, filter) {
	const labels = raw.labels;
	const stores = raw.stores;
	const reportsByIdx = raw.reportsByIdx;

	// compute once per raw (and keep it across filter changes)
	if (!raw.skuBaselines) raw.skuBaselines = buildSkuBaselinesFromRaw(raw);
	if (!raw.skuFloors) raw.skuFloors = buildSkuFloorsFromRaw(raw);

	// Decide value mode:
	// If the *filtered eligible SKU count* on the newest report is exactly 1,
	// show $ deltas instead of % (single bottle mode).
	let valueMode = "percent";
	let newestEligibleSkus = 0;

	const newestRep = reportsByIdx[reportsByIdx.length - 1];
	if (newestRep) {
		const probe = computeDailyStoreSeriesFromReport(
			newestRep,
			{
				...filter,
				stores,
				valueMode: "percent",
			},
			raw.skuBaselines,
			raw.skuFloors,
		);
		newestEligibleSkus = Number(probe?.eligibleSkus || 0);
		if (newestEligibleSkus === 1) valueMode = "dollars";
	}

	const seriesByStore = {};
	const coverageSeriesByStore = {};
	for (const s of stores) {
		seriesByStore[s] = new Array(labels.length).fill(null);
		coverageSeriesByStore[s] = new Array(labels.length).fill(0);
	}

	const marketMedianSeries = new Array(labels.length).fill(null);
	const marketFloorSeries = new Array(labels.length).fill(null);

	let newestUsed = 0;
	let newestTotal = 0;
	let newestCoverageByStore = null;

	for (let i = 0; i < reportsByIdx.length; i++) {
		const rep = reportsByIdx[i];
		if (!rep) continue;

		const daily = computeDailyStoreSeriesFromReport(
			rep,
			{
				...filter,
				stores,
				valueMode,
			},
			raw.skuBaselines,
			raw.skuFloors,
		);

		for (const s of stores) {
			const v = daily.valuesByStore[s];
			seriesByStore[s][i] = Number.isFinite(v) ? v : null;

			const c = daily.coverageByStore?.[s];
			coverageSeriesByStore[s][i] = Number.isFinite(c) ? c : 0;
		}

		marketMedianSeries[i] = Number.isFinite(daily.marketMedianValue)
			? daily.marketMedianValue
			: null;
		marketFloorSeries[i] = Number.isFinite(daily.marketFloorValue) ? daily.marketFloorValue : null;

		if (i === reportsByIdx.length - 1) {
			newestUsed = daily.usedRows;
			newestTotal = daily.totalRows;
			newestCoverageByStore = daily.coverageByStore || null;
			newestEligibleSkus = Number(daily.eligibleSkus || newestEligibleSkus || 0);
		}
	}

	function anchorToFirst(arr) {
		let first = null;
		for (const v of arr) {
			if (Number.isFinite(v)) {
				first = v;
				break;
			}
		}
		return arr.map((v) => (Number.isFinite(v) && Number.isFinite(first) ? v - first : v));
	}

	const marketMedianAnchored = anchorToFirst(marketMedianSeries);
	const marketFloorAnchored = anchorToFirst(marketFloorSeries);

	const marketMedianTrend = movingAverage(marketMedianAnchored, 1);
	const marketFloorTrend = movingAverage(marketFloorAnchored, 1);

	return {
		labels,
		stores,
		seriesByStore,
		marketMedianTrend,
		marketFloorTrend,
		newestUsed,
		newestTotal,
		newestCoverageByStore,
		newestEligibleSkus,
		valueMode,
		coverageSeriesByStore,
	};
}

/* ---------------- y-axis bounds ---------------- */

function computeYBounds(seriesByStore, arg2, arg3, arg4) {
	let extra = [];
	let minSpan = 6;
	let pad = 1;

	if (Array.isArray(arg2)) {
		extra = arg2;
		minSpan = Number.isFinite(arg3) ? arg3 : 6;
		pad = Number.isFinite(arg4) ? arg4 : 1;
	} else {
		minSpan = Number.isFinite(arg2) ? arg2 : 6;
		pad = Number.isFinite(arg3) ? arg3 : 1;
	}

	let mn = Infinity,
		mx = -Infinity;

	for (const arr of Object.values(seriesByStore || {})) {
		if (!Array.isArray(arr)) continue;
		for (const v of arr) {
			if (!Number.isFinite(v)) continue;
			mn = Math.min(mn, v);
			mx = Math.max(mx, v);
		}
	}

	for (const arr of extra || []) {
		if (!Array.isArray(arr)) continue;
		for (const v of arr) {
			if (!Number.isFinite(v)) continue;
			mn = Math.min(mn, v);
			mx = Math.max(mx, v);
		}
	}

	if (mn === Infinity) return { min: -minSpan / 2, max: minSpan / 2 };

	mn = Math.min(mn, 0);
	mx = Math.max(mx, 0);

	// pad a bit so lines aren't glued to edges
	mn = Math.floor(mn - pad);
	mx = Math.ceil(mx + pad);

	// enforce a minimum visible range so it doesn't get *too* tight
	const span = mx - mn;
	if (span < minSpan) {
		const mid = (mn + mx) / 2;
		mn = Math.floor(mid - minSpan / 2);
		mx = Math.ceil(mid + minSpan / 2);
	}

	return { min: mn, max: mx };
}

/* ---------------- prefs ---------------- */

const LS_GROUP = "stviz:v1:stats:group";
const LS_SIZE = "stviz:v1:stats:size";
const LS_TREND_ONLY = "stviz:v1:stats:trendOnly";
const LS_SMOOTH = "stviz:v1:stats:smooth";

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
	let trendOnly = false;
	let smooth = false;
	try {
		group = String(localStorage.getItem(LS_GROUP) || "all");
		size = String(localStorage.getItem(LS_SIZE) || "250");
		trendOnly = localStorage.getItem(LS_TREND_ONLY) === "1";
		smooth = localStorage.getItem(LS_SMOOTH) === "1";
	} catch {}
	group = group === "bc" || group === "ab" || group === "all" ? group : "all";
	size = size === "50" || size === "250" || size === "1000" ? size : "250";
	return { group, size: Number(size), trendOnly, smooth };
}

function savePrefs(group, size) {
	try {
		localStorage.setItem(LS_GROUP, String(group));
		localStorage.setItem(LS_SIZE, String(size));
	} catch {}
}

function saveTrendOnlyPref(trendOnly) {
	try {
		localStorage.setItem(LS_TREND_ONLY, trendOnly ? "1" : "0");
	} catch {}
}

function saveSmoothPref(smooth) {
	try {
		localStorage.setItem(LS_SMOOTH, smooth ? "1" : "0");
	} catch {}
}

/* ---------------- render ---------------- */

export async function renderStats($app) {
	destroyStatsChart();

	const pref = loadPrefs();

	$app.innerHTML = `
    <div class="container containerFull">
      <div class="header">
        <div class="headerRow1">
          <div class="statsHeaderLeft">
            <a id="back" class="btn" href="${peekBack()}"><span class="backArrow">← </span>Back</a>
            <div class="statsTitleStack">
              <h1 class="h1">Market Trend</h1>
              <div class="small" id="statsStatus">Loading…</div>
            </div>
          </div>

          <div class="headerRight statsHeaderRight">
            <div class="statsFilters">
              <select id="statsGroup" class="selectSmall statsFilterField" aria-label="Store group">
                <option value="all">All Stores</option>
                <option value="bc">BC Only</option>
                <option value="ab">Alberta Only</option>
              </select>

              <select id="statsSize" class="selectSmall statsFilterField" aria-label="Sample size">
                <option value="50">Top 50</option>
                <option value="250">Top 250</option>
                <option value="1000">Top 1000</option>
              </select>

              <label id="statsTrendOnly" class="switch mini statsFilterField" style="cursor:pointer;" title="Hide per-store lines and show only the market trendlines">
                <input id="statsTrendOnlyInput" type="checkbox" />
                <div class="switchLabel">
                  <div class="switchStatus muted">Trendlines</div>
                </div>
                <div class="switchPill" aria-hidden="true">
                  <div class="switchKnob"></div>
                </div>
              </label>

              <label id="statsSmooth" class="switch mini statsFilterField" style="cursor:pointer;" title="Apply edge-preserving smoothing — window grows with history length, but sharp spikes are retained">
                <input id="statsSmoothInput" type="checkbox" />
                <div class="switchLabel">
                  <div class="switchStatus muted">Smooth</div>
                </div>
                <div class="switchPill" aria-hidden="true">
                  <div class="switchKnob"></div>
                </div>
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

              <div class="priceRow" id="statsPriceWrap">
                <div class="priceRowLabel">Price</div>

                <div class="rangeDual" aria-label="Price range">
                  <div class="rangeTrack"></div>
                  <div class="rangeFill" id="statsRangeFill"></div>
                  <input id="statsMinPrice" type="range" min="0" max="1000" step="1" value="0" />
                  <input id="statsMaxPrice" type="range" min="0" max="1000" step="1" value="1000" />
                </div>

                <!-- Wider floor than the shared default: this one shows a RANGE
                     ("$15 – $550"), not a single value. -->
                <div class="badge mono priceValue" id="statsPriceLabel" style="min-width:120px;"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card cardFill">
        <div class="chartFill">
          <canvas id="statsChart" aria-label="Statistics chart" role="img"></canvas>
        </div>
        <details class="chartLegend" id="statsLegend" hidden>
          <summary><span id="statsLegendCount">Series</span></summary>
          <div class="chartLegendList" id="statsLegendList"></div>
        </details>
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

	const $trendOnly = document.getElementById("statsTrendOnly");
	const $trendOnlyInput = document.getElementById("statsTrendOnlyInput");
	const $smooth = document.getElementById("statsSmooth");
	const $smoothInput = document.getElementById("statsSmoothInput");

	if ($group) $group.value = pref.group;
	if ($size) $size.value = String(pref.size);
	if ($trendOnly) $trendOnly.classList.toggle("isOn", !!pref.trendOnly);
	if ($trendOnlyInput) $trendOnlyInput.checked = !!pref.trendOnly;
	if ($smooth) $smooth.classList.toggle("isOn", !!pref.smooth);
	if ($smoothInput) $smoothInput.checked = !!pref.smooth;

	const onStatus = (msg) => {
		if ($status) $status.textContent = String(msg || "");
	};

	document.getElementById("back")?.addEventListener("click", (e) => {
		if (e.ctrlKey || e.metaKey || e.shiftKey) return;
		e.preventDefault();
		goBack();
	});

	// log scale requires a positive floor; EFF_MIN is the scale base
	const EFF_MIN = 15;
	let boundMin = EFF_MIN;
	let boundMax = 1000;

	let selectedMinPrice = boundMin;
	let selectedMaxPrice = boundMax;

	// log/exponential scale: fine precision at low prices, coarse at high
	function priceFromT(t) {
		t = clamp(t, 0, 1);
		if (boundMax <= EFF_MIN) return EFF_MIN;
		const ratio = boundMax / EFF_MIN;
		return EFF_MIN * Math.exp(Math.log(ratio) * t);
	}

	function tFromPrice(price) {
		if (!Number.isFinite(price)) return 1;
		if (boundMax <= EFF_MIN) return 1;
		const p = clamp(price, EFF_MIN, boundMax);
		const ratio = boundMax / EFF_MIN;
		return Math.log(p / EFF_MIN) / Math.log(ratio);
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
		$priceLabel.textContent = `${formatDollars(selectedMinPrice)} – ${formatDollars(selectedMaxPrice)}`;
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

			boundMin = EFF_MIN;
			boundMax = Number.isFinite(b.max) && b.max > 0 ? Math.ceil(b.max) : 1000;

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

				if (selectedMinPrice > selectedMaxPrice) selectedMinPrice = selectedMaxPrice;
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

			const trendOnly = !!$trendOnlyInput?.checked;
			series.marketOnly = trendOnly;

			const isDollars = series.valueMode === "dollars";
			const yMinSpan = isDollars ? (group === "all" ? 20 : 15) : group === "all" ? 8 : 6;
			const yPad = isDollars ? 2 : 1;

			// y-bounds derived from the raw (unsmoothed) data so toggling
			// "Smooth" doesn't rescale the axis
			const yBounds = computeYBounds(
				trendOnly ? {} : series.seriesByStore,
				[series.marketMedianTrend, series.marketFloorTrend],
				yMinSpan,
				yPad,
			);

			if ($smoothInput?.checked) applySmoothingToSeries(series);

			await drawOrUpdateChart(series, yBounds);
			resizeStatsChart();

			const short = `${series.labels.length}d · ${series.newestUsed}/${series.newestTotal} SKUs`;
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

			const trendOnly = !!$trendOnlyInput?.checked;
			series.marketOnly = trendOnly;

			const isDollars = series.valueMode === "dollars";
			const yMinSpan = isDollars ? (group === "all" ? 20 : 15) : group === "all" ? 8 : 6;
			const yPad = isDollars ? 2 : 1;

			// y-bounds derived from the raw (unsmoothed) data so toggling
			// "Smooth" doesn't rescale the axis
			const yBounds = computeYBounds(
				trendOnly ? {} : series.seriesByStore,
				[series.marketMedianTrend, series.marketFloorTrend],
				yMinSpan,
				yPad,
			);

			if ($smoothInput?.checked) applySmoothingToSeries(series);

			await drawOrUpdateChart(series, yBounds);
			resizeStatsChart();

			const short = `${series.labels.length}d · ${series.newestUsed}/${series.newestTotal} SKUs`;
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
	$trendOnly?.addEventListener("click", (e) => {
		e.preventDefault();
		const nowOn = !$trendOnly.classList.contains("isOn");
		$trendOnly.classList.toggle("isOn", nowOn);
		if ($trendOnlyInput) $trendOnlyInput.checked = nowOn;
		saveTrendOnlyPref(nowOn);
		applyFiltersDebounced(0);
	});
	$smooth?.addEventListener("click", (e) => {
		e.preventDefault();
		const nowOn = !$smooth.classList.contains("isOn");
		$smooth.classList.toggle("isOn", nowOn);
		if ($smoothInput) $smoothInput.checked = nowOn;
		saveSmoothPref(nowOn);
		applyFiltersDebounced(0);
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
