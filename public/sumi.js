(() => {
'use strict';
const $ = s => document.querySelector(s);
const canvas = $('#paper');
const hint = $('#hint');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const gl = canvas.getContext('webgl2', {alpha:false, antialias:false, depth:false, stencil:false, preserveDrawingBuffer:false, powerPreference:'high-performance'});
if (!gl) { hint.textContent = 'This brush needs WebGL 2, which this browser has turned off or does not support.'; return; }

/* ---------- shaders ---------- */
const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
`;
const NOISE = `
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.-2.*f);
  float a=hash12(i), b=hash12(i+vec2(1.,0.)), c=hash12(i+vec2(0.,1.)), d=hash12(i+vec2(1.,1.));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=mat2(1.6,1.2,-1.2,1.6)*p+vec2(11.3,7.7); a*=.5; } return s; }
`;
const VS_FULL = `#version 300 es
out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.-1.,0.,1.); }`;

// Washi: R grain height, G fibers, B formation cloud, A bark flecks
const FS_PAPER = HEAD + NOISE + `
in vec2 vUv; out vec4 o;
uniform vec2 uRes; uniform float uScale; uniform float uSeed;
void main(){
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = fc/uScale + vec2(uSeed*131.7, uSeed*71.3);
  float grain = fbm(p*0.42)*0.75 + vnoise(p*1.4)*0.25;
  float fib = 0.;
  for(int i=0;i<7;i++){
    float fi = float(i);
    float a = fi*0.93 + hash12(vec2(fi, uSeed))*1.4;
    float ca = cos(a), sa = sin(a);
    vec2 q = mat2(ca, sa, -sa, ca)*p;
    q.y += (vnoise(q*0.006 + fi*5.3) - 0.5)*70.;
    float n = vnoise(vec2(q.x*0.009, q.y*0.13) + fi*19.1);
    float ridge = pow(max(1. - abs(n*2.-1.), 0.), 7.);
    float seg = smoothstep(0.52, 0.82, vnoise(vec2(q.x*0.012, q.y*0.02) + fi*3.7));
    fib = max(fib, ridge*seg);
  }
  float cloud = fbm(p*0.009);
  vec2 cell = floor(p/5.);
  float fleck = 0.;
  if (hash12(cell + 91.7) > 0.9982){
    vec2 c = (cell + 0.5 + (vec2(hash12(cell+3.1), hash12(cell+8.4)) - 0.5)*0.5)*5.;
    vec2 d = p - c;
    fleck = 1. - smoothstep(0.3, 1.3, length(d*vec2(1., 1.6)));
  }
  o = vec4(grain, fib, cloud, fleck);
}`;

// Brush dab, instanced. State layout: R wet pigment, G dry pigment, A water
// Footprint = convex hull of the belly circle (radius R at the dab centre) and a tip circle
// (radius rt) at distance L along the brush axis: a teardrop. L = 0 gives the old round dab.
const VS_DAB = `#version 300 es
layout(location=0) in vec4 aA; // x, y, R (sim px), motion angle
layout(location=1) in vec4 aB; // stroke distance, ink load, pigment amount, seed
layout(location=2) in vec4 aC; // pressure, kind (0 body, 1 stray hair), hair lane, edge noise
layout(location=3) in vec4 aD; // axis angle, tip distance L, tip radius, texture along-scale
layout(location=4) in vec4 aE; // stroke start and end distance (sim px), unused, unused
uniform vec2 uRes;
out vec2 vP; out vec4 vB; out vec4 vC; out vec4 vD; out vec4 vM; out vec2 vU; out float vR; out vec2 vS;
const vec2 Q[6] = vec2[6](vec2(-1,-1),vec2(1,-1),vec2(1,1),vec2(-1,-1),vec2(1,1),vec2(-1,1));
void main(){
  float R = aA.z, L = aD.y, rt = aD.z;
  vec2 m = vec2(cos(aA.w), sin(aA.w));
  vec2 ax = vec2(cos(aD.x), sin(aD.x));
  float E = max(R, L + rt)*1.06 + 1.;
  vP = Q[gl_VertexID]*E;
  vec2 n = vec2(-m.y, m.x);
  float an = dot(ax, n)*L;
  float hi = max(R, an + rt), lo = min(-R, an - rt);
  vU = vec2(0.5*(hi + lo), max(0.5*(hi - lo), 1e-3));
  vB = aB; vC = aC; vD = aD; vM = vec4(m, ax); vR = R; vS = aE.xy;
  gl_Position = vec4((aA.xy + vP)/uRes*2.-1., 0., 1.);
}`;
// Texture-driven deposit: R = bristle height field ("dry map"), G = tuft clump field ("split map")
const FS_DAB = HEAD + NOISE + `
in vec2 vP; in vec4 vB; in vec4 vC; in vec4 vD; in vec4 vM; in vec2 vU; in float vR; in vec2 vS; out vec4 o;
uniform float uWater; uniform vec2 uSimRes;
uniform sampler2D uBristle, uPaper;
float sdTear(vec2 p, float R, float r, float h){
  p.x = abs(p.x);
  if (h <= abs(R - r) + 1e-4) return min(length(p) - R, length(p - vec2(0., h)) - r);
  float b = (R - r)/h, a = sqrt(max(1. - b*b, 0.));
  float k = dot(p, vec2(-b, a));
  if (k < 0.) return length(p) - R;
  if (k > a*h) return length(p - vec2(0., h)) - r;
  return dot(p, vec2(a, b)) - R;
}
// Footprint in dab space. The dab centre slides along m, so a fragment at lateral offset l is covered
// while the centre's offset from it lies inside the footprint's chord along m, clipped to the stroke's extent.
float sdFoot(vec2 p){ vec2 ax = vM.zw; return sdTear(vec2(dot(p, vec2(ax.y, -ax.x)), dot(p, ax)), vR, vD.z, vD.y); }
vec2 chordAt(float l){
  vec2 m = vM.xy, n = vec2(-m.y, m.x);
  float E = max(vR, vD.y + vD.z)*1.1 + 1.;
  float t0 = 0., best = 1e9;
  for (int i = 0; i <= 8; i++){ float t = -E + 2.*E*float(i)/8.; float d = sdFoot(n*l + m*t); if (d < best){ best = d; t0 = t; } }
  if (best >= 0.) return vec2(0.);
  float a = t0, b = E;
  for (int i = 0; i < 10; i++){ float c = 0.5*(a + b); if (sdFoot(n*l + m*c) < 0.) a = c; else b = c; }
  float hi = a; a = -E; b = t0;
  for (int i = 0; i < 10; i++){ float c = 0.5*(a + b); if (sdFoot(n*l + m*c) < 0.) b = c; else a = c; }
  return vec2(b, hi);
}
void main(){
  vec2 m = vM.xy, ax = vM.zw, n = vec2(-m.y, m.x);
  float along = dot(vP, m), lateral = dot(vP, n);
  float sd = sdFoot(vP);
  float q = sd/vR + 1.;
  float sPix = vB.x + along;
  // vB.z is pigment per unit area times dab spacing; dividing by the covered run (chord clipped to the
  // stroke's extent) makes overlapping dabs sum to a flat profile, caps included
  vec2 ch = chordAt(lateral);
  float covered = min(sPix - ch.x, vS.y) - max(sPix - ch.y, vS.x);
  float perDab = vB.z/max(covered, 1.);
  float load = vB.y;
  float dryness = clamp(1.-load, 0., 1.);
  float press = vC.x;
  float alongT = sPix/vD.w + vB.w*0.37;

  float grain = clamp((texture(uPaper, gl_FragCoord.xy/uSimRes).r - 0.28)/0.44, 0., 1.);
  float gThr = smoothstep(0.35, 1.0, dryness)*clamp(1.35 - 0.6*press, 0.15, 1.);
  float tooth = smoothstep(gThr - 0.12, gThr + 0.04, grain);

  if (vC.y > 0.5){
    float mh = 1. - smoothstep(0.35, 1.0, q);
    if (mh <= 0.001) discard;
    float brk = texture(uBristle, vec2(vC.z, alongT*1.7)).r;
    mh *= smoothstep(0.12, 0.28, brk)*mix(1., tooth, 0.7);
    o = vec4(mh*perDab, 0., 0., mh*uWater*0.3);
    return;
  }

  float u = (lateral - vU.x)/vU.y;
  float edgeN = vnoise(vec2(u*6. + vB.w, sPix*0.05));
  // crisp edge (about 1.5 px), roughened by a slow wobble scaled with the style's edge setting
  float mask = 1. - smoothstep(-0.75, 0.75, sd + (edgeN - 0.5)*vC.w*vR);
  if (mask <= 0.001) discard;
  vec4 br = texture(uBristle, vec2(u*0.5 + 0.5, alongT));

  float thr = -0.15 + 1.05*smoothstep(0.12, 0.95, dryness);
  thr -= clamp(press - 0.85, -0.45, 0.8)*0.4*(0.4 + dryness);
  thr += smoothstep(0.55, 1., abs(u))*dryness*0.35;
  float streak = smoothstep(thr - 0.05, thr + 0.05, br.r);

  float sThr = dryness*0.5 + max(press - 1.1, 0.)*0.3 - 0.12;
  float split = smoothstep(sThr - 0.1, sThr + 0.1, br.g);

  float mm = streak*split*tooth;
  float fine = 0.8 + 0.2*br.r;
  o = vec4(mask*mm*fine*perDab, 0., 0., mask*mix(1., mm, 0.85)*uWater*mix(0.3, 1., load));
}`;

// Wet-media step: capillary flow through fibers, pigment transport, edge-driven drying, granulating deposit
const FS_SIM = HEAD + `
in vec2 vUv; out vec4 o;
uniform sampler2D uState, uPaper; uniform vec2 uTexel; uniform float uD, uEvap;
float permAt(vec4 pp){ return 0.18 + 0.7*pp.g + 0.3*pp.b; }
void main(){
  vec4 c = texture(uState, vUv);
  vec4 pp = texture(uPaper, vUv);
  float perm = permAt(pp);
  float w = c.a, p = c.r;
  float conc = min(p/max(w,1e-3), 3.);
  vec2 o4[4] = vec2[4](vec2(1.,0.),vec2(-1.,0.),vec2(0.,1.),vec2(0.,-1.));
  float wn[4];
  float dW = 0., dP = 0.;
  for(int i=0;i<4;i++){
    vec2 uv2 = vUv + o4[i]*uTexel;
    vec4 n = texture(uState, uv2);
    float pn = permAt(texture(uPaper, uv2));
    wn[i] = n.a;
    float gate = smoothstep(0.02, 0.22, max(w, n.a));
    float f = uD*0.5*(perm+pn)*gate*(n.a - w);
    dW += f;
    float nc = min(n.r/max(n.a,1e-3), 3.);
    dP += f*(f > 0. ? nc : conc);
  }
  float w2 = max(w + dW, 0.);
  float p2 = max(p + dP*0.85, 0.);
  float g = length(vec2(wn[0]-wn[1], wn[2]-wn[3]));
  float evap = uEvap*(1. + 5.*g)*(0.8 + 0.4*(1.-perm));
  w2 = max(w2 - evap, 0.);
  float dryness = 1. - smoothstep(0.0, 0.16, w2);
  float rate = (0.003 + 0.3*dryness)*(0.6 + 0.8*pp.r);
  if (w2 < 0.002) rate = 1.;
  float dep = p2*clamp(rate, 0., 1.);
  p2 -= dep;
  o = vec4(min(p2, 6.), min(c.g + dep, 8.), 0., min(w2, 2.));
}`;

const FS_COMP = HEAD + NOISE + `
in vec2 vUv; out vec4 o;
uniform sampler2D uState, uPaper, uSeal; uniform vec2 uRes, uSimTexel; uniform float uScale;
void main(){
  vec2 uv = vUv;
  vec2 tx = 1./uRes;
  vec4 pp = texture(uPaper, uv);
  float hL = texture(uPaper, uv-vec2(tx.x,0.)).r, hR = texture(uPaper, uv+vec2(tx.x,0.)).r;
  float hD = texture(uPaper, uv-vec2(0.,tx.y)).r, hU = texture(uPaper, uv+vec2(0.,tx.y)).r;
  float bump = 2.2*uScale;
  vec3 n = normalize(vec3((hL-hR)*bump, (hD-hU)*bump, 1.));
  vec3 L = normalize(vec3(-0.45, 0.55, 0.9));
  float shade = 0.9 + 0.12*dot(n, L);

  vec3 base = vec3(0.930, 0.914, 0.878);
  base *= mix(0.965, 1.025, pp.b);
  base = mix(base, vec3(0.975, 0.968, 0.945), pp.g*0.6);
  base = mix(base, vec3(0.42, 0.36, 0.28), pp.a*0.55);
  vec3 paper = base*shade;

  vec4 s = texture(uState, uv);
  float d = s.g + s.r*0.92;
  // Paper texture only breaks up thin ink; a thick body of ink covers fibers and grain
  float cover = smoothstep(0.5, 1.3, d);
  d *= mix((1. - 0.2*pp.g)*(0.86 + 0.28*pp.r), 1., cover);
  // Shoulder: thick deposits build up faster than linear, so cores go to true sumi black
  float od = d*(1. + 0.6*d);
  // Near-neutral absorption (a touch warm in the washes); dense sumi keeps a soft floor rather than
  // printing flat #000, and pooled ink sinks a little further than a single pass.
  vec3 absorb = exp(-od*3.2*vec3(0.97, 1.0, 1.05));
  float floorK = 0.10*exp(-max(d - 0.8, 0.)*1.1);
  vec3 col = paper*(floorK + (1. - floorK)*absorb);

  float wL = texture(uState, uv-vec2(uSimTexel.x,0.)).a, wR = texture(uState, uv+vec2(uSimTexel.x,0.)).a;
  float wD = texture(uState, uv-vec2(0.,uSimTexel.y)).a, wU = texture(uState, uv+vec2(0.,uSimTexel.y)).a;
  vec3 wn = normalize(vec3((wL-wR)*2.5, (wD-wU)*2.5, 1.));
  vec3 H = normalize(L + vec3(0.,0.,1.));
  float spec = pow(max(dot(wn, H), 0.), 60.);
  float wet = smoothstep(0.04, 0.45, s.a);
  col *= 1. - 0.12*wet*smoothstep(0., 0.5, d);
  col += vec3(0.95, 0.97, 1.0)*spec*wet*0.12*smoothstep(0.05, 0.4, d);

  float sa = texture(uSeal, uv).a;
  if (sa > 0.){
    vec2 cp = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y)/uScale;
    float mottle = vnoise(cp*0.35)*0.5 + vnoise(cp*0.9)*0.5;
    float inked = smoothstep(0.18, 0.42, mottle*0.6 + pp.r*0.55 - pp.g*0.25);
    sa *= mix(0.55, 1.0, inked);
    vec3 shu = vec3(0.80, 0.22, 0.13);
    col *= mix(vec3(1.), shu*1.06, sa*0.95);
  }
  vec2 q = uv - 0.5;
  col *= 1. - 0.16*dot(q, q);
  col += (hash12(gl_FragCoord.xy) - 0.5)/255.;
  o = vec4(col, 1.);
}`;

const FS_RESAMPLE = HEAD + `
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uOldCss, uNewCss, uNewPx;
void main(){
  vec2 css = gl_FragCoord.xy/uNewPx*uNewCss;
  float fromTop = uNewCss.y - css.y;
  vec2 uv = vec2(css.x, uOldCss.y - fromTop)/uOldCss;
  o = (uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.) ? vec4(0.) : texture(uSrc, uv);
}`;

function compile(type, src){
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(vs, fs){
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++){ const info = gl.getActiveUniform(p, i); u[info.name.replace('[0]','')] = gl.getUniformLocation(p, info.name); }
  return {p, u};
}

let P;
try {
  P = {
    paper: program(VS_FULL, FS_PAPER),
    dab: program(VS_DAB, FS_DAB),
    sim: program(VS_FULL, FS_SIM),
    comp: program(VS_FULL, FS_COMP),
    rs: program(VS_FULL, FS_RESAMPLE),
  };
} catch (err) {
  console.error(err);
  hint.textContent = 'The brush could not start on this device’s graphics driver.';
  return;
}

/* ---------- render targets ---------- */
const RGBA8 = {internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE};
let FMT = RGBA8;
function makeTarget(w, h, fmt){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null);
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {t, f, w, h};
}
function freeTarget(x){ if (!x) return; gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); }
function clearTarget(x){ gl.bindFramebuffer(gl.FRAMEBUFFER, x.f); gl.viewport(0,0,x.w,x.h); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT); }
function blit(a, b){
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, a.f);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, b.f);
  gl.blitFramebuffer(0,0,a.w,a.h, 0,0,b.w,b.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}
if (gl.getExtension('EXT_color_buffer_float')) {
  const half = {internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT};
  const t = makeTarget(4, 4, half);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.f);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) FMT = half;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  freeTarget(t);
}

const emptyVAO = gl.createVertexArray();
function pass(prog, target, w, h){
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null);
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog.p);
  gl.bindVertexArray(emptyVAO);
}
function bindTex(unit, t, loc){ gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc, unit); }
const draw3 = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

/* ---------- dab batching ---------- */
const dabVAO = gl.createVertexArray();
const dabBuf = gl.createBuffer();
gl.bindVertexArray(dabVAO);
gl.bindBuffer(gl.ARRAY_BUFFER, dabBuf);
for (let i = 0; i < 5; i++){ gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 80, 16 * i); gl.vertexAttribDivisor(i, 1); }
gl.bindVertexArray(null);
const DAB_F = 20;
let dabData = new Float32Array(DAB_F * 4096), dabCount = 0;
function pushInst(v){
  if ((dabCount + 1) * DAB_F > dabData.length){ const n = new Float32Array(dabData.length * 2); n.set(dabData); dabData = n; }
  dabData.set(v, dabCount * DAB_F);
  dabCount++;
}

/* ---------- state ---------- */
const TONES = { dark:{pig:1.0, water:0.85, decay:1.0}, light:{pig:0.24, water:1.25, decay:0.8} };
let toneKey = 'dark';
const SIZES = [0.012, 0.02, 0.032], SIZE_NAMES = ['fine','medium','bold'], SIZE_DOT = [3, 5, 7.5];
let sizeIdx = 1;
const GLYPHS = [...'永心道風夢和山花書愛水火木月日人力空雨春'];
let glyphIdx = 0;
const PAPER_SEED = Math.random() * 10;

const V = {cssW:0, cssH:0, dpr:1, sim:1, dW:0, dH:0, sW:0, sH:0, minDim:400, baseR:8};
let cur = null, nxt = null, paper = null;
let dirty = true, simUntil = 0, pendingResize = false;
const undo = [], pool = [];
let seals = [];
let sealMode = false;
let lastLoad = 1, lastStrokeEnd = -1e9;

const sealCanvas = document.createElement('canvas');
const sealCtx = sealCanvas.getContext('2d');
const sealTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, sealTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

/* ---------- bristle texture ----------
   A synthetic dry-brush print: ~160 bristles grouped into tufts, each wandering slightly
   and running out of ink in its own rhythm. Periodic along the stroke (T wraps),
   one brush width across. Both channels are histogram-equalized so a threshold of t
   leaves almost exactly (1 - t) of the area inked. */
function equalize(a){
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < a.length; i++){ const v = a[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const B = 4096, hist = new Uint32Array(B), sc = (B - 1) / ((mx - mn) || 1);
  for (let i = 0; i < a.length; i++) hist[((a[i] - mn) * sc) | 0]++;
  const cdf = new Float32Array(B); let acc = 0;
  for (let i = 0; i < B; i++){ cdf[i] = (acc + hist[i] * 0.5) / a.length; acc += hist[i]; }
  for (let i = 0; i < a.length; i++) a[i] = cdf[((a[i] - mn) * sc) | 0];
}
function buildBristleTexture(){
  const W = 320, H = 2048;
  const R = rng(20260926);
  const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += R(); return (s - 2) / 0.577; };
  const pnoise = cells => {
    const v = new Float32Array(cells); for (let i = 0; i < cells; i++) v[i] = R();
    const out = new Float32Array(H);
    for (let y = 0; y < H; y++){ const t = y / H * cells, i = Math.floor(t), f = t - i, s = f * f * (3 - 2 * f); const a = v[i % cells], b = v[(i + 1) % cells]; out[y] = a + (b - a) * s; }
    return out;
  };
  const K = 8, clumps = [];
  for (let k = 0; k < K; k++){
    const d = pnoise(3 + (R() * 4 | 0)), amp = 3 + R() * 7, drift = new Float32Array(H);
    for (let y = 0; y < H; y++) drift[y] = (d[y] - 0.5) * 2 * amp;
    clumps.push({c: (k + 0.5) / K * W + (R() - 0.5) * (W / K) * 0.5, w: (W / K) * (0.3 + R() * 0.25), drift});
  }
  const h = new Float32Array(W * H), g = new Float32Array(W * H);
  for (let y = 0; y < H; y++){
    const row = y * W;
    for (let x = 0; x < W; x++){
      let s = 0;
      for (let k = 0; k < K; k++){ const c = clumps[k], d = x - (c.c + c.drift[y]); s += Math.exp(-d * d / (2 * c.w * c.w)); }
      g[row + x] = s;
    }
  }
  const N = 160;
  for (let n = 0; n < N; n++){
    const c = clumps[R() * K | 0];
    const x0 = clamp(c.c + gauss() * c.w * 0.75, 1, W - 2);
    const xn = x0 / W * 2 - 1;
    const cap = (0.45 + 0.55 * R()) * (1 - 0.5 * xn * xn);
    const f1 = 1 + (R() * 3 | 0), f2 = 4 + (R() * 5 | 0);
    const a1 = 0.5 + R() * 2.5, a2 = 0.3 + R() * 1.2, p1 = R() * 6.2832, p2 = R() * 6.2832;
    const brk = pnoise(8 + (R() * 48 | 0)), brk2 = pnoise(60 + (R() * 140 | 0));
    const sig = 0.6 + R() * 0.8, reach = Math.ceil(sig * 3), inv = 1 / (2 * sig * sig);
    for (let y = 0; y < H; y++){
      const t = y / H * 6.2831853;
      const x = x0 + c.drift[y] + a1 * Math.sin(f1 * t + p1) + a2 * Math.sin(f2 * t + p2);
      const v = cap * (0.3 + 0.7 * brk[y]) * (0.8 + 0.2 * brk2[y]);
      const xa = Math.max(0, Math.floor(x - reach)), xb = Math.min(W - 1, Math.ceil(x + reach)), row = y * W;
      for (let xi = xa; xi <= xb; xi++){ const d = xi - x, val = v * Math.exp(-d * d * inv); if (val > h[row + xi]) h[row + xi] = val; }
    }
  }
  for (let i = 0; i < h.length; i++) h[i] = Math.max(h[i], R() * 0.05);
  equalize(h); equalize(g);
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++){ data[i * 4] = Math.min(255, h[i] * 255); data[i * 4 + 1] = Math.min(255, g[i] * 255); data[i * 4 + 3] = 255; }
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return t;
}

const S = {down:false, id:null, pen:false, pr:0.5, tip:{x:0,y:0}, target:{x:0,y:0}, lastT:0,
  speed:0, dirX:0, dirY:0, ang:Math.PI/4, turn:0, dwell:0, acc:0, s:0, r:4, load:1, seed:0, strays:[]};

const bristleTex = buildBristleTexture();

/* ---------- GPU passes ---------- */
function drawDabs(){
  if (!dabCount) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, cur.f);
  gl.viewport(0, 0, V.sW, V.sH);
  gl.useProgram(P.dab.p);
  gl.uniform2f(P.dab.u.uRes, V.sW, V.sH);
  gl.uniform1f(P.dab.u.uWater, TONES[toneKey].water);
  gl.uniform2f(P.dab.u.uSimRes, V.sW, V.sH);
  bindTex(0, bristleTex, P.dab.u.uBristle);
  bindTex(1, paper.t, P.dab.u.uPaper);
  gl.enable(gl.BLEND);
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX);
  gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
  gl.bindVertexArray(dabVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, dabBuf);
  gl.bufferData(gl.ARRAY_BUFFER, dabData.subarray(0, dabCount * DAB_F), gl.DYNAMIC_DRAW);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, dabCount);
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
  dabCount = 0;
  simUntil = performance.now() + 9000;
  dirty = true;
}
function simStep(){
  pass(P.sim, nxt, V.sW, V.sH);
  bindTex(0, cur.t, P.sim.u.uState);
  bindTex(1, paper.t, P.sim.u.uPaper);
  gl.uniform2f(P.sim.u.uTexel, 1 / V.sW, 1 / V.sH);
  gl.uniform1f(P.sim.u.uD, 0.18);
  gl.uniform1f(P.sim.u.uEvap, 0.0022);
  draw3();
  const t = cur; cur = nxt; nxt = t;
}
function composite(){
  pass(P.comp, null, V.dW, V.dH);
  bindTex(0, cur.t, P.comp.u.uState);
  bindTex(1, paper.t, P.comp.u.uPaper);
  bindTex(2, sealTex, P.comp.u.uSeal);
  gl.uniform2f(P.comp.u.uRes, V.dW, V.dH);
  gl.uniform2f(P.comp.u.uSimTexel, 1 / V.sW, 1 / V.sH);
  gl.uniform1f(P.comp.u.uScale, V.dpr);
  draw3();
}
function resample(src, dst, old){
  pass(P.rs, dst, dst.w, dst.h);
  bindTex(0, src.t, P.rs.u.uSrc);
  gl.uniform2f(P.rs.u.uOldCss, old.cssW, old.cssH);
  gl.uniform2f(P.rs.u.uNewCss, V.cssW, V.cssH);
  gl.uniform2f(P.rs.u.uNewPx, dst.w, dst.h);
  draw3();
}

/* ---------- sizing ---------- */
function resize(){
  if (S.down){ pendingResize = true; return; }
  const cssW = Math.max(1, canvas.clientWidth), cssH = Math.max(1, canvas.clientHeight);
  const area = cssW * cssH;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (area * dpr * dpr > 4.2e6) dpr = Math.sqrt(4.2e6 / area);
  let sim = Math.min(dpr, 1.5);
  if (area * sim * sim > 1.6e6) sim = Math.sqrt(1.6e6 / area);
  const dW = Math.round(cssW * dpr), dH = Math.round(cssH * dpr);
  const sW = Math.round(cssW * sim), sH = Math.round(cssH * sim);
  if (dW === V.dW && dH === V.dH && sW === V.sW && sH === V.sH) return;

  if (cur) drawDabs();
  const old = {...V}, oldCur = cur, oldNxt = nxt;
  Object.assign(V, {cssW, cssH, dpr, sim, dW, dH, sW, sH, minDim: Math.min(cssW, cssH)});
  V.baseR = Math.max(2.5, SIZES[sizeIdx] * V.minDim);
  canvas.width = dW; canvas.height = dH;

  cur = makeTarget(sW, sH, FMT); nxt = makeTarget(sW, sH, FMT);
  clearTarget(nxt);
  if (oldCur){
    resample(oldCur, cur, old);
    freeTarget(oldCur); freeTarget(oldNxt);
    for (const e of undo) if (e.t){ const t = makeTarget(sW, sH, FMT); resample(e.t, t, old); freeTarget(e.t); e.t = t; }
    pool.forEach(freeTarget); pool.length = 0;
  } else clearTarget(cur);

  freeTarget(paper);
  paper = makeTarget(dW, dH, RGBA8);
  pass(P.paper, paper, dW, dH);
  gl.uniform2f(P.paper.u.uRes, dW, dH);
  gl.uniform1f(P.paper.u.uScale, dpr);
  gl.uniform1f(P.paper.u.uSeed, PAPER_SEED);
  draw3();

  sealCanvas.width = dW; sealCanvas.height = dH;
  drawSeals();
  simUntil = performance.now() + 9000;
  dirty = true;
}
let resizeTimer = 0;
function scheduleResize(){ clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); }
window.addEventListener('resize', scheduleResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);

/* ---------- replay: sweeps with pressure -> dabs ----------
   Pure functions, shared verbatim by the page and the offline test harness.
   A sweep is [stroke, ...]; a stroke is [[x, y, p], ...] control points in a 128-unit box.
   A style holds the only tunable parameters, one set per source. */
const ENGINE = { qVis: 0.965, bleed: 2.55 };   // measured: visible half-width = qVis*R + bleed, in sim px
const INK_DENSITY = 1.5;   // pigment per unit area at full load; about 1.3 is where ink fully covers the paper
function catmullSweep(ctrl, step){
  const n = ctrl.length, P = [];
  P.push(ctrl[0].map((v, j) => 2 * v - ctrl[1][j]));
  for (const c of ctrl) P.push(c);
  P.push(ctrl[n - 1].map((v, j) => 2 * v - ctrl[n - 2][j]));
  const pts = [];
  for (let i = 1; i < P.length - 2; i++){
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(2, Math.floor(seg / step * 2));
    for (let k = 0; k < m; k++){
      const t = k / m, t2 = t * t, t3 = t2 * t;
      pts.push([0, 1, 2].map(j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  pts.push(P[P.length - 2].slice());
  // resample by arclength
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = d[d.length - 1], cnt = Math.max(2, Math.floor(total / step) + 1), out = [];
  let j = 0;
  for (let i = 0; i < cnt; i++){
    const s = total * i / (cnt - 1);
    while (j < d.length - 2 && d[j + 1] < s) j++;
    const f = d[j + 1] > d[j] ? (s - d[j]) / (d[j + 1] - d[j]) : 0;
    out.push([0, 1, 2].map(k => pts[j][k] + (pts[j + 1][k] - pts[j][k]) * f));
  }
  return out;
}
function styleAxis(style, tx, ty){
  const th = style.theta * Math.PI / 180, f = style.follow;
  let ax = Math.cos(th) * (1 - f) - tx * f, ay = Math.sin(th) * (1 - f) - ty * f;
  const l = Math.hypot(ax, ay) || 1;
  return [ax / l, ay / l];
}
/* Returns dab records in css px (y down) with timestamps in ms. */
function sweepToDabs(sweep, style, box, simScale){
  const k = box.size / 128, out = [];
  let t = 0, load = 1, lastEnd = -1e9, s = 0;
  const seedBase = 13.7;
  sweep.forEach((ctrl, si) => {
    if (ctrl.length < 2) return;
    const q = catmullSweep(ctrl, 0.5);
    load = Math.min(1, load + 0.3 + (t - lastEnd) / 1500);
    const seed = (seedBase + si * 17.31) % 97, first = out.length, s0 = s;
    let acc = 1e9;   // emit the first point immediately
    for (let i = 0; i < q.length; i++){
      const a = q[Math.max(0, i - 1)], b = q[Math.min(q.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const seg = i ? Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]) : 0;
      t += seg / style.pace;
      load = Math.max(0, load - seg * style.inkDecay);
      s += seg * k; acc += seg * k;
      const Rbox = Math.max(Math.min(Math.max(q[i][2], 0), 1.4) * style.Rmax, 0.35);
      // geometric footprint radius (css px) -> engine radius that renders at that visible size
      const Rgeo = Rbox * k;
      const Rsim = Math.max((Rgeo * simScale - ENGINE.bleed) / ENGINE.qVis, 0.6);
      const R = Rsim / simScale;
      const spacing = Math.max(0.5, 0.1 * R);
      if (acc < spacing && i !== q.length - 1) continue;
      const [axx, axy] = styleAxis(style, tx, ty);
      out.push({x: box.x + q[i][0] * k, y: box.y + q[i][1] * k, R, L: style.kL * R, rt: style.ratio * R,
        ang: Math.atan2(ty, tx), axis: Math.atan2(axy, axx), s, load, spacing: Math.min(acc, spacing * 2), seed,
        press: Math.min(2, Math.max(0.2, q[i][2] / 0.6)), t});
      acc = 0;
    }
    for (let i = first; i < out.length; i++){ out[i].s0 = s0; out[i].s1 = s; }
    lastEnd = t; t += style.pause;
  });
  return out;
}
/* Pack one record into the 20-float instance layout (sim px, y up, angles negated). */
function packDab(d, V, pig, style, texScale){
  const k = V.sim;
  const amount = INK_DENSITY * pig * (0.55 + 0.45 * d.load) * d.spacing;
  return [d.x * k, (V.cssH - d.y) * k, d.R * k, -d.ang,
          d.s * k, d.load, amount, d.seed,
          d.press, 0, 0, style.edge,
          -d.axis, d.L * k, d.rt * k, texScale,
          d.s0 * k, d.s1 * k, 0, 0];
}

/* Brush styles: one parameter set per source. "free" is the original round brush. */
const STYLES = Object.assign({
  free: {label:'Free brush', short:'筆', font:'Yuji Syuku', theta:-135, kL:0, ratio:1, follow:0, edge:0.18,
         Rmax:6, pace:0.35, pause:150, inkDecay:0.002, texScale:8}
}, (window.SUMI && SUMI.styles) || {});
const STYLE_KEYS = Object.keys(STYLES);
let styleKey = 'free';

/* ---------- brush physics ---------- */
function radiusTarget(){
  const spF = clamp(1.25 - 0.36 * S.speed, 0.36, 1.25);
  const prF = S.pen ? 0.3 + 1.2 * clamp(S.pr, 0, 1) : 1;
  return V.baseR * spF * prF * (1 + 0.45 * S.dwell) * (0.8 + 0.2 * S.load);
}
function emitDab(x, y, r, ang, s, load, spacing, kind = 0, lane = 0, amt = 1, press = -1){
  const k = V.sim, t = TONES[toneKey], st = STYLES[styleKey];
  const rr = Math.max(r, 0.35);
  const pr = press >= 0 ? press : clamp(rr / V.baseR, 0.2, 2);
  const body = kind === 0;
  const L = body ? st.kL * rr : 0, rt = body ? st.ratio * rr : rr;
  const [axx, axy] = styleAxis(st, Math.cos(ang), Math.sin(ang));
  const axis = Math.atan2(axy, axx);
  const amount = INK_DENSITY * amt * t.pig * (0.55 + 0.45 * load) * (1 - Math.min(0.35, S.speed * 0.12)) * spacing;
  pushInst([x * k, (V.cssH - y) * k, Math.max(rr * k, 0.8), -ang, s * k, load, amount, S.seed,
            pr, kind, lane, st.edge, -axis, L * k, rt * k, V.baseR * k * 60,
            body ? 0 : -1e9, 1e9, 0, 0]);
}
// Stray hairs: thin satellite tufts that leave the body of the brush when it is dry,
// pressed flat, bent hard, or flicked off the paper. Each follows its own drifting path.
function stepStrays(x, y, ang, r, spacing, load, fan){
  const dry = 1 - load, press = r / V.baseR;
  const want = clamp((dry - 0.3) * 1.6, 0, 1) + clamp(press - 1.15, 0, 1) * 0.8
             + clamp(Math.abs(S.turn) * 12 - 0.2, 0, 1) * 0.6 + fan;
  if (S.strays.length < 3 && Math.random() < spacing / V.baseR * 0.05 * want){
    const side = Math.abs(S.turn) > 0.02 ? -Math.sign(S.turn) : (Math.random() < 0.5 ? -1 : 1);
    S.strays.push({off: side * (0.9 + Math.random() * 0.35), dOff: (Math.random() - 0.5) * 0.02,
      life: V.baseR * (3 + Math.random() * 9), w: 0.3 + Math.random() * 0.5, lane: 0.05 + Math.random() * 0.9, px: null, py: null});
  }
  const px = -Math.sin(ang), py = Math.cos(ang);
  for (let n = S.strays.length - 1; n >= 0; n--){
    const st = S.strays[n];
    st.dOff += (Math.random() - 0.5) * 0.004;
    st.dOff = clamp(st.dOff, -0.03, 0.03);
    st.off += (st.dOff + Math.sign(st.off) * fan * 0.02) * spacing / V.baseR;
    st.off = Math.sign(st.off) * clamp(Math.abs(st.off), 0.8, 1.8);
    const hx = x + px * st.off * r, hy = y + py * st.off * r;
    const fade = Math.min(1, st.life / (V.baseR * 1.5));
    const hr = Math.max(0.35, (0.35 + st.w * V.baseR * 0.09) * fade);
    if (st.px === null){ st.px = hx; st.py = hy; }
    const d = Math.hypot(hx - st.px, hy - st.py);
    const steps = Math.min(40, Math.ceil(d / (hr * 0.5)));
    for (let i = 1; i <= steps; i++){
      const t = i / steps;
      emitDab(st.px + (hx - st.px) * t, st.py + (hy - st.py) * t, hr, ang, S.s, load, d / steps, 1, st.lane, 0.75, press);
    }
    st.px = hx; st.py = hy;
    st.life -= spacing;
    if (st.life <= 0) S.strays.splice(n, 1);
  }
}
function moveTo(nx, ny, dt){
  const dx = nx - S.tip.x, dy = ny - S.tip.y, dist = Math.hypot(dx, dy);
  S.speed += (dist / dt - S.speed) * (1 - Math.exp(-dt / 40));
  if (dist > 0.05){
    const k = 1 - Math.exp(-dist / 2.5);
    let ndx = S.dirX + (dx / dist - S.dirX) * k, ndy = S.dirY + (dy / dist - S.dirY) * k;
    const l = Math.hypot(ndx, ndy) || 1; ndx /= l; ndy /= l;
    const na = Math.atan2(ndy, ndx);
    if (S.dirX || S.dirY){
      let da = na - S.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
      S.turn += (clamp(da / dist, -0.06, 0.06) - S.turn) * Math.min(1, dist / 12);
    }
    S.dirX = ndx; S.dirY = ndy; S.ang = na;
    S.dwell = Math.max(0, S.dwell - dist / (V.baseR * 1.5));
  } else {
    S.dwell = Math.min(1, S.dwell + dt / 520);
  }
  const rT = radiusTarget();
  if (dist <= 0.05){
    // Resting brush: it spreads and the ink pools
    S.r += (rT - S.r) * (1 - Math.exp(-dt / 170));
    emitDab(S.tip.x, S.tip.y, S.r, S.ang, S.s, S.load, S.r * 0.02 * dt / 16);
    return;
  }
  const decay = 0.75 / V.minDim * TONES[toneKey].decay * (1 + 0.5 * S.speed);
  let traveled = 0;
  for (;;){
    const spacing = Math.max(0.5, S.r * 0.1);
    const need = spacing - S.acc;
    if (traveled + need > dist){ S.acc += dist - traveled; break; }
    traveled += need; S.acc = 0;
    const f = traveled / dist;
    S.r += (rT - S.r) * (1 - Math.exp(-spacing / (V.baseR * 0.9)));
    S.s += spacing;
    S.load = Math.max(0, S.load - spacing * decay);
    const ex = S.tip.x + dx * f, ey = S.tip.y + dy * f;
    emitDab(ex, ey, S.r, S.ang, S.s, S.load, spacing);
    stepStrays(ex, ey, S.ang, S.r, spacing, S.load, 0);
  }
  S.tip.x = nx; S.tip.y = ny;
}
function advance(t){
  let dt = t - S.lastT;
  dt = clamp(dt, 1, 60);
  S.lastT = Math.max(S.lastT, t);
  const a = 1 - Math.exp(-dt / 16);
  moveTo(S.tip.x + (S.target.x - S.tip.x) * a, S.tip.y + (S.target.y - S.tip.y) * a, dt);
}
function tail(){
  const sp = S.speed;
  if (sp < 0.35 || !(S.dirX || S.dirY)) return;
  const L = Math.min(V.baseR * 8, V.baseR * 0.6 + sp * 38);
  const r0 = S.r;
  const n = Math.max(6, Math.ceil(L / Math.max(0.5, r0 * 0.08)));
  const st = L / n;
  const decay = 0.75 / V.minDim * TONES[toneKey].decay * 3 * (1 + 0.5 * sp);
  let x = S.tip.x, y = S.tip.y, a = S.ang, load = S.load;
  for (let i = 1; i <= n; i++){
    const t = i / n;
    a += S.turn * st * (1 - t);
    x += Math.cos(a) * st; y += Math.sin(a) * st;
    load = Math.max(0, load - st * decay);
    S.s += st;
    const rt = r0 * Math.pow(1 - t, 1.25) + 0.3;
    emitDab(x, y, rt, a, S.s, load * (1 - 0.6 * t), st);
    stepStrays(x, y, a, Math.max(rt, r0 * 0.5), st, load * (1 - 0.6 * t), 0.5 * t);
  }
  S.load = load;
}

/* ---------- undo ---------- */
const bUndo = $('#bUndo');
function takeSnap(){ const t = pool.pop() || makeTarget(V.sW, V.sH, FMT); blit(cur, t); return t; }
function pushUndo(e){
  undo.push(e);
  if (undo.length > 6){ const old = undo.shift(); if (old.t) pool.push(old.t); }
  bUndo.disabled = false;
}
function doUndo(){
  if (S.down) return;
  replay = null;
  const e = undo.pop();
  if (!e) return;
  dabCount = 0;
  if (e.t){ blit(e.t, cur); pool.push(e.t); }
  if (e.kind === 'seal') seals.pop();
  if (e.kind === 'clear') seals = e.seals;
  if (e.kind !== 'stroke') drawSeals();
  simUntil = performance.now() + 9000;
  dirty = true;
  bUndo.disabled = undo.length === 0;
}
function newSheet(){
  if (S.down) return;
  replay = null;
  drawDabs();
  pushUndo({kind:'clear', t: takeSnap(), seals: seals.slice()});
  clearTarget(cur); clearTarget(nxt);
  seals = [];
  drawSeals();
  dirty = true;
}

/* ---------- seals ---------- */
function rng(seed){ return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function drawOneSeal(ctx, s){
  const rnd = rng(s.seed);
  const w = s.size, h = s.size * 1.5, pad = 4;
  const ow = w + pad * 2, oh = h + pad * 2;
  const off = document.createElement('canvas');
  off.width = Math.ceil(ow * V.dpr); off.height = Math.ceil(oh * V.dpr);
  const x = off.getContext('2d');
  x.scale(V.dpr, V.dpr); x.translate(pad, pad);
  const pts = [], N = 14, j = 1.3;
  const edge = (x0, y0, x1, y1) => { for (let i = 0; i < N; i++){ const t = i / N; pts.push([x0 + (x1 - x0) * t + (rnd() - .5) * j, y0 + (y1 - y0) * t + (rnd() - .5) * j]); } };
  edge(0, 0, w, 0); edge(w, 0, w, h); edge(w, h, 0, h); edge(0, h, 0, 0);
  x.fillStyle = '#000';
  x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.closePath(); x.fill();
  x.globalCompositeOperation = 'destination-out';
  x.font = `${Math.round(w * 0.66)}px "Yuji Syuku", "Hiragino Mincho ProN", "Yu Mincho", serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(s.chars[0], w / 2, h * 0.285);
  x.fillText(s.chars[1], w / 2, h * 0.715);
  for (let i = 0; i < 22; i++){ x.beginPath(); x.arc(rnd() * w, rnd() * h, rnd() * rnd() * w * 0.045 + 0.3, 0, 7); x.fill(); }
  for (let i = 0; i < 5; i++){
    const side = rnd() * 4 | 0, t = rnd();
    const px = side === 0 ? t * w : side === 1 ? w : side === 2 ? t * w : 0;
    const py = side === 0 ? 0 : side === 1 ? t * h : side === 2 ? h : t * h;
    x.beginPath(); x.arc(px, py, 0.8 + rnd() * w * 0.05, 0, 7); x.fill();
  }
  ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot);
  ctx.drawImage(off, -ow / 2, -oh / 2, ow, oh);
  ctx.restore();
}
function drawSeals(){
  sealCtx.setTransform(1, 0, 0, 1, 0, 0);
  sealCtx.clearRect(0, 0, sealCanvas.width, sealCanvas.height);
  sealCtx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  for (const s of seals) drawOneSeal(sealCtx, s);
  gl.bindTexture(gl.TEXTURE_2D, sealTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  if (seals.length) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sealCanvas);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  dirty = true;
}
async function placeSeal(x, y){
  setSealMode(false);
  const size = clamp(V.minDim * 0.085, 30, 64);
  const s = {x, y, size, rot:(Math.random() - .5) * 0.08, seed:(Math.random() * 1e9) | 0, chars:['墨','遊']};
  try { await document.fonts.load(`${Math.round(size)}px "Yuji Syuku"`, '墨遊'); } catch (_) {}
  seals.push(s);
  pushUndo({kind:'seal'});
  drawSeals();
}

/* ---------- pointer input ---------- */
let hintShown = true;
function hideHint(){ if (hintShown){ hint.classList.add('gone'); hintShown = false; } }
function showHint(text){ hint.textContent = text; hint.classList.remove('gone'); hintShown = true; }
function localPoint(e){ const r = canvas.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; }

canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (S.down) return;
  e.preventDefault();
  const p = localPoint(e);
  if (sealMode){ placeSeal(p.x, p.y); return; }
  canvas.setPointerCapture(e.pointerId);
  drawDabs();
  pushUndo({kind:'stroke', t: takeSnap()});
  const now = performance.now();
  Object.assign(S, {down:true, id:e.pointerId, pen:e.pointerType === 'pen', pr:e.pressure || 0.5,
    tip:{x:p.x, y:p.y}, target:{x:p.x, y:p.y}, lastT:e.timeStamp || now,
    speed:0, dirX:0, dirY:0, ang:Math.PI / 4, turn:0, dwell:0, acc:0, s:0, seed:Math.random() * 97, strays:[]});
  S.load = Math.min(1, lastLoad + 0.3 + (now - lastStrokeEnd) / 1500);
  S.r = V.baseR * 0.35;
  emitDab(p.x, p.y, S.r * 1.2, S.ang, 0, S.load, S.r * 0.6);
  hideHint();
});
canvas.addEventListener('pointermove', e => {
  if (!S.down || e.pointerId !== S.id) return;
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const evs = list.length ? list : [e];
  const r = canvas.getBoundingClientRect();
  for (const ev of evs){
    S.target.x = ev.clientX - r.left; S.target.y = ev.clientY - r.top;
    if (ev.pressure) S.pr = ev.pressure;
    advance(ev.timeStamp);
  }
});
function endStroke(e, withTail){
  if (!S.down || e.pointerId !== S.id) return;
  for (let i = 0; i < 8; i++){
    const gx = S.target.x - S.tip.x, gy = S.target.y - S.tip.y;
    if (Math.hypot(gx, gy) < 0.5) break;
    moveTo(S.tip.x + gx * 0.6, S.tip.y + gy * 0.6, 8);
  }
  if (withTail) tail();
  S.down = false;
  lastLoad = S.load;
  lastStrokeEnd = performance.now();
  if (pendingResize){ pendingResize = false; scheduleResize(); }
}
canvas.addEventListener('pointerup', e => endStroke(e, true));
canvas.addEventListener('pointercancel', e => endStroke(e, false));
canvas.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- toolbar ---------- */
const bGuide = $('#bGuide'), bNext = $('#bNext'), bSize = $('#bSize'), bTone = $('#bTone'), bSeal = $('#bSeal');
const bStyle = $('#bStyle'), bPlay = $('#bPlay'), strip = $('#strip'), stripLabel = $('#stripLabel'), sheet = $('.sheet');
const guide = $('#guide'), glyph = $('#glyph'), sizeDot = $('#sizeDot'), toneDot = $('#toneDot');

/* Ghost character, laid out exactly like the fitting targets: em size 0.9 of the box, ink box centred. */
function drawGhost(){
  const st = STYLES[styleKey], ch = GLYPHS[glyphIdx];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = sheet.clientWidth, px = Math.round(size * dpr);
  if (!px) return;
  const draw = () => {
    glyph.width = px; glyph.height = px;
    const c = glyph.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, size, size);
    c.font = `${Math.floor(size * 0.9)}px "${st.font}", "Hiragino Mincho ProN", serif`;
    c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    const m = c.measureText(ch);
    const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    c.fillStyle = 'rgba(38,34,28,0.085)';
    c.fillText(ch, (size - w) / 2 + m.actualBoundingBoxLeft, (size - h) / 2 + m.actualBoundingBoxAscent);
  };
  draw();
  document.fonts.load(`40px "${st.font}"`, ch).then(draw, () => {});
}
function updatePractice(){
  const st = STYLES[styleKey];
  stripLabel.textContent = `${st.label} · ${GLYPHS[glyphIdx]}`;
  bGuide.querySelector('.g').textContent = GLYPHS[glyphIdx];
  $('#styleGlyph').textContent = st.short;
  bStyle.setAttribute('aria-label', `Brush style: ${st.label}`);
  if (guide.classList.contains('on')) drawGhost();
}
bGuide.addEventListener('click', () => {
  const on = bGuide.getAttribute('aria-pressed') !== 'true';
  bGuide.setAttribute('aria-pressed', String(on));
  guide.classList.toggle('on', on);
  strip.hidden = !on;
  if (on) updatePractice();
});
bNext.addEventListener('click', () => {
  glyphIdx = (glyphIdx + 1) % GLYPHS.length;
  updatePractice();
});
bStyle.addEventListener('click', () => {
  drawDabs();
  styleKey = STYLE_KEYS[(STYLE_KEYS.indexOf(styleKey) + 1) % STYLE_KEYS.length];
  updatePractice();
});
/* Replay: the fitted sweep for this character goes through the same brush you draw with.
   The free brush replays the Yuji Syuku sweeps with the original round footprint, for comparison. */
let replay = null;
function startReplay(){
  if (S.down) return;
  const src = (window.SUMI && SUMI.sweeps[styleKey]) ? styleKey : 'syuku';
  const sw = window.SUMI && SUMI.sweeps[src] && SUMI.sweeps[src][GLYPHS[glyphIdx]];
  if (!sw) { showHint('No recorded sweep for this character yet.'); return; }
  const r = sheet.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
  const cur = STYLES[styleKey];
  const style = Object.assign({}, STYLES[src], styleKey === src ? {} :
    {theta: cur.theta, kL: cur.kL, ratio: cur.ratio, follow: cur.follow, edge: cur.edge});
  drawDabs();
  pushUndo({kind:'stroke', t: takeSnap()});
  replay = {recs: sweepToDabs(sw, style, {x: r.left - cr.left, y: r.top - cr.top, size: r.width}, V.sim), i: 0, t0: performance.now(), style};
  hideHint();
}
bPlay.addEventListener('click', startReplay);
window.addEventListener('resize', () => { if (guide.classList.contains('on')) drawGhost(); });
bSize.addEventListener('click', () => {
  drawDabs();
  sizeIdx = (sizeIdx + 1) % SIZES.length;
  V.baseR = Math.max(2.5, SIZES[sizeIdx] * V.minDim);
  sizeDot.setAttribute('r', SIZE_DOT[sizeIdx]);
  bSize.setAttribute('aria-label', `Brush size: ${SIZE_NAMES[sizeIdx]}`);
});
bTone.addEventListener('click', () => {
  drawDabs();
  toneKey = toneKey === 'dark' ? 'light' : 'dark';
  toneDot.setAttribute('fill-opacity', toneKey === 'dark' ? '1' : '0.28');
  bTone.setAttribute('aria-label', `Ink: ${toneKey}`);
});
function setSealMode(on){
  sealMode = on;
  bSeal.setAttribute('aria-pressed', String(on));
  canvas.style.cursor = on ? 'copy' : 'crosshair';
  if (on) showHint('Tap the paper where the seal should go.');
  else hideHint();
}
bSeal.addEventListener('click', () => setSealMode(!sealMode));
bUndo.addEventListener('click', doUndo);
$('#bClear').addEventListener('click', newSheet);
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z'){ e.preventDefault(); doUndo(); }
  if (e.key === 'Escape' && sealMode) setSealMode(false);
});

/* ---------- loop ---------- */
function frame(now){
  requestAnimationFrame(frame);
  if (harnessBusy) return;
  if (replay){
    const el = now - replay.t0, pig = TONES[toneKey].pig, ts = replay.style.texScale * V.sim;
    while (replay.i < replay.recs.length && replay.recs[replay.i].t <= el){ pushInst(packDab(replay.recs[replay.i], V, pig, replay.style, ts)); replay.i++; }
    if (replay.i >= replay.recs.length) replay = null;
  }
  if (S.down && now - S.lastT > 12) advance(now);
  drawDabs();
  if (now < simUntil){ for (let i = 0; i < 3; i++) simStep(); dirty = true; }
  if (dirty){ composite(); dirty = false; }
}
/* ---------- harness (?harness) ----------
   Used by tools/contact-sheet.html: replays a sweep on a fixed 60 fps clock, lets the paper
   dry for the same 9 s the live loop simulates, then reads the composited frame back. */
let harnessBusy = false;
// rAF stalls in background tabs; a message-channel hop yields without being throttled
const yieldTask = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
async function harnessRender(key, ch, opt = {}){
  harnessBusy = true;
  try {
    replay = null; dabCount = 0;
    clearTarget(cur); clearTarget(nxt);
    seals = []; drawSeals();
    const r = sheet.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    const box = {x: r.left - cr.left, y: r.top - cr.top, size: r.width};
    const style = Object.assign({}, STYLES[key], opt.style), sweep = opt.sweep || SUMI.sweeps[key][ch];
    const recs = sweepToDabs(sweep, style, box, V.sim);
    const pig = TONES[toneKey].pig, ts = style.texScale * V.sim, FRAME = 1000 / 60;
    const end = (recs.length ? recs[recs.length - 1].t : 0) + (opt.dry ?? 9000);
    let i = 0, n = 0;
    for (let t = 0; t <= end; t += FRAME, n++){
      while (i < recs.length && recs[i].t <= t) pushInst(packDab(recs[i++], V, pig, style, ts));
      drawDabs();
      for (let k = 0; k < 3; k++) simStep();
      if (n % 60 === 59){ gl.finish(); await yieldTask(); }
    }
    composite();
    const px = new Uint8Array(V.dW * V.dH * 4);
    gl.readPixels(0, 0, V.dW, V.dH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const res = {box, dpr: V.dpr, w: V.dW, h: V.dH, px, font: style.font};
    if (opt.state){
      const read = t => { const a = new Float32Array(V.sW * V.sH * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, t.f); gl.readPixels(0, 0, V.sW, V.sH, gl.RGBA, gl.FLOAT, a); return a; };
      Object.assign(res, {sim: V.sim, sW: V.sW, sH: V.sH, state: read(cur)});
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return res;
  } finally {
    harnessBusy = false; dirty = true;
  }
}
if (/[?&]harness\b/.test(location.search)) window.__sumi = {glyphs: GLYPHS, render: harnessRender};

resize();
requestAnimationFrame(frame);
})();
