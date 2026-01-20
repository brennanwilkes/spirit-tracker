"use strict";

function normPrice(p) {
  return String(p || "").trim().replace(/\s+/g, "");
}

function priceToNumber(p) {
  const s = String(p || "");
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function salePctOff(oldPriceStr, newPriceStr) {
  const oldN = priceToNumber(oldPriceStr);
  const newN = priceToNumber(newPriceStr);
  if (!Number.isFinite(oldN) || !Number.isFinite(newN) || oldN <= 0) return null;
  if (newN >= oldN) return null;
  return Math.round(((oldN - newN) / oldN) * 100);
}

module.exports = { normPrice, priceToNumber, salePctOff };
