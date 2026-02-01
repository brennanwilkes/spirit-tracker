export function parsePriceToNumber(v) {
    const s = String(v ?? "").replace(/[^0-9.]/g, "");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  
  export function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  
  export function makeSyntheticSku(r) {
    const store = String(r?.storeLabel || r?.store || "store");
    const url = String(r?.url || "");
    const key = `${store}|${url}`;
    return `u:${fnv1a32(key)}`;
  }
  
  export function keySkuForRow(r) {
    const real0 = String(r?.sku || "").trim();
    if (real0) {
      const m = real0.match(/^id:(\d{1,6})$/i);
      return m ? String(m[1]).padStart(6, "0") : real0;
    }
    return makeSyntheticSku(r);
  }
  
  export function displaySku(key) {
    const s = String(key || "");
    return s.startsWith("u:") ? "unknown" : s;
  }
  
  export function isUnknownSkuKey(key) {
    return String(key || "").startsWith("u:");
  }
  
  // Normalize for search: lowercase, punctuation -> space, collapse spaces
  export function normSearchText(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  
  export function tokenizeQuery(q) {
    const n = normSearchText(q);
    return n ? n.split(" ").filter(Boolean) : [];
  }
  
  export function matchesAllTokens(hayNorm, tokens) {
    if (!tokens.length) return true;
    for (const t of tokens) if (!hayNorm.includes(t)) return false;
    return true;
  }
  