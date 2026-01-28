// viz/app/pending.js
const LS_KEY = "stviz:v1:pendingSkuEdits";
const LS_SUBMITTED_KEY = "stviz:v1:submittedSkuEdits";

function safeParseJson(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return null;
  }
}

function normSku(s) {
  return String(s || "").trim();
}

function linkKey(fromSku, toSku) {
  const f = normSku(fromSku);
  const t = normSku(toSku);
  if (!f || !t || f === t) return "";
  return `${f}→${t}`;
}

function pairKey(a, b) {
  const x = normSku(a);
  const y = normSku(b);
  if (!x || !y || x === y) return "";
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function loadEditsFromKey(key) {
  const raw = (() => {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  })();

  const j = safeParseJson(raw);
  const links = Array.isArray(j?.links) ? j.links : [];
  const ignores = Array.isArray(j?.ignores) ? j.ignores : [];

  return {
    createdAt: String(j?.createdAt || ""),
    links: links
      .map((x) => ({ fromSku: normSku(x?.fromSku), toSku: normSku(x?.toSku) }))
      .filter((x) => linkKey(x.fromSku, x.toSku)),
    ignores: ignores
      .map((x) => ({ skuA: normSku(x?.skuA || x?.a), skuB: normSku(x?.skuB || x?.b) }))
      .filter((x) => pairKey(x.skuA, x.skuB)),
  };
}

function saveEditsToKey(key, edits) {
  const out = {
    createdAt: edits?.createdAt || new Date().toISOString(),
    links: Array.isArray(edits?.links) ? edits.links : [],
    ignores: Array.isArray(edits?.ignores) ? edits.ignores : [],
  };
  try {
    localStorage.setItem(key, JSON.stringify(out));
  } catch {}
  return out;
}

export function loadPendingEdits() {
  return loadEditsFromKey(LS_KEY);
}

export function savePendingEdits(edits) {
  return saveEditsToKey(LS_KEY, edits);
}

export function clearPendingEdits() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {}
}

export function loadSubmittedEdits() {
  return loadEditsFromKey(LS_SUBMITTED_KEY);
}

export function saveSubmittedEdits(edits) {
  return saveEditsToKey(LS_SUBMITTED_KEY, edits);
}

export function clearSubmittedEdits() {
  try {
    localStorage.removeItem(LS_SUBMITTED_KEY);
  } catch {}
}

export function pendingCounts() {
  const e = loadPendingEdits();
  return {
    links: e.links.length,
    ignores: e.ignores.length,
    total: e.links.length + e.ignores.length,
  };
}

export function addPendingLink(fromSku, toSku) {
  const f = normSku(fromSku);
  const t = normSku(toSku);
  const k = linkKey(f, t);
  if (!k) return false;

  const pending = loadPendingEdits();
  const submitted = loadSubmittedEdits();

  const seen = new Set(
    [
      ...pending.links.map((x) => linkKey(x.fromSku, x.toSku)),
      ...submitted.links.map((x) => linkKey(x.fromSku, x.toSku)),
    ].filter(Boolean)
  );

  if (seen.has(k)) return false;

  pending.links.push({ fromSku: f, toSku: t });
  savePendingEdits(pending);
  return true;
}

export function addPendingIgnore(skuA, skuB) {
  const a = normSku(skuA);
  const b = normSku(skuB);
  const k = pairKey(a, b);
  if (!k) return false;

  const pending = loadPendingEdits();
  const submitted = loadSubmittedEdits();

  const seen = new Set(
    [
      ...pending.ignores.map((x) => pairKey(x.skuA, x.skuB)),
      ...submitted.ignores.map((x) => pairKey(x.skuA, x.skuB)),
    ].filter(Boolean)
  );

  if (seen.has(k)) return false;

  pending.ignores.push({ skuA: a, skuB: b });
  savePendingEdits(pending);
  return true;
}

// Merge PENDING + SUBMITTED into a meta object {links, ignores}
export function applyPendingToMeta(meta) {
  const base = {
    generatedAt: String(meta?.generatedAt || ""),
    links: Array.isArray(meta?.links) ? meta.links.slice() : [],
    ignores: Array.isArray(meta?.ignores) ? meta.ignores.slice() : [],
  };

  const p0 = loadPendingEdits();
  const p1 = loadSubmittedEdits();
  const overlay = {
    links: [...(p0.links || []), ...(p1.links || [])],
    ignores: [...(p0.ignores || []), ...(p1.ignores || [])],
  };

  // merge links (dedupe by from→to)
  const seenL = new Set(
    base.links
      .map((x) => linkKey(String(x?.fromSku || "").trim(), String(x?.toSku || "").trim()))
      .filter(Boolean)
  );
  for (const x of overlay.links) {
    const k = linkKey(x.fromSku, x.toSku);
    if (!k || seenL.has(k)) continue;
    seenL.add(k);
    base.links.push({ fromSku: x.fromSku, toSku: x.toSku });
  }

  // merge ignores (dedupe by canonical pair key)
  const seenI = new Set(
    base.ignores
      .map((x) => pairKey(String(x?.skuA || x?.a || "").trim(), String(x?.skuB || x?.b || "").trim()))
      .filter(Boolean)
  );
  for (const x of overlay.ignores) {
    const k = pairKey(x.skuA, x.skuB);
    if (!k || seenI.has(k)) continue;
    seenI.add(k);
    base.ignores.push({ skuA: x.skuA, skuB: x.skuB });
  }

  return base;
}

// Move everything from pending -> submitted, then clear pending.
// Returns the moved payload (what should be sent in PR/issue).
export function movePendingToSubmitted() {
  const pending = loadPendingEdits();
  if (!pending.links.length && !pending.ignores.length) return pending;

  const sub = loadSubmittedEdits();

  const seenL = new Set(sub.links.map((x) => linkKey(x.fromSku, x.toSku)).filter(Boolean));
  for (const x of pending.links) {
    const k = linkKey(x.fromSku, x.toSku);
    if (!k || seenL.has(k)) continue;
    seenL.add(k);
    sub.links.push({ fromSku: x.fromSku, toSku: x.toSku });
  }

  const seenI = new Set(sub.ignores.map((x) => pairKey(x.skuA, x.skuB)).filter(Boolean));
  for (const x of pending.ignores) {
    const k = pairKey(x.skuA, x.skuB);
    if (!k || seenI.has(k)) continue;
    seenI.add(k);
    sub.ignores.push({ skuA: x.skuA, skuB: x.skuB });
  }

  saveSubmittedEdits(sub);
  clearPendingEdits();
  return pending;
}
