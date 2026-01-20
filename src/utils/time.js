"use strict";

function ts(d = new Date()) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function isoTimestampFileSafe(d = new Date()) {
  // 2026-01-16T21-27-01Z
  return d.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

module.exports = { ts, isoTimestampFileSafe };
