"use strict";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function color(s, code, enabled) {
  if (!enabled) return String(s);
  return String(code || "") + String(s) + C.reset;
}

module.exports = { C, color };
