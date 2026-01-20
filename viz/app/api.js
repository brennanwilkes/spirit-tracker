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
  
  export async function loadSkuLinksBestEffort() {
    try {
      const r = await fetch("/__stviz/sku-links", { cache: "no-store" });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j?.links) ? j.links : [];
    } catch {
      return [];
    }
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
  