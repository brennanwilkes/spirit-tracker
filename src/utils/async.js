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

module.exports = { parallelMapStaggered };
