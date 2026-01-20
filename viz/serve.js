#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname);

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

const server = http.createServer((req, res) => {
  const u = req.url || "/";
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
});
