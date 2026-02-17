// viz/app/cloud.js
//
// Cloudflare backend client for spirit-tracker-api.
// - Handles auth (login/signup), token storage, expiry checks
// - Provides helpers for GET/PUT (full replace) and POST (merge/patch) endpoints
//
// Backend base URL:
let CLOUD_BASE_URL = "https://spirit-tracker-api.brennan-a53.workers.dev";

const LS_TOKEN = "st:cloud:v1:token";
const LS_USERID = "st:cloud:v1:userId";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AuthError extends Error {
	constructor(message, info) {
		super(message);
		this.name = "AuthError";
		this.info = info || {};
	}
}

export class ApiError extends Error {
	constructor(message, info) {
		super(message);
		this.name = "ApiError";
		this.info = info || {};
	}
}

export function setCloudBaseUrl(url) {
	CLOUD_BASE_URL = String(url || "").replace(/\/+$/g, "");
	return CLOUD_BASE_URL;
}

export function getCloudBaseUrl() {
	return CLOUD_BASE_URL;
}

/* ---------------- Storage ---------------- */

export function logoutAndReload() {
	clearAuth();
	if (typeof window !== "undefined") window.location.reload();
}

function lsGet(k) {
	try {
		return localStorage.getItem(k);
	} catch {
		return null;
	}
}
function lsSet(k, v) {
	try {
		localStorage.setItem(k, v);
	} catch {}
}
function lsDel(k) {
	try {
		localStorage.removeItem(k);
	} catch {}
}

export function clearAuth() {
	lsDel(LS_TOKEN);
	lsDel(LS_USERID);
}

/* ---------------- JWT decode + validation (client-side best-effort) ---------------- */

function b64UrlToJson(b64url) {
	const b64 = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
	const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
	const txt = atob(b64 + pad);
	return JSON.parse(txt);
}

export function decodeJwtPayload(token) {
	const t = String(token || "");
	const parts = t.split(".");
	if (parts.length !== 3) return null;
	try {
		return b64UrlToJson(parts[1]);
	} catch {
		return null;
	}
}

export function getStoredToken() {
	return lsGet(LS_TOKEN) || null;
}

export function getStoredUserId() {
	return lsGet(LS_USERID) || null;
}

/**
 * Returns a detailed auth status so callers can decide how to react.
 * Does NOT throw.
 */
export function getAuthStatus({ leewaySeconds = 30 } = {}) {
	const token = getStoredToken();
	if (!token) return { ok: false, reason: "missing", token: null, userId: null, payload: null };

	const payload = decodeJwtPayload(token);
	if (!payload || typeof payload !== "object") {
		return { ok: false, reason: "invalid", token, userId: getStoredUserId(), payload: null };
	}

	const exp = Number(payload.exp);
	const sub = String(payload.sub || "");
	if (!Number.isFinite(exp) || !sub || !UUID_RE.test(sub)) {
		return { ok: false, reason: "invalid", token, userId: getStoredUserId(), payload };
	}

	const now = Math.floor(Date.now() / 1000);
	const expired = exp <= now + Math.max(0, Number(leewaySeconds) || 0);

	const userId = getStoredUserId() || sub;

	if (expired) return { ok: false, reason: "expired", token, userId, payload };
	return { ok: true, reason: "ok", token, userId, payload };
}

/**
 * Returns {token,userId,payload} or throws AuthError(reason: missing|expired|invalid)
 */
export function requireAuth({ leewaySeconds = 30 } = {}) {
	const s = getAuthStatus({ leewaySeconds });
	if (!s.ok) throw new AuthError(`Auth ${s.reason}`, { reason: s.reason, ...s });
	return { token: s.token, userId: s.userId, payload: s.payload };
}

/* ---------------- Input validation helpers ---------------- */

function validateScorePatchMap(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new TypeError("score must be an object");
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		const kk = assertSmallStringKey(k, "score key");
		if (v === null) {
			out[kk] = null;
			continue;
		}
		const n = Number(v);
		if (!Number.isFinite(n)) throw new TypeError("score values must be numbers or null");
		out[kk] = n;
	}
	return out;
}

function assertUuid(id, name = "userId") {
	const s = String(id || "").trim();
	if (!UUID_RE.test(s)) throw new TypeError(`Invalid ${name}`);
	return s;
}

function assertSmallStringKey(k, name = "key") {
	const s = String(k || "").trim();
	if (!s || s.length > 256) throw new TypeError(`Invalid ${name}`);
	return s;
}

function assertEmailPassword(email, password) {
	const e = String(email || "").trim().toLowerCase();
	const p = String(password || "");
	if (!e || !e.includes("@")) throw new TypeError("Invalid email");
	if (p.length < 8) throw new TypeError("Invalid password");
	return { email: e, password: p };
}

function assertEmailOnly(email) {
	const e = String(email || "").trim().toLowerCase();
	if (!e || !e.includes("@")) throw new TypeError("Invalid email");
	return { email: e };
}

function validateStringArray(arr, name) {
	if (!Array.isArray(arr)) throw new TypeError(`${name} must be an array`);
	for (const v of arr) {
		if (typeof v !== "string" || v.length > 256) throw new TypeError(`${name} must be an array of small strings`);
	}
	return arr;
}

function validateDetails(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new TypeError("details must be an object");
	if (typeof obj.public !== "boolean") throw new TypeError("details.public must be boolean");
	return obj;
}

function validateBoolMap(obj, name) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new TypeError(`${name} must be an object`);
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		out[assertSmallStringKey(k, `${name} key`)] = !!v;
		if (typeof v !== "boolean") throw new TypeError(`${name} values must be boolean`);
	}
	return out;
}

function validateScoreMap(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new TypeError("score must be an object");
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		const kk = assertSmallStringKey(k, "score key");
		const n = Number(v);
		if (!Number.isFinite(n)) throw new TypeError("score values must be numbers");
		out[k] = n;
	}
	return out;
}

/* ---------------- HTTP core ---------------- */

function joinUrl(base, path) {
	const b = String(base || "").replace(/\/+$/g, "");
	const p = String(path || "").replace(/^\/+/g, "");
	return `${b}/${p}`;
}

async function readResponseBody(res) {
	const ct = String(res.headers.get("content-type") || "").toLowerCase();
	const text = await res.text();
	if (ct.includes("application/json")) {
		try {
			return { kind: "json", value: JSON.parse(text || "null") };
		} catch {
			return { kind: "text", value: text };
		}
	}
	return { kind: "text", value: text };
}

async function requestJson(path, { method = "GET", body = undefined, auth = false, token = null } = {}) {
	const url = joinUrl(CLOUD_BASE_URL, path);

	let authToken = token;
	let authUserId = null;

	if (auth) {
		const a = requireAuth();
		authToken = a.token;
		authUserId = a.userId;
	}

	const headers = new Headers();
	headers.set("cache-control", "no-store");
	if (body !== undefined) headers.set("content-type", "application/json");
	if (authToken) headers.set("authorization", `Bearer ${authToken}`);

	const res = await fetch(url, {
		method,
		headers,
		cache: "no-store",
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	if (res.status === 204) return null;

	const parsed = await readResponseBody(res);
	const payload = parsed.kind === "json" ? parsed.value : null;
	const msg =
		(payload && typeof payload === "object" && typeof payload.error === "string" && payload.error) ||
		(parsed.kind === "text" && String(parsed.value || "").trim()) ||
		`HTTP ${res.status}`;

	if (!res.ok) {
		if (res.status === 401) {
			throw new AuthError(msg, { reason: "unauthorized", status: res.status, url, body: payload, userId: authUserId });
		}
		throw new ApiError(msg, { status: res.status, url, body: payload });
	}

	return payload;
}

/* ---------------- Auth endpoints ---------------- */

export async function signup(email, password) {
	const creds = assertEmailPassword(email, password);
	const j = await requestJson("/signup", { method: "POST", body: creds, auth: false });

	// New flow: email verification required, no token returned.
	if (j && typeof j === "object" && j.requiresVerify) {
		return { requiresVerify: true };
	}

	// Backward-compatible: if backend returns token, store it.
	const token = String(j?.token || "");
	const userId = String(j?.userId || "");
	if (!token) throw new ApiError("Signup did not return token", { body: j });
	if (!UUID_RE.test(userId)) throw new ApiError("Signup did not return valid userId", { body: j });

	// sanity: token sub should match
	const p = decodeJwtPayload(token);
	const sub = String(p?.sub || "");
	if (sub && UUID_RE.test(sub) && sub !== userId) throw new ApiError("Token subject mismatch", { userId, sub });

	lsSet(LS_TOKEN, token);
	lsSet(LS_USERID, userId);
	return { token, userId, requiresVerify: false };
}

export async function login(email, password) {
	const creds = assertEmailPassword(email, password);
	const j = await requestJson("/login", { method: "POST", body: creds, auth: false });

	const token = String(j?.token || "");
	const userId = String(j?.userId || "");
	if (!token) throw new ApiError("Login did not return token", { body: j });
	if (!UUID_RE.test(userId)) throw new ApiError("Login did not return valid userId", { body: j });

	const p = decodeJwtPayload(token);
	const sub = String(p?.sub || "");
	if (sub && UUID_RE.test(sub) && sub !== userId) throw new ApiError("Token subject mismatch", { userId, sub });

	lsSet(LS_TOKEN, token);
	lsSet(LS_USERID, userId);
	return { token, userId };
}

export async function requestPasswordReset(email) {
	const e = assertEmailOnly(email);
	return await requestJson("/password-reset/request", { method: "POST", body: e, auth: false });
}

export async function confirmPasswordReset(token, password) {
	const p = String(password || "");
	if (p.length < 8) throw new TypeError("Invalid password");
	const t = String(token || "").trim();
	if (!t) throw new TypeError("Invalid token");
	return await requestJson("/password-reset/confirm", { method: "POST", body: { token: t, password: p }, auth: false });
}

export async function ping() {
	return await requestJson("/", { method: "GET", auth: false });
}

/* ---------------- OAuth (Google/GitHub) ---------------- */

function oauthStartPath(provider) {
	const p = String(provider || "").toLowerCase();
	if (p !== "google" && p !== "github") throw new TypeError("Invalid oauth provider");
	return `/oauth/${p}/start`;
}

export function getOauthStartUrl(provider) {
	return joinUrl(CLOUD_BASE_URL, oauthStartPath(provider));
}

/**
 * Redirects the browser to the Worker OAuth start endpoint.
 * (Call this from a button click handler.)
 */
export function startOauth(provider) {
	if (typeof window === "undefined") throw new Error("startOauth requires a browser");
	window.location.assign(getOauthStartUrl(provider));
}

export function startOauthGoogle() {
	return startOauth("google");
}

export function startOauthGithub() {
	return startOauth("github");
}

function parseHashParams(hash) {
	const h = String(hash || "");
	if (!h || h === "#") return new URLSearchParams("");
	return new URLSearchParams(h.startsWith("#") ? h.slice(1) : h);
}

export function isOauthCallbackHash(hash = (typeof window !== "undefined" ? window.location.hash : "")) {
	const params = parseHashParams(hash);
	return !!params.get("token");
}

/**
 * Call this once on your SPA /oauth page load.
 * If the hash contains a token, it stores token+userId in localStorage and optionally clears the hash.
 *
 * Returns { token, userId, payload } if it consumed OAuth data, otherwise null.
 */
export function consumeOauthCallbackHash({
	hash = (typeof window !== "undefined" ? window.location.hash : ""),
	clearHash = true,
} = {}) {
	const params = parseHashParams(hash);
	const token = String(params.get("token") || "");
	const userIdParam = String(params.get("userId") || "");

	if (!token) return null;

	const payload = decodeJwtPayload(token);
	const sub = String(payload?.sub || "");
	const exp = Number(payload?.exp);

	if (!payload || !UUID_RE.test(sub) || !Number.isFinite(exp)) {
		throw new AuthError("OAuth returned invalid token", { reason: "invalid", token });
	}

	if (userIdParam && UUID_RE.test(userIdParam) && userIdParam !== sub) {
		throw new ApiError("Token subject mismatch", { userId: userIdParam, sub });
	}

	const userId = sub;

	lsSet(LS_TOKEN, token);
	lsSet(LS_USERID, userId);

	if (clearHash && typeof window !== "undefined") {
		// remove token from URL
		const clean = window.location.pathname + window.location.search;
		window.history.replaceState(null, document.title, clean);
	}

	return { token, userId, payload };
}

/* ---------------- Account resources ---------------- */

function acctPath(userId, resource) {
	const uid = assertUuid(userId);
	const r = String(resource || "").trim();
	if (!["details", "favourites", "sampled", "score"].includes(r)) throw new TypeError("Invalid resource");
	return `/u/${encodeURIComponent(uid)}/${encodeURIComponent(r)}`;
}

/* ---- GET ---- */

export async function getDetails(userId, { token = null } = {}) {
	// details may be public; allow optional token for private reads
	return await requestJson(acctPath(userId, "details"), { method: "GET", auth: false, token });
}

export async function getFavourites(userId) {
	return await requestJson(acctPath(userId, "favourites"), { method: "GET", auth: true });
}

export async function getSampled(userId) {
	return await requestJson(acctPath(userId, "sampled"), { method: "GET", auth: false, token: getStoredToken() });
}

export async function getScore(userId) {
	return await requestJson(acctPath(userId, "score"), { method: "GET", auth: false, token: getStoredToken() });
}

/* Convenience: current user (from stored auth) */

export async function getMyDetails() {
	const { userId } = requireAuth();
	return await getDetails(userId, { token: getStoredToken() });
}
export async function getMyFavourites() {
	const { userId } = requireAuth();
	return await getFavourites(userId);
}
export async function getMySampled() {
	const { userId } = requireAuth();
	return await getSampled(userId);
}
export async function getMyScore() {
	const { userId } = requireAuth();
	return await getScore(userId);
}

/* ---- PUT (full replace) ---- */

export async function putDetails(userId, detailsObj) {
	const uid = assertUuid(userId);
	const body = validateDetails(detailsObj);
	return await requestJson(acctPath(uid, "details"), { method: "PUT", body, auth: true });
}

export async function putFavourites(userId, favouritesArray) {
	const uid = assertUuid(userId);
	const body = validateStringArray(favouritesArray, "favourites");
	return await requestJson(acctPath(uid, "favourites"), { method: "PUT", body, auth: true });
}

export async function putSampled(userId, sampledArray) {
	const uid = assertUuid(userId);
	const body = validateStringArray(sampledArray, "sampled");
	return await requestJson(acctPath(uid, "sampled"), { method: "PUT", body, auth: true });
}

export async function putScore(userId, scoreMap) {
	const uid = assertUuid(userId);
	const body = validateScoreMap(scoreMap);
	return await requestJson(acctPath(uid, "score"), { method: "PUT", body, auth: true });
}

/* ---- POST (merge/patch) ---- */

export async function patchFavourites(userId, boolMap) {
	const uid = assertUuid(userId);
	const body = validateBoolMap(boolMap, "favourites");
	return await requestJson(acctPath(uid, "favourites"), { method: "POST", body, auth: true });
}

export async function patchSampled(userId, boolMap) {
	const uid = assertUuid(userId);
	const body = validateBoolMap(boolMap, "sampled");
	return await requestJson(acctPath(uid, "sampled"), { method: "POST", body, auth: true });
}

export async function patchScore(userId, scorePatchMap) {
	const uid = assertUuid(userId);
	const body = validateScorePatchMap(scorePatchMap);
	return await requestJson(acctPath(uid, "score"), { method: "POST", body, auth: true });
}

/* Single-item helpers */

export async function setFavourite(userId, key, isFav) {
	const k = assertSmallStringKey(key, "favourite key");
	if (typeof isFav !== "boolean") throw new TypeError("isFav must be boolean");
	return await patchFavourites(userId, { [k]: isFav });
}

export async function setSampled(userId, key, isSampled) {
	const k = assertSmallStringKey(key, "sampled key");
	if (typeof isSampled !== "boolean") throw new TypeError("isSampled must be boolean");
	return await patchSampled(userId, { [k]: isSampled });
}

export async function setScore(userId, key, score) {
	const k = assertSmallStringKey(key, "score key");
	if (score === null || score === undefined) {
		return await patchScore(userId, { [k]: null });
	}
	const n = Number(score);
	if (!Number.isFinite(n)) throw new TypeError("score must be a finite number (or null to delete)");
	return await patchScore(userId, { [k]: n });
}

export async function deleteScore(userId, key) {
	return await setScore(userId, key, null);
}

/* Convenience: current user (from stored auth) */

export async function setMyFavourite(key, isFav) {
	const { userId } = requireAuth();
	return await setFavourite(userId, key, isFav);
}
export async function setMySampled(key, isSampled) {
	const { userId } = requireAuth();
	return await setSampled(userId, key, isSampled);
}
export async function setMyScore(key, score) {
	const { userId } = requireAuth();
	return await setScore(userId, key, score);
}

export async function patchMyFavourites(boolMap) {
	const { userId } = requireAuth();
	return await patchFavourites(userId, boolMap);
}
export async function patchMySampled(boolMap) {
	const { userId } = requireAuth();
	return await patchSampled(userId, boolMap);
}
export async function patchMyScore(scoreMap) {
	const { userId } = requireAuth();
	return await patchScore(userId, scoreMap);
}
