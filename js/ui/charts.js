// Thin Chart.js wrapper with the dashboard theme and a graceful fallback if the library is missing.

const GRID = '#1f1f28';
const TICK = '#868697';

export function lineChart(canvas, series, { yTitle = '', xTitle = 'iteration', refLine = null } = {}) {
  const Chart = window.Chart;
  if (!Chart) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Chart library failed to load — the values are still shown in the statistics bar.';
    canvas.replaceWith(p);
    return null;
  }
  const datasets = series.map((s) => ({
    label: s.label,
    data: [],
    borderColor: s.color,
    backgroundColor: s.fill || 'transparent',
    fill: !!s.fill,
    borderWidth: s.width || 2,
    borderDash: s.dash || [],
    pointRadius: 0,
    tension: 0,
    spanGaps: true,
  }));
  if (refLine) {
    datasets.push({ label: refLine.label, data: [], borderColor: refLine.color, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false });
  }
  const chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { color: GRID }, ticks: { color: TICK, maxTicksLimit: 8 }, title: { display: !!xTitle, text: xTitle, color: TICK } },
        y: { grid: { color: GRID }, ticks: { color: TICK, maxTicksLimit: 6 }, title: { display: !!yTitle, text: yTitle, color: TICK } },
      },
      plugins: {
        legend: { labels: { color: '#b9b9c6', boxWidth: 14, boxHeight: 2, font: { size: 11 } } },
        tooltip: { backgroundColor: '#17171d', borderColor: '#34343f', borderWidth: 1, titleColor: '#ededf2', bodyColor: '#b9b9c6' },
      },
    },
  });
  chart.$hasRef = !!refLine;
  return chart;
}

/**
 * Replace chart data from full histories, decimating to ≤ maxPoints so long runs stay smooth.
 * `arrays` is one array per series (same length); `ref` is a constant for the reference line.
 */
export function setSeries(chart, arrays, ref = null, maxPoints = 400) {
  if (!chart) return;
  const n = arrays[0]?.length || 0;
  const stride = Math.max(1, Math.ceil(n / maxPoints));
  const idx = [];
  for (let i = 0; i < n; i += stride) idx.push(i);
  if (n && idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  chart.data.labels = idx.map((i) => i + 1);
  arrays.forEach((arr, k) => {
    chart.data.datasets[k].data = idx.map((i) => (Number.isFinite(arr[i]) ? +arr[i].toFixed(4) : null));
  });
  if (chart.$hasRef) {
    const ds = chart.data.datasets[chart.data.datasets.length - 1];
    ds.data = ref == null || !Number.isFinite(ref) ? [] : idx.map(() => +ref.toFixed(4));
  }
  chart.update('none');
}
