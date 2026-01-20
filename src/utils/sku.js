"use strict";

// Alberta CSPC / product code is 6 digits. Some stores label it "SKU".
function normalizeCspc(v) {
  const m = String(v ?? "").match(/\b(\d{6})\b/);
  return m ? m[1] : "";
}

module.exports = { normalizeCspc };
