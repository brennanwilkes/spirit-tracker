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
