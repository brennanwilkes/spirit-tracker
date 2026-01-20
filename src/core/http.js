"use strict";

const { setTimeout: sleep } = require("timers/promises");

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

function backoffMs(attempt) {
  const base = Math.min(12000, 500 * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 400);
  return base + jitter;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/* ---------------- Cookies (simple jar) ---------------- */

// host -> Map(cookieName -> "name=value")
function createCookieJar() {
  const jar = new Map();

  function getHost(u) {
    try {
      return new URL(u).hostname || "";
    } catch {
      return "";
    }
  }

  function parseSetCookieLine(line) {
    // "name=value; Path=/; Secure; HttpOnly; ..."
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
    // Node/undici may support headers.getSetCookie()
    if (headers && typeof headers.getSetCookie === "function") {
      try {
        const arr = headers.getSetCookie();
        return Array.isArray(arr) ? arr : [];
      } catch {
        // fall through
      }
    }

    // Fallback: single combined header (may lose multiples, but better than nothing)
    const one = headers?.get ? headers.get("set-cookie") : null;
    if (!one) return [];

    // Best-effort split. This is imperfect with Expires=... commas, but OK for most WP cookies.
    // If this causes issues later, we can replace with a more robust splitter.
    return String(one)
      .split(/,(?=[^;,]*=)/g)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function storeFromResponse(url, res) {
    const host = getHost(res?.url || url);
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
      if (!c) continue;
      m.set(c.name, c.pair);
    }
  }

  function cookieHeaderFor(url) {
    const host = getHost(url);
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

  function inflightStr() {
    return `inflight=${inflight}`;
  }

  async function fetchWithRetry(
    url,
    tag,
    ua,
    { mode = "text", method = "GET", headers = {}, body = null, cookies = true } = {}
  ) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const reqId = ++reqSeq;
      const start = Date.now();

      inflight++;
      logger?.dbg?.(
        `REQ#${reqId} START ${tag} attempt=${attempt + 1}/${maxRetries + 1} ${url} (${inflightStr()})`
      );

      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);

        const cookieHdr =
          cookies && !Object.prototype.hasOwnProperty.call(headers, "Cookie") && !Object.prototype.hasOwnProperty.call(headers, "cookie")
            ? cookieJar.cookieHeaderFor(url)
            : "";

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

        // capture cookies for subsequent requests to same host
        if (cookies) cookieJar.storeFromResponse(url, res);

        logger?.dbg?.(`REQ#${reqId} HTTP ${status} ${tag} finalUrl=${finalUrl}`);

        if (status === 429 || status === 408 || (status >= 500 && status <= 599)) {
          throw new RetryableError(`HTTP ${status}`);
        }
        if (status >= 400) {
          const bodyTxt = await safeText(res);
          throw new Error(
            `HTTP ${status} bodyHead=${String(bodyTxt).slice(0, 160).replace(/\s+/g, " ")}`
          );
        }

        if (mode === "json") {
          const txt = await res.text();
          const ms = Date.now() - start;
          let json;
          try {
            json = JSON.parse(txt);
          } catch (e) {
            throw new RetryableError(`Bad JSON: ${e?.message || e}`);
          }
          return { json, ms, bytes: txt.length, status, finalUrl };
        }

        const text = await res.text();
        if (!text || text.length < 200) throw new RetryableError(`Short HTML bytes=${text.length}`);

        const ms = Date.now() - start;
        return { text, ms, bytes: text.length, status, finalUrl };
      } catch (e) {
        const retryable = isRetryable(e);
        logger?.dbg?.(
          `REQ#${reqId} ERROR ${tag} retryable=${retryable} err=${e?.message || e} (${inflightStr()})`
        );

        if (!retryable || attempt === maxRetries) throw e;

        const delay = backoffMs(attempt);
        logger?.warn?.(`Request failed, retrying in ${delay}ms (${attempt + 1}/${maxRetries})`);
        await sleep(delay);
      } finally {
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

  return { fetchTextWithRetry, fetchJsonWithRetry, inflightStr };
}

module.exports = { createHttpClient, RetryableError };
