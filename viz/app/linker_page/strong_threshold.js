export const STRONG_ABS = 1.5;
export const STRONG_REL = 0.15;

export function isStrong(score, topScore) {
	const cutoff = Math.max(STRONG_ABS, STRONG_REL * (topScore || 0));
	return (score || 0) >= cutoff;
}

// Probability-scale thresholds, used when the learned blend is active (scores are
// calibrated probabilities in [0,1] instead of the raw multiplicative score). A
// candidate is a "strong suggestion" when it clears an absolute confidence floor AND a
// fraction of the best candidate's confidence.
export const STRONG_ABS_PROB = 0.55;
export const STRONG_REL_PROB = 0.6;

export function isStrongProb(score, topScore) {
	const cutoff = Math.max(STRONG_ABS_PROB, STRONG_REL_PROB * (topScore || 0));
	return (score || 0) >= cutoff;
}

// ── ≤1%-FP "auto-link confidence" bar (the 99%-precision operating point we monitor) ──────────
// An ABSOLUTE certainty gate — a candidate is surfaced as a confident "Suggestion" (and gets the
// strong highlight) ONLY above this bar. It is scorer-specific because precision-at-a-score depends
// on the scorer, and lives on the 0–1 DISPLAYED score (blend probability when the learned model is
// active, else the classical raw score squashed via s/(s+1) = toConfidence01):
//   - GBT/blend probability: 0.95 — conservative, comfortably inside the ≤1% FP budget (the measured
//     held-out 99%-precision line sits ~0.91; see tools/linker_ml + export_gbt.py).
//   - Classical scorer: raw scorePairWithVocab ≥ 16.13 (tools/linker_eval.mjs auto-link @99%
//     precision), which on the squashed display scale is 16.13/(16.13+1) ≈ 0.9416.
export const PREC99_PROB = 0.95;
export const PREC99_DET_RAW = 16.13;
export const PREC99_DET_DISPLAY = PREC99_DET_RAW / (PREC99_DET_RAW + 1); // ≈ 0.9416

// The absolute confidence bar on the displayed 0–1 score, given whether the learned blend is active.
export function autoLinkConfidenceBar(blendActive) {
	return blendActive ? PREC99_PROB : PREC99_DET_DISPLAY;
}
