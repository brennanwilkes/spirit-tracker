// src/core/http.js
"use strict";

const { setTimeout: sleep } = require("timers/promises");
const { setTimeout: setTimeoutCb, clearTimeout } = require("timers");

/* ---------------- Errors ---------------- */

class RetryableError extends Error {
	constructor(msg) {
		super(msg);
		this.name = "RetryableError";
	}
}

function isRetryable(e) {
	if (!e) return false;
	if (e.name === "AbortError") return true;
	if (e instanceof RetryableError) return true;
	const msg = String(e.message || e);
	return /ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed/i.test(msg);
}

/* ---------------- Backoff ---------------- */

function backoffMs(attempt) {
	const base = Math.min(12000, 500 * Math.pow(2, attempt));
	const jitter = Math.floor(Math.random() * 400);
	return base + jitter;
}

function retryAfterMs(res) {
	const ra = res?.headers?.get ? res.headers.get("retry-after") : null;
	if (!ra) return 0;

	const secs = Number(String(ra).trim());
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000);

	const dt = Date.parse(String(ra));
	if (Number.isFinite(dt)) return Math.max(0, dt - Date.now());

	return 0;
}

/* ---------------- Utils ---------------- */

async function safeText(res) {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function hostFromUrl(u) {
	try {
		return new URL(u).host || "";
	} catch {
		return "";
	}
}

/* ---------------- Cookies (simple jar) ---------------- */

// host -> Map(cookieName -> "name=value")
function createCookieJar() {
	const jar = new Map();

	function parseSetCookieLine(line) {
		const s = String(line || "").trim();
		if (!s) return null;
		const first = s.split(";")[0] || "";
		const eq = first.indexOf("=");
		if (eq <= 0) return null;
		const name = first.slice(0, eq).trim();
		const value = first.slice(eq + 1).trim();
		if (!name) return null;
		return { name, pair: `${name}=${value}` };
	}

	function getSetCookieArray(headers) {
		if (headers && typeof headers.getSetCookie === "function") {
			try {
				const arr = headers.getSetCookie();
				return Array.isArray(arr) ? arr : [];
			} catch {}
		}

		const one = headers?.get ? headers.get("set-cookie") : null;
		if (!one) return [];

		return String(one)
			.split(/,(?=[^;,]*=)/g)
			.map((x) => x.trim())
			.filter(Boolean);
	}

	function storeFromResponse(url, res) {
		const host = hostFromUrl(res?.url || url);
		if (!host) return;

		const lines = getSetCookieArray(res?.headers);
		if (!lines.length) return;

		let m = jar.get(host);
		if (!m) {
			m = new Map();
			jar.set(host, m);
		}

		for (const line of lines) {
			const c = parseSetCookieLine(line);
			if (c) m.set(c.name, c.pair);
		}
	}

	function cookieHeaderFor(url) {
		const host = hostFromUrl(url);
		if (!host) return "";
		const m = jar.get(host);
		if (!m || m.size === 0) return "";
		return [...m.values()].join("; ");
	}

	return { storeFromResponse, cookieHeaderFor };
}

/* ---------------- HTTP client ---------------- */

function createHttpClient({ maxRetries, timeoutMs, defaultUa, logger }) {
	let inflight = 0;
	let reqSeq = 0;

	const cookieJar = createCookieJar();

	// host -> epoch ms when next request is allowed
	const hostNextOkAt = new Map();

	// Conservative pacing defaults (slow > blocked)
	const minHostIntervalMs = 2500;

	// Per-host minimum-interval overrides. Some hosts (e.g. Wine and Beyond)
	// require many per-product fetches and tolerate a much tighter cadence.
	// Set via setHostInterval(host, ms); falls back to the conservative default.
	const hostMinInterval = new Map();
	function intervalFor(host) {
		const v = hostMinInterval.get(host);
		return typeof v === "number" && v > 0 ? v : minHostIntervalMs;
	}
	function setHostInterval(host, ms) {
		const h = String(host || "").trim();
		if (h && typeof ms === "number" && ms > 0) hostMinInterval.set(h, ms);
	}

	// Per-host inflight clamp (prevents bursts when global concurrency is high)
	const hostInflight = new Map();
	const maxHostInflight = 1;

	function inflightStr() {
		return `inflight=${inflight}`;
	}

	async function acquireHost(url) {
		const host = hostFromUrl(url);
		if (!host) return () => {};

		while (true) {
			const cur = hostInflight.get(host) || 0;
			if (cur < maxHostInflight) {
				hostInflight.set(host, cur + 1);
				return () => {
					const n = (hostInflight.get(host) || 1) - 1;
					if (n <= 0) hostInflight.delete(host);
					else hostInflight.set(host, n);
				};
			}
			await sleep(50);
		}
	}

	// ✅ Pre-pacing reservation: reserve the next slot BEFORE the fetch is sent
	async function throttleHost(url) {
		const host = hostFromUrl(url);
		if (!host) return;

		while (true) {
			const now = Date.now();
			const next = hostNextOkAt.get(host) || 0;
			const wait = next - now;

			if (wait > 0) {
				logger?.dbg?.(`THROTTLE host=${host} wait=${wait}ms`);
				await sleep(wait);
				continue;
			}

			// Reserve immediately to prevent concurrent pass-through
			hostNextOkAt.set(host, now + intervalFor(host));
			return;
		}
	}

	function noteHost(url, extraDelayMs = 0) {
		const host = hostFromUrl(url);
		if (!host) return;

		const now = Date.now();
		const current = hostNextOkAt.get(host) || 0;

		// Extend (never shorten) any existing cooldown
		const target = now + intervalFor(host) + Math.max(0, extraDelayMs);
		hostNextOkAt.set(host, Math.max(current, target));

		logger?.dbg?.(`HOST-PACE host=${host} nextOkIn=${Math.max(0, (hostNextOkAt.get(host) || 0) - Date.now())}ms`);
	}

	async function fetchWithRetry(
		url,
		tag,
		ua,
		{ mode = "text", method = "GET", headers = {}, body = null, cookies = true } = {},
	) {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const reqId = ++reqSeq;
			const start = Date.now();

			inflight++;
			logger?.dbg?.(
				`REQ#${reqId} START ${tag} attempt=${attempt + 1}/${maxRetries + 1} ${url} (${inflightStr()})`,
			);

			const releaseHost = await acquireHost(url);

			try {
				await throttleHost(url);

				const ctrl = new AbortController();
				const t = setTimeoutCb(() => ctrl.abort(), timeoutMs);

				const cookieHdr =
					cookies && !("Cookie" in headers) && !("cookie" in headers) ? cookieJar.cookieHeaderFor(url) : "";

				const res = await fetch(url, {
					method,
					redirect: "follow",
					headers: {
						"user-agent": ua || defaultUa,
						"accept-language": "en-US,en;q=0.9",
						...(mode === "text"
							? { accept: "text/html,application/xhtml+xml", "cache-control": "no-cache" }
							: { accept: "application/json, text/plain, */*" }),
						...(cookieHdr ? { cookie: cookieHdr } : {}),
						...headers,
					},
					body,
					signal: ctrl.signal,
				}).finally(() => clearTimeout(t));

				const status = res.status;
				const finalUrl = res.url || url;
				const elapsed = Date.now() - start;

				// Raw Set-Cookie lines for callers that manage their own cookie
				// state (e.g. Wine and Beyond's per-location cart token) without
				// polluting the shared jar.
				const setCookie =
					res.headers && typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];

				// Always pace the host a bit after any response
				noteHost(finalUrl);
				if (cookies) cookieJar.storeFromResponse(url, res);

				logger?.dbg?.(`REQ#${reqId} HTTP ${status} ${tag} ms=${elapsed} finalUrl=${finalUrl}`);

				if (status === 429) {
					let raMs = retryAfterMs(res);

					// ✅ If no Retry-After header, enforce a real cooldown (Shopify often omits it)
					if (raMs <= 0) raMs = 15000 + Math.floor(Math.random() * 5000);

					noteHost(finalUrl, raMs);
					logger?.dbg?.(`REQ#${reqId} 429 retryAfterMs=${raMs} host=${hostFromUrl(finalUrl)}`);
					throw new RetryableError("HTTP 429");
				}

				if (status === 408 || (status >= 500 && status <= 599)) {
					throw new RetryableError(`HTTP ${status}`);
				}

				if (status >= 400) {
					const bodyTxt = await safeText(res);
					throw new Error(`HTTP ${status} bodyHead=${String(bodyTxt).slice(0, 160).replace(/\s+/g, " ")}`);
				}

				if (mode === "json") {
					const txt = await res.text();
					let json;
					try {
						json = JSON.parse(txt);
					} catch (e) {
						throw new RetryableError(`Bad JSON: ${e?.message || e}`);
					}
					return { json, ms: elapsed, bytes: txt.length, status, finalUrl, setCookie };
				}

				const text = await res.text();
				if (!text || text.length < 200) {
					throw new RetryableError(`Short HTML bytes=${text.length}`);
				}

				return { text, ms: elapsed, bytes: text.length, status, finalUrl, setCookie };
			} catch (e) {
				const retryable = isRetryable(e);
				const host = hostFromUrl(url);
				const nextOk = hostNextOkAt.get(host) || 0;

				logger?.dbg?.(
					`REQ#${reqId} FAIL ${tag} retryable=${retryable} err=${e?.message || e} host=${host} nextOkIn=${Math.max(
						0,
						nextOk - Date.now(),
					)}ms`,
				);

				if (!retryable || attempt === maxRetries) throw e;

				let delay = backoffMs(attempt);
				if (nextOk > Date.now()) delay = Math.max(delay, nextOk - Date.now());

				logger?.warn?.(`Request failed, retrying in ${delay}ms (${attempt + 1}/${maxRetries})`);
				await sleep(delay);
			} finally {
				releaseHost();
				inflight--;
				logger?.dbg?.(`REQ#${reqId} END ${tag} (${inflightStr()})`);
			}
		}

		throw new Error("unreachable");
	}

	function fetchTextWithRetry(url, tag, ua, opts) {
		return fetchWithRetry(url, tag, ua, { mode: "text", ...(opts || {}) });
	}

	function fetchJsonWithRetry(url, tag, ua, opts) {
		return fetchWithRetry(url, tag, ua, { mode: "json", ...(opts || {}) });
	}

	return { fetchTextWithRetry, fetchJsonWithRetry, inflightStr, setHostInterval };
}

module.exports = { createHttpClient, RetryableError };
