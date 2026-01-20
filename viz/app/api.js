export async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

export async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

export function inferGithubOwnerRepo() {
  const host = location.hostname || "";
  const m = host.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (m) {
    const owner = m[1];
    const parts = (location.pathname || "/").split("/").filter(Boolean);
    const repo = parts.length >= 1 ? parts[0] : `${owner}.github.io`;
    return { owner, repo };
  }
  return { owner: "brennanwilkes", repo: "spirit-tracker" };
}

export function isLocalWriteMode() {
  const h = String(location.hostname || "").toLowerCase();
  return (location.protocol === "http:" || location.protocol === "https:") && (h === "127.0.0.1" || h === "localhost");
}

/* ---- Local disk-backed SKU link API (only on viz/serve.js) ---- */

export async function apiReadSkuMetaFromLocalServer() {
  const r = await fetch("/__stviz/sku-links", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return {
    links: Array.isArray(j?.links) ? j.links : [],
    ignores: Array.isArray(j?.ignores) ? j.ignores : [],
  };
}

export async function apiWriteSkuLink(fromSku, toSku) {
  const res = await fetch("/__stviz/sku-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromSku, toSku }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function apiWriteSkuIgnore(skuA, skuB) {
  const res = await fetch("/__stviz/sku-ignores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ skuA, skuB }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/**
 * Best-effort read of sku meta:
 *  - On GitHub Pages: expects file at viz/data/sku_links.json
 *  - On local server: reads via /__stviz/sku-links (disk)
 */
export async function loadSkuMetaBestEffort() {
  // 1) GitHub Pages / static deploy inside viz/
  try {
    const j = await fetchJson("./data/sku_links.json");
    return {
      links: Array.isArray(j?.links) ? j.links : [],
      ignores: Array.isArray(j?.ignores) ? j.ignores : [],
    };
  } catch {}

  // 2) alternate static path (in case you later serve viz under a subpath)
  try {
    const j = await fetchJson("/data/sku_links.json");
    return {
      links: Array.isArray(j?.links) ? j.links : [],
      ignores: Array.isArray(j?.ignores) ? j.ignores : [],
    };
  } catch {}

  // 3) Local server API (disk)
  try {
    return await apiReadSkuMetaFromLocalServer();
  } catch {}

  return { links: [], ignores: [] };
}

/* ---- GitHub history helpers ---- */

export async function githubListCommits({ owner, repo, branch, path }) {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`;
  const u1 = `${base}?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=100&page=1`;
  const page1 = await fetchJson(u1);

  if (Array.isArray(page1) && page1.length === 100) {
    const u2 = `${base}?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=100&page=2`;
    const page2 = await fetchJson(u2);
    return [...page1, ...(Array.isArray(page2) ? page2 : [])];
  }

  return Array.isArray(page1) ? page1 : [];
}

export async function githubFetchFileAtSha({ owner, repo, sha, path }) {
  const raw = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/${path}`;
  const txt = await fetchText(raw);
  return JSON.parse(txt);
}
