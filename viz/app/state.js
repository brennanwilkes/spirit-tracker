import { fetchJson } from "./api.js";

let INDEX = null;
let RECENT = null;

export async function loadIndex() {
  if (INDEX) return INDEX;
  INDEX = await fetchJson("./data/index.json");
  return INDEX;
}

export async function loadRecent() {
  if (RECENT) return RECENT;
  try {
    RECENT = await fetchJson("./data/recent.json");
  } catch {
    RECENT = { count: 0, items: [] };
  }
  return RECENT;
}

// persist search box value across navigation
const Q_LS_KEY = "stviz:v1:search:q";

export function loadSavedQuery() {
  try {
    return localStorage.getItem(Q_LS_KEY) || "";
  } catch {
    return "";
  }
}

export function saveQuery(v) {
  try {
    localStorage.setItem(Q_LS_KEY, String(v ?? ""));
  } catch {}
}
