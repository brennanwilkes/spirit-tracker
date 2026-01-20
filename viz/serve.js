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

function readMeta() {
  try {
    const raw = fs.readFileSync(LINKS_FILE, "utf8");
    const obj = JSON.parse(raw);

    const links = obj && Array.isArray(obj.links) ? obj.links : [];
    const ignores = obj && Array.isArray(obj.ignores) ? obj.ignores : [];

    return { generatedAt: obj?.generatedAt || new Date().toISOString(), links, ignores };
  } catch {}
  return { generatedAt: new Date().toISOString(), links: [], ignores: [] };
}

function writeMeta(obj) {
  obj.generatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(obj, null, 2) + "\n", "utf8");
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
          obj.links.push({ fromSku, toSku, createdAt: new Date().toISOString() });
          writeMeta(obj);

          return sendJson(res, 200, { ok: true, count: obj.links.length, file: "data/sku_links.json" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      });
      return;
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
          obj.ignores.push({ skuA, skuB, createdAt: new Date().toISOString() });
          writeMeta(obj);

          return sendJson(res, 200, { ok: true, count: obj.ignores.length, file: "data/sku_links.json" });
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
});
