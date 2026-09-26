/* 4 x 4 evaluation sheet: four drawings (rows) at four settings (columns). Each cell is drawn alone on a
   square canvas; positions are fractions of the cell, times are ms at speed 1. */
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
  {name: 'Stroke with hook', brush: {radius: 0.04}, keys: [
    [0, 0.44, 0.1, 0.12], [110, 0.465, 0.13, 0.85], [230, 0.47, 0.14, 0.88], [820, 0.48, 0.7, 0.72],
    [930, 0.482, 0.735, 0.8], [990, 0.478, 0.74, 0.8], [1040, 0.455, 0.727, 0.78], [1090, 0.41, 0.7, 0.6], [1140, 0.35, 0.664, 0.25], [1170, 0.32, 0.648, 0]]},
  {name: 'S flourish', brush: {radius: 0.05, upright: true}, keys: [
    [0, 0.1, 0.2, 0.05], [90, 0.16, 0.26, 0.6], [260, 0.34, 0.4, 1.0], [420, 0.55, 0.47, 0.8],
    [560, 0.72, 0.58, 0.95], [680, 0.82, 0.72, 0.7], [780, 0.78, 0.84, 0.35], [860, 0.62, 0.88, 0]]},
  {name: 'Dry slash', brush: {radius: 0.075, upright: true}, keys: [
    [0, 0.08, 0.66, 0.05], [80, 0.14, 0.62, 1.0], [200, 0.3, 0.57, 1.0], [420, 0.7, 0.43, 0.75], [520, 0.92, 0.36, 0]]},
];
const COLS = [
  {name: 'Wet, slow', dip: 1, speed: 0.5},
  {name: 'Wet, fast', dip: 1, speed: 2.2},
  {name: 'Half ink', dip: 0.45, speed: 1},
  {name: 'Near dry, fast', dip: 0.12, speed: 2.2},
];
function cell(row, col, w, h){
  const R = ROWS[row], C = COLS[col], s = Math.min(w, h), ox = (w - s) / 2, oy = (h - s) / 2;
  return [{name: `${R.name} · ${C.name}`, dip: C.dip,
    brush: Object.assign({}, R.brush, C.brush, {radius: R.brush.radius * s}),
    keys: R.keys.map(([t, x, y, p]) => [t / C.speed, ox + x * s, oy + y * s, p])}];
}
window.SUMI_SHEET = {ROWS, COLS, cell};
})();
