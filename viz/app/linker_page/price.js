// viz/app/linker/price.js
export function buildPricePenaltyForPair({ allAgg, rules, kPerGroup = 6 }) {
	// canonSku -> sorted array of up to kPerGroup lowest prices
	const groupPrices = new Map();

	function insertPrice(arr, p) {
		// keep sorted ascending, cap length
		let i = 0;
		while (i < arr.length && arr[i] <= p) i++;
		arr.splice(i, 0, p);
		if (arr.length > kPerGroup) arr.length = kPerGroup;
	}

	for (const it of allAgg || []) {
		if (!it) continue;
		const sku = String(it.sku || "");
		if (!sku) continue;

		const p = it.cheapestPriceNum;
		if (p == null || !(p > 0)) continue;

		const canon = String((rules && rules.canonicalSku && rules.canonicalSku(sku)) || sku);
		let arr = groupPrices.get(canon);
		if (!arr) groupPrices.set(canon, (arr = []));
		insertPrice(arr, p);
	}

	function bestRelativeGap(prA, prB) {
		// min |a-b| / min(a,b)
		let best = Infinity;
		for (let i = 0; i < prA.length; i++) {
			const a = prA[i];
			for (let j = 0; j < prB.length; j++) {
				const b = prB[j];
				const gap = Math.abs(a - b) / Math.max(1e-9, Math.min(a, b));
				if (gap < best) best = gap;
				if (best <= 0.001) return best;
			}
		}
		return best;
	}

	function gapToMultiplier(gap) {
		// gap = 0.40 => 40% relative difference
		// <=35%: no penalty
		// 35-50%: ease down to ~0.75
		// >50%: continue down gently, floor at 0.35
		if (!(gap >= 0)) return 1.0;
		if (gap <= 0.35) return 1.0;

		if (gap <= 0.5) {
			const t = (gap - 0.35) / 0.15; // 0..1
			return 1.0 - 0.25 * t; // 1.00 -> 0.75
		}

		const m = 0.75 * (0.5 / gap);
		return Math.max(0.35, m);
	}

	return function pricePenaltyForPair(aSku, bSku) {
		const a = String(aSku || "");
		const b = String(bSku || "");
		if (!a || !b) return 1.0;

		const aCanon = String((rules && rules.canonicalSku && rules.canonicalSku(a)) || a);
		const bCanon = String((rules && rules.canonicalSku && rules.canonicalSku(b)) || b);

		const prA = groupPrices.get(aCanon);
		const prB = groupPrices.get(bCanon);
		if (!prA || !prB || !prA.length || !prB.length) return 1.0;

		const gap = bestRelativeGap(prA, prB);
		if (!isFinite(gap)) return 1.0;

		return gapToMultiplier(gap);
	};
}
