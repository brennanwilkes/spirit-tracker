// viz/app/linker_page/gbt.js
//
// Vanilla-JS inference for the gradient-boosted-tree blend (replaces the linear blendScore
// when a model is loaded). The GBT fixes two linear-blend pathologies: it does NOT
// extrapolate (so zero-overlap junk can't be pushed to 0.9 by a suppressor weight) and it
// routes MISSING features natively (a SKU with no embedding vector follows the tree's
// missing branch instead of being treated as "dissimilar").
//
// Model JSON (out/gbt_model.json → deployed as viz/data/gbt_model.json) is produced by
// tools/linker_ml/export_gbt.py: { keys, baseline, trees:[ [node...] ] }, where a node is
// either { leaf:true, value } or { f, t, l, r, m } (feature idx, threshold, left, right,
// missing_go_to_left). raw = baseline + Σ leaf values; probability = sigmoid(raw).

let MODEL = undefined; // undefined = not tried; null = absent; object = loaded

export async function loadGbtModel(url = "viz/data/gbt_model.json") {
	if (MODEL !== undefined) return MODEL;
	try {
		const r = await fetch(url);
		MODEL = r.ok ? await r.json() : null;
	} catch {
		MODEL = null;
	}
	return MODEL;
}

// Build the feature array in the model's key order. A non-finite feature (e.g. embed_cosine
// for a SKU with no vector) becomes NaN → the tree follows its missing branch.
export function gbtFeatureArray(features, keys) {
	const x = new Array(keys.length);
	for (let i = 0; i < keys.length; i++) {
		const v = Number(features[keys[i]]);
		x[i] = Number.isFinite(v) ? v : NaN;
	}
	return x;
}

function evalTree(nodes, x) {
	let i = 0;
	for (let guard = 0; guard < 100000; guard++) {
		const n = nodes[i];
		if (n.leaf) return n.value;
		const v = x[n.f];
		const goLeft = Number.isNaN(v) ? n.m : v <= n.t;
		i = goLeft ? n.l : n.r;
	}
	return 0;
}

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

// features = the object from extractBlendFeatures (+ group features). Returns [0,1] or null.
export function gbtScore(model, features) {
	if (!model || !model.trees) return null;
	const x = gbtFeatureArray(features, model.keys);
	let raw = model.baseline || 0;
	for (const t of model.trees) raw += evalTree(t, x);
	return sigmoid(raw);
}
