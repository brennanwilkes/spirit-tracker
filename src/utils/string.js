"use strict";

function padRight(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padRightV(s, n) {
  s = String(s);
  const w = stripAnsi(s).length;
  return w >= n ? s : s + " ".repeat(n - w);
}

function padLeftV(s, n) {
  s = String(s);
  const w = stripAnsi(s).length;
  return w >= n ? s : " ".repeat(n - w) + s;
}

module.exports = { padRight, padLeft, stripAnsi, padRightV, padLeftV };
