export function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  
  export function normImg(s) {
    const v = String(s || "").trim();
    if (!v) return "";
    if (/^data:/i.test(v)) return "";
    return v;
  }
  
  export function dateOnly(iso) {
    const m = String(iso ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }
  
  export function prettyTs(iso) {
    const s = String(iso || "");
    if (!s) return "";
    return s.replace("T", " ");
  }
  
  export function renderThumbHtml(imgUrl, cls = "thumb") {
    const img = normImg(imgUrl);
    if (!img) return `<div class="thumbPlaceholder"></div>`;
    return `<img class="${esc(cls)}" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.display='none'" />`;
  }
  