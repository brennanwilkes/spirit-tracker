export const STRONG_ABS = 1.5;
export const STRONG_REL = 0.15;

export function isStrong(score, topScore) {
	const cutoff = Math.max(STRONG_ABS, STRONG_REL * (topScore || 0));
	return (score || 0) >= cutoff;
}
