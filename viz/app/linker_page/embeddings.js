// viz/app/linker_page/embeddings.js
//
// Loads the fine-tuned SKU name embeddings (viz/data/sku_embeddings.json, an LFS artifact
// on the data branch produced by tools/linker_ml/train_embed.py) and exposes a cosine
// function for the learned blend. The file is OPTIONAL: if it's absent (e.g. not yet
// shipped to the deployed Pages site), loadSkuEmbeddings() resolves to null and the
// caller falls back to the no-embed blend weights — no error, no behavior change.
//
// Format: a plain JSON map { "<sku>": [f0, f1, …, f383], … } of L2-normalized vectors.

import { fetchJson } from "../api.js";

let EMB = undefined; // undefined = not tried; null = absent; object = loaded

export async function loadSkuEmbeddings() {
	if (EMB !== undefined) return EMB;
	try {
		EMB = await fetchJson("./data/sku_embeddings.json");
		if (!EMB || typeof EMB !== "object") EMB = null;
	} catch {
		EMB = null; // 404 / parse error → treat as "no embeddings available"
	}
	return EMB;
}

// Returns a cosine(skuA, skuB) → [-1,1] function, or null when no embeddings are loaded.
// Vectors are stored normalized, but we normalize defensively so the math is exact.
export function makeEmbedCosFn(emb) {
	if (!emb) return null;
	return (a, b) => {
		const va = emb[a];
		const vb = emb[b];
		if (!va || !vb) return 0;
		let d = 0;
		let na = 0;
		let nb = 0;
		for (let i = 0; i < va.length; i++) {
			d += va[i] * vb[i];
			na += va[i] * va[i];
			nb += vb[i] * vb[i];
		}
		return na && nb ? d / Math.sqrt(na * nb) : 0;
	};
}
