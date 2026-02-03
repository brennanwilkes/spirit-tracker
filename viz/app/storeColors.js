function normalizeId(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  
  // Your pinned colors (exact / “roughly right”)
  const OVERRIDES = {
    strath: "#76B7FF",
    bsw: "#E9DF7A",
    kensingtonwinemarket: "#F2C200",
    vessel: "#FFFFFF",
    gullliquor: "#6B0F1A",
    kegncork: "#111111",
    legacyliquor: "#7B4A12",
    vintagespirits: "#E34A2C",
  
    craftcellars: "#E31B23",     // bright red
    maltsandgrains: "#A67C52",   // faded brown
  
    // aliases
    gull: "#6B0F1A",
    legacy: "#7B4A12",
    vintage: "#E34A2C",
    kwm: "#F2C200",
  };
    
  // High-contrast qualitative palette (distinct hues).
  // (Avoids whites/blacks/yellows that clash w/ your overrides by filtering below.)
  const PALETTE = [
    "#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD",
    "#8C564B", "#E377C2", "#7F7F7F", "#17BECF", "#BCBD22",
    "#AEC7E8", "#FFBB78", "#98DF8A", "#FF9896", "#C5B0D5",
    "#C49C94", "#F7B6D2", "#C7C7C7", "#9EDAE5", "#DBDB8D",
    // extras to reduce wrap risk
    "#393B79", "#637939", "#8C6D31", "#843C39", "#7B4173",
    "#3182BD", "#31A354", "#756BB1", "#636363", "#E6550D",
  ];
  
  function uniq(arr) {
    return [...new Set(arr)];
  }
  
  function buildUniverse(base, extra) {
    const a = Array.isArray(base) ? base : [];
    const b = Array.isArray(extra) ? extra : [];
    return uniq([...a, ...b].map(normalizeId).filter(Boolean));
  }
  
  // Default known ids (keeps mapping stable even if a page only sees a subset)
  const DEFAULT_UNIVERSE = buildUniverse(Object.keys(OVERRIDES), [
    "bcl",
    "bsw",
    "coop",
    "craftcellars",
    "gullliquor",
    "gull",
    "kegncork",
    "kwm",
    "kensingtonwinemarket",
    "legacy",
    "legacyliquor",
    "maltsandgrains",
    "sierrasprings",
    "strath",
    "tudor",
    "vessel",
    "vintage",
    "vintagespirits",
    "willowpark",
  ]);
  
  function isWhiteHex(c) {
    return String(c || "").trim().toUpperCase() === "#FFFFFF";
  }
  
  export function buildStoreColorMap(extraUniverse = []) {
    const universe = buildUniverse(DEFAULT_UNIVERSE, extraUniverse).sort();
  
    const used = new Set();
    const map = new Map();
  
    // pin overrides first
    for (const id of universe) {
      const c = OVERRIDES[id];
      if (c) {
        map.set(id, c);
        used.add(String(c).toUpperCase());
      }
    }
  
    // filter palette to avoid exact collisions with overrides (and keep white reserved for Vessel)
    const palette = PALETTE
      .map((c) => String(c).toUpperCase())
      .filter((c) => !used.has(c) && c !== "#FFFFFF" && c !== "#111111");
  
    let pi = 0;
    for (const id of universe) {
      if (map.has(id)) continue;
      if (pi >= palette.length) {
        // If you ever exceed palette size, just reuse (rare). Still deterministic.
        pi = 0;
      }
      const c = palette[pi++];
      map.set(id, c);
      used.add(c);
    }
  
    return map;
  }
  
  export function storeColor(storeKeyOrLabel, colorMap) {
    const id = normalizeId(storeKeyOrLabel);
    if (!id) return "#7F7F7F";
  
    const forced = OVERRIDES[id];
    if (forced) return forced;
  
    if (colorMap && typeof colorMap.get === "function") {
      const c = colorMap.get(id);
      if (c) return c;
    }
  
    // fallback: deterministic but not “no conflicts”
    return PALETTE[(id.length + id.charCodeAt(0)) % PALETTE.length];
  }
  
  export function datasetStrokeWidth(color) {
    return isWhiteHex(color) ? 2.5 : 1.5;
  }
  
  export function datasetPointRadius(color) {
    return isWhiteHex(color) ? 2.8 : 2.2;
  }
  
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  
  function hexToRgb(hex) {
    const m = String(hex).replace("#", "");
    if (m.length !== 6) return null;
    const n = parseInt(m, 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
    };
  }
  
  function rgbToHex({ r, g, b }) {
    const h = (x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  
  // lighten by mixing with white (amount 0–1)
  export function lighten(hex, amount = 0.25) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    return rgbToHex({
      r: rgb.r + (255 - rgb.r) * amount,
      g: rgb.g + (255 - rgb.g) * amount,
      b: rgb.b + (255 - rgb.b) * amount,
    });
  }
  
  
  