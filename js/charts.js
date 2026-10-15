// Minimal inline-SVG charts.
const fmtN = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

// series/trend: [{x: number, y: number}]
export function lineChart({ series, trend = [], goal = null, xLabel = (x) => x, w = 340, h = 180 }) {
  if (!series.length) return '<div class="chart-empty">No data yet</div>';
  const ys = series.map((p) => p.y).concat(trend.map((p) => p.y), goal != null ? [goal] : []);
  let min = Math.min(...ys), max = Math.max(...ys);
  const pad = Math.max(0.5, (max - min) * 0.12);
  min -= pad; max += pad;
  const xs = series.map((p) => p.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), span = x1 - x0 || 1;
  const L = 36, R = 10, T = 10, B = 24;
  const X = (x) => (x1 === x0 ? (L + w - R) / 2 : L + ((x - x0) / span) * (w - L - R));
  const Y = (y) => T + ((max - y) / (max - min)) * (h - T - B);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');

  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3, y = Y(v);
    g += `<line x1="${L}" x2="${w - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="axis">${fmtN(v)}</text>`;
  }
  if (goal != null) {
    g += `<line x1="${L}" x2="${w - R}" y1="${Y(goal)}" y2="${Y(goal)}" class="goal-line"/><text x="${w - R}" y="${Y(goal) - 5}" text-anchor="end" class="axis goal-txt">goal ${fmtN(goal)}</text>`;
  }
  if (trend.length > 1) g += `<path d="${path(trend)}" class="trend-line"/>`;
  if (series.length > 1) g += `<path d="${path(series)}" class="data-line${trend.length > 1 ? ' faint' : ''}"/>`;
  if (series.length <= 60) g += series.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="2.6" class="dot"/>`).join('');
  g += `<text x="${L}" y="${h - 6}" class="axis">${xLabel(x0)}</text>`;
  if (x1 !== x0) g += `<text x="${w - R}" y="${h - 6}" text-anchor="end" class="axis">${xLabel(x1)}</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">${g}</svg>`;
}

// bars: [{label, value, burn}]
export function barChart({ bars, target, w = 340, h = 170 }) {
  const max = Math.max(target || 0, ...bars.map((b) => b.value)) * 1.12 || 1;
  const L = 8, R = 8, T = 10, B = 22;
  const bw = (w - L - R) / bars.length;
  const Y = (v) => T + (1 - v / max) * (h - T - B);
  let g = '';
  bars.forEach((b, i) => {
    const x = L + i * bw + bw * 0.18, bwid = bw * 0.64;
    if (b.value > 0) {
      const cls = !target ? 'bar' : b.value > target * 1.1 ? 'bar over' : b.value < target * 0.75 ? 'bar under' : 'bar ok';
      g += `<rect x="${x}" y="${Y(b.value)}" width="${bwid}" height="${Y(0) - Y(b.value)}" rx="3" class="${cls}"/>`;
    }
    if (b.burn > 0) g += `<rect x="${x}" y="${Y(0) + 2}" width="${bwid}" height="3" rx="1.5" class="bar-burn"/>`;
    g += `<text x="${x + bwid / 2}" y="${h - 6}" text-anchor="middle" class="axis">${b.label}</text>`;
  });
  if (target) g += `<line x1="${L}" x2="${w - R}" y1="${Y(target)}" y2="${Y(target)}" class="goal-line"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">${g}</svg>`;
}

export function ring({ value, max, size = 132, stroke = 12, over = false }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, max ? value / max : 0));
  return `<svg viewBox="0 0 ${size} ${size}" class="ring" width="${size}" height="${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-track" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fill${over ? ' over' : ''}" stroke-width="${stroke}"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`;
}
