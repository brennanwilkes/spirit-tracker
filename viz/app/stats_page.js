import { esc } from "./dom.js";

let _chart = null;

export function destroyStatsChart() {
  try {
    if (_chart) _chart.destroy();
  } catch {}
  _chart = null;
}

function ensureChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);

  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    // UMD build -> window.Chart
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
    s.async = true;
    s.onload = () => resolve(window.Chart);
    s.onerror = () => reject(new Error("Failed to load Chart.js"));
    document.head.appendChild(s);
  });
}

export async function renderStats($app) {
  destroyStatsChart();

  $app.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="headerRow1">
          <div class="headerLeft">
            <h1 class="h1">Statistics</h1>
            <div class="small">Coming soon</div>
          </div>
          <div class="headerRight headerButtons">
            <a class="btn btnWide" href="#/" style="text-decoration:none;">← Back</a>
          </div>
        </div>
      </div>

      <div class="card">
        <div style="height:340px;">
          <canvas id="statsChart" aria-label="Statistics chart" role="img"></canvas>
        </div>
      </div>
    </div>
  `;

  try {
    const Chart = await ensureChartJs();
    const canvas = document.getElementById("statsChart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    _chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [{ label: "Price", data: [] }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: true } },
        scales: {
          x: { title: { display: true, text: "Time" } },
          y: { title: { display: true, text: "Value" } },
        },
      },
    });
  } catch (e) {
    const msg = esc(e?.message || String(e));
    $app.querySelector(".card").innerHTML = `<div class="small">Chart unavailable: ${msg}</div>`;
  }
}
