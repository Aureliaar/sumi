/* Bristle brush model. No rendering here: the brush turns handle samples (position, pressure) into ink
   deposits, one short capsule per touching bristle per substep (from where the bristle was to where it
   is now, with an amount already scaled so consecutive capsules sum to a flat density).

   The tuft is a teardrop footprint whose belly sits under the handle and whose tip trails it. The tip
   is held by friction and dragged along like a rope, then springs back toward the brush's resting
   tilt, so a tilted touch-down leaves an angled entry, lifting while moving leaves a trailing flick,
   and reversing direction swings the tip over into a hook. Every bristle has a fixed place in the
   tuft, its own ink load and a clump: outer bristles and thin clumps run dry first, and dry bristles
   pull together into separate strands, which is where the dry-brush (kasure) streaks come from.
   Coordinates are px, y down; time is ms. */
(() => {
'use strict';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function rng(seed){ return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const DEFAULTS = {
  radius: 16,        // belly radius at full pressure
  length: 2.2,       // belly-to-tip length at full pressure, in belly radii
  tilt: -135,        // direction the tip points when the brush is at rest, degrees (y down: -135 is up-left)
  upright: false,    // held vertically: no resting tilt, the tip simply trails the first motion
  stiffness: 0.035,  // how fast the tip swings back to the tilt, per px of handle travel
  bristles: 360,
  clumps: 10,
  ink: 1.45,         // pigment per unit area from a fully loaded bristle; about 1.3 covers the paper
  use: 0.02,         // share of a bristle's load spent per brush radius it travels (a full brush lasts ~35 radii)
  edgeUse: 1.6,      // outer bristles spend this much more
  clumpVar: 0.7,     // spread of clump capacities (thin clumps run dry first)
  splay: 0.1,        // scatter of bristle tips at touch-down, in belly radii
  land: 1,           // how staggered the bristles land (0: all at once); each needs some travel or time
  split: 0.8,        // how wide the gaps between clumps open while inked (thin white streaks), 0..1
  splitScale: 150,   // px of travel over which a clump's split opens and closes
  flare: 0.3,        // outer bristles fan out this far (in half-widths) as the brush lands
  lift: 0.3,         // share of the pressure a fast brush loses (it rides up on the ink)
  fast: 1.6,         // handle speed, px/ms, at which lift and thinning are about half on
  step: 1.5,         // handle substep, px
  seed: 7,
};

/* Canonical tuft outline: a round belly (a < BELLY) tapering to a fine tip at a = 1. */
const BELLY = 0.3;
const halfWidth = a => a < BELLY ? Math.sqrt(Math.max(0, 1 - ((BELLY - a) / BELLY) ** 2)) : 1 - 0.9 * ((a - BELLY) / (1 - BELLY)) ** 1.15;

class Brush {
  constructor(opts = {}){
    const o = this.o = Object.assign({}, DEFAULTS, opts);
    const R = rng(o.seed);
    const clumpCap = Array.from({length: o.clumps}, () => 1 + (R() * 2 - 1) * o.clumpVar);
    this.B = [];
    while (this.B.length < o.bristles){
      const a = R(), b = R() * 2 - 1;
      if (Math.abs(b) > halfWidth(a)) continue;   // uniform over the tuft's area
      const c = clamp(Math.floor((b + 1) / 2 * o.clumps), 0, o.clumps - 1);   // clumps are contiguous lanes across the tuft
      const cap = clumpCap[c] * (0.9 + 0.2 * R());
      this.B.push({a, b, c, cap, load: cap,
        quit: 0.006 + 0.035 * R(),                 // fill below which this bristle stops laying ink
        land: R() * (0.45 + 0.55 * smooth(0.4, 1, Math.abs(b))),   // outer bristles land last
        rank: Math.abs(b) * 0.65 + R() * 0.35,     // central bristles are longest and touch first
        ja: R() * 2 - 1, jb: R() * 2 - 1, seed: R() * 97,
        px: 0, py: 0, on: false, s: 0, s0: 0});
    }
    const sum = new Array(o.clumps).fill(0), n = new Array(o.clumps).fill(0);
    for (const q of this.B){ sum[q.c] += q.b; n[q.c]++; }
    for (const q of this.B) q.bc = sum[q.c] / n[q.c];
    const half = new Array(o.clumps).fill(1e-3);
    for (const q of this.B) half[q.c] = Math.max(half[q.c], Math.abs(q.b - q.bc));
    const lo = new Array(o.clumps).fill(1), hi = new Array(o.clumps).fill(-1);
    for (const q of this.B){ lo[q.c] = Math.min(lo[q.c], q.b); hi[q.c] = Math.max(hi[q.c], q.b); }
    this.bnd = Array.from({length: o.clumps - 1}, (_, k) => 0.5 * (hi[k] + lo[k + 1]));   // boundary between clump k and k + 1
    for (const q of this.B){
      q.e = Math.abs(q.b - q.bc) / half[q.c];            // 0 at the clump's middle, 1 at its edge
      q.gap = q.b > q.bc ? q.c : q.c - 1;                  // the clump boundary on this bristle's side
    }
    const t = o.tilt * Math.PI / 180;
    this.rest = [Math.cos(t), Math.sin(t)];
    this.gapK = new Float32Array(o.clumps);   // gap k lies between clump k and clump k + 1
    this.down_ = false;
  }
  /* Load the bristles to fullness f (1 = a full dip); never removes ink already there. */
  dip(f = 1){ for (const q of this.B) q.load = Math.max(q.load, f * q.cap); }
  /* Blot: take the brush down to fullness f. */
  blot(f){ for (const q of this.B) q.load = Math.min(q.load, f * q.cap); }
  /* Mean remaining ink, 0..1. */
  get load(){ let s = 0, c = 0; for (const q of this.B){ s += q.load; c += q.cap; } return s / c; }

  down(x, y, p){
    this.x = x; this.y = y; this.p = p; this.travel = 0;
    this.dir = this.o.upright ? null : this.rest.slice();
    this.speed = 0; this.age = 0;
    for (const q of this.B) q.on = false;
    this.down_ = true;
    return this.move(x, y, p);
  }
  up(){ this.down_ = false; for (const q of this.B) q.on = false; }

  /* Move the handle to (x, y) at pressure p (0..1) over dt ms. Returns the deposits made on the way. */
  move(x, y, p, dt = 1000 / 60){
    const o = this.o, out = [];
    const dx = x - this.x, dy = y - this.y, dist = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(dist / o.step));
    const p0 = this.p;
    this.speed += (dist / Math.max(dt, 1) - this.speed) * Math.min(1, dt / 50);
    this.age += dt;
    for (let k = 1; k <= n; k++){
      const f = k / n;
      this.step_(this.x + dx / n, this.y + dy / n, p0 + (p - p0) * f, dist / n, out);
    }
    return out;
  }

  step_(x, y, pIn, ds, out){
    const o = this.o;
    const fastF = this.speed / (this.speed + o.fast);           // 0 at rest, 0.5 at o.fast
    const p = pIn * (1 - o.lift * fastF);
    this.p = pIn;
    const Rb = o.radius * Math.pow(clamp(p, 0, 1.5), 0.9);
    let Lc = o.radius * o.length * Math.pow(clamp(p, 0, 1.5), 0.5);
    // an upright brush has no preferred side until it first moves; then its tip trails that motion
    if (!this.dir){
      const mx = x - this.x, my = y - this.y, ml = Math.hypot(mx, my);
      this.dir = ml > 1e-6 ? [-mx / ml, -my / ml] : null;
    }
    const dir = this.dir || this.rest;
    // tip: stays put where friction holds it, so the handle drags it behind; then relaxes toward the tilt
    const tx = this.x + dir[0] * Lc, ty = this.y + dir[1] * Lc;
    let ddx = tx - x, ddy = ty - y, l = Math.hypot(ddx, ddy);
    if (l > 1e-6){ ddx /= l; ddy /= l; } else [ddx, ddy] = dir;
    // pushed into its own tip the tuft cannot lead: the hairs buckle and flip over to trail, quickly
    if (ds > 1e-6){
      const mx = (x - this.x) / ds, my = (y - this.y) / ds, lead = ddx * mx + ddy * my;
      if (lead > 0){
        // swing the tip round (the short way) toward trailing the motion
        const f = clamp(lead * ds / (0.35 * Lc + 1) * 2.5, 0, 1);
        const cur = Math.atan2(ddy, ddx);
        let d = Math.atan2(-my, -mx) - cur;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        ddx = Math.cos(cur + d * f); ddy = Math.sin(cur + d * f);
      }
    }
    // the spring back to the resting tilt gives way when the motion heads into the tilt (the tuft buckles)
    let relax = o.upright ? 0 : clamp(o.stiffness * ds * (1.3 - 0.6 * clamp(p, 0, 1)), 0, 1);
    if (ds > 1e-6) relax *= clamp(1 - 3 * ((x - this.x) * this.rest[0] + (y - this.y) * this.rest[1]) / ds, 0, 1);
    ddx += (this.rest[0] - ddx) * relax; ddy += (this.rest[1] - ddy) * relax;
    l = Math.hypot(ddx, ddy) || 1;
    if (this.dir) this.dir = [ddx / l, ddy / l];
    this.x = x; this.y = y; this.travel += ds;
    if (Rb < 0.3) { for (const q of this.B) q.on = false; return; }

    if (!this.dir) Lc = 0;   // upright and not yet moving: just the round belly
    const [ux, uy] = this.dir || dir, nx = -uy, ny = ux;
    const reach = 0.15 + 0.85 * Math.pow(clamp(p, 0, 1), 0.7);
    let active = 0;
    for (const q of this.B) if (q.rank < reach) active++;
    if (!active) return;
    const spacing = spacingOf(Rb, Lc, active);
    const settle = Math.max(0, 1 - this.travel / (1.2 * Rb + 2));   // touch-down scatter fades as the brush settles
    const fan = smooth(0, 1.6 * o.radius + 2, this.travel) * smooth(0.15, 0.6, clamp(p, 0, 1));
    // bristles land one by one as the brush travels or dwells, so the start is a ragged edge of hair ends
    const contact = this.travel / (0.8 * o.radius + 1) + this.age / 160;
    // the gaps between neighbouring clumps open and close along the stroke, more under pressure, and a fast
    // brush skims and opens more of them ("flying white")
    const flying = 1 + 1.6 * fastF;
    for (let k = 0; k < o.clumps - 1; k++)
      this.gapK[k] = clamp(o.split * smooth(0.45 - 0.2 * fastF, 0.8 - 0.2 * fastF, noise1(this.travel / o.splitScale + k * 7.31))
        * (0.35 + 0.65 * clamp(p, 0, 1)) * flying, 0, 1.6);

    for (const q of this.B){
      if (q.rank >= reach || contact < q.land * o.land){ q.on = false; continue; }
      const fill = clamp(q.load / q.cap, 0, 1), dry = 1 - fill;
      let along = -Rb + q.a * (Rb + Lc) + q.ja * o.splay * Rb * settle;
      let b = q.b + q.jb * o.splay * settle;
      b *= 1 + o.flare * settle * smooth(0.6, 1, Math.abs(q.b));   // outer hairs fan out at touch-down
      const clump = 0.12 + 0.62 * smooth(0.25, 0.9, dry);      // drying bristles pull into strands
      b += (q.bc + (b - q.bc) * 0.3 - b) * clump;
      const g = q.gap >= 0 && q.gap < o.clumps - 1 ? this.gapK[q.gap] : 0;
      // dragged, the tuft fans out and its hairs lie in parallel lanes, so each bristle keeps its own lane
      // across the stroke; landing and lifting it gathers back into a teardrop
      const hw = Rb * (halfWidth(q.a) + (1 - halfWidth(q.a)) * fan);
      // an open gap between clumps pushes the bristles on both sides of it out of the gap
      const gapHalf = g > 0 ? 0.5 * g * 4 * spacingOf(Rb, Lc, active) : 0;
      if (gapHalf > 0){
        const d = (b - this.bnd[q.gap]) * hw, side = Math.sign(q.b - q.bc);
        if (d * side > -gapHalf) b = this.bnd[q.gap] - side * gapHalf / Math.max(hw, 1e-3);
      }
      const px = x + ux * along + nx * b * hw, py = y + uy * along + ny * b * hw;
      // a bristle that has just landed has no motion yet; it points away from the tip, the way the handle leads
      const landed = !q.on;
      const seg = landed ? 0 : Math.hypot(px - q.px, py - q.py);
      const ang = seg > 1e-4 ? Math.atan2(py - q.py, px - q.px) : Math.atan2(-uy, -ux);
      if (landed) q.s0 = q.s; else q.s += seg;
      q.px = px; q.py = py; q.on = true;
      // wet bristles spread ink into their neighbours' gaps; dry ones leave their own thin line
      // the outermost bristles lay thinner, separate lines, so edges read as hair and break first
      let r = 0.5 * spacing * (1.35 - 0.85 * smooth(0.2, 0.85, dry)) * (1 - 0.5 * smooth(0.8, 1, Math.abs(q.b)))
        * (1 - 0.35 * fastF);
      // an open gap between clumps: bristles on both sides stop their ink half a gap short of the boundary,
      // and the gap is a few bristle spacings wide so the wet paper's bleed does not simply close it
      if (gapHalf > 0) r = Math.min(r, Math.max(0.25, Math.abs(this.bnd[q.gap] - b) * hw - gapHalf));
      const inkF = smooth(q.quit, q.quit + 0.05, fill);   // a bristle lays a continuous line, then quits
      // a dry bristle lays thinner and skips, but what it lays is still full-strength ink
      const density = o.ink * Math.min(spacing / (2 * r), 1.25) * (0.85 + 0.15 * fill) * inkF * (1 - 0.2 * fastF);
      // amount is density times the distance this dab advances (a landing dab covers its own radius)
      if (inkF > 0 && (landed || seg > 0)) out.push({x: px, y: py, r, ang, seg, s: q.s, s0: q.s0,
        amount: density * (landed ? r : seg), load: fill * (1 - 0.45 * fastF * fastF), water: inkF, seed: q.seed, press: p});
      // a drier bristle gives up its ink more slowly, so dry brush goes on long and broken rather than stopping
      q.load = Math.max(0, q.load - seg / o.radius * o.use * (1 + o.edgeUse * q.b * q.b) * (0.5 + 0.6 * clamp(p, 0, 1.2)) * q.cap
        * (0.12 + 0.88 * smooth(0, 0.6, fill)));
    }
  }
}


/* Mean distance between touching bristles: the footprint's area (belly disc plus the tapered part) shared out. */
const spacingOf = (Rb, Lc, active) => Math.sqrt((Math.PI * Rb * Rb * 0.5 + (Rb + Lc) * Rb * 0.9) / active);
/* Smooth 1D value noise. */
function noise1(x){
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const h = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  return h(i) + (h(i + 1) - h(i)) * u;
}

/* Catmull-Rom through gesture keys [[t, x, y, p], ...] at time t (ms). */
function sampleKeys(keys, t){
  if (t <= keys[0][0]) return keys[0].slice(1);
  const n = keys.length;
  if (t >= keys[n - 1][0]) return keys[n - 1].slice(1);
  let i = 0; while (keys[i + 1][0] < t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
  const u = (t - k1[0]) / (k2[0] - k1[0]), u2 = u * u, u3 = u2 * u;
  return [1, 2, 3].map(j => 0.5 * (2 * k1[j] + (-k0[j] + k2[j]) * u + (2 * k0[j] - 5 * k1[j] + 4 * k2[j] - k3[j]) * u2 + (-k0[j] + 3 * k1[j] - 3 * k2[j] + k3[j]) * u3));
}

window.SumiBrush = {Brush, sampleKeys, DEFAULTS};
})();
