function normalizeStoreId(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }
  
  const STORE_COLOR_OVERRIDES = {
    strath: "#76B7FF",
    bsw: "#E9DF7A",
    kensingtonwinemarket: "#F2C200",
    vessel: "#FFFFFF",
    gullliquor: "#6B0F1A",
    kegncork: "#111111",
    legacyliquor: "#7B4A12",
    vintagespirits: "#E34A2C",
  
    // aliases
    gull: "#6B0F1A",
    legacy: "#7B4A12",
    vintage: "#E34A2C",
  };
  
  function hashToHue(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 360;
  }
  
  export function storeColor(storeKeyOrLabel) {
    const id = normalizeStoreId(storeKeyOrLabel);
    const forced = STORE_COLOR_OVERRIDES[id];
    if (forced) return forced;
  
    const hue = hashToHue(id || "unknown");
    return `hsl(${hue} 65% 55%)`;
  }
  
  export function isWhite(color) {
    return String(color).toUpperCase() === "#FFFFFF";
  }
  