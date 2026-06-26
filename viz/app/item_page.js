import { esc, renderThumbHtml, dateOnly } from "./dom.js";
import { goBack, peekBack } from "./nav.js";
import { parsePriceToNumber, keySkuForRow, displaySku } from "./sku.js";
import { loadIndex } from "./state.js";
import { fetchJson, isLocalWriteMode, apiWriteSkuHidden } from "./api.js";
import { loadSkuRules } from "./mapping.js";
import { loadHiddenSet, isHiddenListing, clearHiddenSetCache } from "./hidden.js";
import { normalizeStoreId, storeById, cityLabel } from "./stores.js";
import { buildStoreColorMap, storeColor, datasetStrokeWidth, lighten } from "./storeColors.js";
import { favStarHtml, loadMyFavouritesSet, installFavStars } from "./fav_star.js";
import { unifySameStoreEntries } from "./rarity.js";
import { selectBestDisplayInfo } from "./catalog.js";
import { getAuthStatus, getMySampled, getMyScore, setMySampled, setMyScore } from "./cloud.js";
import {
	isBcStoreLabel,
	weightedMeanByDuration,
	minFinite,
	medianFinite,
	lastFiniteFromEnd,
	computeSuggestedY,
	computeHighOutlierCap,
	niceStepAtLeast,
	StaticMarkerLinesPlugin,
} from "./item_page/item_chart.js";

/* ---------------- Chart lifecycle ---------------- */

let CHART = null;

export function destroyChart() {
	if (CHART) {
		CHART.destroy();
		CHART = null;
	}
}

// Renders the off-canvas store legend (#chartLegend). A store can have several
// SKU variants (multiple datasets share one store label), so entries are grouped
// by label and clicking toggles the whole group's visibility — mirroring the old
// on-canvas legend's de-dup + group-toggle behavior.
function buildChartLegend(chart) {
	const panel = document.getElementById("chartLegend");
	const list = document.getElementById("chartLegendList");
	const countEl = document.getElementById("chartLegendCount");
	if (!panel || !list || !countEl) return;

	const groups = new Map(); // store label -> { color, idxs }
	chart.data.datasets.forEach((ds, i) => {
		const label = String(ds.label || "");
		if (!label) return;
		if (!groups.has(label)) groups.set(label, { color: ds.borderColor, idxs: [] });
		groups.get(label).idxs.push(i);
	});

	if (groups.size === 0) {
		panel.hidden = true;
		return;
	}

	panel.hidden = false;
	countEl.textContent = `Stores (${groups.size})`;

	const frag = document.createDocumentFragment();
	for (const [label, { color, idxs }] of groups) {
		const allHidden = idxs.every((j) => chart.getDatasetMeta(j).hidden === true);
		const item = document.createElement("button");
		item.type = "button";
		item.className = "chartLegendItem" + (allHidden ? " dimmed" : "");
		const swatch = typeof color === "string" ? color : "var(--muted)";
		item.innerHTML = `<span class="chartLegendSwatch" style="background:${esc(swatch)}"></span><span class="chartLegendLabel">${esc(label)}</span>`;
		item.addEventListener("click", () => {
			const anyVisible = idxs.some((j) => chart.getDatasetMeta(j).hidden !== true);
			for (const j of idxs) {
				if (typeof chart.setDatasetVisibility === "function") chart.setDatasetVisibility(j, !anyVisible);
				else chart.getDatasetMeta(j).hidden = anyVisible ? true : null;
			}
			chart.update();
			item.classList.toggle("dimmed", anyVisible);
		});
		frag.appendChild(item);
	}
	list.replaceChildren(frag);
}

/* ---------------- SKU history from pre-built cache files ---------------- */

function storeIdFromDbFile(dbFile) {
	const s = String(dbFile || "");
	const base = s.slice(s.lastIndexOf("/") + 1).replace(/\.json$/i, "");
	const m = base.match(/^([^_]+)__/);
	return m ? m[1] : "";
}

async function loadSkuHistory(skuGroup, today, hiddenSet) {
	const fetches = [...skuGroup].map((sku) =>
		fetchJson(`./data/skus/${encodeURIComponent(sku)}.json`).catch(() => null),
	);
	const results = await Promise.all(fetches);

	const allDatesSet = new Set();
	allDatesSet.add("2026-01-19"); // earliest data branch commit
	allDatesSet.add(today);

	// Merge multi-category-DB entries at the same physical store before walking
	// events — otherwise an item that migrated categories shows two confused
	// series on the chart, one IS-only, one OOS-only. See rarity.js notes.
	for (const cache of results) {
		if (!cache?.stores) continue;
		cache.stores = unifySameStoreEntries(cache.stores);
		for (const store of Object.values(cache.stores)) {
			for (const ev of Array.isArray(store?.events) ? store.events : []) {
				const d = dateOnly(ev.ts);
				if (d) allDatesSet.add(d);
			}
		}
	}

	// Expand to every calendar day so the x-axis has proportional time spacing
	// and forward-fill produces a dot on every in-stock day.
	const allDatesArray = [...allDatesSet].sort();
	const minDate = allDatesArray[0];
	const maxDate = allDatesArray[allDatesArray.length - 1];
	const labels = [];
	const cursor = new Date(minDate + "T12:00:00Z");
	const endMs = new Date(maxDate + "T12:00:00Z").getTime();
	while (cursor.getTime() <= endMs) {
		labels.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	const series = [];

	for (const cache of results) {
		if (!cache?.sku || !cache.stores) continue;
		const sku = cache.sku;

		for (const [dbFile, store] of Object.entries(cache.stores)) {
			if (hiddenSet && hiddenSet.size > 0) {
				const sid = storeIdFromDbFile(dbFile);
				if (sid && isHiddenListing(hiddenSet, sid, sku)) continue;
			}

			const events = Array.isArray(store?.events) ? store.events : [];
			if (!events.length) continue;

			// Per day we track TWO things separately:
			//   - lastEventByDay: end-of-day state, governs forward-fill into subsequent days
			//   - lastPriceByDay: best in-stock observation on that day, governs the plotted point
			// Without this split, an item that appeared and was removed on the same day would
			// render zero points (the removed event would shadow the price event in the map).
			const lastEventByDay = new Map();
			const lastPriceByDay = new Map();
			for (const ev of events) {
				const d = dateOnly(ev.ts);
				if (!d) continue;
				lastEventByDay.set(d, ev);
				if ("p" in ev) lastPriceByDay.set(d, ev);
			}

			const points = new Map();
			const values = [];
			const dates = [];
			let currentPrice = null;
			let isActive = false;

			for (const date of labels) {
				const priceEv = lastPriceByDay.get(date);
				const lastEv = lastEventByDay.get(date);

				// If we observed a price today, plot it (even if a removal followed later that day).
				let v;
				if (priceEv) {
					v = parsePriceToNumber(priceEv.p);
				} else {
					v = isActive ? currentPrice : null;
				}
				points.set(date, v);
				if (v !== null) values.push(v);
				dates.push(date);

				// End-of-day state determines what next days' forward-fill looks like.
				if (lastEv) {
					if ("p" in lastEv) {
						currentPrice = parsePriceToNumber(lastEv.p);
						isActive = true;
					} else {
						currentPrice = null;
						isActive = false;
					}
				}
			}

			series.push({ label: store.label || dbFile, variantKey: sku, points, values, dates });
		}
	}

	return { series, labels };
}

/* ---------------- Page ---------------- */

export async function renderItem($app, skuInput) {
	destroyChart();

	// Kick off independent fetches immediately — no dependency on rules/sku
	const idxPromise = loadIndex();

	const [rules, fav] = await Promise.all([loadSkuRules(), loadMyFavouritesSet()]);

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
		<div class="container detailContainer">
			<div class="topbar">
				<a id="back" class="btn" href="${peekBack()}"><span class="backArrow">← </span>Back</a>
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

						<!-- DESKTOP links stay here; status/loadingBar moved below the header -->
						<div id="links" class="links"></div>
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

				<!-- DESKTOP: store links dropdown on its own line below header -->
				<div id="linksDropdown" class="links linksDropdown"></div>

				<!-- DESKTOP debug/status below the whole header (both columns) -->
				<div class="small detailStatus" id="status"></div>
				<div class="loadingBar" id="loadingBar"><div class="loadingBarFill"></div></div>

				<!-- MOBILE full-width links/status (different ids, no collisions) -->
				<div class="detailMobileLinks">
				<div id="linksMobile" class="links"></div>
				<div class="small" id="statusMobile"></div>
				<div class="loadingBar" id="loadingBarMobile"><div class="loadingBarFill"></div></div>
				</div>

				<div class="chartBox">
				<canvas id="chart"></canvas>
				</div>
				<details class="chartLegend" id="chartLegend" hidden>
				<summary><span id="chartLegendCount">Stores</span></summary>
				<div class="chartLegendList" id="chartLegendList"></div>
				</details>
			</div>
			</div>
		`;

	installFavStars($app, favSet);

	document.getElementById("back").addEventListener("click", (e) => {
		if (e.ctrlKey || e.metaKey || e.shiftKey) return;
		e.preventDefault();
		goBack();
	});

	const $title = document.getElementById("title");
	const $links = document.getElementById("links");
	const $status = document.getElementById("status");
	const $canvas = document.getElementById("chart");
	const $thumbBox = document.getElementById("thumbBox");

	const $linksMobile = document.getElementById("linksMobile");
	const $linksDropdown = document.getElementById("linksDropdown");
	const $statusMobile = document.getElementById("statusMobile");
	const $loadingBar = document.getElementById("loadingBar");
	const $loadingBarMobile = document.getElementById("loadingBarMobile");

	function setProgress(done, total) {
		const pct = total > 0 ? Math.round((done / total) * 100) : 0;
		for (const $bar of [$loadingBar, $loadingBarMobile]) {
			if (!$bar) continue;
			const $fill = $bar.querySelector(".loadingBarFill");
			if ($fill) $fill.style.width = pct + "%";
			$bar.classList.toggle("loadingBarActive", pct > 0 && pct < 100);
		}
	}

	function clearProgress() {
		for (const $bar of [$loadingBar, $loadingBarMobile]) {
			if (!$bar) continue;
			$bar.classList.remove("loadingBarActive");
			const $fill = $bar.querySelector(".loadingBarFill");
			if ($fill) $fill.style.width = "0%";
		}
	}

	const setLinksHtml = (html) => {
		if ($links) $links.innerHTML = html;
		if ($linksMobile) $linksMobile.innerHTML = html;
	};

	const setStatusText = (txt) => {
		if ($status) $status.textContent = txt;
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
				try {
					$score.select();
				} catch {}
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
				try {
					$score.select();
				} catch {}
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

	const idx = await idxPromise;
	const hiddenSet = await loadHiddenSet().catch(() => new Set());
	const rawAll = Array.isArray(idx.items) ? idx.items : [];
	const all = hiddenSet && hiddenSet.size > 0
		? rawAll.filter((r) => !isHiddenListing(hiddenSet, normalizeStoreId(r?.storeLabel || r?.store || ""), keySkuForRow(r)))
		: rawAll;

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

	// pick best name and image using shared priority logic (store hierarchy + photo + name length)
	const basis = liveRows.length ? liveRows : allRows;
	const { bestName, bestImg } = selectBestDisplayInfo(basis);
	$title.textContent = bestName || `(SKU ${sku})`;
	$thumbBox.innerHTML = bestImg
		? renderThumbHtml(bestImg, "detailThumb")
		: `<div class="thumbPlaceholder"></div>`;

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

	const canHide = isLocalWriteMode();

	// Pinned quick-links: cheapest overall, then cheapest *distinct* store in
	// Vancouver / Victoria. If the cheapest overall is in a BC city, that city's
	// label replaces the province and its dedicated pin is skipped (no duplicate).
	// If the cheapest Vancouver and Victoria stores happen to be the same store
	// (e.g. BCL spans both), only one pin is shown with a combined label.
	// When 3 or fewer live stores carry the item, all are shown as featured pins.
	// The "All stores" dropdown is always shown separately below the header.
	const liveLinkRows = linkRows.filter(({ r }) => rowMinPrice(r) < Infinity && !Boolean(r?.removed));
	const storeOf = (r) => storeById(normalizeStoreId(r?.storeLabel || r?.store || ""));
	const citiesOf = (r) => {
		const st = storeOf(r);
		return st && Array.isArray(st.cities) ? st.cities : [];
	};

	const pinned = [];
	const seenPin = new Set();
	const addPin = (row, extra) => {
		if (!row || seenPin.has(row.store)) return;
		seenPin.add(row.store);
		pinned.push({ ...row, ...extra });
	};

	const showAllAsFeatured = liveLinkRows.length <= 3 && liveLinkRows.length > 0;

	// Per-store state for subtle visual indicators
	const bestPrice = liveLinkRows.length ? rowMinPrice(liveLinkRows[0].r) : Infinity;
	const storeState = new Map(); // store -> "best" | "exclusive" | "lastStock"
	for (const { store, r } of linkRows) {
		const isLive = !Boolean(r?.removed);
		if (!isLive) continue;
		if (linkRows.length === 1) {
			storeState.set(store, "exclusive");
		} else if (liveLinkRows.length === 1) {
			storeState.set(store, "lastStock");
		} else if (liveLinkRows.length > 1 && rowMinPrice(r) === bestPrice) {
			storeState.set(store, "best");
		}
	}

	if (showAllAsFeatured) {
		for (const row of liveLinkRows) {
			addPin(row, {});
		}
	} else {
		const cheapestRow = liveLinkRows[0];
		if (cheapestRow) {
			const cheapestCities = citiesOf(cheapestRow.r);
			const servesVan = cheapestCities.includes("vancouver");
			const servesVic = cheapestCities.includes("victoria");

			if (servesVan && servesVic) {
				addPin(cheapestRow, { hint: "Cheapest overall", cities: ["vancouver", "victoria"] });
			} else if (servesVan) {
				addPin(cheapestRow, { hint: "Cheapest in Vancouver", city: "vancouver" });
			} else if (servesVic) {
				addPin(cheapestRow, { hint: "Cheapest in Victoria", city: "victoria" });
			} else {
				addPin(cheapestRow, { hint: "Cheapest overall" });
			}

			if (!servesVan && !servesVic) {
				// Neither city covered → find cheapest Van and Vic separately
				const vanRow = liveLinkRows.find(({ r, store }) => !seenPin.has(store) && citiesOf(r).includes("vancouver"));
				const vicRow = liveLinkRows.find(({ r, store }) => !seenPin.has(store) && citiesOf(r).includes("victoria"));
				if (vanRow && vicRow && vanRow.store === vicRow.store) {
					addPin(vanRow, { hint: "Cheapest in Vancouver & Victoria", cities: ["vancouver", "victoria"] });
				} else {
					addPin(vanRow, { hint: "Cheapest in Vancouver", city: "vancouver" });
					addPin(vicRow, { hint: "Cheapest in Victoria", city: "victoria" });
				}
			} else if (!servesVic) {
				// Only Vancouver covered → find cheapest Victoria store
				addPin(
					liveLinkRows.find(({ r, store }) => !seenPin.has(store) && citiesOf(r).includes("victoria")),
					{ hint: "Cheapest in Victoria", city: "victoria" },
				);
			}
			// If both covered → already done (cheapest overall has both city labels)
		}
	}

	const pinnedHtml = pinned.length
		? `<div class="storeQuickLinks">${pinned
				.map(({ store, r, hint, city, cities }) => {
					const href = String(r.url || "").trim();
					const num = rowMinPrice(r);
					const priceStr = Number.isFinite(num) ? `$${num.toFixed(2)}` : "";
					const st = storeOf(r);
					const province = st?.region ? st.region.toUpperCase() : "";
					let loc;
					if (city) {
						loc = cityLabel(city);
					} else if (cities) {
						loc = cities.map(cityLabel).join(" and ");
					} else {
						loc = province;
					}
					const locHtml = loc ? `<span class="sqlLoc">${esc(loc)}</span>` : "";
					const stCls = storeState.get(store) || "";
					const stAttr = stCls ? ` storeState${stCls.charAt(0).toUpperCase() + stCls.slice(1)}` : "";
					return `<a class="storeQuickLink${stAttr}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(hint || "")}"><span class="sqlInfo"><span class="sqlStore">${esc(store)}</span>${locHtml}</span><span class="sqlPrice">${esc(priceStr)}</span></a>`;
				})
				.join("")}</div>`
		: "";

	const liveListRows = linkRows.filter(({ r }) => !Boolean(r?.removed));
	const removedListRows = linkRows.filter(({ r }) => Boolean(r?.removed));

	function rowLinkHtml({ store, r }, isRemoved) {
		const href = String(r.url || "").trim();

		const num = rowMinPrice(r);
		const priceStr = Number.isFinite(num) ? `$${num.toFixed(2)}` : "";
		const priceHtml = priceStr ? `<span class="sqlPrice">${esc(priceStr)}</span>` : "";

		const st = storeOf(r);
		const province = st?.region ? st.region.toUpperCase() : "";
		let loc = province;
		const locHtml = loc ? `<span class="sqlLoc">${esc(loc)}</span>` : "";

		const cssClasses = [];
		if (isRemoved) cssClasses.push("storeRemoved");
		const stCls = storeState.get(store) || "";
		if (stCls) cssClasses.push("storeState" + stCls.charAt(0).toUpperCase() + stCls.slice(1));
		const cls = cssClasses.length ? ` class="${cssClasses.join(" ")}"` : "";
		const anchor = `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${cls}><span class="sqlInfo"><span class="sqlStore">${esc(store)}</span>${locHtml}</span>${priceHtml}</a>`;
		let inner = anchor;
		if (canHide) {
			const sid = normalizeStoreId(r?.storeLabel || r?.store || "");
			const rawSku = String(keySkuForRow(r) || "");
			if (sid && rawSku) {
				const title = `Hide this listing at ${store} (storeId=${sid}, sku=${rawSku})`;
				inner = `${anchor}<button type="button" class="hideListingBtn" data-storeid="${esc(sid)}" data-sku="${esc(rawSku)}" data-store-label="${esc(store)}" title="${esc(title)}" aria-label="${esc(title)}">✕</button>`;
			}
		}
		return `<span class="storeLinkRow">${inner}</span>`;
	}

	let summaryBtnHtml = "";
	let listContentHtml = "";
	let listHtmlMobile = "";
	let bothCategories = false;
	if (linkRows.length > 0) {
		const liveHtml = liveListRows.map((r) => rowLinkHtml(r, false));
		const removedHtml = removedListRows.map((r) => rowLinkHtml(r, true));
		bothCategories = liveHtml.length > 0 && removedHtml.length > 0;
		let summary;
		if (removedHtml.length === 0) {
			summary = `In stock (${liveHtml.length})`;
		} else if (liveHtml.length === 0) {
			summary = `Out of stock (${removedHtml.length})`;
		} else {
			summary = `In stock (${liveHtml.length}) · Out of stock (${removedHtml.length})`;
		}
		const inner = liveHtml.join("")
			+ (liveHtml.length && removedHtml.length ? `<hr class="storeListDivider">` : "")
			+ removedHtml.join("");

		if (bothCategories) {
			// Both categories — toggle between them
			summaryBtnHtml = `<button class="storeLinksToggle" type="button">${esc(summary)} <span class="storeLinksChevron">▾</span></button>`;
			listContentHtml = `<div class="storeLinksList">${inner}</div>`;
			listHtmlMobile = `<details class="storeLinksMore"><summary>${esc(summary)}</summary><div class="storeLinksList">${inner}</div></details>`;
		} else {
			// Only one category — show list directly
			listContentHtml = `<div class="storeLinksList">${inner}</div>`;
			listHtmlMobile = `<div class="storeLinksList">${inner}</div>`;
		}
	}

	if ($links) $links.innerHTML = pinnedHtml + summaryBtnHtml;
	if ($linksDropdown) {
		$linksDropdown.innerHTML = listContentHtml;
		if (!bothCategories) $linksDropdown.classList.add("linksDropdownOpen");
	}
	if ($linksMobile) $linksMobile.innerHTML = pinnedHtml + listHtmlMobile;

	// Toggle desktop dropdown
	if ($links) {
		$links.addEventListener("click", (ev) => {
			const btn = ev.target.closest(".storeLinksToggle");
			if (!btn || !$linksDropdown) return;
			const wasOpen = $linksDropdown.classList.contains("linksDropdownOpen");
			ev.preventDefault();
			$linksDropdown.classList.toggle("linksDropdownOpen");
			btn.classList.toggle("storeLinksToggleOpen");
			if (!wasOpen) {
				requestAnimationFrame(() => $linksDropdown.scrollIntoView({ block: "start", behavior: "smooth" }));
			}
		});
	}

	if (canHide) {
		const onHideClick = async (ev) => {
			const btn = ev.target.closest(".hideListingBtn");
			if (!btn) return;
			ev.preventDefault();
			ev.stopPropagation();
			const sid = btn.getAttribute("data-storeid") || "";
			const rawSku = btn.getAttribute("data-sku") || "";
			if (!sid || !rawSku) return;
			btn.disabled = true;
			try {
				await apiWriteSkuHidden(sid, rawSku, "");
				clearHiddenSetCache();
				const h = location.hash || "";
				location.hash = "#/";
				setTimeout(() => { location.hash = h; }, 0);
			} catch (e) {
				btn.disabled = false;
				console.error("Failed to hide listing:", e);
			}
		};
		for (const el of [$links, $linksMobile, $linksDropdown]) {
			if (el) el.addEventListener("click", onHideClick);
		}
	}

	const today = dateOnly(idx.generatedAt || new Date().toISOString());

	setStatusText(isRemovedEverywhere ? "Removed everywhere — loading history…" : "Loading history…");

	const { series, labels } = await loadSkuHistory(skuGroup, today, hiddenSet);

	if (!labels.length || !series.length) {
		clearProgress();
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
		const lastVal =
			todayVal !== null ? todayVal : lastFiniteFromEnd(labels.map((d) => merged.points.get(d)));
		return { label, vars, merged, sortVal: Number.isFinite(lastVal) ? lastVal : null };
	});

	const storeSeriesSorted = storeSeries.slice().sort((a, b) => {
		const av = a.sortVal,
			bv = b.sortVal;
		if (av === null && bv === null) return a.label.localeCompare(b.label);
		if (av === null) return 1;
		if (bv === null) return -1;
		if (av !== bv) return av - bv;
		return a.label.localeCompare(b.label);
	});

	const colorMap = buildStoreColorMap(storeSeriesSorted.map((x) => x.label));

	// --- If multiple points exist on a given date for the same store, only show the cheapest one ---
	const winnerByStoreDate = new Map(); // `${store}|${date}` -> variantKey
	for (const st of storeSeriesSorted) {
		const vars = st.vars
			.slice()
			.sort((a, b) => String(a.variantKey).localeCompare(String(b.variantKey)));
		for (const d of labels) {
			let bestKey = null;
			let bestVal = Infinity;
			for (const s of vars) {
				const v = s.points.has(d) ? s.points.get(d) : null;
				if (!Number.isFinite(v)) continue;
				if (v < bestVal) {
					bestVal = v;
					bestKey = s.variantKey;
				}
			}
			if (bestKey !== null) winnerByStoreDate.set(`${st.label}|${d}`, bestKey);
		}
	}
	const winKeyFor = (store, date) => winnerByStoreDate.get(`${store}|${date}`) ?? null;

	// Build datasets: multiple lines per store, same label, same color, same stroke
	const datasets = [];
	const suppressDots = window.innerWidth <= 640 && winnerByStoreDate.size > 50;
	for (const st of storeSeriesSorted) {
		const base = storeColor(st.label, colorMap);
		const stroke = lighten(base, 0.25);

		// stable ordering within store so colors don't flicker
		const vars = st.vars
			.slice()
			.sort((a, b) => String(a.variantKey).localeCompare(String(b.variantKey)));

		for (const s of vars) {
			datasets.push({
				label: st.label, // IMPORTANT: no SKU in label
				variantKey: s.variantKey,
				data: labels.map((d) => (s.points.has(d) ? s.points.get(d) : null)),
				spanGaps: false,
				tension: 0.15,
				backgroundColor: base,
				borderColor: stroke,
				pointBackgroundColor: base,
				pointBorderColor: stroke,
				borderWidth: datasetStrokeWidth(base),
				pointRadius: (ctx) => {
					if (suppressDots) return 0;
					const v = ctx.parsed?.y;
					if (!Number.isFinite(v)) return 0;
					const d = labels[ctx.dataIndex];
					return ctx.dataset.variantKey === winKeyFor(ctx.dataset.label, d) ? 3 : 0;
				},
				pointHoverRadius: (ctx) => {
					if (suppressDots) return 0;
					const v = ctx.parsed?.y;
					if (!Number.isFinite(v)) return 0;
					const d = labels[ctx.dataIndex];
					return ctx.dataset.variantKey === winKeyFor(ctx.dataset.label, d) ? 5 : 0;
				},
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

	// With many stores, one or two pricing way above the rest stretch the y-axis
	// and squash all the detail. Detect those and cap the axis; the min is never
	// capped so low prices always render as usual.
	const outlierInfo = computeHighOutlierCap(
		storeSeriesSorted.map((st) => ({
			label: st.label,
			rep: weightedMeanByDuration(st.merged.points, labels),
			values: st.merged.values,
		})),
	);
	const outlierCap = outlierInfo ? outlierInfo.cap : null;
	const outlierStores = outlierInfo ? outlierInfo.outliers : null;

	const isMobile = window.innerWidth <= 640;
	const ySug = computeSuggestedY(allVals, undefined, outlierCap, isMobile ? 0.01 : undefined);

	// Rather than let outlier lines clip away (the data point vanishes), clamp them
	// into a reserved band at the top so they "sit at the top". The true price is
	// kept on each dataset (_rawData) for the tooltip, and the line is dashed to
	// signal it is out of scale. yHardMax is a HARD axis max (suggestedMax is only a
	// hint Chart.js would expand past).
	let yHardMax;
	if (Number.isFinite(outlierCap) && outlierStores) {
		const lo = ySug.suggestedMin ?? 0;
		const range = Math.max(1, outlierCap - lo);
		const clampY = outlierCap + range * 0.12;
		yHardMax = outlierCap + range * 0.18;

		for (const ds of datasets) {
			if (!outlierStores.has(String(ds.label))) continue;
			ds._rawData = ds.data.slice();
			ds.data = ds.data.map((v) => (Number.isFinite(v) && v > clampY ? clampY : v));
			ds.borderDash = [5, 4];
		}
	}

	const MIN_STEP = 10; // never denser than $10
	const MAX_TICKS = 12; // cap tick count when span is huge

	const span = (ySug.suggestedMax ?? 0) - (ySug.suggestedMin ?? 0);
	const step = niceStepAtLeast(MIN_STEP, span, MAX_TICKS);

	// Target price: pick 3 lowest per-store mins (distinct stores), then average (>=3 stores)
	// Only show if there are at least 6 total unique price points (finite) across the chart.
	const uniquePricePoints = new Set(
		allVals.filter((v) => Number.isFinite(v)).map((v) => Math.round(v * 100)),
	);
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

			// v3 fallback (plugin reads this too)
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

				// On-canvas legend is replaced by a collapsible HTML panel below the
				// chart (#chartLegend) — see buildChartLegend() — so a 20-30 store
				// legend doesn't eat the plot height on mobile.
				legend: { display: false },

				tooltip: {
					filter: (tctx) => {
						const store = String(tctx.dataset?.label || "");
						const date = String(tctx.label || "");
						return tctx.dataset?.variantKey === winKeyFor(store, date);
					},
					callbacks: {
						label: (ctx) => {
							const ds = ctx.dataset;
							const raw = ds._rawData ? ds._rawData[ctx.dataIndex] : ctx.parsed?.y;
							const v = Number.isFinite(raw) ? raw : ctx.parsed?.y;
							if (!Number.isFinite(v)) return `${ds.label}: (no data)`;
							const suffix = ds._rawData ? "  ↑ above chart" : "";
							return `${ds.label}: $${v.toFixed(2)}${suffix}`;
						},
					},
				},
			},
			// layout: {
			// padding: { right: 18 }
			// },
			scales: {
				x: {
					ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: window.innerWidth <= 640 ? 3 : 12 },
					grid: { display: false },
				},
				y: {
					...ySug,
					max: yHardMax,
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
		const ySug2 = computeSuggestedY(allVals, undefined, outlierCap, isMobile ? 0.01 : undefined);

		CHART.options.scales.y.suggestedMin = ySug2.suggestedMin;
		CHART.options.scales.y.suggestedMax = ySug2.suggestedMax;
		if (Number.isFinite(yHardMax)) CHART.options.scales.y.max = yHardMax;
		CHART.options.scales.y.ticks.stepSize = 10;

		CHART.update();
	}

	buildChartLegend(CHART);

	clearProgress();
	setStatusText(
		isRemovedEverywhere
			? `History loaded (removed everywhere). Points=${labels.length}.`
			: `History loaded. Points=${labels.length}.`,
	);
}
