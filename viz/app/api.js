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
	return (
		(location.protocol === "http:" || location.protocol === "https:") &&
		(h === "127.0.0.1" || h === "localhost")
	);
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

const RAW_CACHE_NAME = "stviz:raw:v1";
const MEM = new Map(); // session-only microcache

// Parse a Git LFS pointer file. Returns { oid, size } or null if not a pointer.
function parseLfsPointer(txt) {
	const lines = (txt || "").trim().split(/\r?\n/);
	if (!lines[0]?.startsWith("version https://git-lfs.github.com/spec/v1")) return null;
	let oid = null, size = null;
	for (const line of lines) {
		const m1 = line.match(/^oid sha256:([0-9a-f]{64})$/);
		if (m1) oid = m1[1];
		const m2 = line.match(/^size (\d+)$/);
		if (m2) size = parseInt(m2[1], 10);
	}
	return oid && Number.isFinite(size) ? { oid, size } : null;
}

// Call GitHub LFS Batch API for a single object and return the CDN download URL.
async function githubLfsBatchUrl({ owner, repo, oid, size }) {
	const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/info/lfs/objects/batch`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/vnd.git-lfs+json",
			"Accept": "application/vnd.git-lfs+json",
		},
		body: JSON.stringify({
			operation: "download",
			transfers: ["basic"],
			objects: [{ oid, size }],
		}),
	});
	if (!res.ok) throw new Error(`LFS batch API HTTP ${res.status}`);
	const data = await res.json();
	const href = data?.objects?.[0]?.actions?.download?.href;
	if (!href) throw new Error(`LFS batch: no download href for oid ${oid.slice(0, 8)}`);
	return href;
}

const LFS_CACHE_KEY_PREFIX = "stviz://lfs/";

// Fetch and cache LFS object content by OID (stable key, never expires).
async function fetchLfsContent({ owner, repo, oid, size }) {
	// Session cache (keyed by OID, not CDN URL which is time-limited)
	const lfsKey = `${LFS_CACHE_KEY_PREFIX}${oid}`;
	const memHit = MEM.get(lfsKey);
	if (typeof memHit === "string") return memHit;

	// Persistent cache
	if (globalThis.caches) {
		const cache = await caches.open(RAW_CACHE_NAME);
		const hit = await cache.match(lfsKey);
		if (hit) {
			const txt = await hit.text();
			MEM.set(lfsKey, txt);
			return txt;
		}
	}

	// Resolve via LFS batch API then fetch from CDN
	const cdnUrl = await githubLfsBatchUrl({ owner, repo, oid, size });
	const cdnRes = await fetch(cdnUrl);
	if (!cdnRes.ok) throw new Error(`LFS CDN HTTP ${cdnRes.status} for oid ${oid.slice(0, 8)}`);
	const txt = await cdnRes.text();
	MEM.set(lfsKey, txt);

	if (globalThis.caches) {
		const cache = await caches.open(RAW_CACHE_NAME);
		await cache.put(lfsKey, new Response(txt));
	}

	return txt;
}

export async function githubFetchFileAtSha({ owner, repo, sha, path }) {
	const cleanPath = String(path || "").replace(/^\/+/, "");
	const raw = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/${cleanPath}`;
	const txt = await fetchTextImmutableCached(raw);

	const lfs = parseLfsPointer(txt);
	if (lfs) {
		// LFS-tracked file: resolve actual content via batch API → CDN, cached by OID.
		const actual = await fetchLfsContent({ owner, repo, ...lfs });
		return JSON.parse(actual);
	}

	return JSON.parse(txt);
}

async function fetchTextImmutableCached(url) {
	// session cache
	const memHit = MEM.get(url);
	if (typeof memHit === "string") return memHit;

	// persistent cache (CacheStorage)
	if (globalThis.caches) {
		const cache = await caches.open(RAW_CACHE_NAME);
		const hit = await cache.match(url);
		if (hit) {
			const txt = await hit.text();
			MEM.set(url, txt);
			return txt;
		}

		// Use normal HTTP cache too; URL is immutable because sha is in it.
		const res = await fetch(url, { cache: "force-cache" });
		if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
		await cache.put(url, res.clone());

		const txt = await res.text();
		MEM.set(url, txt);
		return txt;
	}

	// fallback
	const res = await fetch(url, { cache: "force-cache" });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	const txt = await res.text();
	MEM.set(url, txt);
	return txt;
}
