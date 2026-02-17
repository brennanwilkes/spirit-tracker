import { esc, renderThumbHtml, dateOnly } from "./dom.js";
import { parsePriceToNumber, keySkuForRow, displaySku } from "./sku.js";
import { loadIndex } from "./state.js";
import { inferGithubOwnerRepo, githubListCommits, githubFetchFileAtSha, fetchJson } from "./api.js";
import { loadSkuRules } from "./mapping.js";
import { buildStoreColorMap, storeColor, datasetStrokeWidth, lighten } from "./storeColors.js";
import { favStarHtml, loadMyFavouritesSet, installFavStars } from "./fav_star.js";
import { getAuthStatus, getMySampled, getMyScore, setMySampled, setMyScore } from "./cloud.js";

/* ---------------- Chart lifecycle ---------------- */

let CHART = null;

/* ---------------- Static marker lines ---------------- */

// --- Province store matching (robust to labels like "Vessel Liquor", "BCL", etc.) ---
const BC_STORE_NAMES = new Set([
	"bcl",
	"tudorhouse",
	"vesselliquor",
	"strathliquor",
	"gullliquor",
	"vintagespirits",
	"legacyliquor",
	"arc",
]);

function normStoreLabel(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, "");
}

function isBcStoreLabel(label) {
	const n = normStoreLabel(label);
	if (BC_STORE_NAMES.has(n)) return true;

	// extra fuzzy contains for safety
	if (n.includes("vessel")) return true;
	if (n.includes("tudor")) return true;
	if (n === "bcl") return true;
	if (n.includes("strath")) return true;
	if (n.includes("gull")) return true;
	if (n.includes("vintagespirits")) return true;
	if (n.includes("legacy")) return true;
	if (n.includes("arc")) return true;

	return false;
}

function weightedMeanByDuration(pointsMap, sortedDates) {
	// pointsMap: Map(dateStr -> number|null)
	// sortedDates: ["YYYY-MM-DD", ...] sorted asc
	let wsum = 0;
	let wtot = 0;

	for (let i = 0; i < sortedDates.length; i++) {
		const d0 = sortedDates[i];
		const v = pointsMap.get(d0);
		if (!Number.isFinite(v)) continue;

		const t0 = Date.parse(d0 + "T00:00:00Z");
		const d1 = sortedDates[i + 1];
		const t1 = d1 ? Date.parse(d1 + "T00:00:00Z") : t0 + 24 * 3600 * 1000;

		// weight in days (min 1 day)
		const w = Math.max(1, Math.round((t1 - t0) / (24 * 3600 * 1000)));
		wsum += v * w;
		wtot += w;
	}

	return wtot ? wsum / wtot : null;
}

function meanFinite(arr) {
	if (!Array.isArray(arr)) return null;
	let sum = 0,
		n = 0;
	for (const v of arr) {
		if (Number.isFinite(v)) {
			sum += v;
			n++;
		}
	}
	return n ? sum / n : null;
}

function minFinite(arr) {
	if (!Array.isArray(arr)) return null;
	let m = null;
	for (const v of arr) {
		if (Number.isFinite(v)) m = m === null ? v : Math.min(m, v);
	}
	return m;
}

function medianFinite(nums) {
	const a = (Array.isArray(nums) ? nums : [])
		.filter((v) => Number.isFinite(v))
		.slice()
		.sort((x, y) => x - y);
	const n = a.length;
	if (!n) return null;
	const mid = Math.floor(n / 2);
	return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const StaticMarkerLinesPlugin = {
	id: "staticMarkerLines",
	afterDraw(chart, _args, passedOpts) {
		const opts =
			(chart?.options?.plugins && chart.options.plugins.staticMarkerLines) ||
			chart?.options?.staticMarkerLines ||
			passedOpts ||
			{};

		const markers = Array.isArray(opts?.markers) ? opts.markers : [];
		if (!markers.length) return;

		// Find y-scale (v2/v3 tolerant)
		const scalesObj = chart?.scales || {};
		const scales = Object.values(scalesObj);
		const y =
			scalesObj.y ||
			scales.find((s) => s && s.axis === "y") ||
			scales.find((s) => s && typeof s.getPixelForValue === "function" && s.isHorizontal === false) ||
			scales.find(
				(s) =>
					s &&
					typeof s.getPixelForValue === "function" &&
					String(s.id || "")
						.toLowerCase()
						.includes("y"),
			);

		const area = chart?.chartArea;
		if (!y || !area) return;

		const { ctx } = chart;
		const { left, right, top, bottom } = area;

		const lineWidth = Number.isFinite(opts?.lineWidth) ? opts.lineWidth : 1.25; // thinner
		const baseAlpha = Number.isFinite(opts?.alpha) ? opts.alpha : 0.38; // brighter than before
		const strokeStyle = String(opts?.color || "#7f8da3"); // light grey-blue

		// "marker on Y axis" text
		const font = opts?.font || "600 11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
		const labelColor = String(opts?.labelColor || "#556274");
		const axisInset = Number.isFinite(opts?.axisInset) ? opts.axisInset : 2;

		ctx.save();
		ctx.setLineDash([]); // SOLID
		ctx.lineWidth = lineWidth;
		ctx.font = font;
		ctx.fillStyle = labelColor;

		for (const m of markers) {
			const yVal = Number(m?.y);
			if (!Number.isFinite(yVal)) continue;

			const py = y.getPixelForValue(yVal);
			if (!Number.isFinite(py) || py < top || py > bottom) continue;

			// line
			ctx.globalAlpha = Number.isFinite(m?.alpha) ? m.alpha : baseAlpha;
			ctx.strokeStyle = String(m?.color || strokeStyle);
			ctx.beginPath();
			ctx.moveTo(left, py);
			ctx.lineTo(right, py);
			ctx.stroke();

			// tiny tick mark starting at axisX
			// y scale box: [y.left .. y.right], where y.right is usually chartArea.left
			const yLeft = Number.isFinite(y?.left) ? y.left : left;
			const yRight = Number.isFinite(y?.right) ? y.right : left;

			// center of the y-axis box (clamped)
			const axisCenterX = Math.max(0, Math.min((yLeft + yRight) / 2, chart.width));

			// draw the little tick at the chart edge (right edge of y-axis box)
			ctx.beginPath();
			ctx.moveTo(yRight, py);
			ctx.lineTo(yRight + 6, py);
			ctx.stroke();

			// label centered in the y-axis box
			const text = String(m?.text || "");
			if (text) {
				ctx.globalAlpha = 0.95;
				ctx.fillStyle = String(m?.labelColor || labelColor);
				ctx.textBaseline = "middle";
				ctx.textAlign = "center";
				ctx.fillText(text, axisCenterX, py);
			}
		}

		ctx.restore();
	},
};

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

// Global limiter for aggressive network concurrency (shared across ALL stores/files)
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

function findMinPricesForSkuGroupInDb(obj, wantRealSkus, skuKeys, storeLabel, wantUrls) {
	const items = Array.isArray(obj?.items) ? obj.items : [];
	let liveMin = null;
	let removedMin = null;

	const consider = (isRemoved, priceVal) => {
		const p = parsePriceToNumber(priceVal);
		if (p === null) return;
		if (!isRemoved) liveMin = liveMin === null ? p : Math.min(liveMin, p);
		else removedMin = removedMin === null ? p : Math.min(removedMin, p);
	};

	const urlSet = wantUrls instanceof Set ? wantUrls : new Set();
	const skuKeySet = new Set((Array.isArray(skuKeys) ? skuKeys : []).map((s) => String(s || "")));

	for (const it of items) {
		if (!it) continue;

		const isRemoved = Boolean(it.removed);
		const url = String(it.url || "");

		// 0) URL match (critical for u: keys when storeLabel changes over time)
		if (url && urlSet.size && urlSet.has(url)) {
			consider(isRemoved, it.price);
			continue;
		}

		// 1) Real SKU match (fast path)
		const real = String(it.sku || "").trim();
		if (real && wantRealSkus && wantRealSkus.has(real)) {
			consider(isRemoved, it.price);
			continue;
		}

		// 2) Fallback: keySkuForRow match (still useful for real SKUs and stable labels)
		if (skuKeySet.size) {
			const row = { sku: real, url, storeLabel: storeLabel || "", store: "" };
			const kk = keySkuForRow(row);
			if (skuKeySet.has(String(kk || ""))) {
				consider(isRemoved, it.price);
			}
		}
	}

	return { liveMin, removedMin };
}


function lastFiniteFromEnd(arr) {
	if (!Array.isArray(arr)) return null;
	for (let i = arr.length - 1; i >= 0; i--) {
		const v = arr[i];
		if (Number.isFinite(v)) return v;
	}
	return null;
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

/* ---------------- Series cache (per dbFile + per skuKey) ---------------- */

function cacheKeySeries(sku, dbFile, cacheBust, variantKey) {
	return `stviz:v6:series:${cacheBust}:${sku}:${dbFile}:${variantKey || ""}`;
}

function loadSeriesCache(sku, dbFile, cacheBust, variantKey) {
	try {
		const raw = localStorage.getItem(cacheKeySeries(sku, dbFile, cacheBust, variantKey));
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

function saveSeriesCache(sku, dbFile, cacheBust, variantKey, points) {
	try {
		localStorage.setItem(
			cacheKeySeries(sku, dbFile, cacheBust, variantKey),
			JSON.stringify({ savedAt: Date.now(), points }),
		);
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
		const sha = String(arr[arr.length - 1]?.sha || "");
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

	const [rules, fav] = await Promise.all([
		loadSkuRules(),
		loadMyFavouritesSet()
	]);
	
	const sku = rules.canonicalSku(String(skuInput || ""));
	const favSet = new Set();
	for (const k of fav.set) {
		const raw = String(k || "");
		favSet.add(String(rules.canonicalSku(raw) || raw));
	}

	function setSaving(el, on) {
		if (!el) return;
		el.classList.toggle("isSaving", !!on);
	}
	
	function flashSaved(el) {
		if (!el) return;
		el.classList.remove("isSaved");
		// restart animation
		void el.offsetWidth;
		el.classList.add("isSaved");
		setTimeout(() => el && el.classList.remove("isSaved"), 650);
	}
	
		
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
					<div class="detailTopRow">
					<div class="detailLeft">
						<div class="detailTitleRow">
						<div id="title" class="h1">Loading…</div>
						</div>

						<!-- DESKTOP links/status stay here -->
						<div id="links" class="links"></div>
						<div class="small" id="status"></div>
					</div>

					<div class="detailRight">
						<button id="sampledBtn" class="pillBtn" type="button" aria-pressed="false">
						<span class="pillMark pillMarkOff">×</span>
						<span class="pillMark pillMarkOn">✓</span>
						<span>Sampled</span>
						</button>

						${favStarHtml(sku, favSet.has(sku), { cls: "favStarItem" })}

						<div id="scoreWrap" class="pillInput" role="button" tabindex="0" aria-label="Score">
						<span class="pillMarkNum">#</span>
						<input
							id="scoreInput"
							class="pillNumber"
							type="number"
							min="0"
							max="100"
							step="1"
							inputmode="numeric"
							placeholder="Score"
						/>
						</div>
					</div>
					</div>
				</div>
				</div>

				<!-- MOBILE full-width links/status (different ids, no collisions) -->
				<div class="detailMobileLinks">
				<div id="linksMobile" class="links"></div>
				<div class="small" id="statusMobile"></div>
				</div>

				<div class="chartBox">
				<canvas id="chart"></canvas>
				</div>
			</div>
			</div>
		`;
  
  
	installFavStars($app, favSet);

	document.getElementById("back").addEventListener("click", () => {
		const last = sessionStorage.getItem("viz:lastRoute");
		if (last && last !== location.hash) location.hash = last;
		else location.hash = "#/";
	});

	const $title = document.getElementById("title");
	const $links = document.getElementById("links");
	const $status = document.getElementById("status");
	const $canvas = document.getElementById("chart");
	const $thumbBox = document.getElementById("thumbBox");

	const $linksMobile = document.getElementById("linksMobile");
	const $statusMobile = document.getElementById("statusMobile");

	const setLinksHtml = (html) => {
	if ($links) $links.innerHTML = html;
	if ($linksMobile) $linksMobile.innerHTML = html;
	};

	const setStatusText = (txt) => {
	if ($status) setStatusText(txt);
	if ($statusMobile) $statusMobile.textContent = txt;
	};


	// ---- Cloud: sampled + score (per canonical SKU) ----
	const $sampledBtn = document.getElementById("sampledBtn");
	const $scoreWrap = document.getElementById("scoreWrap");
	const $score = document.getElementById("scoreInput");

	const loginUrl = "#/login";
	const openLogin = () => window.open(loginUrl, "_blank", "noopener,noreferrer");

	function setSampledUi(isOn) {
		const on = !!isOn;
		if (!$sampledBtn) return;
		$sampledBtn.classList.toggle("isOn", on);
		$sampledBtn.setAttribute("aria-pressed", on ? "true" : "false");
	}

	function setScoreUi(score) {
		if (!$score) return;
		if (score === null || score === undefined) $score.value = "";
		else if (Number.isFinite(Number(score))) $score.value = String(Math.round(Number(score)));
	}

	// Make the WHOLE score pill clickable -> focuses input
	if ($scoreWrap && $score) {
		const focusAndSelectScore = () => {
			$score.focus();
			// defer so selection sticks (esp. when focus came from a click)
			setTimeout(() => {
				try { $score.select(); } catch {}
			}, 0);
		};

			
		$scoreWrap.addEventListener("click", (e) => {
			if (e.target !== $score) focusAndSelectScore();
		});
		$scoreWrap.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				focusAndSelectScore();
			}
		});
		// Tab focus into the input -> select current value for quick replace
		$score.addEventListener("focus", () => {
			setTimeout(() => {
				try { $score.select(); } catch {}
			}, 0);
		});
	}

	const auth = getAuthStatus();
	const cloudKey = sku;

	if (!auth.ok) {
		if ($sampledBtn) $sampledBtn.classList.add("isLoginGate");
		if ($scoreWrap) $scoreWrap.classList.add("isLoginGate");
		if ($score) $score.readOnly = true;
	  
		if ($sampledBtn) {
		  $sampledBtn.addEventListener("click", (e) => {
			e.preventDefault();
			openLogin();
		  });
		}
	  
		if ($scoreWrap) {
		  $scoreWrap.addEventListener("click", (e) => {
			e.preventDefault();
			openLogin();
		  });
		}
	  
		if ($score) $score.addEventListener("focus", () => $score.blur());
	  } else {
		// Auth ok: load initial values
		(async () => {
			try {
				const [sampledArr, scoreMap] = await Promise.all([getMySampled(), getMyScore()]);
				const sampled = Array.isArray(sampledArr) && sampledArr.includes(cloudKey);

				let score = null;
				if (scoreMap && typeof scoreMap === "object") {
					const n = Number(scoreMap[cloudKey]);
					if (Number.isFinite(n)) score = n;
				}

				setSampledUi(sampled);
				setScoreUi(score);
			} catch {
				setSampledUi(false);
				setScoreUi(null);
			}
		})();

		// Sampled toggle
		if ($sampledBtn) {
			$sampledBtn.addEventListener("click", async () => {
			  const next = !$sampledBtn.classList.contains("isOn");
			  setSampledUi(next);
		
			  setSaving($sampledBtn, true);
			  try {
				await setMySampled(cloudKey, next);
				flashSaved($sampledBtn);
			  } catch {
				setSampledUi(!next);
			  } finally {
				setSaving($sampledBtn, false);
			  }
			});
		}
		
		// Score save
		if ($score) {
			const saveScore = async () => {
				const raw = String($score.value || "").trim();
				let toSend = null;
			
				if (raw !== "") {
					const n = Number(raw);
					if (Number.isFinite(n)) {
						toSend = Math.max(0, Math.min(100, Math.round(n)));
						$score.value = String(toSend);
					} else {
						$score.value = "";
						toSend = null;
					}
				}
			
				setSaving($scoreWrap, true);
				try {
					await setMyScore(cloudKey, toSend);
					flashSaved($scoreWrap);
				} catch {
					// keep silent like now
				} finally {
					setSaving($scoreWrap, false);
				}
			};

			$score.addEventListener("change", saveScore);
			$score.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					$score.blur();
				}
			});
		}
	}

	const idx = await loadIndex();
	const all = Array.isArray(idx.items) ? idx.items : [];

	// include toSku + all fromSkus mapped to it
	const skuGroup = rules.groupForCanonical(sku);

	// index.json includes removed rows too. Split live vs all.
	const allRows = all.filter((x) => skuGroup.has(String(keySkuForRow(x) || "")));
	const liveRows = allRows.filter((x) => !Boolean(x?.removed));

	if (!allRows.length) {
		$title.textContent = "Item not found";
		setStatusText("No matching SKU in index.");
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

	function rowMinPrice(r) {
		const p = parsePriceToNumber(r?.price);
		return p === null ? Infinity : p;
	}

	const linkRows = Array.from(bestByStore.entries())
		.map(([store, r]) => ({ store, r }))
		.sort((A, B) => {
			// 1) cheapest current price first (Infinity sorts to end)
			const ap = rowMinPrice(A.r);
			const bp = rowMinPrice(B.r);
			if (ap !== bp) return ap - bp;

			// 2) live before removed
			const ar = Boolean(A.r?.removed) ? 1 : 0;
			const br = Boolean(B.r?.removed) ? 1 : 0;
			if (ar !== br) return ar - br;

			// 3) stable fallback
			return A.store.localeCompare(B.store);
		});

	setLinksHtml(linkRows
		.map(({ store, r }) => {
			const href = String(r.url || "").trim();
			const suffix = Boolean(r?.removed) ? " (removed)" : "";
			return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(store + suffix)}</a>`;
		})
		.join(""));

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

	setStatusText(isRemovedEverywhere
		? `Item is removed everywhere (showing historical chart across ${dbFiles.length} store file(s))…`
		: `Loading history for ${dbFiles.length} store file(s)...`);

	const manifest = await loadDbCommitsManifest();

	// Shared caches across all stores
	const fileJsonCache = new Map(); // ck(sha|path) -> parsed JSON
	const inflightFetch = new Map(); // ck -> Promise
	const today = dateOnly(idx.generatedAt || new Date().toISOString());

	// Tuning knobs:
	// - keep compute modest: only a few stores processed simultaneously
	// - make network aggressive: many file-at-sha fetches in-flight globally
	const DBFILE_CONCURRENCY = 3;
	const NET_CONCURRENCY = 16;
	const limitNet = makeLimiter(NET_CONCURRENCY);

	const MAX_POINTS = 260;

	// process ONE dbFile, but return MULTIPLE series: one per skuKey that exists in this file
	async function processDbFile(dbFile) {
		const rowsAll = byDbFileAll.get(dbFile) || [];
		if (!rowsAll.length) return [];

		const storeLabel = String(rowsAll[0]?.storeLabel || rowsAll[0]?.store || dbFile);

		// Variant keys in this store/dbFile (e.g. ["805160","141495"])
		const variantKeys = Array.from(
			new Set(
				rowsAll
					.map((r) => String(keySkuForRow(r) || "").trim())
					.filter(Boolean)
					.filter((k) => skuGroup.has(k)),
			),
		).sort();

		const wantUrlsByVar = new Map(); // vk -> Set(urls)
		for (const vk of variantKeys) wantUrlsByVar.set(vk, new Set());

		for (const r of rowsAll) {
			const vk = String(keySkuForRow(r) || "").trim();
			if (!vk || !wantUrlsByVar.has(vk)) continue;
			const u = String(r?.url || "").trim();
			if (u) wantUrlsByVar.get(vk).add(u);
		}


		// Split rows by variant for "today" point
		const rowsLiveByVar = new Map();
		for (const r of rowsAll) {
			const k = String(keySkuForRow(r) || "").trim();
			if (!k || !variantKeys.includes(k)) continue;
			if (!Boolean(r?.removed)) {
				if (!rowsLiveByVar.has(k)) rowsLiveByVar.set(k, []);
				rowsLiveByVar.get(k).push(r);
			}
		}

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

		// Chronological sort
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

		// If all variants cached, return cached series
		const cachedOut = [];
		let missing = 0;
		for (const vk of variantKeys) {
			const cached = loadSeriesCache(sku, dbFile, cacheBust, vk);
			if (!cached?.points?.length) {
				missing++;
				continue;
			}
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
			cachedOut.push({ label: storeLabel, variantKey: vk, points, values, dates });
		}
		if (missing === 0) return cachedOut;

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

		// Aggressive global network fetch (dedup + throttled)
		async function loadAtSha(sha) {
			const ck = `${sha}|${dbFile}`;
			const cachedObj = fileJsonCache.get(ck);
			if (cachedObj) return cachedObj;

			const prev = inflightFetch.get(ck);
			if (prev) return prev;

			const p = limitNet(async () => {
				const obj = await githubFetchFileAtSha({ owner, repo, sha, path: dbFile });
				fileJsonCache.set(ck, obj);
				return obj;
			}).finally(() => {
				inflightFetch.delete(ck);
			});

			inflightFetch.set(ck, p);
			return p;
		}

		// Prefetch the last sha for each day (these are always needed)
		{
			const shas = [];
			for (const day of dayEntries) {
				const arr = day.commits;
				if (!arr?.length) continue;
				const sha = String(arr[arr.length - 1]?.sha || "");
				if (sha) shas.push(sha);
			}
			await Promise.all(shas.map((sha) => loadAtSha(sha).catch(() => null)));
		}

		// Build series for variants missing from cache
		const out = cachedOut.slice();

		const state = new Map(); // vk -> { points, values, dates, compactPoints, removedStreak, prevLive }
		for (const vk of variantKeys) {
			if (out.some((s) => s.variantKey === vk)) continue;
			state.set(vk, {
				points: new Map(),
				values: [],
				dates: [],
				compactPoints: [],
				removedStreak: false,
				prevLive: null,
			});
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

			for (const [vk, st] of state.entries()) {
				const wantRealSkus = new Set([vk].filter((x) => x && !String(x).startsWith("u:")));
				const skuKeysOne = [vk];

				const wantUrls = wantUrlsByVar.get(vk) || new Set();
				const lastMin = findMinPricesForSkuGroupInDb(objLast, wantRealSkus, skuKeysOne, storeLabel, wantUrls);
				const lastLive = lastMin.liveMin;
				const lastRemoved = lastMin.removedMin;

				// end-of-day removed state: no live but removed exists
				const endIsRemoved = lastLive === null && lastRemoved !== null;

				// If end-of-day is removed, find the LAST live price earlier the same day
				let sameDayLastLive = null;
				if (endIsRemoved && dayCommits.length > 1) {
					const firstSha = String(dayCommits[0]?.sha || "");
					if (firstSha) {
						try {
							const objFirst = await loadAtSha(firstSha);
							const firstMin = findMinPricesForSkuGroupInDb(objFirst, wantRealSkus, skuKeysOne, storeLabel, wantUrls);
							if (firstMin.liveMin !== null) {
								const candidates = [];
								for (let i = 0; i < dayCommits.length - 1; i++) {
									const sha = String(dayCommits[i]?.sha || "");
									if (sha) candidates.push(sha);
								}
								await Promise.all(candidates.map((sha) => loadAtSha(sha).catch(() => null)));

								for (let i = dayCommits.length - 2; i >= 0; i--) {
									const sha = String(dayCommits[i]?.sha || "");
									if (!sha) continue;
									try {
										const obj = await loadAtSha(sha);
										const m = findMinPricesForSkuGroupInDb(obj, wantRealSkus, skuKeysOne, storeLabel, wantUrls);
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
					st.removedStreak = false;
					st.prevLive = lastLive;
				} else if (endIsRemoved) {
					// first removed day => show dot (prefer removed price; else last live earlier that day; else prev live)
					if (!st.removedStreak) {
						v = lastRemoved !== null ? lastRemoved : sameDayLastLive !== null ? sameDayLastLive : st.prevLive;
						st.removedStreak = true;
					} else {
						v = null; // days AFTER removal: no dot
					}
				} else {
					v = null;
				}

				st.points.set(d, v);
				if (v !== null) st.values.push(v);
				st.compactPoints.push({ date: d, price: v });
				st.dates.push(d);
			}
		}

		// Add "today" point per variant ONLY if listing currently exists for that variant in this store/dbFile
		for (const [vk, st] of state.entries()) {
			const rowsLive = rowsLiveByVar.get(vk) || [];
			if (rowsLive.length) {
				let curMin = null;
				for (const r of rowsLive) {
					const p = parsePriceToNumber(r.price);
					if (p !== null) curMin = curMin === null ? p : Math.min(curMin, p);
				}
				if (curMin !== null) {
					st.points.set(today, curMin);
					st.values.push(curMin);
					st.compactPoints.push({ date: today, price: curMin });
					st.dates.push(today);
				}
			}

			saveSeriesCache(sku, dbFile, cacheBust, vk, st.compactPoints);
			out.push({ label: storeLabel, variantKey: vk, points: st.points, values: st.values, dates: st.dates });
		}

		return out;
	}

	const results = await mapLimit(dbFiles, DBFILE_CONCURRENCY, async (dbFile) => {
		try {
			return await processDbFile(dbFile); // array
		} catch {
			return [];
		}
	});

	const allDatesSet = new Set();
	const series = []; // per (store, variant)

	for (const arr of results) {
		for (const r of Array.isArray(arr) ? arr : []) {
			if (!r) continue;
			series.push(r);
			for (const d of r.dates) allDatesSet.add(d);
		}
	}

	const labels = [...allDatesSet].sort();
	if (!labels.length || !series.length) {
		setStatusText("No historical points found.");
		return;
	}

	// Group variants by store
	const variantsByStore = new Map(); // storeLabel -> series[]
	for (const s of series) {
		const k = String(s.label || "Store");
		if (!variantsByStore.has(k)) variantsByStore.set(k, []);
		variantsByStore.get(k).push(s);
	}

	// Merge per-store (min across variants) for sorting + markers
	function mergeStorePoints(vars) {
		const points = new Map();
		const values = [];
		for (const d of labels) {
			let v = null;
			for (const s of vars) {
				const vv = s.points.has(d) ? s.points.get(d) : null;
				if (Number.isFinite(vv)) v = v === null ? vv : Math.min(v, vv);
			}
			points.set(d, v);
			if (v !== null) values.push(v);
		}
		return { points, values };
	}

	const todayKey = today;

	const storeSeries = Array.from(variantsByStore.entries()).map(([label, vars]) => {
		const merged = mergeStorePoints(vars);
		const todayVal = merged.points.has(todayKey) ? merged.points.get(todayKey) : null;
		const lastVal = todayVal !== null ? todayVal : lastFiniteFromEnd(labels.map((d) => merged.points.get(d)));
		return { label, vars, merged, sortVal: Number.isFinite(lastVal) ? lastVal : null };
	});

	const storeSeriesSorted = storeSeries
		.slice()
		.sort((a, b) => {
			const av = a.sortVal,
				bv = b.sortVal;
			if (av === null && bv === null) return a.label.localeCompare(b.label);
			if (av === null) return 1;
			if (bv === null) return -1;
			if (av !== bv) return av - bv;
			return a.label.localeCompare(b.label);
		});

	const colorMap = buildStoreColorMap(storeSeriesSorted.map((x) => x.label));

	// Build datasets: multiple lines per store, same label, same color, same stroke
	const datasets = [];
	for (const st of storeSeriesSorted) {
		const base = storeColor(st.label, colorMap);
		const stroke = lighten(base, 0.25);

		// stable ordering within store so colors don't flicker
		const vars = st.vars.slice().sort((a, b) => String(a.variantKey).localeCompare(String(b.variantKey)));

		for (const s of vars) {
			datasets.push({
				label: st.label, // IMPORTANT: no SKU in label
				data: labels.map((d) => (s.points.has(d) ? s.points.get(d) : null)),
				spanGaps: false,
				tension: 0.15,
				backgroundColor: base,
				borderColor: stroke,
				pointBackgroundColor: base,
				pointBorderColor: stroke,
				borderWidth: datasetStrokeWidth(base),
			});
		}
	}

	// --- Compute marker values (use merged per-store series) ---
	const storeMeans = storeSeriesSorted
		.map((st) => ({ label: st.label, mean: weightedMeanByDuration(st.merged.points, labels) }))
		.filter((x) => Number.isFinite(x.mean));

	const bcMeans = storeMeans.filter((x) => isBcStoreLabel(x.label));
	const abMeans = storeMeans.filter((x) => !isBcStoreLabel(x.label));

	const markers = [];

	if (bcMeans.length >= 3) {
		const y = medianFinite(bcMeans.map((x) => x.mean));
		if (Number.isFinite(y)) markers.push({ y: Math.round(y), text: "BC" });
	}

	if (abMeans.length >= 3) {
		const y = medianFinite(abMeans.map((x) => x.mean));
		if (Number.isFinite(y)) markers.push({ y: Math.round(y), text: "Alberta" });
	}

	// Collect all finite values across ALL lines for y-scale + uniqueness check
	const allVals = [];
	for (const ds of datasets) {
		for (const v of ds.data) if (Number.isFinite(v)) allVals.push(v);
	}

	const ySug = computeSuggestedY(allVals);

	const MIN_STEP = 10; // never denser than $10
	const MAX_TICKS = 12; // cap tick count when span is huge

	const span = (ySug.suggestedMax ?? 0) - (ySug.suggestedMin ?? 0);
	const step = niceStepAtLeast(MIN_STEP, span, MAX_TICKS);

	// Target price: pick 3 lowest per-store mins (distinct stores), then average (>=3 stores)
	// Only show if there are at least 6 total unique price points (finite) across the chart.
	const uniquePricePoints = new Set(allVals.filter((v) => Number.isFinite(v)).map((v) => Math.round(v * 100)));
	const hasEnoughUniquePoints = uniquePricePoints.size >= 6;

	const storeMins = storeSeriesSorted
		.map((st) => ({ label: st.label, min: minFinite(st.merged.values) }))
		.filter((x) => Number.isFinite(x.min))
		.sort((a, b) => a.min - b.min);

	if (hasEnoughUniquePoints && storeMins.length >= 3) {
		const t = (storeMins[0].min + storeMins[1].min + storeMins[2].min) / 3;
		if (Number.isFinite(t)) markers.push({ y: Math.round(t), text: "Target" });
	}

	const markerYs = markers.map((m) => Number(m.y)).filter(Number.isFinite);

	// helper: approximate font px size from a CSS font string (Chart uses one)
	function fontPx(font) {
		const m = String(font || "").match(/(\d+(?:\.\d+)?)px/);
		return m ? Number(m[1]) : 12;
	}

	const ctx = $canvas.getContext("2d");
	CHART = new Chart(ctx, {
		type: "line",
		data: { labels, datasets },
		plugins: [StaticMarkerLinesPlugin],
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "nearest", intersect: false },

			// v2 fallback (plugin reads this)
			staticMarkerLines: {
				markers,
				color: "#7f8da3",
				alpha: 0.38,
				lineWidth: 1.25,
				labelColor: "#556274",
				axisInset: 2,
			},

			plugins: {
				// v3+ (plugin reads this too)
				staticMarkerLines: {
					markers,
					color: "#7f8da3",
					alpha: 0.38,
					lineWidth: 1.25,
					labelColor: "#556274",
					axisInset: 2,
				},

				// De-dupe legend items by label WITHOUT changing legend styling.
				legend: {
					display: true,
					labels: {
						generateLabels: (chart) => {
							const gen = Chart?.defaults?.plugins?.legend?.labels?.generateLabels;
							const items = typeof gen === "function" ? gen(chart) : [];

							const seen = new Map(); // text -> { item, idxs }
							for (const it of items) {
								const t = String(it.text || "");
								if (!seen.has(t)) {
									seen.set(t, { item: { ...it, _group: [it.datasetIndex] } });
								} else {
									seen.get(t).item._group.push(it.datasetIndex);
								}
							}

							// make "hidden" reflect ALL datasets in the group
							const out = [];
							for (const { item } of seen.values()) {
								const idxs = item._group || [item.datasetIndex];
								const allHidden = idxs.every((j) => chart.getDatasetMeta(j).hidden === true);
								out.push({ ...item, hidden: allHidden, datasetIndex: idxs[0], _group: idxs });
							}
							return out;
						},
					},
					onClick: (_e, legendItem, legend) => {
						const chart = legend.chart;
						const idxs = legendItem._group || [legendItem.datasetIndex];

						// toggle all as a group
						const anyVisible = idxs.some((j) => chart.getDatasetMeta(j).hidden !== true);
						for (const j of idxs) {
							if (typeof chart.setDatasetVisibility === "function") chart.setDatasetVisibility(j, !anyVisible);
							else chart.getDatasetMeta(j).hidden = anyVisible ? true : null;
						}
						chart.update();
					},
				},

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
			// layout: {
			// padding: { right: 18 }
			// },
			scales: {
				x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
				y: {
					...ySug,
					ticks: {
						stepSize: step,
						maxTicksLimit: MAX_TICKS,
						padding: 10,
						callback: function (v) {
							const val = Number(v);
							if (!Number.isFinite(val)) return "";

							// if no markers, normal label
							if (!markerYs.length || typeof this.getPixelForValue !== "function") {
								return `$${val.toFixed(0)}`;
							}

							const py = this.getPixelForValue(val);
							if (!Number.isFinite(py)) return `$${val.toFixed(0)}`;

							// derive a "collision window" from tick label height
							// Chart.js puts resolved font on ticks.font (v3+), otherwise fall back
							const tickFont = this?.options?.ticks?.font || this?.ctx?.font || "12px system-ui";

							const h = fontPx(
								typeof tickFont === "string"
									? tickFont
									: `${tickFont?.size || 12}px ${tickFont?.family || "system-ui"}`,
							);

							// hide if within 55% of label height (tweak 0.45–0.75)
							const COLLIDE_PX = Math.max(6, h * 0.75);

							for (const my of markerYs) {
								const pmy = this.getPixelForValue(my);
								if (!Number.isFinite(pmy)) continue;
								if (pmy < this.top || pmy > this.bottom) continue;

								if (Math.abs(py - pmy) <= COLLIDE_PX) return "";
							}

							return `$${val.toFixed(0)}`;
						},
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

	setStatusText(manifest
		? isRemovedEverywhere
			? `History loaded (removed everywhere). Source=prebuilt manifest. Points=${labels.length}.`
			: `History loaded from prebuilt manifest (multi-commit/day) + current run. Points=${labels.length}.`
		: isRemovedEverywhere
			? `History loaded (removed everywhere). Source=GitHub API fallback. Points=${labels.length}.`
			: `History loaded (GitHub API fallback; multi-commit/day) + current run. Points=${labels.length}.`);
}
