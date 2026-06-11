// viz/app/linker_page/embeddings.js
//
// Loads the fine-tuned SKU name embeddings (viz/data/sku_embeddings.json, an LFS artifact
// on the data branch produced by tools/linker_ml/train_embed.py) and builds the learned
// blend for the live ranker.
//
// CRITICAL: the embed-trained weights rely on a REAL embed_cosine signal — they down-weight
// the deterministic factors expecting the embedding to carry that load. If the embeddings
// file is absent OR doesn't match the loaded catalog (a build/version skew), embed_cosine
// would be 0/missing for every pair and the embed weights would collapse every score to
// ~0.02. So buildBlend() VERIFIES coverage and falls back to the (robust, no-data) no-embed
// weights unless the vectors genuinely cover the catalog. Missing ≠ dissimilar.

import { fetchJson } from "../api.js";
import { keySkuForRow } from "../sku.js";

let EMB = undefined; // undefined = not tried; null = absent; object = loaded

// sku_embeddings.json is no longer committed to the data branch — it's a ~40 MB blob rewritten
// ~3x/day, so it ships as a GitHub Release asset (fixed tag, overwritten each scrape by
// run_daily.sh; see CLAUDE.md "LFS removal"). Try the local path first (present in local dev,
// where run_daily.sh copies it into the worktree); fall back to the Release asset in prod, where
// the local path 404s. The Release CDN sends permissive CORS, so the cross-origin fetch works.
const EMB_RELEASE_URL =
	"https://github.com/brennanwilkes/spirit-tracker/releases/download/embeddings-latest/sku_embeddings.json";

export async function loadSkuEmbeddings() {
	if (EMB !== undefined) return EMB;
	try {
		let raw = await fetchJson("./data/sku_embeddings.json").catch(() => null);
		if (!raw) raw = await fetchJson(EMB_RELEASE_URL);
		if (!raw || typeof raw !== "object") {
			EMB = null;
			return EMB;
		}
		// The file is keyed by RAW store SKU (e.g. "id:1011105"), but the SPA aggregates
		// items under keySkuForRow-normalized SKUs ("id:1011105" → "1011105"). Re-key so the
		// lookups match. Vectors are shared by reference (no copy). Raw keys are kept too.
		const norm = Object.create(null);
		for (const k in raw) {
			norm[k] = raw[k];
			const nk = keySkuForRow({ sku: k });
			if (nk && nk !== k) norm[nk] = raw[k];
		}
		EMB = norm;
	} catch {
		EMB = null; // 404 / parse error → treat as "no embeddings available"
	}
	return EMB;
}

// Returns a cosine(skuA, skuB) → [-1,1] function, or null when no embeddings are loaded.
// Returns NULL for a pair when either vector is missing (so blendScore treats it as neutral,
// not as a real cosine of 0). Vectors are stored normalized; we normalize defensively.
export function makeEmbedCosFn(emb) {
	if (!emb) return null;
	return (a, b) => {
		const va = emb[a];
		const vb = emb[b];
		if (!va || !vb) return null;
		let d = 0;
		let na = 0;
		let nb = 0;
		for (let i = 0; i < va.length; i++) {
			d += va[i] * vb[i];
			na += va[i] * va[i];
			nb += vb[i] * vb[i];
		}
		return na && nb ? d / Math.sqrt(na * nb) : null;
	};
}

const COVERAGE_MIN = 0.8; // need ≥80% of sampled catalog SKUs embedded to trust the embed weights

// The one entry point the linker pages call. Picks the embed weights + cosine ONLY when the
// vectors cover the loaded catalog; otherwise the no-embed weights (robust, no data needed).
// Returns { weights, embedCosFn } — the shape recommendSimilar's opts.blend expects.
export async function buildBlend(allAgg, weightsEmbed, weightsNoEmbed) {
	const emb = await loadSkuEmbeddings();
	if (emb) {
		const n = Array.isArray(allAgg) ? allAgg.length : 0;
		const step = Math.max(1, Math.floor(n / 500));
		let sampled = 0;
		let present = 0;
		for (let i = 0; i < n; i += step) {
			const s = String(allAgg[i] && allAgg[i].sku ? allAgg[i].sku : "");
			if (!s) continue;
			sampled++;
			if (emb[s]) present++;
		}
		const coverage = sampled ? present / sampled : 0;
		if (coverage >= COVERAGE_MIN) {
			console.info(`[linker] embeddings active — coverage ${(coverage * 100).toFixed(0)}%`);
			// weightsNoEmbed is carried so recommendSimilar can compute the AI contribution
			// (embed prob − classical prob) per candidate for the UI indicator.
			return {
				weights: weightsEmbed,
				weightsNoEmbed,
				embedCosFn: makeEmbedCosFn(emb),
				embeddings: true,
				coverage,
			};
		}
		console.warn(
			`[linker] sku_embeddings.json present but coverage only ${(coverage * 100).toFixed(0)}% ` +
				`(stale/mismatched build) — using the no-embed blend. Rebuild via ` +
				`tools/linker_ml/train_embed.py against the current catalog to activate the embedding.`,
		);
	}
	return { weights: weightsNoEmbed, weightsNoEmbed: null, embedCosFn: null, embeddings: false, coverage: 0 };
}
