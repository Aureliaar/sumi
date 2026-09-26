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
  stiffness: 0.035,  // how fast the tip swings back to the tilt, per px of handle travel
  bristles: 240,
  clumps: 13,
  ink: 1.45,         // pigment per unit area from a fully loaded bristle; about 1.3 covers the paper
  use: 0.0011,       // share of a bristle's load spent per px it travels
  edgeUse: 1.6,      // outer bristles spend this much more
  clumpVar: 0.7,     // spread of clump capacities (thin clumps run dry first)
  splay: 0.1,        // scatter of bristle tips at touch-down, in belly radii
  flare: 0.3,        // outer bristles fan out this far (in half-widths) as the brush lands
  lift: 0.45,        // share of the pressure a fast brush loses (it rides up on the ink)
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
      const c = clamp(Math.floor((b + 1) / 2 * o.clumps + (R() - 0.5) * 0.9), 0, o.clumps - 1);
      const cap = clumpCap[c] * (0.9 + 0.2 * R());
      this.B.push({a, b, c, cap, load: cap,
        quit: 0.04 + 0.2 * R(),                    // fill below which this bristle stops laying ink
        rank: Math.abs(b) * 0.65 + R() * 0.35,     // central bristles are longest and touch first
        ja: R() * 2 - 1, jb: R() * 2 - 1, seed: R() * 97,
        px: 0, py: 0, on: false, s: 0, s0: 0});
    }
    const sum = new Array(o.clumps).fill(0), n = new Array(o.clumps).fill(0);
    for (const q of this.B){ sum[q.c] += q.b; n[q.c]++; }
    for (const q of this.B) q.bc = sum[q.c] / n[q.c];
    const t = o.tilt * Math.PI / 180;
    this.rest = [Math.cos(t), Math.sin(t)];
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
    this.dir = this.rest.slice();
    this.speed = 0;
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
    const Rb = o.radius * Math.pow(clamp(p, 0, 1.5), 0.65);
    const Lc = o.radius * o.length * Math.pow(clamp(p, 0, 1.5), 0.5);
    // tip: stays put where friction holds it, so the handle drags it behind; then relaxes toward the tilt
    const tx = this.x + this.dir[0] * Lc, ty = this.y + this.dir[1] * Lc;
    let ddx = tx - x, ddy = ty - y, l = Math.hypot(ddx, ddy);
    if (l > 1e-6){ ddx /= l; ddy /= l; } else [ddx, ddy] = this.dir;
    const relax = clamp(o.stiffness * ds * (1.3 - 0.6 * clamp(p, 0, 1)), 0, 1);
    ddx += (this.rest[0] - ddx) * relax; ddy += (this.rest[1] - ddy) * relax;
    l = Math.hypot(ddx, ddy) || 1;
    this.dir = [ddx / l, ddy / l];
    this.x = x; this.y = y; this.travel += ds;
    if (Rb < 0.3) { for (const q of this.B) q.on = false; return; }

    const [ux, uy] = this.dir, nx = -uy, ny = ux;
    const reach = 0.3 + 0.7 * Math.sqrt(clamp(p, 0, 1));
    let active = 0;
    for (const q of this.B) if (q.rank < reach) active++;
    if (!active) return;
    // footprint area (belly disc plus the tapered part) shared out between the touching bristles
    const area = Math.PI * Rb * Rb * 0.5 + (Rb + Lc) * Rb * 0.9;
    const spacing = Math.sqrt(area / active);
    const settle = Math.max(0, 1 - this.travel / (1.2 * Rb + 2));   // touch-down scatter fades as the brush settles

    for (const q of this.B){
      if (q.rank >= reach){ q.on = false; continue; }
      const fill = clamp(q.load / q.cap, 0, 1), dry = 1 - fill;
      let along = -Rb + q.a * (Rb + Lc) + q.ja * o.splay * Rb * settle;
      let b = q.b + q.jb * o.splay * settle;
      b *= 1 + o.flare * settle * smooth(0.6, 1, Math.abs(q.b));   // outer hairs fan out at touch-down
      const clump = 0.12 + 0.62 * smooth(0.25, 0.9, dry);      // drying bristles pull into strands
      b += (q.bc + (b - q.bc) * 0.3 - b) * clump;
      const hw = halfWidth(q.a) * Rb;
      const px = x + ux * along + nx * b * hw, py = y + uy * along + ny * b * hw;
      // a bristle that has just landed has no motion yet; it points away from the tip, the way the handle leads
      const landed = !q.on;
      const seg = landed ? 0 : Math.hypot(px - q.px, py - q.py);
      const ang = seg > 1e-4 ? Math.atan2(py - q.py, px - q.px) : Math.atan2(-uy, -ux);
      if (landed) q.s0 = q.s; else q.s += seg;
      q.px = px; q.py = py; q.on = true;
      // wet bristles spread ink into their neighbours' gaps; dry ones leave their own thin line
      // the outermost bristles lay thinner, separate lines, so edges read as hair and break first
      const r = 0.5 * spacing * (1.35 - 0.85 * smooth(0.2, 0.85, dry)) * (1 - 0.5 * smooth(0.8, 1, Math.abs(q.b)))
        * (1 - 0.35 * fastF);
      const inkF = smooth(q.quit, q.quit + 0.05, fill);   // a bristle lays a continuous line, then quits
      const density = o.ink * Math.min(spacing / (2 * r), 1.25) * (0.55 + 0.45 * fill) * inkF * (1 - 0.3 * fastF);
      // amount is density times the distance this dab advances (a landing dab covers its own radius)
      if (inkF > 0 && (landed || seg > 0)) out.push({x: px, y: py, r, ang, seg, s: q.s, s0: q.s0,
        amount: density * (landed ? r : seg), load: fill, water: inkF, seed: q.seed, press: p});
      q.load = Math.max(0, q.load - seg * o.use * (1 + o.edgeUse * q.b * q.b) * (0.5 + 0.6 * clamp(p, 0, 1.2)) * q.cap);
    }
  }
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
