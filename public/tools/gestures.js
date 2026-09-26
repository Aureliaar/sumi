/* Test gestures for the bristle brush, authored in a 1000 x 640 space. Keys are [t ms, x, y, pressure].
   SUMI_GESTURES(w, h) returns them fitted and centred in a w x h canvas, in the form playGestures() takes. */
(() => {
const ensoKeys = () => {
  // one breath: the brush dives in already moving low on the left, presses, goes round clockwise,
  // lightening and speeding up, and lifts past the start
  const k = [], cx = 770, cy = 440, R = 150, a0 = 2.75, turn = 2 * Math.PI * 0.94, n = 28;
  let t = 0;
  k.push([0, cx + R * 1.06 * Math.cos(a0 - 0.12), cy + R * 1.06 * Math.sin(a0 - 0.12), 0.05]);
  for (let i = 0; i <= n; i++){
    const f = i / n, a = a0 + turn * f;
    const r = R * (1 + 0.04 * Math.sin(f * 5.1));   // a hand-drawn circle wanders a little
    t += i === 0 ? 70 : 42 - 22 * f;                // accelerating
    const p = i === 0 ? 0.8 : Math.min(1, 0.8 + f * 3) - 0.5 * f * f;
    k.push([t, cx + r * Math.cos(a), cy + r * Math.sin(a), p]);
  }
  const a = a0 + turn + 0.12;
  k.push([t + 60, cx + R * 1.02 * Math.cos(a), cy + R * 1.02 * Math.sin(a), 0]);
  return k;
};

const GESTURES = [
  {name: 'horizontal: angled entry, pressed stop', brush: {radius: 15}, dip: 1, keys: [
    [0, 80, 80, 0.12], [120, 92, 92, 0.85], [260, 96, 94, 0.9], [700, 380, 92, 0.7], [820, 394, 96, 0.92], [900, 392, 90, 0]]},
  {name: 'vertical with hook', brush: {radius: 15}, dip: 1, keys: [
    [0, 505, 40, 0.12], [120, 518, 54, 0.85], [250, 521, 58, 0.88], [900, 522, 300, 0.72], [1040, 525, 318, 0.95], [1160, 520, 321, 0.9], [1190, 506, 314, 0.4], [1225, 474, 296, 0]]},
  {name: 'left sweep', brush: {radius: 15}, dip: 1, keys: [
    [0, 760, 40, 0.15], [120, 772, 54, 0.85], [480, 728, 170, 0.62], [760, 650, 272, 0.3], [900, 596, 306, 0]]},
  {name: 'right sweep', brush: {radius: 15}, dip: 1, keys: [
    [0, 90, 200, 0.08], [380, 230, 292, 0.55], [680, 330, 352, 1.0], [790, 382, 362, 0.9], [880, 432, 356, 0]]},
  {name: 'dot', brush: {radius: 15}, dip: 1, keys: [
    [0, 470, 380, 0.1], [140, 484, 394, 0.95], [300, 489, 399, 0.95], [380, 486, 396, 0]]},
  {name: 'enso', brush: {radius: 27, length: 2.4, upright: true}, dip: 1, keys: ensoKeys()},
  {name: 'fast half-dry sweep', brush: {radius: 22}, dip: 0.4, keys: [
    [0, 70, 540, 0.2], [70, 110, 532, 0.95], [420, 500, 575, 0.85], [500, 560, 590, 0]]},
];

window.SUMI_GESTURES = (w, h) => {
  const k = Math.min(w / 1000, h / 640), ox = (w - 1000 * k) / 2, oy = (h - 640 * k) / 2;
  return GESTURES.map(g => ({name: g.name, dip: g.dip,
    brush: Object.assign({}, g.brush, {radius: (g.brush.radius || 16) * k}),
    keys: g.keys.map(([t, x, y, p]) => [t, ox + x * k, oy + y * k, p])}));
};
})();
