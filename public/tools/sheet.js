/* 4 x 4 evaluation sheet: four drawings (rows) at four ink loads (columns). Each cell is drawn alone on a
   square canvas; positions are fractions of the cell, times are ms at speed 1. Kanji rows are built from the
   fitted character sweeps in sweeps.js, with one brush load for the whole character. */
(() => {
const enso = () => {
  const k = [], a0 = 2.75, turn = 2 * Math.PI * 0.94, n = 30, R = 0.33;
  let t = 0;
  k.push([0, 0.5 + R * 1.07 * Math.cos(a0 - 0.14), 0.5 + R * 1.07 * Math.sin(a0 - 0.14), 0.05]);
  for (let i = 0; i <= n; i++){
    const f = i / n, a = a0 + turn * f, r = R * (1 + 0.04 * Math.sin(f * 5.1));
    t += i === 0 ? 70 : 42 - 22 * f;
    k.push([t, 0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), i === 0 ? 0.85 : Math.min(1, 0.85 + f * 3) - 0.45 * f * f]);
  }
  const a = a0 + turn + 0.12;
  k.push([t + 60, 0.5 + R * 1.02 * Math.cos(a), 0.5 + R * 1.02 * Math.sin(a), 0]);
  return k;
};
const ROWS = [
  {name: 'Ensō', brush: {radius: 0.06, length: 2.4, upright: true}, keys: enso()},
  {name: '永', kanji: '永', source: 'syuku'},
  {name: 'S flourish', brush: {radius: 0.05, upright: true}, keys: [
    [0, 0.1, 0.2, 0.05], [90, 0.16, 0.26, 0.6], [260, 0.34, 0.4, 1.0], [420, 0.55, 0.47, 0.8],
    [560, 0.72, 0.58, 0.95], [680, 0.82, 0.72, 0.7], [780, 0.78, 0.84, 0.35], [860, 0.62, 0.88, 0]]},
  {name: '道', kanji: '道', source: 'syuku'},
];
const COLS = [
  {name: 'Ink 0.45', dip: 0.45},
  {name: 'Ink 0.29', dip: 0.285},
  {name: 'Ink 0.12', dip: 0.12},
  {name: 'Ink 0.06', dip: 0.06},
];

/* A fitted sweep (strokes of [x, y, pressure] in a 128 box, radius = pressure * Rmax) as brush gestures:
   the brush is sized to the widest stroke, each point's radius becomes a pressure, time follows arclength,
   and every stroke lands lightly and lifts just past its last point. */
function kanjiGestures(sweep, Rmax, box, brush, dip, speed){
  const k = box.size / 128;
  let rMax = 0;
  for (const s of sweep) for (const q of s) rMax = Math.max(rMax, q[2] * Rmax);
  const R = rMax * k * 1.05, pace = 0.3 * k * speed;   // brush radius px, handle speed px per ms
  const P = r => Math.min(1, Math.pow(Math.max(r * k, 0) / R, 1 / 0.9));   // inverse of the belly's radius curve
  return sweep.map((s, si) => {
    const pts = s.map(([x, y, p]) => [box.x + x * k, box.y + y * k, P(p * Rmax)]);
    const keys = [[0, pts[0][0], pts[0][1], 0.08]];
    let t = 60;
    pts.forEach((q, i) => {
      if (i) t += Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) / pace;
      keys.push([t, q[0], q[1], Math.max(q[2], 0.12)]);
    });
    const a = pts[pts.length - 2], b = pts[pts.length - 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    keys.push([t + 45, b[0] + (b[0] - a[0]) / l * R * 0.4, b[1] + (b[1] - a[1]) / l * R * 0.4, 0]);
    const g = {keys, after: 160};
    if (si === 0){ g.brush = Object.assign({}, brush, {radius: R}); g.dip = dip; }
    return g;
  });
}

/* opts: {sweeps, styles, brush: overrides merged into every brush (size scales the radius), speed, ink} */
function cell(row, col, w, h, opts = {}){
  const R = ROWS[row], C = COLS[col], s = Math.min(w, h), ox = (w - s) / 2, oy = (h - s) / 2;
  const speed = opts.speed || 1, over = Object.assign({}, opts.brush), size = over.size || 1;
  delete over.size;
  const dip = Math.min(1, C.dip * (opts.ink || 1));
  if (R.kanji){
    const box = {x: ox + s * 0.07, y: oy + s * 0.07, size: s * 0.86};
    const gs = kanjiGestures(opts.sweeps[R.source][R.kanji], opts.styles[R.source].Rmax, box, over, dip, speed);
    gs[0].brush.radius *= size;
    return gs;
  }
  return [{dip, brush: Object.assign({}, R.brush, over, {radius: R.brush.radius * s * size}),
    keys: R.keys.map(([t, x, y, p]) => [t / speed, ox + x * s, oy + y * s, p])}];
}
window.SUMI_SHEET = {ROWS, COLS, cell};
})();
