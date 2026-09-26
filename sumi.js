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
const VS_DAB = `#version 300 es
layout(location=0) in vec4 aA; // x, y, r (sim px), angle
layout(location=1) in vec4 aB; // stroke distance, ink load, pigment amount, seed
layout(location=2) in vec4 aC; // pressure, kind (0 body, 1 stray hair), hair lane, unused
uniform vec2 uRes;
out vec2 vLocal; out vec4 vB; out vec4 vC; out float vR;
const vec2 Q[6] = vec2[6](vec2(-1,-1),vec2(1,-1),vec2(1,1),vec2(-1,-1),vec2(1,1),vec2(-1,1));
void main(){
  vec2 q = Q[gl_VertexID]*1.06;
  float c = cos(aA.w), s = sin(aA.w);
  vec2 w = aA.xy + aA.z*vec2(c*q.x - s*q.y, s*q.x + c*q.y);
  vLocal = q; vB = aB; vC = aC; vR = aA.z;
  gl_Position = vec4(w/uRes*2.-1., 0., 1.);
}`;
// Texture-driven deposit: R = bristle height field ("dry map"), G = tuft clump field ("split map")
const FS_DAB = HEAD + NOISE + `
in vec2 vLocal; in vec4 vB; in vec4 vC; in float vR; out vec4 o;
uniform float uWater, uBaseR; uniform vec2 uSimRes;
uniform sampler2D uBristle, uPaper;
void main(){
  float r = length(vLocal);
  float sPix = vB.x + vLocal.x*vR;
  float load = vB.y;
  float dryness = clamp(1.-load, 0., 1.);
  float press = vC.x;
  float along = sPix/(uBaseR*60.) + vB.w*0.37;

  // Paper tooth: a dry, lightly pressed brush only touches the grain peaks
  float grain = clamp((texture(uPaper, gl_FragCoord.xy/uSimRes).r - 0.28)/0.44, 0., 1.);
  float gThr = smoothstep(0.35, 1.0, dryness)*clamp(1.35 - 0.6*press, 0.15, 1.);
  float tooth = smoothstep(gThr - 0.12, gThr + 0.04, grain);

  if (vC.y > 0.5){
    // Stray hair: one thin bristle, broken along its length by its own texture column
    float m = 1. - smoothstep(0.35, 1.0, r);
    if (m <= 0.001) discard;
    float brk = texture(uBristle, vec2(vC.z, along*1.7)).r;
    m *= smoothstep(0.12, 0.28, brk)*mix(1., tooth, 0.7);
    o = vec4(m*vB.z, 0., 0., m*uWater*0.3);
    return;
  }

  float u = vLocal.y;
  float edgeN = vnoise(vec2(u*6. + vB.w, sPix*0.05));
  float mask = 1. - smoothstep(0.62, 1.0, r + (edgeN-0.5)*0.18);
  if (mask <= 0.001) discard;
  vec4 br = texture(uBristle, vec2(u*0.5 + 0.5, along));

  // Dry map threshold: moisture raises it, pressure lowers it, edges dry first
  float thr = -0.15 + 1.05*smoothstep(0.12, 0.95, dryness);
  thr -= clamp(press - 0.85, -0.45, 0.8)*0.4*(0.4 + dryness);
  thr += smoothstep(0.55, 1., abs(u))*dryness*0.35;
  float streak = smoothstep(thr - 0.05, thr + 0.05, br.r);

  // Split map: tufts separate as the brush dries or is pressed flat
  float sThr = dryness*0.5 + max(press - 1.1, 0.)*0.3 - 0.12;
  float split = smoothstep(sThr - 0.1, sThr + 0.1, br.g);

  float m = streak*split*tooth;
  float fine = 0.8 + 0.2*br.r;
  o = vec4(mask*m*fine*vB.z, 0., 0., mask*mix(1., m, 0.85)*uWater*mix(0.3, 1., load));
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
  vec3 col = paper*exp(-od*3.2*vec3(1.06, 1.0, 0.9));

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
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 48, 0); gl.vertexAttribDivisor(0, 1);
gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 48, 16); gl.vertexAttribDivisor(1, 1);
gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 48, 32); gl.vertexAttribDivisor(2, 1);
gl.bindVertexArray(null);
const DAB_F = 12;
let dabData = new Float32Array(DAB_F * 4096), dabCount = 0;
function pushDab(a, b, c, d, e, f, g, h, i, j, k){
  if ((dabCount + 1) * DAB_F > dabData.length){ const n = new Float32Array(dabData.length * 2); n.set(dabData); dabData = n; }
  const o = dabCount * DAB_F;
  dabData[o]=a; dabData[o+1]=b; dabData[o+2]=c; dabData[o+3]=d;
  dabData[o+4]=e; dabData[o+5]=f; dabData[o+6]=g; dabData[o+7]=h;
  dabData[o+8]=i; dabData[o+9]=j; dabData[o+10]=k; dabData[o+11]=0;
  dabCount++;
}

/* ---------- state ---------- */
const TONES = { dark:{pig:1.0, water:0.85, decay:1.0}, light:{pig:0.24, water:1.25, decay:0.8} };
let toneKey = 'dark';
const SIZES = [0.012, 0.02, 0.032], SIZE_NAMES = ['fine','medium','bold'], SIZE_DOT = [3, 5, 7.5];
let sizeIdx = 1;
const GLYPHS = ['永','心','道','風','夢','和','山','花','書','愛'];
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
  gl.uniform1f(P.dab.u.uBaseR, V.baseR * V.sim);
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

/* ---------- brush physics ---------- */
function radiusTarget(){
  const spF = clamp(1.25 - 0.36 * S.speed, 0.36, 1.25);
  const prF = S.pen ? 0.3 + 1.2 * clamp(S.pr, 0, 1) : 1;
  return V.baseR * spF * prF * (1 + 0.45 * S.dwell) * (0.8 + 0.2 * S.load);
}
function emitDab(x, y, r, ang, s, load, spacing, kind = 0, lane = 0, amt = 1, press = -1){
  const k = V.sim, t = TONES[toneKey];
  const rr = Math.max(r, 0.35);
  const pr = press >= 0 ? press : clamp(rr / V.baseR, 0.2, 2);
  const amount = amt * t.pig * (0.55 + 0.45 * load) * (1 - Math.min(0.35, S.speed * 0.12)) * spacing / (1.7 * rr);
  pushDab(x * k, (V.cssH - y) * k, Math.max(rr * k, 0.8), -ang, s * k, load, amount, S.seed, pr, kind, lane);
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
const guide = $('#guide'), glyph = $('#glyph'), sizeDot = $('#sizeDot'), toneDot = $('#toneDot');

bGuide.addEventListener('click', () => {
  const on = bGuide.getAttribute('aria-pressed') !== 'true';
  bGuide.setAttribute('aria-pressed', String(on));
  guide.classList.toggle('on', on);
  bNext.hidden = !on;
});
bNext.addEventListener('click', () => {
  glyphIdx = (glyphIdx + 1) % GLYPHS.length;
  glyph.textContent = GLYPHS[glyphIdx];
  bGuide.querySelector('.g').textContent = GLYPHS[glyphIdx];
});
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
  if (S.down && now - S.lastT > 12) advance(now);
  drawDabs();
  if (now < simUntil){ for (let i = 0; i < 3; i++) simStep(); dirty = true; }
  if (dirty){ composite(); dirty = false; }
}
resize();
requestAnimationFrame(frame);
})();
