/* Refit recorded sweeps to a font glyph.
   A sweep is [stroke, ...], a stroke is [[x, y, r], ...] in the 128-unit sheet box, where r is the
   visible brush radius in box units. Each stroke keeps its KanjiVG order and rough path, but its
   centreline is snapped to the glyph's medial ridge, its width is read from the glyph's distance
   transform, and its ends are trimmed or extended to where the glyph's ink actually ends. */
(() => {
const N = 512, U = N / 128;   // raster size, px per box unit

/* Glyph mask laid out like drawGhost() in sumi.js: em 0.9 of the box, ink box centred. */
async function glyphMask(ch, font){
  await document.fonts.load(`40px "${font}"`, ch);
  const c = document.createElement('canvas'); c.width = c.height = N;
  const x = c.getContext('2d');
  x.font = `${Math.floor(N * 0.9)}px "${font}", "Hiragino Mincho ProN", serif`;
  const m = x.measureText(ch);
  const gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, gh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  x.fillText(ch, (N - gw) / 2 + m.actualBoundingBoxLeft, (N - gh) / 2 + m.actualBoundingBoxAscent);
  const a = x.getImageData(0, 0, N, N).data, mask = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) mask[i] = a[i * 4 + 3] > 127;
  return mask;
}

/* Exact Euclidean distance (px) from each pixel of the given class to the nearest pixel of the other (Felzenszwalb). */
function edt(mask, inside = 1){
  const INF = 1e12, f = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) f[i] = mask[i] === inside ? INF : 0;
  const d1 = (g, n) => {
    const v = new Int32Array(n), z = new Float64Array(n + 1), out = new Float64Array(n);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++){
      let s;
      while ((s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])) <= z[k]) k--;
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++){ while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + g[v[k]]; }
    return out;
  };
  const col = new Float64Array(N);
  for (let x = 0; x < N; x++){
    for (let y = 0; y < N; y++) col[y] = f[y * N + x];
    const o = d1(col, N); for (let y = 0; y < N; y++) f[y * N + x] = o[y];
  }
  const row = new Float64Array(N), dt = new Float32Array(N * N);
  for (let y = 0; y < N; y++){
    for (let x = 0; x < N; x++) row[x] = f[y * N + x];
    const o = d1(row, N); for (let x = 0; x < N; x++) dt[y * N + x] = Math.sqrt(o[x]);
  }
  return dt;
}

/* Distance field sampler in box units. */
function sampler(dt){
  return (x, y) => {
    const px = x * U - 0.5, py = y * U - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    const g = (i, j) => (i < 0 || j < 0 || i >= N || j >= N) ? 0 : dt[j * N + i];
    return ((g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy) / U;
  };
}

/* Catmull-Rom through the control points, resampled every `step` units. */
function densify(ctrl, step){
  const P = [ctrl[0].map((v, j) => 2 * v - ctrl[1][j]), ...ctrl, ctrl[ctrl.length - 1].map((v, j) => 2 * v - ctrl[ctrl.length - 2][j])];
  const pts = [];
  for (let i = 1; i < P.length - 2; i++){
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const m = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step * 2));
    for (let k = 0; k < m; k++){
      const t = k / m, t2 = t * t, t3 = t2 * t;
      pts.push([0, 1].map(j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  pts.push(P[P.length - 2].slice(0, 2));
  return resample(pts, step);
}
function resample(pts, step){
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = d[d.length - 1], n = Math.max(2, Math.round(total / step) + 1), out = [];
  let j = 0;
  for (let i = 0; i < n; i++){
    const s = total * i / (n - 1);
    while (j < d.length - 2 && d[j + 1] < s) j++;
    const f = d[j + 1] > d[j] ? (s - d[j]) / (d[j + 1] - d[j]) : 0;
    out.push(pts[j].map((v, k) => v + (pts[j + 1][k] - v) * f));
  }
  return out;
}
const tangent = (pts, i, w = 2) => {
  const a = pts[Math.max(0, i - w)], b = pts[Math.min(pts.length - 1, i + w)];
  const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
  return [tx / l, ty / l];
};
const median = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

const STEP = 0.5, SEARCH = 9, SCAN = 0.25, GAP_R = 0.3;

function fitStroke(ctrl, D){
  let pts = densify(ctrl.map(p => [p[0], p[1]]), STEP);
  // 1. snap each sample across the stroke to the distance ridge of the ink run nearest to it
  let snap = pts.map((p, i) => {
    const [tx, ty] = tangent(pts, i), nx = -ty, ny = tx;
    const prof = [];
    for (let o = -SEARCH; o <= SEARCH + 1e-9; o += SCAN) prof.push([o, D(p[0] + nx * o, p[1] + ny * o)]);
    const runs = []; let cur = null;
    for (const [o, v] of prof){
      if (v > 0.05){ if (!cur) runs.push(cur = {a: o, b: o, best: o, bv: v}); cur.b = o; if (v > cur.bv){ cur.bv = v; cur.best = o; } }
      else cur = null;
    }
    if (!runs.length) return null;
    const gap = r => r.a <= 0 && r.b >= 0 ? 0 : Math.min(Math.abs(r.a), Math.abs(r.b));
    const run = runs.reduce((m, r) => gap(r) < gap(m) ? r : m);
    if (gap(run) > 3) return null;
    return {o: run.best, len: run.b - run.a + SCAN, r: run.bv, n: [nx, ny]};
  });
  // drop samples that found no ink at either end (the KanjiVG path overshoots the font there)
  let a = 0, b = snap.length - 1;
  while (a < b && !snap[a]) a++;
  while (b > a && !snap[b]) b--;
  pts = pts.slice(a, b + 1); snap = snap.slice(a, b + 1);
  if (pts.length < 2) return null;
  // fill interior gaps by interpolation
  for (let i = 0; i < snap.length; i++) if (!snap[i]){
    let j = i; while (!snap[j]) j++;
    const L = snap[i - 1], R = snap[j];
    for (let k = i; k < j; k++){ const f = (k - i + 1) / (j - i + 1); snap[k] = {o: L.o + (R.o - L.o) * f, len: 0, r: L.r + (R.r - L.r) * f, n: tangent(pts, k).reverse().map((v, q) => q ? v : -v), junction: true}; }
    i = j;
  }
  // 2. junctions: where the cross-section runs far wider than the ridge height suggests, another stroke
  //    crosses; there both the offset and the radius come from the clean samples on either side
  const rMed = median(snap.map(s => s.r));
  snap.forEach(s => { if (s.len > 2.6 * Math.max(s.r, 0.5) + 1 || s.r > 1.6 * rMed) s.junction = true; });
  const clean = snap.map(s => !s.junction);
  if (clean.some(Boolean)){
    for (let i = 0; i < snap.length; i++) if (!clean[i]){
      let l = i; while (l >= 0 && !clean[l]) l--;
      let r = i; while (r < snap.length && !clean[r]) r++;
      const L = l >= 0 ? snap[l] : snap[r], R = r < snap.length ? snap[r] : snap[l];
      const f = l >= 0 && r < snap.length ? (i - l) / (r - l) : 0;
      snap[i].o = L.o + (R.o - L.o) * f;
      snap[i].r = Math.min(snap[i].r, L.r + (R.r - L.r) * f);
    }
  }
  // smooth the offsets so the path does not wobble with the glyph outline
  const W = 4;
  const off = snap.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - W); k <= Math.min(snap.length - 1, i + W); k++){ s += snap[k].o; n++; } return s / n; });
  let out = pts.map((p, i) => [p[0] + snap[i].n[0] * off[i], p[1] + snap[i].n[1] * off[i]]);
  out = resample(out, STEP).map(p => [p[0], p[1], D(p[0], p[1])]);
  // re-apply the junction clamp to the radius at the snapped positions
  const rr = out.map(p => p[2]), rm = median(rr);
  for (let i = 0; i < out.length; i++){
    const w = Math.max(3, Math.round(2 * rm / STEP)), win = [];
    for (let k = Math.max(0, i - w); k <= Math.min(out.length - 1, i + w); k++) win.push(rr[k]);
    out[i][2] = Math.min(rr[i], 1.15 * median(win));
  }
  // 3. ends: follow the ridge outwards while there is ink, letting the radius fall to the glyph's tip
  const grow = (list, dir) => {
    const res = [];
    let [x, y, r0] = list[0];
    let [tx, ty] = tangent(list.map(p => p), 0, 3); tx *= dir; ty *= dir;
    let rPrev = r0;
    for (let n = 0; n < 200; n++){
      let bx = x + tx * STEP, by = y + ty * STEP, bv = D(bx, by);
      for (let o = -1; o <= 1; o += 0.25){ const cx = x + tx * STEP - ty * o, cy = y + ty * STEP + tx * o, v = D(cx, cy); if (v > bv){ bv = v; bx = cx; by = cy; } }
      if (bv < 0.35 || bv > rPrev * 1.2 + 0.1) break;   // tip reached, or ran into another stroke
      const l = Math.hypot(bx - x, by - y) || 1;
      tx = 0.7 * tx + 0.3 * (bx - x) / l; ty = 0.7 * ty + 0.3 * (by - y) / l;
      const tl = Math.hypot(tx, ty); tx /= tl; ty /= tl;
      x = bx; y = by; rPrev = Math.min(rPrev, bv);
      res.push([x, y, rPrev]);
    }
    return res;
  };
  // 4. where the path crosses paper (the font lifts the brush there) split it into separate strokes
  const parts = [];
  let cur = [];
  for (let i = 0; i < out.length; i++){
    if (out[i][2] >= GAP_R) cur.push(out[i]);
    else if (cur.length){ parts.push(cur); cur = []; }
  }
  if (cur.length) parts.push(cur);
  return parts.filter(p => p.length >= 3).map(p => {
    const head = grow(p, -1).reverse(), tail = grow(p.slice().reverse(), -1);
    return simplify([...head, ...p, ...tail], 0.2, 5);
  });
}

/* Douglas-Peucker on (x, y, r) with a cap on segment length. */
function simplify(pts, tol, maxSeg){
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const rec = (i, j) => {
    if (j <= i + 1) return;
    const [ax, ay, ar] = pts[i], [bx, by, br] = pts[j];
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    let worst = -1, wd = 0;
    for (let k = i + 1; k < j; k++){
      const [px, py, pr] = pts[k];
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / (L * L)));
      const d = Math.max(Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)), Math.abs(pr - (ar + t * (br - ar))));
      if (d > wd){ wd = d; worst = k; }
    }
    if (wd > tol || L > maxSeg){
      if (worst < 0) worst = (i + j) >> 1;   // a straight run that is only too long
      keep[worst] = 1; rec(i, worst); rec(worst, j);
    }
  };
  rec(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]).map(p => p.map(v => Math.round(v * 100) / 100));
}

/* Scale and shift the whole sweep onto the glyph (the KanjiVG layout and each font's proportions differ).
   Cost: path samples should lie on ink (distance to ink), and every part of the glyph's medial ridge should
   have a path nearby, so the fit cannot shrink into one thick stroke. */
function align(sweep, dt, Dout){
  const path = sweep.flatMap(s => s.length >= 2 ? densify(s.map(p => [p[0], p[1]]), 1.5) : []);
  const ridge = [];
  for (let y = 2; y < N - 2; y += 3) for (let x = 2; x < N - 2; x += 3){
    const v = dt[y * N + x];
    if (v < 1.5) continue;
    let top = true;
    for (let j = -2; j <= 2 && top; j++) for (let i = -2; i <= 2; i++) if (dt[(y + j) * N + x + i] > v + 0.5){ top = false; break; }
    if (top) ridge.push([(x + 0.5) / U, (y + 0.5) / U]);
  }
  const cost = ([sx, sy, tx, ty]) => {
    const q = path.map(([x, y]) => [64 + (x - 64) * sx + tx, 64 + (y - 64) * sy + ty]);
    let a = 0;
    for (const [x, y] of q){ const d = Dout(x, y); a += d * d; }
    let b = 0;
    for (const [x, y] of ridge){
      let m = 1e9;
      for (const [px, py] of q){ const d = (px - x) ** 2 + (py - y) ** 2; if (d < m) m = d; }
      b += Math.min(m, 100);
    }
    return a / q.length + b / Math.max(1, ridge.length) + 20 * ((sx - 1) ** 2 + (sy - 1) ** 2);
  };
  let best = [1, 1, 0, 0], bc = cost(best);
  for (const step of [[0.08, 0.08, 4, 4], [0.04, 0.04, 2, 2], [0.02, 0.02, 1, 1], [0.01, 0.01, 0.5, 0.5]]){
    for (let improved = true, guard = 0; improved && guard < 30; guard++){
      improved = false;
      for (let k = 0; k < 4; k++) for (const sgn of [-1, 1]){
        const c = best.slice(); c[k] += sgn * step[k];
        if (k < 2 && (c[k] < 0.8 || c[k] > 1.25)) continue;
        const v = cost(c);
        if (v < bc - 1e-6){ bc = v; best = c; improved = true; }
      }
    }
  }
  const [sx, sy, tx, ty] = best;
  return sweep.map(s => s.map(([x, y, p]) => [64 + (x - 64) * sx + tx, 64 + (y - 64) * sy + ty, p]));
}

/* Per stroke, in writing order: slide the path to the nearby spot that lies best on ink, preferring
   ink no earlier stroke has taken, so two strokes cannot settle onto the same line of the glyph. */
function shiftStroke(ctrl, Dout, claimed){
  const pts = densify(ctrl.map(p => [p[0], p[1]]), 1);
  const taken = (x, y) => { const i = Math.floor(x * U), j = Math.floor(y * U); return i >= 0 && j >= 0 && i < N && j < N && claimed[j * N + i]; };
  const cost = (tx, ty) => {
    let a = 0, c = 0;
    for (const [x, y] of pts){ const d = Math.min(Dout(x + tx, y + ty), 6); a += d * d; if (taken(x + tx, y + ty)) c++; }
    return a / pts.length + 8 * c / pts.length + 0.02 * (tx * tx + ty * ty);
  };
  let bt = [0, 0], bc = cost(0, 0);
  for (let ty = -12; ty <= 12; ty++) for (let tx = -12; tx <= 12; tx++){ const v = cost(tx, ty); if (v < bc){ bc = v; bt = [tx, ty]; } }
  for (let ty = bt[1] - 1; ty <= bt[1] + 1; ty += 0.25) for (let tx = bt[0] - 1; tx <= bt[0] + 1; tx += 0.25){ const v = cost(tx, ty); if (v < bc){ bc = v; bt = [tx, ty]; } }
  return ctrl.map(([x, y, p]) => [x + bt[0], y + bt[1], p]);
}
function claim(claimed, strokes){
  for (const s of strokes){
    const dense = resample(s, 0.5);
    for (const [x, y, r] of dense){
      const R = (r + 0.75) * U, cx = x * U, cy = y * U;
      for (let j = Math.max(0, Math.floor(cy - R)); j <= Math.min(N - 1, Math.ceil(cy + R)); j++)
        for (let i = Math.max(0, Math.floor(cx - R)); i <= Math.min(N - 1, Math.ceil(cx + R)); i++)
          if ((i - cx) ** 2 + (j - cy) ** 2 <= R * R) claimed[j * N + i] = 1;
    }
  }
}

async function fitGlyph(sweep, font, ch){
  const mask = await glyphMask(ch, font), dt = edt(mask);
  const D = sampler(dt), Dout = sampler(edt(mask, 0)), claimed = new Uint8Array(N * N);
  // the stored sweeps carry pressure, not radius; only the path is reused
  const out = [];
  for (const s of align(sweep, dt, Dout)){
    if (s.length < 2) continue;
    const parts = (fitStroke(shiftStroke(s, Dout, claimed), D) || []).filter(p => p.length >= 2);
    claim(claimed, parts);
    out.push(...parts);
  }
  return out;
}

window.SumiFit = {fitGlyph};
})();
