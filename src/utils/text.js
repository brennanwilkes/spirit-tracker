"use strict";

const { cleanText, decodeHtml } = require("./html");

function sanitizeName(s) {
  return cleanText(decodeHtml(String(s || "")))
    .replace(/['"’“”`´]/g, "")
    .replace(/[^\p{L}\p{N}\s\-&().,/]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { sanitizeName };
