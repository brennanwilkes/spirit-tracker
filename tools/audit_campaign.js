#!/usr/bin/env node
// Resumable audit campaign over SKU links: recall, precision and — first of all — hard-negative
// ignores, in agent-sized batches tracked by audit/campaign/manifest.json. Operator runbook:
// docs/audit-campaign.md. Never commits, pushes, uploads, or touches the shipped model.
//
//   node tools/audit_campaign.js init
//   node tools/audit_campaign.js generate --round N --profile default|wide [--model shipped|round-M]
//   node tools/audit_campaign.js mine --round N [--sources pool,wide,emb,sibling,precision,labels] [--dry-run]
//   node tools/audit_campaign.js status
//   node tools/audit_campaign.js next [--n K]
//   node tools/audit_campaign.js mark <batch|all-applied> <status> [--tokens N] [--note "…"]
//   node tools/audit_campaign.js coverage <batch>        (read-only; agents run it on their own output)
//   node tools/audit_campaign.js collect <batch> [--no-fetch]
//   node tools/audit_campaign.js round-close N [--allow-open]
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawnSync } = require("child_process");
const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");
const { priceRatioLabel, priceToNum } = require("../scripts/audit_new_listings.js");

const REPO = path.resolve(__dirname, "..");
const CAMPAIGN = path.join(REPO, "audit", "campaign");
const MANIFEST = path.join(CAMPAIGN, "manifest.json");
const LOCK = path.join(CAMPAIGN, "manifest.lock");
const FROZEN = path.join(CAMPAIGN, "frozen_split.json");
const TEMPLATE = path.join(CAMPAIGN, "prompt-template.md");
const ML = path.join(REPO, "tools", "linker_ml");
const ML_OUT = path.join(ML, "out", "campaign");
const PYTHON = path.join(ML, ".venv", "bin", "python");
const GENERATOR = path.join(REPO, "scripts", "audit_new_listings.js");

const STATUSES = ["pending", "running", "done", "applied", "committed", "failed"];
// Value order of the recall/hard-negative buckets. `conf` = below 0.05 but confusable: a sibling
// family pair, or embedCos/det high while the model says no.
const BUCKETS = [
	{ id: "B0", label: "unjudged above bar (>= 0.95)", min: 0.95, max: Infinity },
	{ id: "B1", label: "0.5 - 0.95", min: 0.5, max: 0.95 },
	{ id: "B2", label: "0.2 - 0.5", min: 0.2, max: 0.5 },
	{ id: "B3", label: "0.05 - 0.2", min: 0.05, max: 0.2 },
	{ id: "B4", label: "confusable low band (< 0.05)", min: 0, max: 0.05 },
	{ id: "B5", label: "remaining 0.01 - 0.05", min: 0.01, max: 0.05 },
];
const CONF_EMB = 0.85;
const CONF_DET = 4;
// Batches never mix tiers, so value order holds batch by batch; within a tier, pairs sharing a
// canonical neighbourhood sit together. perItem = expected end-context tokens per decision.
const TIERS = [
	{ id: "A", buckets: ["B0", "B1", "B2"], perItem: 1600 },
	{ id: "B", buckets: ["B3"], perItem: 1200 },
	{ id: "C", buckets: ["B4"], perItem: 800 },
	{ id: "D", buckets: ["B5"], perItem: 600 },
];
// §6 of docs/audit-full-library-plan.md: ~80K fixed + ~0.6 tokens/byte, 50% of a 1M window soft.
const FIXED_TOKENS = 80000;
const TOKENS_PER_BYTE = 0.6;
const TARGET_TOKENS = 480000;
const BATCH_BYTES = 650000;
const GROUP_BATCH_BYTES = 650000;
const LABEL_LIMIT = 200;
const LABEL_PER_ITEM = 2000;
// Every PRECISION_EVERY recall batches, the next pending precision batch takes a slot.
const PRECISION_EVERY = 3;

// ---------------------------------------------------------------------------------------------
// small utilities

const nk = (s) => normalizeImplicitSkuKey(String(s).trim());
const pairKey = (a, b) => (nk(a) < nk(b) ? `${nk(a)}|${nk(b)}` : `${nk(b)}|${nk(a)}`);
const rel = (p) => path.relative(REPO, p);
const abs = (p) => path.join(REPO, p);
const nowIso = () => new Date().toISOString();
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const fnv = (s) => {
	let h = 0x811c9dc5;
	for (const c of String(s)) h = Math.imul((h ^ (c.codePointAt(0) & 0xff)) >>> 0, 0x01000193) >>> 0;
	return h;
};
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// Thrown, not process.exit, so an open manifest lock is always released on the way out.
class CampaignError extends Error {}
function die(msg) {
	throw new CampaignError(msg);
}

function writeAtomic(file, text) {
	const tmp = `${file}.tmp-${process.pid}`;
	const fd = fs.openSync(tmp, "w");
	fs.writeSync(fd, text);
	fs.fsyncSync(fd);
	fs.closeSync(fd);
	fs.renameSync(tmp, file);
}

function parseArgs(argv, valueFlags, boolFlags) {
	const pos = [];
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (boolFlags.includes(a)) opts[a] = true;
		else if (valueFlags.includes(a)) {
			if (i + 1 >= argv.length) die(`${a} expects a value`);
			opts[a] = argv[++i];
		} else if (a.startsWith("--")) die(`unknown flag ${a}`);
		else pos.push(a);
	}
	return { pos, opts };
}

function run(cmd, args, env = {}) {
	console.log(`\n$ ${Object.entries(env).map(([k, v]) => `${k}=${v} `).join("")}${cmd} ${args.join(" ")}`);
	const r = spawnSync(cmd, args, { cwd: REPO, stdio: "inherit", env: { ...process.env, ...env } });
	if (r.status !== 0) die(`command failed (exit ${r.status}): ${cmd} ${args.join(" ")}`);
}

function capture(cmd, args, env = {}) {
	const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 30, env: { ...process.env, ...env } });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function eachJsonl(file, fn) {
	const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	let first = true;
	for await (const line of rl) {
		if (!line) continue;
		const row = JSON.parse(line);
		const isMeta = first && row._meta !== undefined;
		first = false;
		fn(row, isMeta);
	}
}

async function firstLine(file) {
	const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	for await (const line of rl) {
		rl.close();
		return JSON.parse(line);
	}
	throw new Error(`${file} is empty`);
}

// ---------------------------------------------------------------------------------------------
// manifest (atomic writes under an exclusive lock, so an interrupted step never half-writes it)

function withManifest(fn, { create = false } = {}) {
	fs.mkdirSync(CAMPAIGN, { recursive: true });
	if (!create && !fs.existsSync(MANIFEST)) die(`no manifest at ${rel(MANIFEST)} — run \`node tools/audit_campaign.js init\` first`);
	let fd;
	try {
		fd = fs.openSync(LOCK, "wx");
	} catch (e) {
		if (e.code !== "EEXIST") throw e;
		die(`${rel(LOCK)} exists (held by: ${fs.readFileSync(LOCK, "utf8").trim()}). If that process is gone, delete the lock and re-run.`);
	}
	fs.writeSync(fd, `pid ${process.pid} ${process.argv.slice(2).join(" ")} at ${nowIso()}`);
	fs.closeSync(fd);
	const release = () => fs.existsSync(LOCK) && fs.unlinkSync(LOCK);
	const m = fs.existsSync(MANIFEST) ? readJson(MANIFEST) : null;
	const save = () => {
		m.updatedAt = nowIso();
		writeAtomic(MANIFEST, JSON.stringify(m, null, 1) + "\n");
	};
	return Promise.resolve()
		.then(() => fn(m, save))
		.finally(release);
}

function loadManifest() {
	if (!fs.existsSync(MANIFEST)) die(`no manifest at ${rel(MANIFEST)} — run \`node tools/audit_campaign.js init\` first`);
	return readJson(MANIFEST);
}

const roundOf = (m, n) => {
	const r = m.rounds.find((x) => x.round === n);
	if (!r) die(`round ${n} does not exist (rounds: ${m.rounds.map((x) => x.round).join(", ")})`);
	return r;
};
const batchOf = (m, id) => {
	const b = m.batches.find((x) => x.id === id);
	if (!b) die(`no batch ${id}`);
	return b;
};
const roundDir = (n) => path.join(CAMPAIGN, `round-${n}`);

function setStatus(b, status, note) {
	if (!STATUSES.includes(status)) die(`status must be one of ${STATUSES.join(" | ")}`);
	b.status = status;
	b.history.push({ status, at: nowIso(), ...(note !== undefined ? { note } : {}) });
}

// ---------------------------------------------------------------------------------------------
// labels + catalog

function loadLabels(wt) {
	const links = readJson(path.join(wt, "data", "sku_links.json"));
	const auto = readJson(path.join(wt, "data", "sku_links_auto.json")).links;
	const parent = new Map();
	const find = (x) => {
		while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
		return x;
	};
	for (const l of [...links.links, ...auto]) {
		const ra = find(nk(l.fromSku));
		const rb = find(nk(l.toSku));
		if (ra !== rb) parent.set(ra, rb);
	}
	const canon = (s) => find(nk(s));
	const members = new Map();
	for (const x of new Set([...parent.keys(), ...parent.values()])) {
		const r = find(x);
		if (!members.has(r)) members.set(r, []);
		members.get(r).push(x);
	}
	const canonPair = (a, b) => {
		const x = canon(a);
		const y = canon(b);
		return x < y ? `${x}|${y}` : `${y}|${x}`;
	};
	const ignoredCanon = new Set(links.ignores.map((g) => canonPair(g.skuA, g.skuB)));
	return {
		links: links.links,
		ignores: links.ignores,
		auto,
		canon,
		members: (s) => members.get(canon(s)) || [nk(s)],
		decided: (a, b) => canon(a) === canon(b) || ignoredCanon.has(canonPair(a, b)),
		counts: { links: links.links.length, ignores: links.ignores.length, auto: auto.length },
	};
}

function loadCatalog(wt) {
	const idx = readJson(path.join(wt, "viz", "data", "index.json"));
	const bySku = new Map();
	for (const it of idx.items) {
		const k = nk(it.sku);
		if (!bySku.has(k)) bySku.set(k, { sku: String(it.sku), listings: [] });
		const slug = String(it.url).replace(/[?#].*$/, "").split("/").filter(Boolean).pop();
		bySku.get(k).listings.push({ store: it.storeLabel, name: it.name, price: priceToNum(it.price), removed: !!it.removed, slug });
	}
	for (const e of bySku.values()) {
		const live = e.listings.filter((l) => !l.removed);
		e.name = (live[0] || e.listings[0]).name;
		const priced = live.filter((l) => l.price > 0).sort((x, y) => x.price - y.price);
		e.cheapest = priced.length ? priced[0] : null;
	}
	return {
		get: (s) => bySku.get(nk(s)),
		catalogSku: (s) => {
			const e = bySku.get(nk(s));
			if (!e) throw new Error(`sku ${s} is not in index.json`);
			return e.sku;
		},
		keys: () => bySku.keys(),
	};
}

// Group batches keep audit_link_group_slice.js's shape (groups[], each with id = canon) so its
// --exclude can read earlier ones; pair and label batches carry items[].
const itemsOf = (b, data) => (b.kind === "groups" ? data.groups : data.items);

function priorPairKeys(m) {
	const keys = new Set();
	for (const b of m.batches) {
		if (b.status === "failed" || b.kind === "groups") continue;
		for (const p of readJson(abs(b.file)).items) keys.add(pairKey(p.a, p.b));
	}
	return keys;
}

// ---------------------------------------------------------------------------------------------
// retrain + frozen-split metrics (writes only under tools/linker_ml/out/campaign/)

function retrain(n, wt, { pinFrozen }) {
	const dir = path.join(ML_OUT, `round-${n}`);
	fs.mkdirSync(dir, { recursive: true });
	const env = { DATA_WORKTREE: wt, LINKER_OUT_DIR: dir };
	run("node", [path.join(ML, "build_dataset.mjs")], env);
	if (pinFrozen) pinFrozenSplit(dir);
	fs.copyFileSync(path.join(wt, "viz", "data", "sku_embeddings.json"), path.join(dir, "embeddings.json"));
	run("node", [path.join(ML, "dump_features.mjs")], { ...env, LINKER_FROZEN_SPLIT: FROZEN });
	run(PYTHON, [path.join(ML, "export_gbt.py")], { FEATURES_PATH: path.join(dir, "features.jsonl"), GBT_OUT: path.join(dir, "gbt_model.json") });
	run(PYTHON, [path.join(ML, "oof_misses.py")], { LINKER_OUT_DIR: dir });
	return dir;
}

// Frozen split = every catalog sku whose round-0 canonical group hashes into the trainers' own
// TEST bucket (FNV(canon) < 0.15, the rule export_gbt.py / train_embed.py use), so it is as close
// as the labels allow to the groups the shipped encoder was never fine-tuned on.
function pinFrozenSplit(dir) {
	if (fs.existsSync(FROZEN)) die(`${rel(FROZEN)} already exists — the frozen split is pinned once, at round 0`);
	const bucket = (c) => (fnv(c) % 1000) / 1000;
	const rows = fs.readFileSync(path.join(dir, "sku_texts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const skus = rows.filter((r) => bucket(r.canon) < 0.15).map((r) => nk(r.sku));
	const groups = new Set(rows.filter((r) => bucket(r.canon) < 0.15).map((r) => r.canon));
	const pre = path.join(ML, "out", "pre-2026-09-24", "sku_texts.jsonl");
	let encoderOverlap = null;
	if (fs.existsSync(pre)) {
		const preCanon = new Map(fs.readFileSync(pre, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [nk(r.sku), r.canon]));
		const known = skus.filter((s) => preCanon.has(s));
		encoderOverlap = { file: rel(pre), skusKnown: known.length, inPreTestBucket: known.filter((s) => bucket(preCanon.get(s)) < 0.15).length };
	}
	writeAtomic(
		FROZEN,
		JSON.stringify({
			createdAt: nowIso(),
			rule: "FNV-1a(canon from round-0 build_dataset sku_texts.jsonl) % 1000 / 1000 < 0.15; a pair is frozen when either sku is in skus[]",
			source: rel(path.join(dir, "sku_texts.jsonl")),
			catalogSkus: rows.length,
			groups: groups.size,
			encoderOverlap,
			skus: [...new Set(skus)].sort(),
		}) + "\n",
	);
	console.log(`pinned frozen split: ${skus.length} of ${rows.length} skus, ${groups.size} groups → ${rel(FROZEN)}`);
}

function evalFrozen(dir, models) {
	const out = path.join(dir, "frozen_metrics.json");
	run("node", [path.join(ML, "eval_frozen.mjs"), "--features", path.join(dir, "features.jsonl"), ...models.flatMap(([n, p]) => ["--model", `${n}=${p}`]), "--out", out]);
	const res = readJson(out);
	for (const v of Object.values(res.models)) v.path = rel(v.path);
	return res;
}

// ---------------------------------------------------------------------------------------------
// subcommands

async function cmdInit(opts) {
	const wt = path.resolve(opts["--root"] || path.join(REPO, ".worktrees", "data"));
	await withManifest(async (m, save) => {
		if (m) die(`${rel(MANIFEST)} already exists`);
		const labels = loadLabels(wt);
		const dir = retrain(0, wt, { pinFrozen: true });
		const metrics = evalFrozen(dir, [["baseline", path.join(dir, "gbt_model.json")]]);
		const frozen = readJson(FROZEN);
		m = {
			version: 1,
			createdAt: nowIso(),
			worktree: wt,
			frozenSplit: { file: rel(FROZEN), skus: frozen.skus.length, groups: frozen.groups },
			baselineModel: rel(path.join(dir, "gbt_model.json")),
			rounds: [
				{ round: 0, status: "closed", closedAt: nowIso(), labels: labels.counts, model: rel(path.join(dir, "gbt_model.json")), metrics: metrics.models },
				{ round: 1, status: "open", openedAt: nowIso(), labelsAtOpen: labels.counts, rich: {}, mines: [], precisionSince: "2026-09-24T00:00:00Z" },
			],
			batches: [],
			linksState: null,
		};
		// withManifest's save() closes over the manifest object it read, which was null here.
		writeAtomic(MANIFEST, JSON.stringify(m, null, 1) + "\n");
		console.log(`initialised ${rel(MANIFEST)}: round 0 closed (baseline), round 1 open`);
	}, { create: true });
}

async function cmdGenerate(opts) {
	const n = Number(opts["--round"]);
	const profile = opts["--profile"];
	if (!["default", "wide"].includes(profile)) die("--profile must be default or wide");
	const m = loadManifest();
	const r = roundOf(m, n);
	if (r.status !== "open") die(`round ${n} is ${r.status}`);
	const out = path.join(roundDir(n), `rich-${profile}.jsonl`);
	if (opts["--register"]) {
		if (!fs.existsSync(out)) die(`--register: ${rel(out)} does not exist`);
		await withManifest(async (mm, save) => {
			roundOf(mm, n).rich[profile] = { file: rel(out), generatedAt: fs.statSync(out).mtime.toISOString(), model: opts["--model"] || "shipped", registered: true };
			save();
		});
		return console.log(`registered ${rel(out)}`);
	}
	const model = opts["--model"] || "shipped";
	const env = { NODE_OPTIONS: `--max-old-space-size=${profile === "wide" ? 12000 : 10000}` };
	if (model !== "shipped") {
		const mr = roundOf(m, Number(model.replace(/^round-/, "")));
		env.LINKER_GBT_MODEL = abs(mr.model);
	}
	const args = [GENERATOR, "--root", m.worktree, "--since", "1970-01-01", "--format", "jsonl"];
	if (profile === "wide") {
		Object.assign(env, { AUDIT_POOL_EMB: "1", AUDIT_POOL_BUDGET: "2000", AUDIT_POOL_PER_CHANNEL: "400", AUDIT_MAX_CHEAP_KEEP: "1000", AUDIT_MAX_FINE: "250" });
		args.push("--top", "10");
	}
	fs.mkdirSync(roundDir(n), { recursive: true });
	run("node", [...args, "--out", out], env);
	await withManifest(async (mm, save) => {
		roundOf(mm, n).rich[profile] = { file: rel(out), generatedAt: nowIso(), model, env };
		save();
	});
}

// Live attribute parsers (ESM) for the sibling-class tag; imported, never re-implemented.
async function loadParsers() {
	const url = (p) => require("url").pathToFileURL(path.join(REPO, p)).href;
	const sim = await import(url("viz/app/linker_page/similarity.js"));
	const size = await import(url("viz/app/linker_page/size.js"));
	const sku = await import(url("viz/app/sku.js"));
	return { sim, size, sku };
}

const IB_RE = /\b(signatory|adelphi|cadenhead|gordon\s*(?:&|and)?\s*macphail|g\s*&\s*m|g m cc|connoisseurs choice|douglas laing|hunter laing|old malt cask|carn mor|single cask nation|scn|smws|boutique ?y|tbwc|murray mcdavid|berry bros|whisky sponge|decadent drams|that boutique)\b/;
const GIFT_RE = /\b(gift|pack|set|bundle|sampler|tasting|calendar|glass(?:es)?|tin|combo|mini|miniature|\d+\s*x\s*\d+)\b/;
const EDITION_WORDS = ["cask strength", "barrel proof", "single cask", "single barrel", "batch", "limited", "edition", "release", "reserve", "special", "private", "exclusive", "pick", "sherry", "port", "finish", "peated", "unpeated", "double", "triple", "rye", "wheated", "bottled in bond", "full proof", "overproof", "navy strength", "small batch", "anniversary", "vintage", "old bottling"];
const STRIP_RE = /\b(\d+\w*|ml|cl|l|ltr|litre|liter|year|years|yr|yrs|yo|old|aged|abv|proof|the|of|and|whisky|whiskey|scotch|single|malt|cask|strength|batch|no|number|edition|release|limited|vintage)\b/g;

function attrsOf(parsers, name) {
	const { sim, size, sku } = parsers;
	const norm = sku.normSearchText(name);
	const ym = norm.match(/\b(19\d\d|20\d\d)\b/);
	return {
		age: sim.extractAgeFromText(norm) || null,
		year: ym ? ym[1] : null,
		sizes: new Set(size.parseSizesMlFromText(name).map((ml) => size.canonSizeMl(ml))),
		abv: sim.extractAbv(name),
		codes: sim.extractEditionCodes(name),
		bottler: (norm.match(IB_RE) || [null])[0],
		gift: GIFT_RE.test(norm),
		words: new Set(EDITION_WORDS.filter((w) => ` ${norm} `.includes(` ${w} `))),
		base: norm.replace(IB_RE, " ").replace(STRIP_RE, " ").replace(/\s+/g, " ").trim(),
	};
}

// Which identity attributes differ between two names. [] = none parsed differently.
function classOf(x, y) {
	const d = [];
	if ((x.age !== null || y.age !== null) && x.age !== y.age) d.push("age");
	if ((x.year !== null || y.year !== null) && x.year !== y.year) d.push("vintage");
	if (x.sizes.size && y.sizes.size && ![...x.sizes].some((s) => y.sizes.has(s))) d.push("size");
	if (x.abv !== null && y.abv !== null && Math.abs(x.abv - y.abv) > 0.5) d.push("abv");
	if (x.codes.size && y.codes.size && ![...x.codes].some((c) => y.codes.has(c))) d.push("batch");
	if (x.bottler !== y.bottler) d.push("bottler");
	if (x.gift !== y.gift) d.push("gift");
	const wx = [...x.words].filter((w) => !y.words.has(w));
	const wy = [...y.words].filter((w) => !x.words.has(w));
	if (wx.length || wy.length) d.push("edition");
	return d;
}

function siblingPairs(parsers, catalog, labels, exclude) {
	const families = new Map();
	for (const k of catalog.keys()) {
		const e = catalog.get(k);
		const at = attrsOf(parsers, e.name);
		if (at.base.split(" ").filter((t) => t.length >= 4).length === 0) continue;
		if (!families.has(at.base)) families.set(at.base, []);
		families.get(at.base).push({ k, at });
	}
	const out = [];
	let familiesUsed = 0;
	for (const fam of families.values()) {
		if (fam.length < 2 || fam.length > 40) continue;
		let n = 0;
		for (let i = 0; i < fam.length && n < 60; i++) {
			for (let j = i + 1; j < fam.length && n < 60; j++) {
				const a = fam[i], b = fam[j];
				if (labels.decided(a.k, b.k) || exclude.has(pairKey(a.k, b.k))) continue;
				if (classOf(a.at, b.at).length > 1) continue;
				out.push([catalog.catalogSku(a.k), catalog.catalogSku(b.k)]);
				n++;
			}
		}
		if (n) familiesUsed++;
	}
	return { pairs: out, families: familiesUsed };
}

function bucketOf(p) {
	if (p.prob >= 0.05) return BUCKETS.find((b) => p.prob >= b.min && p.prob < b.max).id;
	const confusable = p.src.has("sibling") || (p.emb !== null && p.emb >= CONF_EMB) || p.det >= CONF_DET;
	if (confusable) return "B4";
	if (p.prob >= 0.01) return "B5";
	return null;
}

async function cmdMine(opts) {
	await withManifest((m, save) => mineLocked(m, save, opts));
}

async function mineLocked(m, save, opts) {
	const n = Number(opts["--round"]);
	const sources = (opts["--sources"] || "pool,wide,emb,sibling,precision,labels").split(",");
	const dry = !!opts["--dry-run"];
	const embK = Number(opts["--emb-k"] || 8);
	const r = roundOf(m, n);
	if (r.status !== "open") die(`round ${n} is ${r.status}`);
	const wt = m.worktree;
	const dir = roundDir(n);
	const work = path.join(dir, "work");
	fs.mkdirSync(work, { recursive: true });
	const labels = loadLabels(wt);
	const catalog = loadCatalog(wt);
	const prior = priorPairKeys(m);
	const pairs = new Map();
	const srcCounts = {};
	const bump = (src, k) => {
		srcCounts[src] = srcCounts[src] || { seen: 0, unjudged: 0 };
		srcCounts[src][k]++;
	};
	if (!r.rich.default) die(`round ${n} has no default rich file — run \`generate --round ${n} --profile default\``);
	const storePriceRatio = (await firstLine(abs(r.rich.default.file)))._meta.eval.storePriceRatio;
	const take = (src, a, b, prob, det, emb, pol, extra) => {
		bump(src, "seen");
		const k = pairKey(a, b);
		if (labels.decided(a, b) || prior.has(k)) return;
		bump(src, "unjudged");
		const cur = pairs.get(k);
		if (!cur) {
			pairs.set(k, { k, a: catalog.catalogSku(a), b: catalog.catalogSku(b), prob, det, emb, pol, src: new Set([src]), ...extra });
			return;
		}
		cur.src.add(src);
		if (prob > cur.prob) Object.assign(cur, { prob, det, emb, pol, ...extra });
	};

	for (const profile of ["default", "wide"]) {
		const src = profile === "default" ? "pool" : "wide";
		if (!sources.includes(src)) continue;
		const info = r.rich[profile];
		if (!info) die(`round ${n} has no ${profile} rich file — run \`generate --round ${n} --profile ${profile}\``);
		console.log(`reading ${info.file} …`);
		let rows = 0;
		await eachJsonl(abs(info.file), (l, isMeta) => {
			if (isMeta) return;
			if (++rows % 5000 === 0) console.log(`  ${rows} rows`);
			if (!l.scores || !l.scores.scored) return;
			const anchor = catalog.catalogSku(l.sku);
			for (const c of [...l.scores.candidates, ...l.scores.twins]) {
				const emb = typeof c.features.embedCos === "number" ? c.features.embedCos : null;
				take(src, anchor, c.sku, c.prob, c.detScore, emb, c.pol);
			}
		});
	}

	const scoreFile = (src, file) =>
		eachJsonl(file, (p, isMeta) => {
			if (isMeta) {
				if (p._meta.missing && p._meta.missing.length) console.log(`  ${src}: ${p._meta.missing.length} pair(s) skipped, a sku absent from the scorer catalog (hidden listings)`);
				return;
			}
			const emb = typeof p.embedCos === "number" ? p.embedCos : null;
			take(src, p.a, p.b, p.prob, p.det, emb, p.pol, p.nnCos !== undefined ? { nnCos: p.nnCos } : {});
		});
	if (sources.includes("emb")) {
		const f = path.join(work, `emb-nn-k${embK}.jsonl`);
		if (!fs.existsSync(f)) run("node", [GENERATOR, "--root", wt, "--emb-neighbours", String(embK), "--out", f]);
		await scoreFile("emb", f);
	}
	const parsers = await loadParsers();
	if (sources.includes("sibling")) {
		const f = path.join(work, "sibling-scored.jsonl");
		if (!fs.existsSync(f)) {
			const sib = siblingPairs(parsers, catalog, labels, prior);
			console.log(`sibling families: ${sib.families} families, ${sib.pairs.length} candidate pairs to score`);
			const inF = path.join(work, "sibling-pairs.jsonl");
			fs.writeFileSync(inF, sib.pairs.map(([a, b]) => JSON.stringify({ a, b })).join("\n") + "\n");
			run("node", [GENERATOR, "--root", wt, "--score-pairs", inF, "--out", f]);
		}
		await scoreFile("sibling", f);
	}

	// bucket + class
	const attrCache = new Map();
	const attr = (s) => {
		const k = nk(s);
		if (!attrCache.has(k)) attrCache.set(k, attrsOf(parsers, catalog.get(k).name));
		return attrCache.get(k);
	};
	const byBucket = new Map(BUCKETS.map((b) => [b.id, []]));
	let dropped = 0;
	for (const p of pairs.values()) {
		const bk = bucketOf(p);
		if (bk === null) {
			dropped++;
			continue;
		}
		p.bk = bk;
		const d = classOf(attr(p.a), attr(p.b));
		p.cls = d.length ? d.join("+") : attr(p.a).base === attr(p.b).base ? "same-attrs" : "other";
		byBucket.get(bk).push(p);
	}

	console.log(`\n## Round ${n} mine — sources`);
	console.log("| source | pair slots seen | unjudged slots |");
	console.log("|---|---|---|");
	for (const [s, c] of Object.entries(srcCounts)) console.log(`| ${s} | ${c.seen} | ${c.unjudged} |`);
	console.log(`\nunique unjudged pairs: ${pairs.size}; below the value floor (prob < 0.01, not confusable): ${dropped}`);
	const srcCombos = {};
	console.log("\n| bucket | pairs | by source (a pair can carry several) |");
	console.log("|---|---|---|");
	for (const b of BUCKETS) {
		const arr = byBucket.get(b.id);
		const bySrc = {};
		for (const p of arr) for (const s of p.src) bySrc[s] = (bySrc[s] || 0) + 1;
		for (const p of arr) {
			const key = [...p.src].sort().join("+");
			srcCombos[key] = (srcCombos[key] || 0) + 1;
		}
		console.log(`| ${b.id} ${b.label} | ${arr.length} | ${Object.entries(bySrc).map(([s, c]) => `${s} ${c}`).join(", ")} |`);
	}
	const clsCounts = {};
	for (const arr of byBucket.values()) for (const p of arr) clsCounts[p.cls] = (clsCounts[p.cls] || 0) + 1;
	console.log(`\nclass tags: ${Object.entries(clsCounts).sort((x, y) => y[1] - x[1]).map(([c, k]) => `${c} ${k}`).join(", ")}`);
	console.log(`source combinations: ${Object.entries(srcCombos).sort((x, y) => y[1] - x[1]).map(([c, k]) => `${c} ${k}`).join(", ")}`);

	// pair-major batches, one tier at a time, canonical neighbourhoods kept together
	const newBatches = [];
	const legend =
		"items[] = one PAIR each, decide it once. a/b = catalog-form skus (use them verbatim in ops). prob = live GBT probability (max over both scoring directions; >= 0.95 means CI would auto-link it today). det = deterministic score. embedCos = embedding cosine (null = a side has no vector). pol = mechanical policy conflict (size:/store-exclusive:). pr = dearer/cheaper of the two skus' cheapest live prices (omitted < 1.05); prPct = where pr falls in the dearer store's own markup distribution (>max = never seen that far above market). src = how the pair was found: pool (default audit pool), wide (widened pool), emb (whole-catalog embedding neighbour), sibling (same family name, one attribute apart), labels. cls = the identity attributes the parsed names differ on (age, vintage, size, abv, batch, bottler, gift, edition; same-attrs = none parsed differently; other = different base name). bk = value bucket. skus{} (normalized keys) = each sku once: c = its catalog form, g = canonical group key, l = listings [store, name, price, removed(1), url slug]. groups{} = each canonical group of 2+ members once: m = members [sku, name, cheapest price], more = members not shown.";
	let seq = m.batches.filter((b) => b.round === n).length;
	for (const tier of TIERS) {
		const arr = tier.buckets.flatMap((id) => byBucket.get(id));
		if (!arr.length) continue;
		const adj = new Map();
		for (const p of arr) for (const s of [labels.canon(p.a), labels.canon(p.b)]) (adj.get(s) || adj.set(s, []).get(s)).push(p);
		const seen = new Set();
		const comps = [];
		for (const p of arr) {
			if (seen.has(p.k)) continue;
			const comp = [];
			const stack = [p];
			seen.add(p.k);
			while (stack.length) {
				const c = stack.pop();
				comp.push(c);
				for (const s of [labels.canon(c.a), labels.canon(c.b)]) for (const d of adj.get(s)) if (!seen.has(d.k)) (seen.add(d.k), stack.push(d));
			}
			comp.sort((x, y) => y.prob - x.prob);
			comps.push(comp);
		}
		comps.sort((x, y) => y[0].prob - x[0].prob || y.length - x.length);
		// Balanced: as few batches as the item and byte caps allow, filled evenly.
		const maxItems = Math.floor((TARGET_TOKENS - FIXED_TOKENS) / tier.perItem);
		const nBatches = Math.ceil(arr.length / maxItems);
		const perBatch = Math.ceil(arr.length / nBatches);
		let cur = null;
		const flush = () => {
			if (!cur) return;
			seq++;
			const id = `r${n}-b${String(seq).padStart(3, "0")}`;
			newBatches.push(writePairBatch(id, n, tier, cur.items, cur.skus, cur.groups, legend));
			cur = null;
		};
		for (const comp of comps) {
			for (const p of comp) {
				if (cur && (cur.bytes >= BATCH_BYTES || cur.items.length >= perBatch)) flush();
				if (!cur) cur = { items: [], skus: {}, groups: {}, bytes: 0 };
				const item = pairItem(p, catalog, storePriceRatio, cur.items.length + 1);
				cur.items.push(item);
				cur.bytes += JSON.stringify(item).length;
				for (const s of [p.a, p.b]) {
					const k = nk(s);
					if (!cur.skus[k]) {
						cur.skus[k] = skuEntry(s, catalog, labels);
						cur.bytes += JSON.stringify(cur.skus[k]).length + k.length;
					}
					const g = cur.skus[k].g;
					if (g !== undefined && !cur.groups[g]) {
						cur.groups[g] = groupEntry(g, catalog, labels);
						cur.bytes += JSON.stringify(cur.groups[g]).length + g.length;
					}
				}
			}
		}
		flush();
	}

	// precision: whole groups touched by CI auto-links no agent has read
	const precision = [];
	if (sources.includes("precision")) {
		const since = r.precisionSince;
		const prefix = path.join(dir, "batches", `r${n}-precision`);
		const prev = m.batches.filter((b) => b.kind === "groups" && b.status !== "failed").map((b) => abs(b.file));
		fs.mkdirSync(path.dirname(prefix), { recursive: true });
		if (!dry) {
			const args = [path.join(REPO, "tools", "audit_link_group_slice.js"), "--from", abs(r.rich.default.file), "--auto-since", since, "--batch-bytes", String(GROUP_BATCH_BYTES), "--out-prefix", prefix, "--root", wt];
			if (prev.length) args.push("--exclude", prev.join(","));
			const res = capture("node", args);
			if (res.status !== 0) die(`group slicer failed:\n${res.stderr}`);
			process.stdout.write(res.stdout);
			for (const line of res.stdout.split("\n")) {
				const mm = line.match(/^(.*-b\d+\.json): (\d+) groups, (\d+) edges, (\d+) B$/);
				if (!mm) continue;
				seq++;
				const id = `r${n}-b${String(seq).padStart(3, "0")}`;
				const file = path.join(dir, "batches", `${id}.json`);
				const data = readJson(mm[1]);
				data.groups = data.groups.map((g) => ({ id: g.canon, ...g }));
				data._meta.id = id;
				data._meta.kind = "groups";
				fs.writeFileSync(file, JSON.stringify(data) + "\n");
				fs.unlinkSync(mm[1]);
				const bytes = fs.statSync(file).size;
				precision.push({ id, round: n, kind: "groups", tier: "P", file: rel(file), items: data.groups.length, edges: Number(mm[3]), bytes, estTokens: Math.round(FIXED_TOKENS + TOKENS_PER_BYTE * bytes) });
			}
		}
	}
	// labels: existing labels the round's OOF model disagrees with most (never frozen-split rows)
	if (sources.includes("labels")) {
		const prevRound = m.rounds.filter((x) => x.round < n && x.status === "closed").pop();
		const oof = path.join(ML_OUT, `round-${prevRound.round}`, "oof_scores.jsonl");
		if (!fs.existsSync(oof)) die(`no ${rel(oof)} — close a round first`);
		const rows = fs.readFileSync(oof, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const disagree = rows
			.filter((x) => !x.noTrain && !x.frozen && (x.kind === "pos" || x.kind === "ignore") && !prior.has(pairKey(x.a, x.b)))
			.map((x) => ({ ...x, dis: x.label === 1 ? 1 - x.p : x.p }))
			.filter((x) => x.dis >= 0.5)
			.sort((x, y) => y.dis - x.dis);
		const cand = disagree.slice(0, LABEL_LIMIT);
		console.log(`\nlabels: the round-${prevRound.round} OOF model disagrees (>= 0.5) with ${disagree.length} labels (${disagree.filter((x) => x.label === 1).length} links, ${disagree.filter((x) => x.label === 0).length} ignores); batching the top ${cand.length}`);
		if (cand.length && !dry) {
			seq++;
			const id = `r${n}-b${String(seq).padStart(3, "0")}`;
			const skus = {};
			const groups = {};
			const items = cand.map((x, i) => {
				for (const s of [x.a, x.b]) {
					const k = nk(s);
					if (!skus[k]) skus[k] = skuEntry(s, catalog, labels);
					if (skus[k].g !== undefined && !groups[skus[k].g]) groups[skus[k].g] = groupEntry(skus[k].g, catalog, labels);
				}
				return { id: `L${String(i + 1).padStart(3, "0")}`, a: catalog.catalogSku(x.a), b: catalog.catalogSku(x.b), label: x.label === 1 ? "link" : "ignore", oofP: x.p, direct: x.label === 1 ? directLink(labels, x.a, x.b) : true };
			});
			const file = path.join(dir, "batches", `${id}.json`);
			const legendL = "items[] = EXISTING labels the retrained model (scored out-of-fold, never trained on the pair's group) disagrees with. label = what sku_links.json says (link = same canonical group, ignore = curated hard negative). oofP = the model's out-of-fold probability. direct = the pair is an explicit link entry (false = linked only transitively via other members; to split, unlink every edge between the products). skus{} / groups{} as in pair batches.";
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ _meta: { id, round: n, kind: "labels", source: rel(oof), items: items.length, legend: legendL }, items, skus, groups }) + "\n");
			const bytes = fs.statSync(file).size;
			precision.push({ id, round: n, kind: "labels", tier: "L", file: rel(file), items: items.length, bytes, estTokens: Math.round(FIXED_TOKENS + Math.max(TOKENS_PER_BYTE * bytes, LABEL_PER_ITEM * items.length)) });
		}
	}

	console.log(`\n## Round ${n} batches${dry ? " (dry run — nothing written)" : ""}`);
	console.log("| batch | kind | tier | items | bytes | est. end tokens |");
	console.log("|---|---|---|---|---|---|");
	for (const b of [...newBatches, ...precision]) console.log(`| ${b.id} | ${b.kind} | ${b.tier} | ${b.items} | ${b.bytes} | ${b.estTokens} |`);
	const total = [...newBatches, ...precision].reduce((s, b) => s + b.estTokens, 0);
	console.log(`total: ${newBatches.length + precision.length} batches, ~${Math.round(total / 1000)}K end-context tokens`);
	if (dry) {
		for (const b of newBatches) fs.unlinkSync(abs(b.file));
		return;
	}

	let order = m.batches.reduce((x, b) => Math.max(x, b.order), 0);
	const recall = [...newBatches];
	const prec = [...precision];
	let sinceP = 0;
	while (recall.length || prec.length) {
		const usePrec = prec.length && (sinceP >= PRECISION_EVERY || !recall.length);
		const b = usePrec ? prec.shift() : recall.shift();
		sinceP = usePrec ? 0 : sinceP + 1;
		m.batches.push({
			...b,
			order: ++order,
			proposal: rel(path.join(dir, "proposals", `${b.id}.json`)),
			followup: rel(path.join(dir, "proposals", `${b.id}.followup.json`)),
			decisions: rel(path.join(dir, "decisions", `${b.id}.jsonl`)),
			result: rel(path.join(dir, "proposals", `${b.id}.result.json`)),
			scratch: rel(path.join(dir, "scratch", b.id)),
			status: "pending",
			history: [{ status: "pending", at: nowIso() }],
			tokens: null,
			yield: null,
		});
	}
	r.mines.push({ at: nowIso(), sources, srcCounts, buckets: Object.fromEntries([...byBucket].map(([k, v]) => [k, v.length])), classes: clsCounts, batches: newBatches.length + precision.length });
	if (sources.includes("precision")) r.precisionSince = nowIso();
	save();
	console.log(`appended to ${rel(MANIFEST)}`);
}

function directLink(labels, a, b) {
	return labels.links.some((l) => pairKey(l.fromSku, l.toSku) === pairKey(a, b)) || labels.auto.some((l) => pairKey(l.fromSku, l.toSku) === pairKey(a, b));
}

function skuEntry(s, catalog, labels) {
	const e = catalog.get(s);
	if (!e) throw new Error(`sku ${s} is not in index.json`);
	const g = labels.canon(s);
	return {
		c: e.sku,
		...(labels.members(s).length > 1 ? { g } : {}),
		l: e.listings.map((l) => [l.store, l.name, l.price === undefined ? null : l.price, ...(l.removed ? [1] : [0]), l.slug]),
	};
}

function groupEntry(g, catalog, labels) {
	const mem = labels.members(g).map((s) => catalog.get(s)).filter((e) => e !== undefined);
	const shown = mem.slice(0, 15).map((e) => [e.sku, e.name, e.cheapest ? e.cheapest.price : null]);
	return { m: shown, ...(mem.length > 15 ? { more: mem.length - 15 } : {}) };
}

function pairItem(p, catalog, storePriceRatio, i) {
	const item = { id: `P${String(i).padStart(3, "0")}`, a: p.a, b: p.b, prob: +p.prob.toFixed(4), det: +p.det.toFixed(2), embedCos: p.emb === null ? null : +p.emb.toFixed(3) };
	if (p.pol) item.pol = p.pol;
	const ca = catalog.get(p.a).cheapest;
	const cb = catalog.get(p.b).cheapest;
	if (ca && cb) {
		const [hi, lo] = ca.price >= cb.price ? [ca, cb] : [cb, ca];
		const ratio = hi.price / lo.price;
		if (ratio >= 1.05) {
			item.pr = +ratio.toFixed(2);
			const lab = priceRatioLabel(storePriceRatio, hi.store, ratio);
			if (lab !== undefined && lab !== "<=p50") item.prPct = lab;
		}
	}
	item.src = [...p.src].sort();
	item.cls = p.cls;
	item.bk = p.bk;
	return item;
}

function writePairBatch(id, n, tier, items, skus, groups, legend) {
	const file = path.join(roundDir(n), "batches", `${id}.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const buckets = {};
	for (const it of items) buckets[it.bk] = (buckets[it.bk] || 0) + 1;
	fs.writeFileSync(file, JSON.stringify({ _meta: { id, round: n, kind: "pairs", tier: tier.id, items: items.length, buckets, legend }, items, skus, groups }) + "\n");
	const bytes = fs.statSync(file).size;
	return { id, round: n, kind: "pairs", tier: tier.id, buckets, file: rel(file), items: items.length, bytes, estTokens: Math.round(FIXED_TOKENS + Math.max(TOKENS_PER_BYTE * bytes, tier.perItem * items.length)) };
}

function cmdStatus() {
	const m = loadManifest();
	console.log(`campaign: ${rel(MANIFEST)} (updated ${m.updatedAt || m.createdAt})`);
	console.log(`frozen split: ${m.frozenSplit.skus} skus / ${m.frozenSplit.groups} groups; baseline model ${m.baselineModel}`);
	console.log(`links state: ${m.linksState ? `applied-uncommitted (${m.linksState.by} at ${m.linksState.at})` : "clean (everything applied is committed)"}`);
	console.log("\n| round | status | labels at open/close | rec@99 base → round | AUC+ base → round | prec@bar base → round | batches |");
	console.log("|---|---|---|---|---|---|---|");
	const pct = (x) => (x === null || x === undefined ? "—" : `${(100 * x).toFixed(2)}%`);
	for (const r of m.rounds) {
		const lab = r.labels || r.labelsAtOpen;
		const bs = m.batches.filter((b) => b.round === r.round).length;
		const met = r.metrics || {};
		const base = met.baseline || {};
		const cur = met.round || {};
		console.log(`| ${r.round} | ${r.status} | ${lab.links} links / ${lab.ignores} ignores | ${pct(base.rec99)} → ${pct(cur.rec99)} | ${base.aucPlus !== undefined ? base.aucPlus.toFixed(4) : "—"} → ${cur.aucPlus !== undefined ? cur.aucPlus.toFixed(4) : "—"} | ${pct(base.precAtBar)} → ${pct(cur.precAtBar)} | ${bs} |`);
	}
	console.log("\n| # | batch | kind | tier | items | bytes | est tok | status | tokens | +link | +ignore | unlink | review | model wrong |");
	console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	const sum = { link: 0, ignore: 0, unlink: 0, review: 0, wrong: 0, tokens: 0 };
	for (const b of [...m.batches].sort((x, y) => x.order - y.order)) {
		const y = b.yield;
		if (y) for (const k of ["link", "ignore", "unlink", "review"]) sum[k] += y[k];
		if (y) sum.wrong += y.modelWrong;
		if (b.tokens !== null) sum.tokens += b.tokens;
		console.log(`| ${b.order} | ${b.id} | ${b.kind} | ${b.tier} | ${b.items} | ${b.bytes} | ${Math.round(b.estTokens / 1000)}K | ${b.status} | ${b.tokens === null ? "—" : `${Math.round(b.tokens / 1000)}K`} | ${y ? y.link : "—"} | ${y ? y.ignore : "—"} | ${y ? y.unlink : "—"} | ${y ? y.review : "—"} | ${y ? y.modelWrong : "—"} |`);
	}
	const by = {};
	for (const b of m.batches) by[b.status] = (by[b.status] || 0) + 1;
	console.log(`\n${Object.entries(by).map(([s, c]) => `${s} ${c}`).join(", ")} · yield so far: +${sum.link} links, +${sum.ignore} ignores, ${sum.unlink} unlinks, ${sum.review} review, model wrong ${sum.wrong}; ${Math.round(sum.tokens / 1000)}K agent tokens recorded`);
}

function renderPrompt(m, b) {
	const tpl = fs.readFileSync(TEMPLATE, "utf8");
	const r = roundOf(m, b.round);
	const vars = {
		BATCH: b.id,
		KIND: b.kind,
		FILE: abs(b.file),
		ITEMS: String(b.items),
		PROPOSAL: abs(b.proposal),
		FOLLOWUP: abs(b.followup),
		DECISIONS: abs(b.decisions),
		RESULT: abs(b.result),
		SCRATCH: abs(b.scratch),
		RICH: r.rich.default ? abs(r.rich.default.file) : "(none — use tools/audit_search.mjs)",
		REPO,
		WT: m.worktree,
	};
	const kindBlock = tpl.match(new RegExp(`<!-- kind:${b.kind} -->([\\s\\S]*?)<!-- /kind -->`));
	if (!kindBlock) die(`template has no <!-- kind:${b.kind} --> block`);
	let out = tpl.replace(/<!-- kind:\w+ -->[\s\S]*?<!-- \/kind -->\n?/g, "").replace("{{KIND_BLOCK}}", kindBlock[1].trim());
	out = out.replace(/^<!--[\s\S]*?-->\n/, "");
	out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => {
		if (vars[k] === undefined) die(`template placeholder {{${k}}} has no value`);
		return vars[k];
	});
	return out;
}

function cmdNext(opts) {
	const m = loadManifest();
	const k = Number(opts["--n"] || 1);
	const pending = m.batches.filter((b) => b.status === "pending").sort((x, y) => x.order - y.order).slice(0, k);
	const running = m.batches.filter((b) => b.status === "running");
	if (running.length) console.log(`already running: ${running.map((b) => b.id).join(", ")} — resume a stopped agent with SendMessage, never relaunch\n`);
	if (!pending.length) return console.log("no pending batches — mine the next round or close this one");
	for (const b of pending) {
		fs.mkdirSync(abs(b.scratch), { recursive: true });
		fs.mkdirSync(path.dirname(abs(b.proposal)), { recursive: true });
		fs.mkdirSync(path.dirname(abs(b.decisions)), { recursive: true });
		console.log(`==================== ${b.id} (${b.kind}, tier ${b.tier}, ${b.items} items, ${b.bytes} B, est ~${Math.round(b.estTokens / 1000)}K) ====================`);
		console.log(`file: ${b.file}`);
		console.log(`before launching: node tools/audit_campaign.js mark ${b.id} running`);
		console.log(`agent: subagent_type general-purpose, run_in_background true, description "campaign ${b.id}", prompt:\n`);
		console.log(renderPrompt(m, b));
		console.log("");
	}
}

async function cmdMark(pos, opts) {
	const [id, status] = pos;
	if (!id || !status) die("usage: mark <batch|all-applied> <status> [--tokens N] [--note …]");
	await withManifest(async (m, save) => {
		const targets = id === "all-applied" ? m.batches.filter((b) => b.status === "applied") : [batchOf(m, id)];
		if (!targets.length) die("no applied batches");
		if (status === "committed") {
			const dirty = capture("git", ["-C", m.worktree, "status", "--porcelain", "--", "data/sku_links.json", "data/sku_links_auto.json"]).stdout.trim();
			if (dirty) die(`the link files are still uncommitted in ${m.worktree}:\n${dirty}\nThe owner commits them; mark committed only after that.`);
			for (const b of targets) if (b.status !== "applied") die(`${b.id} is ${b.status}, not applied`);
			m.linksState = null;
		}
		if (status === "applied") die("`applied` is set only by `collect`");
		if (status === "done")
			for (const b of targets) {
				const { errors } = checkCoverage(b);
				if (errors.length) die(`${b.id} coverage FAILED (${errors.length}): ${errors.slice(0, 10).join("; ")}`);
			}
		const head = status === "committed" ? capture("git", ["-C", m.worktree, "rev-parse", "HEAD"]).stdout.trim() : undefined;
		for (const b of targets) {
			setStatus(b, status, opts["--note"]);
			if (head !== undefined) b.commit = head;
			if (opts["--tokens"] !== undefined) {
				const t = Number(opts["--tokens"]);
				if (!Number.isFinite(t)) die("--tokens must be a number");
				b.tokens = t;
			}
		}
		save();
		console.log(`${targets.map((b) => b.id).join(", ")} → ${status}`);
	});
}

function readDecisions(b) {
	const f = abs(b.decisions);
	if (!fs.existsSync(f)) die(`no decisions file ${b.decisions}`);
	return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l, i) => {
		try {
			return JSON.parse(l);
		} catch (e) {
			die(`${b.decisions}:${i + 1} is not JSON: ${e.message}`);
		}
	});
}

const VERDICTS = {
	pairs: ["link", "ignore", "noop", "review"],
	groups: ["clean", "split", "review"],
	labels: ["keep", "flip", "remove", "review"],
};

function checkCoverage(b) {
	const data = readJson(abs(b.file));
	const want = new Map(itemsOf(b, data).map((it) => [it.id, it]));
	const seen = new Map();
	const errors = [];
	for (const d of readDecisions(b)) {
		if (d.id === undefined) errors.push(`decision without id: ${JSON.stringify(d)}`);
		else if (!want.has(d.id)) errors.push(`extra id ${d.id}`);
		else if (seen.has(d.id)) errors.push(`duplicate id ${d.id}`);
		else if (!VERDICTS[b.kind].includes(d.verdict)) errors.push(`${d.id}: verdict "${d.verdict}" not in ${VERDICTS[b.kind].join("|")}`);
		else seen.set(d.id, d);
	}
	for (const idk of want.keys()) if (!seen.has(idk)) errors.push(`missing ${idk}`);
	return { data, decisions: seen, errors };
}

function cmdCoverage(pos) {
	const m = loadManifest();
	const b = batchOf(m, pos[0]);
	const { errors, decisions } = checkCoverage(b);
	if (errors.length) die(`${b.id} coverage FAILED (${errors.length}):\n  ${errors.slice(0, 40).join("\n  ")}`);
	const by = {};
	for (const d of decisions.values()) by[d.verdict] = (by[d.verdict] || 0) + 1;
	console.log(`${b.id}: ${decisions.size}/${b.items} items decided exactly once — ${Object.entries(by).map(([v, c]) => `${v} ${c}`).join(", ")}`);
}

// The model disagreed with the agent: prob >= 0.5 but judged different, or < 0.5 but judged same.
function modelWrong(b, data, decisions, ops) {
	let wrong = 0;
	if (b.kind === "pairs") {
		for (const it of data.items) {
			const v = decisions.get(it.id).verdict;
			if ((v === "link" && it.prob < 0.5) || (v === "ignore" && it.prob >= 0.5)) wrong++;
		}
	} else if (b.kind === "labels") {
		for (const it of data.items) {
			const v = decisions.get(it.id).verdict;
			if (v === "review" || v === "remove") continue;
			const same = (it.label === "link") === (v === "keep");
			if ((same && it.oofP < 0.5) || (!same && it.oofP >= 0.5)) wrong++;
		}
	} else {
		const cut = new Set(ops.filter((o) => o.op === "unlink" || o.op === "unlink-auto").map((o) => pairKey(o.a, o.b)));
		for (const g of data.groups) {
			if (decisions.get(g.id).verdict === "review") continue;
			for (const e of g.edges) {
				if (e.prob === null || e.pin) continue;
				const severed = cut.has(pairKey(e.a, e.b));
				if ((severed && e.prob >= 0.5) || (!severed && e.prob < 0.5)) wrong++;
			}
		}
	}
	return wrong;
}

async function cmdCollect(pos, opts) {
	await withManifest((m, save) => collectLocked(m, save, pos, opts));
}

// Runs under the manifest lock: applies are serial and the recorded link-file state always matches
// what was written.
function collectLocked(m, save, pos, opts) {
	const b = batchOf(m, pos[0]);
	if (b.status !== "done" && b.status !== "running") die(`${b.id} is ${b.status}; collect takes a done (or running, finished) batch`);
	const { data, decisions, errors } = checkCoverage(b);
	if (errors.length) die(`${b.id} coverage FAILED — fix the decisions file first:\n  ${errors.slice(0, 40).join("\n  ")}`);
	const wt = m.worktree;
	if (!opts["--no-fetch"]) {
		const f = capture("git", ["-C", wt, "fetch", "origin", "data"]);
		if (f.status !== 0) die(`git fetch failed:\n${f.stderr}`);
	}
	const behind = Number(capture("git", ["-C", wt, "rev-list", "--count", "HEAD..origin/data"]).stdout.trim());
	if (behind !== 0) die(`the worktree is ${behind} commit(s) behind origin/data. The owner must commit the applied link files and update the worktree first (an apply over a stale file would be lost on the next pull).`);
	const dirty = capture("git", ["-C", wt, "status", "--porcelain"]).stdout.split("\n").filter(Boolean);
	const allowed = new Set(["data/sku_links.json", "data/sku_links_auto.json"]);
	const unexpected = dirty.filter((l) => !allowed.has(l.slice(3)));
	if (unexpected.length) die(`unexpected dirty files in ${wt}:\n  ${unexpected.join("\n  ")}`);
	const linkFiles = ["data/sku_links.json", "data/sku_links_auto.json"].map((f) => path.join(wt, f));
	const state = () => linkFiles.map((f) => sha256(f)).join(",");
	if (dirty.length) {
		if (!m.linksState || m.linksState.sha !== state()) die(`the link files are dirty but do not match the campaign's last apply (${m.linksState ? m.linksState.by : "none recorded"}) — someone else edited them. Resolve by hand before collecting.`);
	}
	const proposals = [abs(b.proposal), abs(b.followup)].filter((f, i) => i === 0 || fs.existsSync(f));
	if (!fs.existsSync(proposals[0])) die(`no proposal ${b.proposal}`);
	const reports = [];
	for (const p of proposals) {
		run("node", [path.join(REPO, "tools", "validate_proposal_skus.js"), "--proposal", p, "--root", wt, "--fix"]);
		const dry = capture("node", [path.join(REPO, "tools", "apply_audit_proposal.js"), "--proposal", p, "--root", wt, "--json"]);
		if (dry.status !== 0) die(`dry-run failed for ${rel(p)}:\n${dry.stderr}${dry.stdout.slice(0, 4000)}`);
		const rep = JSON.parse(dry.stdout);
		if (rep.newlyGroupedIgnores.length) die(`${rel(p)} would group ${rep.newlyGroupedIgnores.length} ignored pair(s) — resolve before applying: ${JSON.stringify(rep.newlyGroupedIgnores.slice(0, 10))}`);
		const app = capture("node", [path.join(REPO, "tools", "apply_audit_proposal.js"), "--proposal", p, "--root", wt, "--json", "--apply"]);
		if (app.status !== 0) die(`apply failed for ${rel(p)}:\n${app.stderr}`);
		const ar = JSON.parse(app.stdout);
		m.linksState = { sha: state(), at: nowIso(), by: `collect ${b.id} (${rel(p)})` };
		save();
		if (ar.ineffectiveUnlinks.length) console.log(`WARN ${rel(p)}: ${ar.ineffectiveUnlinks.length} ineffective unlink(s) — the group was NOT split; follow up: ${JSON.stringify(ar.ineffectiveUnlinks.slice(0, 5))}`);
		reports.push(ar);
	}
	const ops = proposals.flatMap((p) => readJson(p).ops);
	const okOps = reports.flatMap((r) => r.ops.filter((o) => o.status === "ok"));
	const count = (op) => okOps.filter((o) => o.op === op).length;
	const y = {
		link: count("link"),
		ignore: reports.reduce((s, r) => s + r.diff.addedIgnores.length, 0),
		unlink: count("unlink") + count("unlink-auto"),
		removeIgnore: count("remove-ignore"),
		review: reports.reduce((s, r) => s + r.review.length, 0),
		dataQuality: reports.reduce((s, r) => s + r.dataQuality.length, 0),
		skipped: reports.reduce((s, r) => s + r.summary.skipped, 0),
		ineffectiveUnlinks: reports.reduce((s, r) => s + r.ineffectiveUnlinks.length, 0),
		modelWrong: modelWrong(b, data, decisions, ops),
		verdicts: {},
	};
	for (const d of decisions.values()) y.verdicts[d.verdict] = (y.verdicts[d.verdict] || 0) + 1;
	const resultFile = abs(b.result);
	if (fs.existsSync(resultFile)) {
		const res = readJson(resultFile);
		for (const [v, c] of Object.entries(y.verdicts)) if (res.verdicts && res.verdicts[v] !== c) console.log(`WARN: the agent's result.json says ${v}=${res.verdicts[v]}, the decisions file has ${c}`);
	}
	b.yield = y;
	b.applyReports = reports.map((r) => ({ proposal: r.proposal, links: `${r.counts.linksBefore}→${r.counts.linksAfter}`, ignores: `${r.counts.ignoresBefore}→${r.counts.ignoresAfter}` }));
	setStatus(b, "applied", `+${y.link} links, +${y.ignore} ignores, ${y.unlink} unlinks`);
	m.linksState = { sha: state(), at: nowIso(), by: `collect ${b.id}` };
	save();
	console.log(`${b.id} applied: ${JSON.stringify(y)}`);
	console.log("The link files are now uncommitted. Ask the owner to commit data/sku_links.json (+ sku_links_auto.json if changed) before the next cron run, then `mark all-applied committed`.");
}

async function cmdRoundClose(pos, opts) {
	const n = Number(pos[0]);
	const m = loadManifest();
	const r = roundOf(m, n);
	if (r.status !== "open") die(`round ${n} is ${r.status}`);
	const open = m.batches.filter((b) => b.round === n && (b.status === "running" || b.status === "done"));
	if (open.length && !opts["--allow-open"]) die(`round ${n} has unapplied batches (${open.map((b) => `${b.id}:${b.status}`).join(", ")}) — collect them, mark them failed, or pass --allow-open`);
	const labels = loadLabels(m.worktree);
	const dir = retrain(n, m.worktree, { pinFrozen: false });
	const metrics = evalFrozen(dir, [
		["baseline", abs(m.baselineModel)],
		["round", path.join(dir, "gbt_model.json")],
	]);
	await withManifest(async (mm, save) => {
		const rr = roundOf(mm, n);
		const applied = mm.batches.filter((b) => b.round === n && b.yield);
		Object.assign(rr, {
			status: "closed",
			closedAt: nowIso(),
			labels: labels.counts,
			labelsAdded: { links: labels.counts.links - rr.labelsAtOpen.links, ignores: labels.counts.ignores - rr.labelsAtOpen.ignores, fromBatches: { link: applied.reduce((s, b) => s + b.yield.link, 0), ignore: applied.reduce((s, b) => s + b.yield.ignore, 0) } },
			model: rel(path.join(dir, "gbt_model.json")),
			metrics: metrics.models,
			frozenRows: metrics.rows,
		});
		mm.rounds.push({ round: n + 1, status: "open", openedAt: nowIso(), labelsAtOpen: labels.counts, rich: {}, mines: [], precisionSince: rr.precisionSince });
		save();
	});
	console.log(`round ${n} closed; round ${n + 1} open. Metrics on the frozen split (${metrics.rows} rows) are in ${rel(path.join(dir, "frozen_metrics.json"))}.`);
}

// ---------------------------------------------------------------------------------------------

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const V = ["--round", "--profile", "--model", "--sources", "--n", "--tokens", "--note", "--root", "--emb-k"];
	const B = ["--dry-run", "--no-fetch", "--allow-open", "--register"];
	const { pos, opts } = parseArgs(rest, V, B);
	if (cmd === "init") return cmdInit(opts);
	if (cmd === "generate") return cmdGenerate(opts);
	if (cmd === "mine") return cmdMine(opts);
	if (cmd === "status") return cmdStatus();
	if (cmd === "next") return cmdNext(opts);
	if (cmd === "mark") return cmdMark(pos, opts);
	if (cmd === "coverage") return cmdCoverage(pos);
	if (cmd === "collect") return cmdCollect(pos, opts);
	if (cmd === "round-close") return cmdRoundClose(pos, opts);
	console.error(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 15).join("\n").replace(/^\/\/ ?/gm, ""));
	process.exit(2);
}

main().catch((e) => {
	console.error(e instanceof CampaignError ? `audit_campaign: ${e.message}` : e);
	process.exit(1);
});
