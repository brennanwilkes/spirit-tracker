// viz/app/pending.js
const LS_KEY = "stviz:v1:pendingSkuEdits";

function safeParseJson(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return null;
  }
}

export function loadPendingEdits() {
  const raw = (() => {
    try {
      return localStorage.getItem(LS_KEY) || "";
    } catch {
      return "";
    }
  })();

  const j = safeParseJson(raw);
  const links = Array.isArray(j?.links) ? j.links : [];
  const ignores = Array.isArray(j?.ignores) ? j.ignores : [];

  return {
    links: links
      .map((x) => ({
        fromSku: String(x?.fromSku || "").trim(),
        toSku: String(x?.toSku || "").trim(),
      }))
      .filter((x) => x.fromSku && x.toSku && x.fromSku !== x.toSku),
    ignores: ignores
      .map((x) => ({
        skuA: String(x?.skuA || x?.a || "").trim(),
        skuB: String(x?.skuB || x?.b || "").trim(),
      }))
      .filter((x) => x.skuA && x.skuB && x.skuA !== x.skuB),
    createdAt: String(j?.createdAt || ""),
  };
}

export function savePendingEdits(edits) {
  const out = {
    createdAt: edits?.createdAt || new Date().toISOString(),
    links: Array.isArray(edits?.links) ? edits.links : [],
    ignores: Array.isArray(edits?.ignores) ? edits.ignores : [],
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(out));
  } catch {}
  return out;
}

export function clearPendingEdits() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {}
}

function canonicalPairKey(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return "";
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

export function addPendingLink(fromSku, toSku) {
  const f = String(fromSku || "").trim();
  const t = String(toSku || "").trim();
  if (!f || !t || f === t) return false;

  const edits = loadPendingEdits();
  const k = `${f}→${t}`;
  const seen = new Set(edits.links.map((x) => `${x.fromSku}→${x.toSku}`));
  if (seen.has(k)) return false;

  edits.links.push({ fromSku: f, toSku: t });
  savePendingEdits(edits);
  return true;
}

export function addPendingIgnore(skuA, skuB) {
  const a = String(skuA || "").trim();
  const b = String(skuB || "").trim();
  if (!a || !b || a === b) return false;

  const edits = loadPendingEdits();
  const k = canonicalPairKey(a, b);
  const seen = new Set(edits.ignores.map((x) => canonicalPairKey(x.skuA, x.skuB)));
  if (seen.has(k)) return false;

  edits.ignores.push({ skuA: a, skuB: b });
  savePendingEdits(edits);
  return true;
}

export function pendingCounts() {
  const e = loadPendingEdits();
  return { links: e.links.length, ignores: e.ignores.length, total: e.links.length + e.ignores.length };
}

export function applyPendingToMeta(meta) {
  const base = {
    generatedAt: String(meta?.generatedAt || ""),
    links: Array.isArray(meta?.links) ? meta.links.slice() : [],
    ignores: Array.isArray(meta?.ignores) ? meta.ignores.slice() : [],
  };

  const p = loadPendingEdits();

  // merge links (dedupe by from→to)
  const seenL = new Set(
    base.links.map((x) => `${String(x?.fromSku || "").trim()}→${String(x?.toSku || "").trim()}`)
  );
  for (const x of p.links) {
    const k = `${x.fromSku}→${x.toSku}`;
    if (!seenL.has(k)) {
      seenL.add(k);
      base.links.push({ fromSku: x.fromSku, toSku: x.toSku });
    }
  }

  // merge ignores (dedupe by canonical pair key)
  const seenI = new Set(
    base.ignores.map((x) =>
      canonicalPairKey(String(x?.skuA || x?.a || "").trim(), String(x?.skuB || x?.b || "").trim())
    )
  );
  for (const x of p.ignores) {
    const k = canonicalPairKey(x.skuA, x.skuB);
    if (!seenI.has(k)) {
      seenI.add(k);
      base.ignores.push({ skuA: x.skuA, skuB: x.skuB });
    }
  }

  return base;
}
