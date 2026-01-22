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
  
    const d0 = new Date(s);
    const t0 = d0.getTime();
    if (!Number.isFinite(t0)) return "";
  
    // Round to nearest hour
    const d = new Date(Math.round(t0 / 3600000) * 3600000);
  
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Vancouver",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(d);
  
    let month = "";
    let day = "";
    let hour = "";
    let minute = "";
    let dayPeriod = "";
  
    for (const p of parts) {
      if (p.type === "month") month = p.value;
      else if (p.type === "day") day = p.value;
      else if (p.type === "hour") hour = p.value;
      else if (p.type === "minute") minute = p.value;
      else if (p.type === "dayPeriod") dayPeriod = p.value;
    }
  
    return `${month} ${day} ${hour}:${minute}${String(dayPeriod || "").toLowerCase()}`;
  }
    
  export function renderThumbHtml(imgUrl, cls = "thumb") {
    const img = normImg(imgUrl);
    if (!img) return `<div class="thumbPlaceholder"></div>`;
    return `<img class="${esc(cls)}" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.display='none'" />`;
  }
  