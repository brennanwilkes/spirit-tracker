"use strict";

const { setTimeout: sleep } = require("timers/promises");

async function parallelMapStaggered(arr, concurrency, staggerMs, fn) {
	const out = new Array(arr.length);
	let next = 0;

	async function worker(workerId) {
		if (staggerMs > 0 && workerId > 1) await sleep(staggerMs * (workerId - 1));
		while (true) {
			const i = next++;
			if (i >= arr.length) return;
			if (staggerMs > 0 && i > 0) await sleep(staggerMs);
			out[i] = await fn(arr[i], i);
		}
	}

	const w = Math.min(concurrency, arr.length);
	const workers = [];
	for (let i = 0; i < w; i++) workers.push(worker(i + 1));
	await Promise.all(workers);
	return out;
}

/**
 * Returns a scheduler function that enforces a minimum interval between calls.
 * Calls are serialized and each waits until at least minIntervalMs after the
 * previous call started.
 *
 *   const schedule = createMinIntervalLimiter(12000);
 *   await schedule(() => fetchPage(url)); // each call spaced ≥12s apart
 */
function createMinIntervalLimiter(minIntervalMs) {
	let lastStart = 0;
	let chain = Promise.resolve();

	return async function schedule(fn) {
		chain = chain.then(async () => {
			const now = Date.now();
			const waitMs = Math.max(0, lastStart + minIntervalMs - now);
			if (waitMs) await sleep(waitMs);
			lastStart = Date.now();
			return fn();
		});
		return chain;
	};
}

module.exports = { parallelMapStaggered, createMinIntervalLimiter };
