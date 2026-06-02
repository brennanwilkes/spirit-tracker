#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname); // viz/
const projectRoot = path.resolve(__dirname, ".."); // repo root

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
};

function safePath(urlPath) {
	const p = decodeURIComponent(urlPath.split("?")[0]).replace(/\\/g, "/");
	const joined = path.join(root, p);
	const norm = path.normalize(joined);
	if (!norm.startsWith(root)) return null;
	return norm;
}

// Project-level file (shared by viz + report tooling)
const LINKS_FILE = path.join(projectRoot, "data", "sku_links.json");
const LINKS_AUTO_FILE = path.join(projectRoot, "data", "sku_links_auto.json");
const HIDDEN_FILE = path.join(projectRoot, "data", "sku_hidden.json");

function readAutoMeta() {
	try {
		const raw = fs.readFileSync(LINKS_AUTO_FILE, "utf8");
		const obj = JSON.parse(raw);
		const links = obj && Array.isArray(obj.links) ? obj.links : [];
		return { generatedAt: obj?.generatedAt || "", source: obj?.source || "auto", links };
	} catch {}
	return { generatedAt: "", source: "auto", links: [] };
}

function readMeta() {
	try {
		const raw = fs.readFileSync(LINKS_FILE, "utf8");
		const obj = JSON.parse(raw);

		const links = obj && Array.isArray(obj.links) ? obj.links : [];
		const ignores = obj && Array.isArray(obj.ignores) ? obj.ignores : [];

		return { links, ignores };
	} catch {}
	return { links: [], ignores: [] };
}

// Union-find dedup: keep only links that actually merge two distinct components.
// Also dedupes ignores by unordered pair.
function dedupeLinks(links, ignores) {
	const parent = new Map();
	function find(x) {
		if (!parent.has(x)) parent.set(x, x);
		if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
		return parent.get(x);
	}
	const kept = [];
	for (const link of links) {
		const ra = find(link.fromSku), rb = find(link.toSku);
		if (ra !== rb) {
			parent.set(ra, rb);
			kept.push(link.noTrain ? { fromSku: link.fromSku, toSku: link.toSku, noTrain: true } : { fromSku: link.fromSku, toSku: link.toSku });
		}
	}

	const seenIgnores = new Set();
	const keptIgnores = [];
	for (const ig of ignores) {
		const key = [ig.skuA, ig.skuB].sort().join("\0");
		if (!seenIgnores.has(key)) {
			seenIgnores.add(key);
			keptIgnores.push(ig.noTrain ? { skuA: ig.skuA, skuB: ig.skuB, noTrain: true } : { skuA: ig.skuA, skuB: ig.skuB });
		}
	}

	return { links: kept, ignores: keptIgnores };
}

function writeMeta(obj) {
	const deduped = dedupeLinks(obj.links, obj.ignores);
	fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
	fs.writeFileSync(LINKS_FILE, JSON.stringify({ links: deduped.links, ignores: deduped.ignores }) + "\n", "utf8");
	return deduped;
}

function readHidden() {
	try {
		const raw = fs.readFileSync(HIDDEN_FILE, "utf8");
		const obj = JSON.parse(raw);
		const hidden = obj && Array.isArray(obj.hidden) ? obj.hidden : [];
		return { generatedAt: obj?.generatedAt || new Date().toISOString(), hidden };
	} catch {}
	return { generatedAt: new Date().toISOString(), hidden: [] };
}

function writeHidden(obj) {
	obj.generatedAt = new Date().toISOString();
	fs.mkdirSync(path.dirname(HIDDEN_FILE), { recursive: true });
	fs.writeFileSync(HIDDEN_FILE, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function send(res, code, body, headers) {
	res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", ...(headers || {}) });
	res.end(body);
}

function sendJson(res, code, obj) {
	res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
	const u = req.url || "/";
	const url = new URL(u, "http://127.0.0.1");

	// Local API: read/write sku links + ignore pairs on disk (only exists when using this local server)

	if (url.pathname === "/__stviz/sku-links") {
		if (req.method === "GET") {
			const obj = readMeta();
			return sendJson(res, 200, { ok: true, count: obj.links.length, links: obj.links, ignores: obj.ignores });
		}

		if (req.method === "POST") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				try {
					const inp = JSON.parse(body || "{}");
					const fromSku = String(inp.fromSku || "").trim();
					const toSku = String(inp.toSku || "").trim();
					if (!fromSku || !toSku) return sendJson(res, 400, { ok: false, error: "fromSku/toSku required" });

					const obj = readMeta();
					obj.links.push({ fromSku, toSku, ...(inp.noTrain ? { noTrain: true } : {}) });
					const saved = writeMeta(obj);

					return sendJson(res, 200, { ok: true, count: saved.links.length, file: "data/sku_links.json" });
				} catch (e) {
					return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) });
				}
			});
			return;
		}

		return send(res, 405, "Method Not Allowed");
	}

	if (url.pathname === "/__stviz/sku-links-auto") {
		if (req.method === "GET") {
			const obj = readAutoMeta();
			return sendJson(res, 200, { ok: true, count: obj.links.length, source: obj.source, links: obj.links });
		}
		return send(res, 405, "Method Not Allowed");
	}

	if (url.pathname === "/__stviz/sku-ignores") {
		if (req.method === "GET") {
			const obj = readMeta();
			return sendJson(res, 200, { ok: true, count: obj.ignores.length, ignores: obj.ignores });
		}

		if (req.method === "POST") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				try {
					const inp = JSON.parse(body || "{}");
					const skuA = String(inp.skuA || "").trim();
					const skuB = String(inp.skuB || "").trim();
					if (!skuA || !skuB) return sendJson(res, 400, { ok: false, error: "skuA/skuB required" });
					if (skuA === skuB) return sendJson(res, 400, { ok: false, error: "skuA and skuB must differ" });

					const obj = readMeta();
					obj.ignores.push({ skuA, skuB, ...(inp.noTrain ? { noTrain: true } : {}) });
					const saved = writeMeta(obj);

					return sendJson(res, 200, { ok: true, count: saved.ignores.length, file: "data/sku_links.json" });
				} catch (e) {
					return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) });
				}
			});
			return;
		}

		return send(res, 405, "Method Not Allowed");
	}

	if (url.pathname === "/__stviz/sku-hidden") {
		if (req.method === "GET") {
			const obj = readHidden();
			return sendJson(res, 200, { ok: true, count: obj.hidden.length, hidden: obj.hidden });
		}

		if (req.method === "POST") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				try {
					const inp = JSON.parse(body || "{}");
					const storeId = String(inp.storeId || "").trim();
					const sku = String(inp.sku || "").trim();
					const reason = String(inp.reason || "").trim();
					if (!storeId || !sku) return sendJson(res, 400, { ok: false, error: "storeId/sku required" });

					const obj = readHidden();
					const exists = obj.hidden.some((h) => h && h.storeId === storeId && h.sku === sku);
					if (!exists) {
						obj.hidden.push({ storeId, sku, ...(reason ? { reason } : {}), createdAt: new Date().toISOString() });
						writeHidden(obj);
					}

					return sendJson(res, 200, { ok: true, count: obj.hidden.length, file: "data/sku_hidden.json" });
				} catch (e) {
					return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) });
				}
			});
			return;
		}

		if (req.method === "DELETE") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				try {
					const inp = JSON.parse(body || "{}");
					const storeId = String(inp.storeId || "").trim();
					const sku = String(inp.sku || "").trim();
					if (!storeId || !sku) return sendJson(res, 400, { ok: false, error: "storeId/sku required" });

					const obj = readHidden();
					const before = obj.hidden.length;
					obj.hidden = obj.hidden.filter((h) => !(h && h.storeId === storeId && h.sku === sku));
					if (obj.hidden.length !== before) writeHidden(obj);

					return sendJson(res, 200, { ok: true, count: obj.hidden.length, removed: before - obj.hidden.length });
				} catch (e) {
					return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) });
				}
			});
			return;
		}

		return send(res, 405, "Method Not Allowed");
	}

	// Static
	let file = safePath(u === "/" ? "/index.html" : u);
	if (!file) {
		res.writeHead(400);
		res.end("Bad path");
		return;
	}

	if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
		file = path.join(file, "index.html");
	}

	fs.readFile(file, (err, buf) => {
		if (err) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		const ext = path.extname(file);
		res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
		res.end(buf);
	});
});

const port = Number(process.env.PORT || 8080);
server.listen(port, "127.0.0.1", () => {
	process.stdout.write(`Serving ${root} on http://127.0.0.1:${port}\n`);
	process.stdout.write(`SKU links file: ${LINKS_FILE}\n`);
	process.stdout.write(`SKU hidden file: ${HIDDEN_FILE}\n`);
});
