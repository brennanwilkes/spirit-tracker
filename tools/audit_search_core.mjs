#!/usr/bin/env node
// tools/audit_search_core.mjs — shared deterministic search core for SKU-link audits.
//
// Three pieces:
//   loadEnv(worktree)        — build the live ranker env (sets DATA_WORKTREE before
//                              dynamically importing tools/linker_ml/featurize.mjs, which
//                              resolves its WORKTREE at module load time).
//   buildSurface(...)        — the audit catalog surface: current aggregates + delisted
//                              history recovered by walking git history of data/db/** (cached).
//   buildBlockIndex / buildEmbeddingIndex — the union blocking index with five channels
//                              (distinctive token, topTerm, SMWS, title-twin, fuzzy/trigram)
//                              plus the embedding cosine channel. Reuses the LIVE ranker's
//                              vocab/similarity — never forks scoring.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

import { keySkuForRow } from "../viz/app/sku.js";
import { normalizeImplicitSkuKey } from "../viz/app/sku_canonical.js";
import { smwsKeyFromName, filterSimTokens } from "../viz/app/linker_page/similarity.js";

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CORE_DIR, "..");

export const DEFAULT_CACHE_FILE = path.join(REPO_ROOT, "audit", ".cache", "history_surface.json");

const ALIASES_PER_TOKEN = 8;

// Lazy built-in alias table (Phase 3). If the caller did not pass an explicit
// aliasTable, load the mined table from viz/app/linker_page/sku_aliases.js once at
// module scope. buildBlockIndex stays synchronous, so this cannot be deferred to call
// time; import failure (module missing) degrades to no aliases.
let BUILTIN_ALIAS_TABLE = null;
try {
	const aliasModule = await import(
		pathToFileURL(path.join(REPO_ROOT, "viz", "app", "linker_page", "sku_aliases.js")).href
	);
	BUILTIN_ALIAS_TABLE = aliasModule && typeof aliasModule.buildAliasTable === "function" ? aliasModule.buildAliasTable() : null;
} catch {
	BUILTIN_ALIAS_TABLE = null;
}

/* ---------------------------------------------------------------------------
 * 1. Live env
 * ------------------------------------------------------------------------- */

export async function loadEnv(worktree) {
	process.env.DATA_WORKTREE = worktree;
	const featurize = await import(pathToFileURL(path.join(CORE_DIR, "linker_ml", "featurize.mjs")).href);
	return featurize.buildEnv();
}

/* ---------------------------------------------------------------------------
 * 2. Surface (current + delisted history)
 * ------------------------------------------------------------------------- */

// Alnum-only lowercase title with sizes stripped ("700 mL"/"750ml"/"1.14l" all
// collapse) — the twin-channel bucket key. Mirrors audit_new_listings.js.
export function normNameForTwin(name) {
	return (name || "")
		.toLowerCase()
		.replace(/\b\d+(?:\.\d+)?\s?(?:ml|l|cl|oz|liter|litre)\b/gi, "")
		.replace(/[^a-z0-9]+/g, "")
		.trim();
}

function lfsPointer(out) {
	return !out || out.includes("git-lfs.github.com") || out.startsWith("version https://git-lfs.github.com");
}

async function recoverDelisted({ worktree, currentNormKeys, cacheFile }) {
	const dbCommitsPath = path.join(worktree, "viz", "data", "db_commits.json");
	let generatedAt = "";
	try {
		const dbCommits = JSON.parse(fs.readFileSync(dbCommitsPath, "utf8"));
		generatedAt = dbCommits.generatedAt || "";
	} catch {
		return { records: [], fromCache: false, generatedAt: null };
	}

	if (cacheFile && fs.existsSync(cacheFile)) {
		try {
			const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
			if (cached.dbCommitsGeneratedAt === generatedAt && Array.isArray(cached.delisted)) {
				return { records: cached.delisted, fromCache: true, generatedAt };
			}
		} catch {
			/* corrupt cache -> rebuild */
		}
	}

	const records = new Map(); // normKey -> {sku,normKey,name,storeLabel,price,category}
	const files = {};
	try {
		const dbCommits = JSON.parse(fs.readFileSync(dbCommitsPath, "utf8"));
		Object.assign(files, dbCommits.files || {});
	} catch {
		return { records: [], fromCache: false, generatedAt: null };
	}
	const fileKeys = Object.keys(files);
	const walkStart = Date.now();
	let n = 0;
	try {
		for (const [relPath, commits] of Object.entries(files)) {
			n++;
			if (n % 20 === 0) {
				process.stderr.write(`  history walk: ${n}/${fileKeys.length} files (${Date.now() - walkStart}ms)\n`);
			}
			for (const c of commits) {
				let out;
				try {
					out = execFileSync("git", ["show", `${c.sha}:${relPath}`], {
						cwd: worktree,
						encoding: "utf8",
						maxBuffer: 64 * 1024 * 1024,
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch {
					continue;
				}
				if (lfsPointer(out)) continue;
				let parsed;
				try {
					parsed = JSON.parse(out);
				} catch {
					continue;
				}
				const storeLabel = parsed && (parsed.storeLabel || parsed.store || "");
				const category = parsed && (parsed.categoryLabel || parsed.category || "");
				const its = parsed && Array.isArray(parsed.items) ? parsed.items : [];
				for (const it of its) {
					const s = String(it && it.sku || "");
					if (!s || !it.name) continue;
					const nk = normalizeImplicitSkuKey(s);
					if (!nk || currentNormKeys.has(nk)) continue;
					// last seen wins (commits walked oldest -> newest)
					records.set(nk, {
						sku: nk,
						normKey: nk,
						name: it.name,
						storeLabel,
						price: it.price,
						category,
					});
				}
			}
		}
		process.stderr.write(`  history walk: done ${fileKeys.length} files, ${records.size} delisted skus (${Date.now() - walkStart}ms)\n`);
	} catch (e) {
		process.stderr.write(`  WARN: delisted history walk failed (${e.message}); degrading to current-only\n`);
		return { records: [...records.values()], fromCache: false, generatedAt };
	}

	if (cacheFile) {
		try {
			fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
			fs.writeFileSync(cacheFile, JSON.stringify({ dbCommitsGeneratedAt: generatedAt, delisted: [...records.values()] }));
		} catch {
			/* cache write is best-effort */
		}
	}
	return { records: [...records.values()], fromCache: false, generatedAt };
}

export async function buildSurface({ worktree, env, includeDelisted = true, cacheFile }) {
	cacheFile = cacheFile || DEFAULT_CACHE_FILE;
	const items = [];
	const byKey = new Map();
	for (const a of env.allAgg || []) {
		const sku = String(a.sku || "");
		if (!sku) continue;
		const item = {
			sku,
			normKey: normalizeImplicitSkuKey(sku),
			name: a.name || "",
			stores: a.stores instanceof Set ? a.stores : new Set(a.stores || []),
			cheapestPriceNum: a.cheapestPriceNum ?? null,
			category: a.category || "",
			delisted: false,
		};
		items.push(item);
		if (!byKey.has(item.sku)) byKey.set(item.sku, item);
		if (!byKey.has(item.normKey)) byKey.set(item.normKey, item);
	}

	let delisted = [];
	let fromCache = false;
	if (includeDelisted) {
		const currentNormKeys = new Set();
		for (const it of items) currentNormKeys.add(it.normKey);
		const rec = await recoverDelisted({ worktree, currentNormKeys, cacheFile });
		delisted = rec.records;
		fromCache = rec.fromCache;
		for (const r of delisted) {
			const item = {
				sku: r.sku,
				normKey: r.normKey,
				name: r.name || "",
				stores: new Set([r.storeLabel].filter(Boolean)),
				cheapestPriceNum: parseFloat(String(r.price == null ? "" : r.price).replace(/[^0-9.]/g, "")) || null,
				category: r.category || "",
				delisted: true,
			};
			items.push(item);
			if (!byKey.has(item.sku)) byKey.set(item.sku, item);
			if (!byKey.has(item.normKey)) byKey.set(item.normKey, item);
		}
	}

	return {
		items,
		byKey,
		stats: {
			current: items.length - delisted.length,
			delisted: delisted.length,
			fromCache,
			byChannel: {},
		},
	};
}

/* ---------------------------------------------------------------------------
 * 3. Blocking index (union of channels)
 * ------------------------------------------------------------------------- */

function tokenizeLetterTokens(name) {
	const raw = String(name || "")
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, " ")
		.split(/\s+/)
		.filter(Boolean);
	// filterSimTokens drops the scorer's stoplist (whisky/single/malt/cask/…) and is
	// order-sensitive, so it gets raw ordered tokens. Without it every generic word is
	// a fuzzy seed pulling maxPerKey items each.
	return filterSimTokens(raw).filter((t) => /^[a-z]{3,}$/.test(t));
}

// Bounded Levenshtein with early exit when the running row minimum exceeds max.
function levBounded(a, b, maxLev) {
	if (Math.abs(a.length - b.length) > maxLev) return maxLev + 1;
	if (a === b) return 0;
	const n = a.length;
	const m = b.length;
	let prev = new Array(m + 1);
	let cur = new Array(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		cur[0] = i;
		let rowMin = cur[0];
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= m; j++) {
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
			if (cur[j] < rowMin) rowMin = cur[j];
		}
		if (rowMin > maxLev) return maxLev + 1;
		[prev, cur] = [cur, prev];
	}
	return prev[m];
}

export function loadSkuLinkPolicy(worktree) {
	const p = path.join(worktree, "data", "sku_link_policy.md");
	let md;
	try {
		md = fs.readFileSync(p, "utf8");
	} catch {
		return { exists: false };
	}
	const rules = [];
	for (const line of md.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("|")) continue;
		const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
		if (cells.length < 4) continue;
		if (/^class$/i.test(cells[0])) continue;
		if (/^[-:\s]+$/.test(cells[0])) continue;
		if (!cells[0]) continue;
		rules.push({ class: cells[0], linkDefault: cells[1], notes: cells[2], examples: cells[3] });
	}
	return { exists: true, md, rules };
}

export function buildBlockIndex(items, { vocab, similarity, aliasTable = null }) {
	const table = aliasTable == null ? BUILTIN_ALIAS_TABLE : aliasTable;
	const indexBySku = new Map();
	items.forEach((it, i) => {
		if (it.sku && !indexBySku.has(it.sku)) indexBySku.set(it.sku, i);
		if (it.normKey && !indexBySku.has(it.normKey)) indexBySku.set(it.normKey, i);
	});

	const distIndex = new Map(); // token -> Set<itemIndex>
	const topTermIndex = new Map(); // token -> Set<itemIndex>
	const smwsBucket = new Map(); // cask key -> Set<itemIndex>
	const twinBucket = new Map(); // normNameForTwin -> Set<itemIndex>
	const tokenItems = new Map(); // letter token -> Set<itemIndex>
	const trigramTokens = new Map(); // trigram -> Set<token>

	const addIdx = (m, k, i) => {
		if (!m || k == null || k === "") return;
		let s = m.get(k);
		if (!s) m.set(k, (s = new Set()));
		s.add(i);
	};

	for (let i = 0; i < items.length; i++) {
		const name = items[i].name || "";
		for (const t of vocab.distinctiveUnigramsForName(name) || []) addIdx(distIndex, t, i);
		const tt = vocab.topTerm(name);
		if (tt && tt.term) addIdx(topTermIndex, tt.term, i);
		addIdx(smwsBucket, similarity.smwsKeyFromName(name), i);
		addIdx(twinBucket, normNameForTwin(name), i);
		for (const t of tokenizeLetterTokens(name)) {
			addIdx(tokenItems, t, i);
			for (let g = 0; g + 3 <= t.length; g++) {
				const tri = t.slice(g, g + 3);
				let s = trigramTokens.get(tri);
				if (!s) trigramTokens.set(tri, (s = new Set()));
				s.add(t);
			}
		}
	}

	const trigramCache = new Map();
	const trigramsOf = (tok) => {
		let v = trigramCache.get(tok);
		if (!v) {
			v = [];
			for (let g = 0; g + 3 <= tok.length; g++) v.push(tok.slice(g, g + 3));
			trigramCache.set(tok, v);
		}
		return v;
	};

	const fuzzyCache = new Map(); // token -> Set<variant tokens>
	const fuzzyVariants = (tok) => {
		let v = fuzzyCache.get(tok);
		if (v) return v;
		v = new Set();
		v.add(tok);
		if (table) {
			let added = 0;
			for (const a of table.get(tok) || []) {
				if (added >= ALIASES_PER_TOKEN) break;
				v.add(a);
				added++;
			}
		}
		const cands = new Set();
		for (const g of trigramsOf(tok)) {
			const s = trigramTokens.get(g);
			if (s) for (const t of s) cands.add(t);
		}
		for (const t of cands) {
			if (t === tok) continue;
			const lenDiff = Math.abs(t.length - tok.length);
			let ok = false;
			if (lenDiff <= 1 && levBounded(tok, t, 1) <= 1) ok = true;
			else if (tok.length >= 6 && lenDiff <= 2 && levBounded(tok, t, 2) <= 2) ok = true;
			if (ok) v.add(t);
		}
		fuzzyCache.set(tok, v);
		return v;
	};

	const fuzzyTokensForName = (name) => {
		const out = new Set();
		for (const t of tokenizeLetterTokens(name)) for (const f of fuzzyVariants(t)) out.add(f);
		return out;
	};

	// Both caps below cut in catalog order, not by relevance (no score exists yet), so a
	// deep bucket loses members the old uncapped blocker kept. Counted so it is visible
	// in _meta rather than silent.
	const truncation = { perKeyHits: 0, perKeyDropped: 0, limitHits: 0, limitDropped: 0 };

	function poolFor(anchor, opts = {}) {
		const channels = opts.channels || { dist: true, topTerm: true, smws: true, twin: true, fuzzy: true };
		// Caps each index KEY, not each channel: 12 fuzzy seeds contribute 12 * maxPerKey
		// before `limit`. maxPerChannel is the old name, still accepted.
		const perKeyOpt = Number.isFinite(opts.maxPerKey) ? opts.maxPerKey : opts.maxPerChannel;
		const maxPerKey = Number.isFinite(perKeyOpt) ? perKeyOpt : 4000;
		const limit = Number.isFinite(opts.limit) ? opts.limit : 4000;
		const aIdx = indexBySku.get(String(anchor && anchor.sku || ""));
		const name = (anchor && anchor.name) || "";
		const set = new Set();
		const collect = (m, k, n) => {
			if (!m) return;
			const s = m.get(k);
			if (!s) return;
			let taken = 0;
			let skipped = 0;
			for (const i of s) {
				if (i === aIdx) continue;
				if (taken >= n) {
					skipped++;
					continue;
				}
				set.add(i);
				taken++;
			}
			if (skipped) {
				truncation.perKeyHits++;
				truncation.perKeyDropped += skipped;
			}
		};
		const cap = Math.max(1, maxPerKey);
		if (channels.dist) for (const t of vocab.distinctiveUnigramsForName(name) || []) collect(distIndex, t, cap);
		if (channels.topTerm) {
			const tt = vocab.topTerm(name);
			if (tt && tt.term) collect(topTermIndex, tt.term, cap);
		}
		if (channels.smws) collect(smwsBucket, similarity.smwsKeyFromName(name), cap);
		if (channels.twin) collect(twinBucket, normNameForTwin(name), cap);
		if (channels.fuzzy) for (const t of fuzzyTokensForName(name)) collect(tokenItems, t, cap);
		const out = [...set];
		if (out.length > limit) {
			truncation.limitHits++;
			truncation.limitDropped += out.length - limit;
			out.length = limit;
		}
		return out.map((i) => items[i]);
	}

	return {
		poolFor,
		truncation,
		stats: {
			items: items.length,
			distTokens: distIndex.size,
			topTermTokens: topTermIndex.size,
			smwsBuckets: smwsBucket.size,
			twinBuckets: twinBucket.size,
			fuzzyTokens: tokenItems.size,
			fuzzyTrigrams: trigramTokens.size,
		},
	};
}

/* ---------------------------------------------------------------------------
 * 4. Embedding cosine index
 * ------------------------------------------------------------------------- */

export function buildEmbeddingIndex(worktree, items) {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(path.join(worktree, "viz", "data", "sku_embeddings.json"), "utf8"));
	} catch {
		return null;
	}
	const vecByKey = new Map();
	for (const k in raw) {
		vecByKey.set(k, raw[k]);
		const nk = keySkuForRow({ sku: k });
		if (nk && nk !== k && !vecByKey.has(nk)) vecByKey.set(nk, raw[k]);
	}
	const normVec = (v) => {
		let n = 0;
		for (let i = 0; i < v.length; i++) n += v[i] * v[i];
		n = Math.sqrt(n);
		if (!n) return null;
		const o = new Float32Array(v.length);
		for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
		return o;
	};
	const idx = new Map();
	const vecForIndex = new Map();
	const vectors = [];
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (it.sku && !idx.has(it.sku)) idx.set(it.sku, i);
		if (it.normKey && !idx.has(it.normKey)) idx.set(it.normKey, i);
		const v = vecByKey.get(String(it.sku)) || vecByKey.get(String(it.normKey));
		if (!v || !Array.isArray(v) || !v.length) continue;
		const n = normVec(v);
		if (!n) continue;
		vecForIndex.set(i, n);
		vectors.push({ i, v: n });
	}
	return {
		count: vectors.length,
		vectorFor(item) {
			if (!item) return null;
			const i = iFor(item);
			return i == null ? null : vecForIndex.get(i) || null;
		},
		nearest(anchorItem, K) {
			const i = iFor(anchorItem);
			if (i == null) return [];
			const av = vecForIndex.get(i);
			if (!av) return [];
			const scored = [];
			for (const c of vectors) {
				if (c.i === i) continue;
				let d = 0;
				for (let j = 0; j < av.length; j++) d += av[j] * c.v[j];
				scored.push({ item: items[c.i], cos: d });
			}
			scored.sort((x, y) => y.cos - x.cos);
			return K > 0 && scored.length > K ? scored.slice(0, K) : scored;
		},
	};
	function iFor(item) {
		const it = item || {};
		return idx.get(String(it.sku)) ?? idx.get(String(it.normKey)) ?? null;
	}
}

/* ---------------------------------------------------------------------------
 * CLI self-check
 * ------------------------------------------------------------------------- */

const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) {
	const args = process.argv.slice(2);
	const get = (k) => {
		const i = args.indexOf(k);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const worktree = get("--worktree") || (process.env.DATA_WORKTREE || path.join(REPO_ROOT, ".worktrees", "data"));
	const sku = get("--sku");
	const t0 = Date.now();

	const env = await loadEnv(worktree);
	console.log(`env: ${env.allAgg.length} aggregates, ${env.allLinks.length} link edges (${Date.now() - t0}ms)`);

	const surface = await buildSurface({
		worktree,
		env,
		includeDelisted: process.env.AUDIT_INCLUDE_DELISTED !== "0",
		cacheFile: get("--cache") || undefined,
	});
	console.log(
		`surface: ${surface.items.length} items (current=${surface.stats.current}, delisted=${surface.stats.delisted}, fromCache=${surface.stats.fromCache}); ${surface.byKey.size} keys`,
	);

	const block = buildBlockIndex(surface.items, { vocab: env.vocab, similarity: { smwsKeyFromName } });
	console.log(`block index: ${JSON.stringify(block.stats)}`);

	const emb = buildEmbeddingIndex(worktree, surface.items);
	console.log(`embeddings: ${emb ? emb.count : 0} items with vectors`);

	if (sku) {
		const a = surface.byKey.get(sku) || surface.byKey.get(normalizeImplicitSkuKey(sku));
		if (!a) {
			console.error(`--sku ${sku} not found`);
			process.exit(2);
		}
		console.log(`anchor: ${a.sku} ${JSON.stringify(a.name)} stores=${a.stores.size} delisted=${a.delisted}`);
		const pool = block.poolFor(a, { maxPerChannel: 2000, limit: 2000 });
		console.log(`poolFor: ${pool.length} candidates`);
		for (const c of pool.slice(0, 20)) {
			console.log(`  ${c.sku}  ${JSON.stringify(c.name)}  stores=${c.stores.size}${c.delisted ? " [DL]" : ""}`);
		}
		if (emb) {
			console.log("nearest 10 by cosine:");
			for (const r of emb.nearest(a, 10)) {
				console.log(`  ${r.cos.toFixed(3)}  ${r.item.sku}  ${JSON.stringify(r.item.name)}`);
			}
		}
	}
}