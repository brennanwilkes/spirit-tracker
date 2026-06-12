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

export async function apiWriteSkuLink(fromSku, toSku, noTrain) {
	const res = await fetch("/__stviz/sku-links", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ fromSku, toSku, ...(noTrain ? { noTrain: true } : {}) }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

export async function apiWriteSkuIgnore(skuA, skuB, noTrain) {
	const res = await fetch("/__stviz/sku-ignores", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ skuA, skuB, ...(noTrain ? { noTrain: true } : {}) }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

// Approve an auto-classified pending link: drops the status annotation in place (the entry
// stays a real, now-confirmed, link). Used by the #/link-review page (local-write only).
export async function apiConfirmSkuLink(fromSku, toSku) {
	const res = await fetch("/__stviz/sku-links/confirm", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ fromSku, toSku }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

// Reject an auto-classified pending link: removes the link entry and records an ignore pair
// (a curated hard negative). Used by the #/link-review page (local-write only).
export async function apiRejectSkuLink(fromSku, toSku) {
	const res = await fetch("/__stviz/sku-links/reject", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ fromSku, toSku }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

export async function apiWriteSkuHidden(storeId, sku, reason) {
	const res = await fetch("/__stviz/sku-hidden", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ storeId, sku, ...(reason ? { reason } : {}) }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

export async function apiDeleteSkuHidden(storeId, sku) {
	const res = await fetch("/__stviz/sku-hidden", {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ storeId, sku }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

async function tryFetchLinks(path) {
	try {
		const j = await fetchJson(path);
		return Array.isArray(j?.links) ? j.links : [];
	} catch {
		return null;
	}
}

/**
 * Best-effort read of sku meta. The manually curated `sku_links.json` and the
 * auto-generated `sku_links_auto.json` are both pulled (when present) and their
 * `.links` arrays are unioned — downstream union-find treats every link the same
 * regardless of origin.
 *  - On GitHub Pages: expects files at viz/data/sku_links.json and viz/data/sku_links_auto.json
 *  - On local server: reads via /__stviz/sku-links (disk) and tries /data paths for auto
 */
export async function loadSkuMetaBestEffort() {
	// Manual links + ignores
	let manualLinks = null;
	let ignores = [];

	for (const p of ["./data/sku_links.json", "/data/sku_links.json"]) {
		try {
			const j = await fetchJson(p);
			manualLinks = Array.isArray(j?.links) ? j.links : [];
			ignores = Array.isArray(j?.ignores) ? j.ignores : [];
			break;
		} catch {}
	}

	if (manualLinks === null) {
		try {
			const meta = await apiReadSkuMetaFromLocalServer();
			manualLinks = Array.isArray(meta?.links) ? meta.links : [];
			ignores = Array.isArray(meta?.ignores) ? meta.ignores : [];
		} catch {
			manualLinks = [];
		}
	}

	// Auto-generated links (separate file; same shape)
	let autoLinks =
		(await tryFetchLinks("./data/sku_links_auto.json")) ||
		(await tryFetchLinks("/data/sku_links_auto.json")) ||
		[];

	if (!autoLinks.length) {
		try {
			const r = await fetch("/__stviz/sku-links-auto", { cache: "no-store" });
			if (r.ok) {
				const j = await r.json();
				autoLinks = Array.isArray(j?.links) ? j.links : [];
			}
		} catch {}
	}

	return {
		links: [...manualLinks, ...autoLinks],
		ignores,
	};
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

export async function githubFetchFileAtSha({ owner, repo, sha, path }) {
	const cleanPath = String(path || "").replace(/^\/+/, "");
	const raw = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/${cleanPath}`;
	const txt = await fetchTextImmutableCached(raw);
	if (txt.trimStart().startsWith("version https://git-lfs.github.com/spec/v1")) {
		throw new Error(`LFS pointer returned for ${cleanPath} at ${sha.slice(0, 7)} — not yet migrated`);
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
