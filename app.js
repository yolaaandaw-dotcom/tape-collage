'use strict';
// Tape Collage — clear tape lifts the ink off a magazine page, and the strips pile up on the board.
// Everything is DOM + CSS; the sounds are Web Audio synthesis (no files).

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const uid = () => Math.random().toString(36).slice(2, 10);
const DEG = Math.PI / 180;
function srand(seed) { let s = (seed >>> 0) || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const div = cls => { const d = document.createElement('div'); d.className = cls; return d; };
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

const SW = 400;                 // every magazine page is laid out 400px wide in the tray
const HOVER = 6;                // px the near end lifts when you hover a tape
const MAX_L = 760;

const boardEl = $('#board'), trayEl = $('#tray'), floatLayer = $('#float-layer'), ctxEl = $('#ctx');
// magazine pages are laid out 400px wide and zoomed down to fit a narrow tray; k converts client px -> page px
let SRC_ZOOM = 1;
const kOf = cont => cont.classList.contains('src') ? SRC_ZOOM : 1;
function fitTray() { SRC_ZOOM = clamp((trayEl.clientWidth - 16) / SW, .35, 1); trayEl.style.setProperty('--src-zoom', SRC_ZOOM); }
addEventListener('resize', fitTray);

const state = { sources: [], tapes: [], scars: [], zTop: 1, sound: true, width: 76, ink: 25, tut: false };
const SRC_URL = {};             // source id -> displayable url (object url / http url / data url)
const MASKS = {};               // layer/scar id -> canvas with the mask (for combining layers + export)
let undoStack = [];

// ---------- textures (generated once) ----------
function makeNoise(size, alpha) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const d = g.createImageData(size, size);
  for (let i = 0; i < d.data.length; i += 4) { const v = 150 + Math.random() * 105; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = Math.random() * alpha * 255; }
  g.putImageData(d, 0, 0); return c.toDataURL();
}
function makeFiber() {           // the torn paper surface: pale fibres, a few darker flecks
  const c = document.createElement('canvas'); c.width = c.height = 220; const g = c.getContext('2d');
  g.fillStyle = '#f4f0e7'; g.fillRect(0, 0, 220, 220);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 220, y = Math.random() * 220, a = Math.random() * Math.PI, l = 2 + Math.random() * 9;
    g.strokeStyle = `rgba(${Math.random() < .5 ? '255,255,255' : '190,182,165'},${.25 + Math.random() * .5})`; g.lineWidth = .4 + Math.random() * .8;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(120,110,95,${Math.random() * .25})`; g.beginPath(); g.arc(Math.random() * 220, Math.random() * 220, Math.random() * 1.2, 0, 7); g.fill(); }
  return c.toDataURL();
}
document.documentElement.style.setProperty('--fiber', `url(${makeFiber()})`);
document.documentElement.style.setProperty('--paper-noise', `url(${makeNoise(160, .09)})`);
document.documentElement.style.setProperty('--desk-noise', `url(${makeNoise(120, .12)})`);

// ---------- the ink mask: how much ink the tape actually lifted at each point ----------
// Continuous alpha (not hard holes): blotches + streaks along the tape + feathered edges,
// so the strip's boundary stays soft. Where this tape already carries ink, the glue is
// covered, so a later press picks up much less.
function noiseLayer(w, h, rng) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  const d = g.createImageData(w, h);
  for (let i = 0; i < d.data.length; i += 4) { const v = rng() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  g.putImageData(d, 0, 0); return c;
}
function scaled(src, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}
function makeMask(L, W, seed, olds = [], amount = .35, rub = null) {   // amount: base pressure 0..1; rub: per-pixel extra pressure (alpha bytes, same size)
  const rng = srand(seed); amount = clamp(amount, 0, 1);
  const w = clamp(Math.round(L), 8, 1024), h = clamp(Math.round(W), 4, 128);
  const blob = scaled(noiseLayer(Math.ceil(w / 16) + 2, Math.ceil(h / 9) + 2, rng), w, h);
  const fine = scaled(noiseLayer(Math.ceil(w / 4) + 2, Math.ceil(h / 4) + 2, rng), w, h);
  const streak = scaled(noiseLayer(Math.ceil(w / 22) + 2, Math.ceil(h / 2.6) + 2, rng), w, h);
  const oldA = olds.map(c => scaled(c, w, h));
  const scratches = [];                                        // thin scrapes along the tape where the ink got dragged off
  for (let i = 0; i < Math.round(h / 12) + 1; i++) scratches.push({ y: rng() * h, t: .5 + rng() * 1.2, x0: rng() * w * .6, x1: w * (.4 + rng() * .6), k: .55 + rng() * .3 });
  const b0 = .46 + rng() * .06, g0 = 1.2 + rng() * .4;
  const rubS = rub ? blurAlpha(rub, w, h, 6) : null;                            // the scraped map, softened: pressure fades out around a stroke
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  const out = g.createImageData(w, h), o = out.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let v = blob[i] / 255 * .5 + fine[i] / 255 * .25 + streak[i] / 255 * .25;
    const amt = rubS ? amount + (1 - amount) * rubS[y * w + x] / 255 : amount;   // pressure here: base + what you scraped
    const bias = b0 - amt * .4, gain = g0 + amt * 2.6, fy = h * (.34 - amt * .26), fx = 8 + (1 - amt) * 34;
    let a = clamp((v - bias) * gain, 0, 1); a = a * (.6 + .4 * a);
    const ey = smooth(Math.min(y + .5, h - y - .5) / fy), ex = smooth(Math.min(x + .5, w - x - .5) / fx);
    a *= ey * ex;
    for (const s of scratches) if (x > s.x0 && x < s.x1 && Math.abs(y - s.y) < s.t) a *= s.k;
    for (const od of oldA) a *= 1 - .74 * od[i + 3] / 255;
    o[i] = o[i + 1] = o[i + 2] = 0; o[i + 3] = a * 255;
  }
  g.putImageData(out, 0, 0);
  return c;
}
function blurAlpha(rgba, w, h, r) {        // alpha channel -> separable box blur, radius r px
  const a = new Float32Array(w * h), t = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = rgba[i * 4 + 3];
  for (let y = 0; y < h; y++) { let acc = 0; for (let x = -r; x < w; x++) { if (x + r < w) acc += a[y * w + x + r]; if (x - r - 1 >= 0) acc -= a[y * w + x - r - 1]; if (x >= 0) t[y * w + x] = acc / (2 * r + 1); } }
  for (let x = 0; x < w; x++) { let acc = 0; for (let y = -r; y < h; y++) { if (y + r < h) acc += t[(y + r) * w + x]; if (y - r - 1 >= 0) acc -= t[(y - r - 1) * w + x]; if (y >= 0) a[y * w + x] = acc / (2 * r + 1); } }
  return a;
}
function maskFromDataURL(id, url) {        // rebuild the runtime canvas for a stored mask (async, best effort)
  if (MASKS[id]) return;
  const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0); MASKS[id] = c; }; im.src = url;
}

// ---------- sound (synthesised, no files) ----------
let actx;
const ac = () => { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); return actx; };
let NZ = null;
const noiseBuf = c => { if (!NZ) { NZ = c.createBuffer(1, c.sampleRate, c.sampleRate); const d = NZ.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; } return NZ; };
function envTo(c, node, t, peak, dur, attack = .002) {
  const g = c.createGain(); g.gain.setValueAtTime(.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(.0002, peak), t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  node.connect(g).connect(c.destination); return g;
}
function nz(c, t, dur, type, f, q, peak, attack) {
  const s = c.createBufferSource(); s.buffer = noiseBuf(c);
  const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q || 1;
  s.connect(fl); envTo(c, fl, t, peak, dur, attack); s.start(t, Math.random() * .9); s.stop(t + dur + .02); return fl;
}
function tone(c, t, type, f0, f1, dur, peak) {
  const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  envTo(c, o, t, peak, dur); o.start(t); o.stop(t + dur + .02); return o;
}
const crackle = (c, t, v) => nz(c, t, .022, 'bandpass', rand(2400, 8500), 12, .08 + v * .5);
const suck = (c, t, v) => { tone(c, t, 'sine', rand(150, 240), 70, .05, .05 + v * .18); nz(c, t, .04, 'lowpass', 1100, .9, .03 + v * .14, .004); };
function sPress(big = 1) {                       // the strip pressed flat
  if (!state.sound) return; const c = ac(), t = c.currentTime;
  tone(c, t, 'sine', 160 * big, 55, .08, .16);
  const f = nz(c, t, .3, 'lowpass', 4200, .7, .15, .05); f.frequency.setValueAtTime(4200, t + .02); f.frequency.exponentialRampToValueAtTime(450, t + .28);
  suck(c, t + .09, .5);
}
function sCut() {                                // torn off the roll across the teeth
  if (!state.sound) return; const c = ac(), t = c.currentTime;
  const f = nz(c, t, .075, 'highpass', 3200, .8, .32, .003); f.frequency.exponentialRampToValueAtTime(900, t + .07);
  nz(c, t + .005, .04, 'bandpass', rand(1800, 2800), 3, .22);
  for (let i = 0; i < 3; i++) crackle(c, t + i * .012, .6);
}
function sDetach() {                             // the last of the glue lets go
  if (!state.sound) return; const c = ac(), t = c.currentTime;
  const f = nz(c, t, .13, 'bandpass', 5200, 1.1, .4); f.frequency.exponentialRampToValueAtTime(1100, t + .12);
  tone(c, t, 'sine', 230, 85, .07, .2);
  for (let i = 0; i < 4; i++) crackle(c, t + i * .014, .8);
}
let rubSnd = null;
function rubSoundStart() {
  if (!state.sound) return; const c = ac();
  const src = c.createBufferSource(); src.buffer = noiseBuf(c); src.loop = true;
  const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = .9; f.frequency.value = 900;
  const g = c.createGain(); g.gain.value = 0; src.connect(f).connect(g).connect(c.destination); src.start();
  rubSnd = { c, src, f, g };
}
function rubSoundUpdate(speed) {
  if (!rubSnd) return; const { c, f, g } = rubSnd, t = c.currentTime, v = clamp(speed / 10, 0, 1);
  g.gain.setTargetAtTime(v * .16, t, .04); f.frequency.setTargetAtTime(700 + 1800 * v, t, .06);
  if (v > .1 && Math.random() < v * .5) nz(c, t, .03, 'bandpass', rand(1200, 3000), 3, .04 + v * .1, .005);
}
function rubSoundStop() { if (!rubSnd) return; const { c, g, src } = rubSnd; g.gain.setTargetAtTime(0, c.currentTime, .05); setTimeout(() => { try { src.stop(); } catch (e) {} }, 200); rubSnd = null; }
function sRub() { if (!state.sound) return; const c = ac(), t = c.currentTime; const f = nz(c, t, .16, 'bandpass', 1500, .8, .22, .03); f.frequency.exponentialRampToValueAtTime(3200, t + .14); tone(c, t, 'sine', 140, 70, .06, .08); }
function sFlapBack() { if (!state.sound) return; const c = ac(), t = c.currentTime; nz(c, t, .06, 'lowpass', 1800, .7, .16); suck(c, t, .3); }
function sTick() { if (!state.sound) return; const c = ac(), t = c.currentTime; nz(c, t, .012, 'highpass', 5000, .7, .08); }
function sFlip() { if (!state.sound) return; const c = ac(), t = c.currentTime; for (let i = 0; i < 3; i++) crackle(c, t + i * .02, .5); nz(c, t + .05, .05, 'lowpass', 2500, .7, .12); }
function sCrumple() { if (!state.sound) return; const c = ac(), t = c.currentTime; for (let i = 0; i < 9; i++) crackle(c, t + i * rand(.02, .045), .5 + rand(0, .5)); nz(c, t + .2, .12, 'lowpass', 900, .7, .18, .02); }
// pulling tape off the roll: a buzzy hiss whose pitch and rate follow the speed
let pull = null;
function pullStart() {
  if (!state.sound) return; const c = ac();
  const src = c.createBufferSource(); src.buffer = noiseBuf(c); src.loop = true;
  const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.3; f.frequency.value = 1800;
  const g = c.createGain(); g.gain.value = 0; src.connect(f).connect(g).connect(c.destination); src.start();
  pull = { c, src, f, g };
}
function pullUpdate(speed) {
  if (!pull) return; const { c, f, g } = pull, t = c.currentTime, v = clamp(speed / 9, 0, 1);
  g.gain.setTargetAtTime(v * .2, t, .03); f.frequency.setTargetAtTime(1800 + 2600 * v, t, .05);
  if (v > .05 && Math.random() < v * 1.7) nz(c, t, .008, 'highpass', rand(3000, 7000), .8, .04 + v * .16);
}
function pullStop() { if (!pull) return; const { c, g, src } = pull; g.gain.setTargetAtTime(0, c.currentTime, .03); setTimeout(() => { try { src.stop(); } catch (e) {} }, 160); pull = null; }
// peeling: a zippy hiss + crackles, bursts when the glue slips
let peelSnd = null;
function peelSoundStart() {
  if (!state.sound) return; const c = ac();
  const src = c.createBufferSource(); src.buffer = noiseBuf(c); src.loop = true;
  const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2; f.frequency.value = 900;
  const g = c.createGain(); g.gain.value = 0; src.connect(f).connect(g).connect(c.destination); src.start();
  peelSnd = { c, src, f, g };
}
function peelSoundUpdate(speed) {
  if (!peelSnd) return; const { c, f, g } = peelSnd, t = c.currentTime, v = clamp(speed / 6, 0, 1);
  g.gain.setTargetAtTime(v * .3, t, .03); f.frequency.setTargetAtTime(900 + 3000 * v, t, .05);
  if (v > .04 && Math.random() < v * 2.2) crackle(c, t, v);
}
function peelSlip(amount) { if (!peelSnd) return; const { c } = peelSnd, t = c.currentTime; const n = 1 + Math.min(3, Math.floor(amount / 6)); for (let i = 0; i < n; i++) crackle(c, t + i * rand(.006, .02), clamp(amount / 14, .3, 1)); }
function peelSoundStop() { if (!peelSnd) return; const { c, g, src } = peelSnd; g.gain.setTargetAtTime(0, c.currentTime, .03); setTimeout(() => { try { src.stop(); } catch (e) {} }, 160); peelSnd = null; }

// ---------- geometry ----------
// A tape is anchored at the centre of its start end (item.x, item.y) and rotated by item.th.
// Local coords: lx along the strip (0..L), ly across it (-W/2..W/2).
function toLocal(item, wx, wy) { const c = Math.cos(item.th * DEG), s = Math.sin(item.th * DEG); const dx = wx - item.x, dy = wy - item.y; return { lx: c * dx + s * dy, ly: -s * dx + c * dy }; }
function toWorld(item, lx, ly) { const c = Math.cos(item.th * DEG), s = Math.sin(item.th * DEG); return { x: item.x + c * lx - s * ly, y: item.y + s * lx + c * ly }; }
function rotateAboutCenter(item, deg) {
  const c0 = toWorld(item, item.L / 2, 0); item.th += deg;
  const c1 = toWorld(item, item.L / 2, 0); item.x += c0.x - c1.x; item.y += c0.y - c1.y;
}
function tapeStyle(el, item) {
  el.style.width = item.L + 'px'; el.style.height = item.W + 'px'; el.style.top = (-item.W / 2) + 'px';
  el.style.transform = `translate(${item.x}px, ${item.y}px) rotate(${item.th}deg)`; el.style.zIndex = item.z;
}
function teeth(item) {           // the serrated ends from a dispenser, slightly slanted
  const rng = srand(item.seed ^ 0x5bd1e995), n = Math.max(4, Math.round(item.W / 4.5)), amp = 2.4;
  const sl = rng() * 5 - 2.5, sr = rng() * 5 - 2.5, left = [], right = [];
  for (let i = 0; i <= n; i++) { const t = i / n; left.push(3.5 + (i % 2 ? amp : 0) + rng() * .9 + sl * t); right.push(3.5 + (i % 2 ? amp : 0) + rng() * .9 + sr * t); }
  return { n, left, right };
}
function serrationCSS(item) {
  const { n, left, right } = teeth(item), pts = [];
  for (let i = 0; i <= n; i++) pts.push(`${left[i].toFixed(2)}px ${(i / n * 100).toFixed(2)}%`);
  for (let i = n; i >= 0; i--) pts.push(`calc(100% - ${right[i].toFixed(2)}px) ${(i / n * 100).toFixed(2)}%`);
  return `polygon(${pts.join(',')})`;
}
function serrationPoly(item) {   // the same outline in px, for export
  const { n, left, right } = teeth(item), pts = [];
  for (let i = 0; i <= n; i++) pts.push([left[i], i / n * item.W]);
  for (let i = n; i >= 0; i--) pts.push([item.L - right[i], i / n * item.W]);
  return pts;
}

// ---------- tape elements ----------
function srcOf(id) { return state.sources.find(s => s.id === id); }
function srcEl(id) { return trayEl.querySelector(`.src[data-id="${id}"]`); }
function containerOf(item) { return item.on === 'src' ? srcEl(item.srcId) : boardEl; }
function layerOf(item) { return item.on === 'src' ? srcEl(item.srcId).querySelector('.tapes') : boardEl; }

function makeScarEl(sc) {
  const el = div('scar'); el.dataset.id = sc.id;
  el.style.width = sc.L + 'px'; el.style.height = sc.W + 'px'; el.style.top = (-sc.W / 2) + 'px';
  el.style.transform = `translate(${sc.x}px, ${sc.y}px) rotate(${sc.th}deg)`;
  el.style.webkitMaskImage = el.style.maskImage = `url(${sc.mask})`;
  return el;
}
function renderInks(el, item) {
  for (const box of el.querySelectorAll('.tp-inks')) {
    box.innerHTML = '';
    item.inks.forEach((ly, i) => {
      const ink = div('tp-ink'); ink.style.zIndex = item.inks.length - i;      // the first ink sits on the glue, so it is in front
      ink.style.webkitMaskImage = ink.style.maskImage = `url(${ly.mask})`;
      const img = div('tp-img'); img.style.width = ly.sw + 'px'; img.style.height = ly.sh + 'px';
      img.style.backgroundImage = `url("${SRC_URL[ly.srcId] || ''}")`; img.style.backgroundSize = `${ly.sw}px ${ly.sh}px`;
      img.style.transform = `rotate(${-ly.th}deg) translate(${-ly.ax}px, ${-ly.ay}px)`;
      ink.append(img); box.append(ink);
    });
  }
}
function decorate(el, item) {    // creases and trapped air, fixed per tape
  const rng = srand(item.seed ^ 0x9e3779b9), bg = [];
  const nc = Math.floor(rng() * 3);
  for (let i = 0; i < nc; i++) { const a = 15 + rng() * 60 + (rng() < .5 ? 90 : 0), p = 10 + rng() * 80; bg.push(`linear-gradient(${a.toFixed(0)}deg, transparent calc(${p}% - 1.2px), rgba(255,255,255,.32) ${p}%, rgba(0,0,0,.05) calc(${p}% + 1px), transparent calc(${p}% + 2.2px))`); }
  const nb = Math.floor(rng() * 3);
  for (let i = 0; i < nb; i++) { const x = rng() * 100, y = 20 + rng() * 60, w = 6 + rng() * 14, h = 2 + rng() * 4; bg.push(`radial-gradient(ellipse ${w.toFixed(0)}px ${h.toFixed(0)}px at ${x.toFixed(0)}% ${y.toFixed(0)}%, rgba(255,255,255,.22), rgba(255,255,255,.06) 55%, rgba(0,0,0,.03) 70%, transparent 75%)`); }
  for (const w of el.querySelectorAll('.tp-wrinkle')) w.style.backgroundImage = bg.join(',');
}
// ---------- scraping: the air under a stuck strip, rubbed out with a fingernail ----------
// A canvas the size of the strip starts milky (air, unpressed); scraping erases it. At peel
// time its remaining alpha says where the strip was never pressed, so little ink comes off there.
const RUBS = {};
const RUB_MILK = .3;
function rubCanvas(item) {
  if (RUBS[item.id]) return RUBS[item.id];
  const c = document.createElement('canvas'); c.width = Math.max(8, Math.round(item.L)); c.height = Math.max(4, Math.round(item.W));
  const g = c.getContext('2d'); g.fillStyle = `rgba(255,255,255,${RUB_MILK})`; g.fillRect(0, 0, c.width, c.height);
  if (item.rub) { const im = new Image(); im.onload = () => { g.clearRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0); }; im.src = item.rub; }
  return RUBS[item.id] = c;
}
function rubMap(item) {           // extra pressure 0..255 per pixel, from how much milk is left
  const c = RUBS[item.id]; if (!c) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) d[i] = 255 - clamp(d[i] / (RUB_MILK * 255), 0, 1) * 255;
  return d;
}
function punchScars(maskC, item) {   // subtract this page's existing scars from a strip's ink mask (box coords)
  const g = maskC.getContext('2d'); g.save(); g.globalCompositeOperation = 'destination-out'; g.globalAlpha = .94;
  for (const sc of state.scars) {
    if (sc.srcId !== item.srcId) continue;
    const m = MASKS[sc.id.startsWith('s') ? sc.id.slice(1) : sc.id]; if (!m) continue;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.translate(0, item.W / 2); g.rotate(-item.th * DEG); g.translate(-item.x, -item.y);      // page -> this strip's box
    g.translate(sc.x, sc.y); g.rotate(sc.th * DEG); g.translate(0, -sc.W / 2);                // scar -> page
    g.drawImage(m, 0, 0, sc.L, sc.W);
  }
  g.restore();
}
function rubStroke(item, x0, y0, x1, y1, speed) {   // soft stamps along the stroke: a wide faint pad, a narrow firmer nail
  const g = rubCanvas(item).getContext('2d'); g.globalCompositeOperation = 'destination-out';
  const v = clamp(speed / 12, .3, 1), d = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(d / 3));
  const rp = item.W * .6, rn = item.W * .22;
  for (let i = 0; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
    let gr = g.createRadialGradient(x, y, 0, x, y, rp); gr.addColorStop(0, `rgba(0,0,0,${.045 * v})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - rp, y - rp, rp * 2, rp * 2);
    gr = g.createRadialGradient(x, y, 0, x, y, rn); gr.addColorStop(0, `rgba(0,0,0,${.16 * v})`); gr.addColorStop(.5, `rgba(0,0,0,${.09 * v})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - rn, y - rn, rn * 2, rn * 2);
  }
  g.globalCompositeOperation = 'source-over';
}
function attachRub(el, item) {    // show the milk layer on a strip that sits on a magazine page
  let c = el.querySelector('.tp-rubc'); if (c) return;
  c = rubCanvas(item); c.className = 'tp-rubc'; el.querySelector('.tp-body .tp-film').after(c);
}
function detachRub(el, item) { const c = el.querySelector('.tp-rubc'); if (c) c.remove(); delete RUBS[item.id]; item.rub = undefined; }
function makeTapeEl(item) {
  const el = div('tape'); el.dataset.id = item.id;
  el.innerHTML = '<div class="tp-serr"><div class="tp-body"><div class="tp-inks"></div><div class="tp-film"></div><div class="tp-wrinkle"></div><div class="tp-gloss"></div></div>'
    + '<div class="tp-flap"><div class="tp-flapin"><div class="tp-inks"></div><div class="tp-film back"></div><div class="tp-gloss"></div></div></div></div>';
  el.querySelector('.tp-serr').style.clipPath = serrationCSS(item);
  renderInks(el, item); decorate(el, item); tapeStyle(el, item); el.classList.toggle('flipped', !!item.flipped);
  el._item = item;
  return el;
}
function bindTape(el, item) {
  el._item = item;
  el.addEventListener('pointerdown', e => onTapeDown(e, el, item));
  el.addEventListener('pointermove', e => { if (!drag && !peel && !lay && !rub) hoverLift(e, el, item); });
  el.addEventListener('pointerleave', () => { if (!peel && el._hover) { el._hover = false; setPeel(el, item, { x: 0, y: 0 }, [1, 0], 0); } });
  el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, el, item); });
  el.addEventListener('dblclick', e => { e.stopPropagation(); flipTape(el, item); });
  el.addEventListener('wheel', e => {
    if (item.on !== 'board' || drag || peel || lay) return;
    e.preventDefault(); e.stopPropagation();
    rotateAboutCenter(item, wheelDeg(e));
    el.style.transition = 'transform .08s'; tapeStyle(el, item); setTimeout(() => el.style.transition = '', 100);
    lastTape = { el, item }; save();
  }, { passive: false });
}
function placeTape(item, el) { el = el || makeTapeEl(item); tapeStyle(el, item); bindTape(el, item); layerOf(item).append(el); if (item.on === 'src') attachRub(el, item); return el; }

// ---------- the fold: body / lifted flap split by a fold line that follows your pull ----------
// Box coords: bx along the strip (0..L), by across it (0..W). The fold starts at the corner you
// grabbed and advances along u (unit vector); the fold line is perpendicular to u.
const LBIG = 4000;
function nearestCorner(item, bx, by) { let best = null, bd = 1e9; for (const c of [{ x: 0, y: 0 }, { x: item.L, y: 0 }, { x: item.L, y: item.W }, { x: 0, y: item.W }]) { const d = Math.hypot(c.x - bx, c.y - by); if (d < bd) { bd = d; best = c; } } return best; }
const inward = (item, c) => (c.x ? -1 : 1);                    // axial direction pointing into the strip from that corner
function setPeel(el, item, c, u, s) {
  const body = el.querySelector('.tp-body'), flap = el.querySelector('.tp-flap'), fin = flap.firstElementChild, scar = el._scar;
  if (s <= .5) {
    body.style.clipPath = ''; flap.style.display = 'none'; el.style.setProperty('--fs', '-100px');
    if (scar) scar.style.clipPath = 'polygon(0 0, 0 0, 0 0)';
    return;
  }
  const [ux, uy] = u, px = c.x + ux * s / 2, py = c.y + uy * s / 2;   // the fold sits halfway to the fingertip
  const vx = -uy, vy = ux;
  const ax = px + vx * LBIG, ay = py + vy * LBIG, bx = px - vx * LBIG, by = py - vy * LBIG;
  const stuck = `polygon(${ax}px ${ay}px, ${bx}px ${by}px, ${bx + ux * LBIG}px ${by + uy * LBIG}px, ${ax + ux * LBIG}px ${ay + uy * LBIG}px)`;
  const lifted = `polygon(${ax}px ${ay}px, ${bx}px ${by}px, ${bx - ux * LBIG}px ${by - uy * LBIG}px, ${ax - ux * LBIG}px ${ay - uy * LBIG}px)`;
  body.style.clipPath = stuck; fin.style.clipPath = lifted; flap.style.display = 'block';
  const th = Math.atan2(uy, ux) * 180 / Math.PI;
  flap.style.transform = `translate(${px}px, ${py}px) rotate(${th}deg) scaleX(-1) rotate(${-th}deg) translate(${-px}px, ${-py}px)`;
  // shadow of the flap on the stuck part: a gradient along u, positioned at the fold
  const len = Math.abs(item.L * ux) + Math.abs(item.W * uy);
  const fs = (px - item.L / 2) * ux + (py - item.W / 2) * uy + len / 2;
  el.style.setProperty('--fd', (90 + th).toFixed(2) + 'deg'); el.style.setProperty('--fs', fs.toFixed(1) + 'px');
  if (scar) scar.style.clipPath = lifted;
}
function boxPoint(item, cont, e) {
  const r = cont.getBoundingClientRect(), k = kOf(cont);
  const { lx, ly } = toLocal(item, (e.clientX - r.left) / k, (e.clientY - r.top) / k);
  return { bx: lx, by: ly + item.W / 2 };
}
function hoverLift(e, el, item) {
  const { bx, by } = boxPoint(item, containerOf(item), e);
  const c = nearestCorner(item, bx, by);
  el._hover = true; setPeel(el, item, c, [inward(item, c), 0], HOVER);
}

// ---------- laying a fresh strip ----------
let lay = null, peel = null, drag = null, lastTape = null;
function restorePage(srcItem) {   // quietly put the ink back: the page's scars go, strips on it stay
  if (!srcItem || !state.scars.some(sc => sc.srcId === srcItem.id)) return;
  pushUndo(); state.scars = state.scars.filter(sc => sc.srcId !== srcItem.id);
  for (const n of srcEl(srcItem.id).querySelectorAll('.scars .scar')) n.remove();
  sPress(.8); save();
}
let hoverSrc = null;
trayEl.addEventListener('pointerover', e => { const s = e.target.closest('.src'); hoverSrc = s ? srcOf(s.dataset.id) : null; });
trayEl.addEventListener('pointerleave', () => hoverSrc = null);
function onContainerDown(e, container, srcItem) {
  if (e.button && e.button !== 0) return;
  if (e.target.closest('.src-del')) return;
  if (srcItem && e.shiftKey && e.altKey) { e.preventDefault(); restorePage(srcItem); return; }
  startLay(e, container, srcItem);
}
function startLay(e, container, srcItem) {
  e.preventDefault(); ac(); closeMenu();
  const r = container.getBoundingClientRect(), k = kOf(container);
  const item = { id: uid(), on: srcItem ? 'src' : 'board', srcId: srcItem ? srcItem.id : undefined, x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k, th: 0, L: 0, W: state.width, z: ++state.zTop, seed: Math.floor(Math.random() * 2 ** 31), flipped: false, inks: [] };
  const el = makeTapeEl(item); el.classList.add('laying'); layerOf(item).append(el);
  lay = { item, el, container, r, k, pid: e.pointerId, lastL: 0, srcItem };
  pullStart();
  try { container.setPointerCapture(e.pointerId); } catch (err) {}
  container.addEventListener('pointermove', onLayMove); container.addEventListener('pointerup', onLayEnd); container.addEventListener('pointercancel', onLayEnd);
}
function onLayMove(e) {
  if (!lay || e.pointerId !== lay.pid) return;
  const { item, el, r, k } = lay; const dx = (e.clientX - r.left) / k - item.x, dy = (e.clientY - r.top) / k - item.y;
  const L = clamp(Math.hypot(dx, dy), 0, MAX_L);
  if (L > 6) item.th = Math.atan2(dy, dx) / DEG;
  item.L = L; tapeStyle(el, item); pullUpdate(L - lay.lastL); lay.lastL = L;
}
function onLayEnd(e) {
  if (!lay || e.pointerId !== lay.pid) return;
  const { item, el, container } = lay;
  container.removeEventListener('pointermove', onLayMove); container.removeEventListener('pointerup', onLayEnd); container.removeEventListener('pointercancel', onLayEnd);
  lay = null; pullStop();
  if (item.L < 18) { el.remove(); return; }
  pushUndo();
  el.classList.remove('laying'); el.classList.add('stick'); setTimeout(() => el.classList.remove('stick'), 450);
  state.tapes.push(item); bindTape(el, item); lastTape = { el, item };
  if (item.on === 'src') { attachRub(el, item); tutHit(1); }
  sCut(); setTimeout(sPress, 60); updateCount(); save();
}

// ---------- peeling a stuck strip ----------
// Grab a strip and pull: it folds over from the end nearest your finger, you see its glue
// side (the ink, mirrored), and the glue holds back in stick-slip jumps. Past the middle
// it comes off into your hand. On a magazine page it takes the ink with it.
const PEEL_SRC = { gain: 1, hold: 9, creep: .12, slip: .5, detach: .42, back: .5 };     // ink on glossy paper: holds hard
const PEEL_BOARD = { gain: 1, hold: 6, creep: .2, slip: .6, detach: .3, back: .55 };
function onTapeDown(e, el, item) {
  if (e.button && e.button !== 0) return;
  e.stopPropagation();
  if (e.shiftKey) { startLay(e, containerOf(item), item.on === 'src' ? srcOf(item.srcId) : null); return; }
  if (item.on === 'src') { const { bx } = boxPoint(item, containerOf(item), e); const endZone = Math.max(26, item.L * .2); if (bx > endZone && bx < item.L - endZone) { startRub(e, el, item); return; } }
  startPeel(e, el, item);
}
let rub = null;
function startRub(e, el, item) {
  e.preventDefault(); ac(); closeMenu();
  const cont = containerOf(item), { bx, by } = boxPoint(item, cont, e);
  rub = { el, item, cont, pid: e.pointerId, bx, by, moved: 0 };
  el.classList.add('rubbing'); rubSoundStart();
  try { el.setPointerCapture(e.pointerId); } catch (err) {}
  el.addEventListener('pointermove', onRubMove); el.addEventListener('pointerup', onRubEnd); el.addEventListener('pointercancel', onRubEnd);
}
function onRubMove(e) {
  if (!rub || e.pointerId !== rub.pid) return;
  const r = rub, { bx, by } = boxPoint(r.item, r.cont, e);
  const d = Math.hypot(bx - r.bx, by - r.by); if (d < .5) return;
  rubStroke(r.item, r.bx, r.by, bx, by, d); r.bx = bx; r.by = by; r.moved += d;
  rubSoundUpdate(d);
}
function onRubEnd(e) {
  if (!rub || e.pointerId !== rub.pid) return;
  const r = rub; rub = null; rubSoundStop();
  r.el.removeEventListener('pointermove', onRubMove); r.el.removeEventListener('pointerup', onRubEnd); r.el.removeEventListener('pointercancel', onRubEnd);
  r.el.classList.remove('rubbing');
  if (r.moved > 2) { r.item.rub = RUBS[r.item.id].toDataURL(); save(); if (r.moved > 120) tutHit(2); }
}
function startPeel(e, el, item) {
  e.preventDefault(); ac(); closeMenu();
  const cont = containerOf(item), k = kOf(cont);
  const { bx, by } = boxPoint(item, cont, e);
  const c = nearestCorner(item, bx, by), u = [inward(item, c), 0];
  peel = { el, item, c, u, k, P: item.on === 'src' ? PEEL_SRC : PEEL_BOARD, s: HOVER, target: 0, pid: e.pointerId, px: e.clientX, py: e.clientY, ex: e.clientX, ey: e.clientY, cont };
  if (item.on === 'src') {                                      // what this press will lift: a new ink layer + the hole it leaves
    const src = srcOf(item.srcId);
    const maskC = makeMask(item.L, item.W, Math.floor(Math.random() * 2 ** 31), item.inks.map(l => MASKS[l.id]).filter(Boolean), state.ink / 100, rubMap(item));
    punchScars(maskC, item);                                    // where the page is already bare there is no ink to take
    const mask = maskC.toDataURL(), id = uid(); MASKS[id] = maskC;
    const layer = { id, srcId: item.srcId, ax: item.x, ay: item.y, th: item.th, sw: SW, sh: src.sh, mask };
    const scar = { id: 's' + id, srcId: item.srcId, x: item.x, y: item.y, th: item.th, L: item.L, W: item.W, mask };
    item.inks.push(layer); renderInks(el, item);
    const scarEl = makeScarEl(scar); scarEl.style.clipPath = 'polygon(0 0, 0 0, 0 0)'; cont.querySelector('.scars').append(scarEl);
    el._scar = scarEl; peel.pending = { layer, scar, scarEl };
  }
  el.classList.add('peel-active'); setPeel(el, item, c, u, HOVER + 2); peelSoundStart();
  try { el.setPointerCapture(e.pointerId); } catch (err) {}
  el.addEventListener('pointermove', onPeelMove); el.addEventListener('pointerup', onPeelEnd); el.addEventListener('pointercancel', onPeelEnd);
  requestAnimationFrame(peelLoop);
}
const FOLD_MAX = 65 * DEG;                                      // how far the fold may slant from the strip's axis
function onPeelMove(e) {
  if (!peel || e.pointerId !== peel.pid) return;
  const p = peel, it = p.item; p.ex = e.clientX; p.ey = e.clientY;
  const cs = Math.cos(it.th * DEG), sn = Math.sin(it.th * DEG);
  const dx = (e.clientX - p.px) / p.k, dy = (e.clientY - p.py) / p.k;
  const wx = cs * dx + sn * dy, wy = -sn * dx + cs * dy;          // pull, in strip coords
  const d = Math.hypot(wx, wy), ax = inward(it, p.c);
  if (d > 8) {                                                  // the fold turns to follow the direction you pull, within the cone
    let ang = Math.atan2(wy, wx * ax); ang = clamp(ang, -FOLD_MAX, FOLD_MAX);
    const nx = Math.cos(ang) * ax, ny = Math.sin(ang);
    p.u[0] += (nx - p.u[0]) * .3; p.u[1] += (ny - p.u[1]) * .3;
    const L = Math.hypot(p.u[0], p.u[1]); p.u[0] /= L; p.u[1] /= L;
  }
  const along = wx * p.u[0] + wy * p.u[1], away = -wx * ax;      // pulling straight off the end still lifts it, slowly
  p.target = Math.max(0, along) * p.P.gain + Math.max(0, away) * .3;
}
function peelLoop(now = performance.now()) {
  const p = peel; if (!p) return;
  const fr = clamp((now - (p.last || now - 16.7)) / 16.7, .25, 4); p.last = now;
  const P = p.P, tension = p.target - p.s; let ds;
  if (tension > P.hold) { ds = tension * P.slip; peelSlip(ds); }
  else if (tension > 0) ds = tension * (1 - Math.pow(1 - P.creep, fr));
  else ds = tension;
  p.s = Math.max(0, p.s + ds);
  peelSoundUpdate(Math.max(0, ds) / fr);
  const tug = clamp(tension, 0, 40) * .1, cs = Math.cos(p.item.th * DEG), sn = Math.sin(p.item.th * DEG);   // the page itself gets tugged
  const ux = cs * p.u[0] - sn * p.u[1], uy = sn * p.u[0] + cs * p.u[1];
  if (p.item.on === 'src') { p.cont.classList.add('tugged'); p.cont.style.translate = `${(ux * tug).toFixed(2)}px ${(uy * tug).toFixed(2)}px`; }
  else p.el.style.translate = `${(ux * tug).toFixed(2)}px ${(uy * tug).toFixed(2)}px`;
  setPeel(p.el, p.item, p.c, p.u, p.s);
  const extent = p.item.L * Math.abs(p.u[0]) + p.item.W * Math.abs(p.u[1]);
  if (p.s / 2 >= extent * P.detach) { detachPeel(); return; }
  requestAnimationFrame(peelLoop);
}
function endPeelListeners(el) { el.removeEventListener('pointermove', onPeelMove); el.removeEventListener('pointerup', onPeelEnd); el.removeEventListener('pointercancel', onPeelEnd); }
function untug(p) { p.cont.classList.remove('tugged'); p.cont.style.translate = ''; p.el.style.translate = ''; }
function onPeelEnd() {
  if (!peel) return;
  const p = peel; endPeelListeners(p.el); peel = null; peelSoundStop(); untug(p);
  if (p.pending) { p.item.inks.pop(); renderInks(p.el, p.item); }       // nothing lifted after all
  if (p.s > HOVER + 3) sFlapBack();
  let s = p.s;
  const tick = () => { s *= p.P.back; setPeel(p.el, p.item, p.c, p.u, s); if (s > .8) requestAnimationFrame(tick); else { setPeel(p.el, p.item, p.c, p.u, 0); p.el.classList.remove('peel-active'); if (p.pending) { p.pending.scarEl.remove(); p.el._scar = null; } } };
  tick();
}
function detachPeel() {
  const p = peel, item = p.item; endPeelListeners(p.el); peel = null; peelSoundStop(); untug(p); sDetach();
  pushUndo();
  setPeel(p.el, item, p.c, p.u, 0); p.el.classList.remove('peel-active');
  if (p.pending) { p.pending.scarEl.style.clipPath = ''; state.scars.push(p.pending.scar); p.el._scar = null; detachRub(p.el, item); tutHit(3); }
  state.tapes = state.tapes.filter(t => t !== item);
  // the pressed element stays (hidden) as the pointer-capture target; a clone goes into the hand
  const holder = p.el, r = p.cont.getBoundingClientRect();
  const ghost = holder.cloneNode(true); ghost.classList.remove('peel-active', 'taken'); ghost.style.zIndex = ''; ghost._item = item;
  holder.classList.add('taken');
  const glx = p.c.x ? item.L - 10 : 10, gly = (p.c.y ? 1 : -1) * item.W * .3;   // it hangs from the corner you peeled
  ghost.style.transform = `translate(${r.left + item.x * p.k}px, ${r.top + item.y * p.k}px) rotate(${item.th}deg)`;
  floatLayer.append(ghost);
  beginDrag(holder, ghost, item, { clientX: p.ex, clientY: p.ey, pointerId: p.pid }, glx, gly);
  updateCount();
}

// ---------- in the hand ----------
function beginDrag(holder, ghost, item, e, glx, gly) {
  drag = { holder, ghost, item, glx, gly, x: e.clientX, y: e.clientY, tx: e.clientX, ty: e.clientY, tilt: 0, pid: e.pointerId, start: performance.now() };
  document.body.classList.add('dragging-tape');
  ghost.style.transition = 'transform .15s cubic-bezier(.3,1.2,.5,1)'; setTimeout(() => { if (drag && drag.ghost === ghost) ghost.style.transition = ''; }, 170);
  holder.addEventListener('pointermove', onDragMove); holder.addEventListener('pointerup', onDragEnd); holder.addEventListener('pointercancel', onDragEnd);
  dragLoop();
}
function onDragMove(e) { if (!drag || e.pointerId !== drag.pid) return; drag.tx = e.clientX; drag.ty = e.clientY; markDropTarget(e.clientX, e.clientY); }
function dragLoop() {
  const d = drag; if (!d) return; const it = d.item;
  d.x += (d.tx - d.x) * .42; d.y += (d.ty - d.y) * .42;
  const vx = d.tx - d.x, vy = d.ty - d.y, c = Math.cos(it.th * DEG), s = Math.sin(it.th * DEG);
  const perp = -s * vx + c * vy;
  d.tilt += ((d.glx < it.L / 2 ? -1 : 1) * clamp(perp * .3, -14, 14) - d.tilt) * .18;
  d.ghost._tilt = d.tilt;
  d.ghost.style.transform = `translate(${d.x.toFixed(2)}px, ${d.y.toFixed(2)}px) rotate(${(it.th + d.tilt).toFixed(2)}deg) translate(${-d.glx}px, ${-d.gly}px)`;
  d.ghost.style.setProperty('--vx', clamp(vx, -30, 30).toFixed(1)); d.ghost.style.setProperty('--vy', clamp(vy, -30, 30).toFixed(1));
  requestAnimationFrame(dragLoop);
}
function srcUnder(cx, cy) { return document.elementsFromPoint(cx, cy).find(n => n.classList && n.classList.contains('src')) || null; }
let dropTarget = null;
function markDropTarget(cx, cy) {
  const s = srcUnder(cx, cy);
  if (s !== dropTarget) { if (dropTarget) dropTarget.classList.remove('drop-target'); dropTarget = s; if (s) s.classList.add('drop-target'); }
}
function onDragEnd(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag; drag = null; document.body.classList.remove('dragging-tape');
  d.holder.removeEventListener('pointermove', onDragMove); d.holder.removeEventListener('pointerup', onDragEnd); d.holder.removeEventListener('pointercancel', onDragEnd);
  if (dropTarget) dropTarget.classList.remove('drop-target'); dropTarget = null;
  d.holder.remove();
  const it = d.item, c = Math.cos(it.th * DEG), s = Math.sin(it.th * DEG);
  const srcTarget = srcUnder(e.clientX, e.clientY);
  let cont;
  if (srcTarget) { cont = srcTarget; it.on = 'src'; it.srcId = srcTarget.dataset.id; }
  else { cont = boardEl; it.on = 'board'; it.srcId = undefined; }
  const r = cont.getBoundingClientRect(), k = kOf(cont);
  const ax = e.clientX - (c * d.glx - s * d.gly) * k, ay = e.clientY - (s * d.glx + c * d.gly) * k;   // anchor in client coords
  it.x = (ax - r.left) / k; it.y = (ay - r.top) / k;
  const w = r.width / k, h = r.height / k;
  const cx = it.x + c * it.L / 2, cy = it.y + s * it.L / 2;        // keep the middle of the strip on the page / board
  const ncx = clamp(cx, 24, w - 24), ncy = clamp(cy, 24, h - 24); it.x += ncx - cx; it.y += ncy - cy;
  it.z = ++state.zTop; state.tapes.push(it);
  const el = d.ghost; el._tilt = 0; el.style.transition = ''; el.style.removeProperty('--vx'); el.style.removeProperty('--vy');
  placeTape(it, el); el.classList.add('stick'); setTimeout(() => el.classList.remove('stick'), 450);
  if (it.on === 'src') attachRub(el, it); else tutHit(4);
  lastTape = { el, item: it }; sPress(); updateCount(); save();
}
// trackpads send many tiny deltas and mice a few big ones: rotate by the amount scrolled, gently
const wheelDeg = e => clamp((e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * .06, -2.5, 2.5);
addEventListener('wheel', e => {
  if (drag) { e.preventDefault(); drag.item.th += wheelDeg(e); if (Math.random() < .25) sTick(); }
}, { passive: false });

// ---------- light: a highlight that slides along every strip as the cursor moves ----------
const light = { x: innerWidth * .6, y: innerHeight * .35, mx: null, my: null, lastMove: 0 };
addEventListener('pointermove', e => { light.mx = e.clientX; light.my = e.clientY; light.lastMove = performance.now(); }, { passive: true });
// A lamp 230px above the desk follows the pointer (drifts on its own when idle), as in the sticker project.
// On a flat clear coat the mirror image of that lamp is a spot right under it; each strip gets the spot's
// position in its own coords (--lx/--ly) so the spot is one and the same across all of them.
const LIGHT_H = 230;
function lightLoop(now) {
  const idle = now - light.lastMove > 1800 || light.mx === null;
  if (idle) { light.x = innerWidth * (.5 + .55 * Math.sin(now / 2100)); light.y = innerHeight * (.45 + .45 * Math.cos(now / 2900)); }
  else { light.x += (light.mx - light.x) * .3; light.y += (light.my - light.y) * .3; }
  const els = document.querySelectorAll('.tape'); const rects = [];
  for (const el of els) rects.push(el.getBoundingClientRect());
  els.forEach((el, i) => {
    const r = rects[i], it = el._item; if (!it) return;
    if (r.bottom < -400 || r.top > innerHeight + 400 || r.right < -400 || r.left > innerWidth + 400) return;
    const k = el.closest('.src') ? SRC_ZOOM : 1;
    const dx = light.x - (r.left + r.width / 2), dy = light.y - (r.top + r.height / 2);
    const th = (it.th + (el._tilt || 0)) * DEG, c = Math.cos(th), s = Math.sin(th);
    const lx = (c * dx + s * dy) / k, ly = (-s * dx + c * dy) / k;        // lamp, in strip coords around the middle
    const X = it.L / 2 + lx, Y = it.W / 2 + (it.flipped ? -ly : ly);
    const kk = clamp(-ly / 120, -1, 1);                                 // which long edge faces the lamp
    el.style.setProperty('--lx', X.toFixed(1) + 'px'); el.style.setProperty('--ly', Y.toFixed(1) + 'px'); el.style.setProperty('--lk', (1 / k).toFixed(3));
    el.style.setProperty('--gt', (.14 + .1 * kk).toFixed(3)); el.style.setProperty('--gb', (.13 - .09 * kk).toFixed(3));
  });
  requestAnimationFrame(lightLoop);
}

// ---------- flip / menu / delete ----------
function flipTape(el, item) { pushUndo(); item.flipped = !item.flipped; el.classList.toggle('flipped', item.flipped); sFlip(); save(); }
function crumple(el, item) {
  pushUndo(); state.tapes = state.tapes.filter(t => t !== item);
  el.classList.add('crumple'); sCrumple(); setTimeout(() => el.remove(), 420);
  if (lastTape && lastTape.item === item) lastTape = null; updateCount(); save();
}
let menuFor = null;
function openMenu(x, y, el, item) {
  menuFor = { el, item }; lastTape = menuFor; ctxEl.hidden = false;
  ctxEl.style.left = Math.min(x, innerWidth - 170) + 'px'; ctxEl.style.top = Math.min(y, innerHeight - 150) + 'px';
}
function closeMenu() { ctxEl.hidden = true; menuFor = null; }
ctxEl.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !menuFor) return; const { el, item } = menuFor; closeMenu();
  if (b.dataset.act === 'flip') flipTape(el, item);
  if (b.dataset.act === 'del') crumple(el, item);
  if (b.dataset.act === 'top') { pushUndo(); item.z = ++state.zTop; el.style.zIndex = item.z; sTick(); save(); }
  if (b.dataset.act === 'bottom') { pushUndo(); const min = Math.min(...state.tapes.filter(t => t.on === item.on && t.srcId === item.srcId).map(t => t.z)); item.z = min - 1; el.style.zIndex = item.z; sTick(); save(); }
});
document.addEventListener('pointerdown', e => { if (!ctxEl.contains(e.target)) closeMenu(); }, true);
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { closeMenu(); return; }
  if (e.key === 'R' && e.shiftKey && hoverSrc) { restorePage(hoverSrc); return; }
  if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); undo(); return; }
  if (!lastTape || !lastTape.el.isConnected) return;
  const { el, item } = lastTape;
  if (e.key === 'f' || e.key === 'F') flipTape(el, item);
  if (e.key === 'Delete' || e.key === 'Backspace') crumple(el, item);
  if (e.key === '[' || e.key === ']') { rotateAboutCenter(item, e.key === ']' ? 3 : -3); tapeStyle(el, item); sTick(); save(); }
});

// ---------- undo ----------
function snapshot() { return JSON.stringify({ tapes: state.tapes, scars: state.scars, zTop: state.zTop }); }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 40) undoStack.shift(); }
function undo() {
  if (drag || peel || lay) return; const s = undoStack.pop(); if (!s) return;
  const o = JSON.parse(s); state.tapes = o.tapes; state.scars = o.scars; state.zTop = o.zTop;
  rerenderAll(); sTick(); save();
}
function rerenderAll() {
  for (const n of document.querySelectorAll('.tape, .scars .scar')) n.remove();
  for (const sc of state.scars) { const s = srcEl(sc.srcId); if (s) s.querySelector('.scars').append(makeScarEl(sc)); }
  for (const t of state.tapes) { if (t.on === 'src' && !srcEl(t.srcId)) continue; placeTape(t); }
  lastTape = null; updateCount();
}
function updateCount() {
  const n = state.tapes.filter(t => t.on === 'board').length; $('#count').textContent = n;
  boardEl.classList.toggle('has-tapes', n > 0);
}

// ---------- sources: the magazine pages ----------
function renderSource(s) {
  const el = div('src'); el.dataset.id = s.id; el.style.height = s.sh + 'px';
  const img = new Image(); img.src = SRC_URL[s.id]; img.draggable = false; img.referrerPolicy = 'no-referrer';
  const scars = div('scars'), tapes = div('tapes');
  const del = document.createElement('button'); del.className = 'src-del'; del.textContent = '×'; del.title = 'Remove this page';
  const label = div('src-label'); label.textContent = s.name || '';
  el.append(img, scars, tapes, del, label);
  el.addEventListener('pointerdown', e => onContainerDown(e, el, s));
  del.addEventListener('click', e => { e.stopPropagation(); removeSource(s); });
  trayEl.prepend(el);
  const empty = trayEl.querySelector('.tray-empty'); if (empty) empty.remove();
  return el;
}
async function addSource(input, name) {         // input: Blob | url string
  let blob = null, url = input;
  if (input instanceof Blob) { blob = input; url = URL.createObjectURL(blob); }
  else {                                        // try to fetch it so it survives reloads; fall back to the hot link
    try { const res = await fetch(input, { mode: 'cors' }); if (res.ok) { const b = await res.blob(); if (b.type.startsWith('image/')) { blob = b; url = URL.createObjectURL(b); } } } catch (e) {}
  }
  const dims = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = rej; im.referrerPolicy = 'no-referrer'; im.src = url; }).catch(() => null);
  if (!dims || !dims.w) { toast('That image would not load (the site probably blocks hotlinking). Save it to your computer and drop it in instead.'); return null; }
  const s = { id: uid(), kind: blob ? 'blob' : 'url', url: blob ? undefined : input, w: dims.w, h: dims.h, sw: SW, sh: Math.round(SW * dims.h / dims.w), name: name || '' };
  SRC_URL[s.id] = url; state.sources.unshift(s);
  if (blob) await DB.set('blob:' + s.id, blob).catch(() => {});
  renderSource(s); save(); sPress(.8);
  return s;
}
function removeSource(s) {
  const used = state.tapes.some(t => t.on === 'board' && t.inks.some(l => l.srcId === s.id));
  if (!confirm(used ? 'Remove this page? Strips already peeled onto the board will stay.' : 'Remove this page?')) return;
  pushUndo();
  state.tapes = state.tapes.filter(t => !(t.on === 'src' && t.srcId === s.id));
  state.scars = state.scars.filter(sc => sc.srcId !== s.id);
  const el = srcEl(s.id); if (el) el.remove();
  if (used) s.hidden = true; else { state.sources = state.sources.filter(x => x !== s); DB.del('blob:' + s.id); }
  if (!trayEl.querySelector('.src')) showTrayEmpty();
  updateCount(); save();
}
function showTrayEmpty() { const e = div('tray-empty'); e.innerHTML = 'No pages yet.<br>Drop images here, or paste.'; trayEl.append(e); }

// a few pages so the first run has something to tear (in samples/)
const SAMPLES = [['samples/buddha.jpg', 'buddha'], ['samples/ants.jpg', 'ants'], ['samples/thorns.jpg', 'thorns'], ['samples/fish.jpg', 'fish'],
  ['samples/skeleton.jpg', 'skeleton'], ['samples/coral.jpg', 'coral'], ['samples/lips.jpg', 'lips'], ['samples/blue-coral.jpg', 'blue coral']];
async function addSamples(only) { for (const [u, n] of [...SAMPLES].reverse()) if (!only || only.includes(n)) await addSource(new URL(u, location.href).href, n); }

// ---------- import: files, paste, drag from other tabs, urls, bookmarklet ----------
function urlFromTransfer(dt) {
  const html = dt.getData('text/html');
  if (html) { const m = html.match(/<img[^>]+src=["']([^"']+)["']/i); if (m) return m[1].replace(/&amp;/g, '&'); }
  const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
  if (uri && /^https?:\/\//i.test(uri.trim())) return uri.trim().split('\n')[0];
  return null;
}
async function importTransfer(dt) {
  const files = [...(dt.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) { for (const f of files) await addSource(f, f.name); return; }
  const url = urlFromTransfer(dt);
  if (url) { await addSource(url, url.split('/').pop().split('?')[0].slice(0, 40)); return; }
  toast('No image in that.');
}
addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('file-over'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('file-over'); });
addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('file-over'); importTransfer(e.dataTransfer); });
addEventListener('paste', e => {
  const dt = e.clipboardData; if (!dt) return;
  const items = [...dt.items].filter(i => i.type.startsWith('image/'));
  if (items.length) { e.preventDefault(); items.forEach(i => addSource(i.getAsFile(), 'pasted')); return; }
  const t = dt.getData('text/plain'); if (t && /^https?:\/\//i.test(t.trim())) { e.preventDefault(); addSource(t.trim(), 'link'); }
});
$('#file-input').addEventListener('change', e => { for (const f of e.target.files) addSource(f, f.name); e.target.value = ''; });
$('#btn-url').addEventListener('click', () => { const u = prompt('Image URL:'); if (u && u.trim()) addSource(u.trim(), 'link'); });
$('#btn-bm').addEventListener('click', () => {
  if (location.protocol === 'file:') { toast('The bookmarklet needs this page to have an http address: run  python3 -m http.server 8790  in the project folder, open http://localhost:8790/ and press this button again.', 7000); return; }
  const target = location.href.split('#')[0];
  const code = `javascript:(()=>{const T=${JSON.stringify(target)};const o=document.createElement('div');o.style='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(255,80,40,.06)';const h=document.createElement('div');h.style='position:fixed;pointer-events:none;outline:3px solid #e5452f;z-index:2147483647;display:none';document.body.append(o,h);let cur=null;o.onmousemove=e=>{o.style.pointerEvents='none';const el=document.elementFromPoint(e.clientX,e.clientY);o.style.pointerEvents='';cur=el&&(el.closest('img,picture,[style*=background]')||el);if(!cur)return;const r=cur.getBoundingClientRect();h.style.display='block';h.style.left=r.left+'px';h.style.top=r.top+'px';h.style.width=r.width+'px';h.style.height=r.height+'px';};o.onclick=()=>{let u=null;if(cur){const im=cur.tagName==='IMG'?cur:cur.querySelector&&cur.querySelector('img');if(im)u=im.currentSrc||im.src;else{const b=getComputedStyle(cur).backgroundImage.match(/url\\("?(.*?)"?\\)/);if(b)u=b[1];}}o.remove();h.remove();if(u)window.open(T+'#add='+encodeURIComponent(u),'_blank');};addEventListener('keydown',e=>{if(e.key==='Escape'){o.remove();h.remove();}},{once:true});})();`;
  navigator.clipboard.writeText(code).then(() => toast('Bookmarklet code copied. Make a new bookmark in your bookmarks bar and paste it as the URL. Then on any page: click the bookmark, click an image, and it lands here.', 9000),
    () => prompt('Copy this and save it as a bookmark:', code));
});
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('tapecollage') : null;
async function handleHash() {
  const m = location.hash.match(/#add=(.+)/); if (!m) return;
  const url = decodeURIComponent(m[1]); history.replaceState(null, '', location.pathname + location.search);
  if (bc && window.opener !== null) {           // opened by the bookmarklet: hand it to a tab that is already open, if any
    const got = await new Promise(res => { const f = e => { if (e.data && e.data.type === 'ack' && e.data.url === url) { bc.removeEventListener('message', f); res(true); } }; bc.addEventListener('message', f); bc.postMessage({ type: 'add', url }); setTimeout(() => res(false), 400); });
    if (got) { window.close(); return; }
  }
  addSource(url, 'from the web');
}
if (bc) bc.addEventListener('message', e => { if (e.data && e.data.type === 'add' && document.visibilityState !== 'hidden') { bc.postMessage({ type: 'ack', url: e.data.url }); addSource(e.data.url, 'from the web'); } });
addEventListener('hashchange', handleHash);

// ---------- export ----------
async function exportPNG() {
  const r = boardEl.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  const c = document.createElement('canvas'); c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); const g = c.getContext('2d'); g.scale(dpr, dpr);
  g.fillStyle = '#f6f3ec'; g.fillRect(0, 0, r.width, r.height);
  const imgs = {};
  for (const s of state.sources) { imgs[s.id] = await new Promise(res => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = SRC_URL[s.id]; }); }
  const maskImg = async url => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
  const tapes = state.tapes.filter(t => t.on === 'board').sort((a, b) => a.z - b.z);
  let tainted = false;
  for (const t of tapes) {
    g.save(); g.translate(t.x, t.y); g.rotate(t.th * DEG); if (t.flipped) g.scale(1, -1); g.translate(0, -t.W / 2);
    g.beginPath(); serrationPoly(t).forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.clip();
    for (let i = t.inks.length - 1; i >= 0; i--) {                      // oldest layer last = on top
      const ly = t.inks[i], im = imgs[ly.srcId]; if (!im) { tainted = true; continue; }
      const oc = document.createElement('canvas'); oc.width = Math.ceil(t.L); oc.height = Math.ceil(t.W); const og = oc.getContext('2d');
      og.translate(0, t.W / 2); og.rotate(-ly.th * DEG); og.translate(-ly.ax, -ly.ay);
      og.drawImage(im, 0, 0, ly.sw, ly.sh);
      og.setTransform(1, 0, 0, 1, 0, 0);
      const mk = await maskImg(ly.mask); if (mk) { og.globalCompositeOperation = 'destination-in'; og.drawImage(mk, 0, 0, oc.width, oc.height); }
      g.globalAlpha = .72; g.drawImage(oc, 0, 0); g.globalAlpha = 1;
    }
    g.fillStyle = 'rgba(255,246,222,.06)'; g.fillRect(0, 0, t.L, t.W);
    const edge = g.createLinearGradient(0, 0, 0, t.W); edge.addColorStop(0, 'rgba(255,255,255,.16)'); edge.addColorStop(.08, 'rgba(255,255,255,0)'); edge.addColorStop(.92, 'rgba(255,255,255,0)'); edge.addColorStop(1, 'rgba(255,255,255,.16)');
    g.fillStyle = edge; g.fillRect(0, 0, t.L, t.W);
    {                                                                  // the lamp's mirror image, where it is right now
      const cc = toWorld(t, t.L / 2, 0), dx = light.x - (r.left + cc.x), dy = light.y - (r.top + cc.y);
      const c = Math.cos(t.th * DEG), s = Math.sin(t.th * DEG), lx = c * dx + s * dy, ly = (t.flipped ? -1 : 1) * (-s * dx + c * dy);
      const X = t.L / 2 + lx, Y = t.W / 2 + ly;
      const gl = g.createRadialGradient(X, Y, 0, X, Y, 300);
      gl.addColorStop(0, 'rgba(255,255,255,.7)'); gl.addColorStop(22 / 300, 'rgba(255,255,255,.52)'); gl.addColorStop(60 / 300, 'rgba(255,255,255,.2)'); gl.addColorStop(130 / 300, 'rgba(255,255,255,.08)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gl; g.fillRect(0, 0, t.L, t.W);
    }
    g.restore();
  }
  try {
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tape-collage-${new Date().toISOString().slice(0, 10)}.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    if (tainted) toast('Saved, but a few strips use images from sites that block cross-origin reads, so they were left out. Save those images to your computer and import them instead.', 6000); else sTick();
  } catch (e) { toast('Could not save: some strips use images from other sites and the browser will not read them. Save those images to your computer and import them instead.', 6000); }
}

// ---------- persistence (IndexedDB) ----------
const DB = {
  db: null,
  open() { return new Promise((res, rej) => { const r = indexedDB.open('tapecollage', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(this.db = r.result); r.onerror = () => rej(r.error); }); },
  get(k) { if (!this.db) return Promise.reject(new Error('no db')); return new Promise((res, rej) => { const t = this.db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); },
  set(k, v) { if (!this.db) return Promise.reject(new Error('no db')); return new Promise((res, rej) => { const t = this.db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); },
  del(k) { if (!this.db) return Promise.reject(new Error('no db')); return new Promise((res, rej) => { const t = this.db.transaction('kv', 'readwrite').objectStore('kv').delete(k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); },
};
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { if (DB.db) DB.set('state', JSON.stringify({ sources: state.sources, tapes: state.tapes, scars: state.scars, zTop: state.zTop, sound: state.sound, width: state.width, ink: state.ink, tut: state.tut, seenSamples: state.seenSamples })).catch(() => {}); }, 400); }
async function load() {
  try { await DB.open(); } catch (e) { return false; }
  let st = null; try { st = JSON.parse(await DB.get('state') || 'null'); } catch (e) {}
  if (!st) return false;
  Object.assign(state, { tapes: st.tapes || [], scars: st.scars || [], zTop: st.zTop || 1, sound: st.sound !== false, width: ({ 22: 44, 38: 76, 60: 120 })[st.width] || st.width || 76, ink: (st.ink === 80 || st.ink === 35 || st.ink === 15) ? 25 : (st.ink ?? 25), tut: !!st.tut, seenSamples: st.seenSamples });
  state.sources = [];
  for (const s of st.sources || []) {
    if (s.kind === 'blob') { const b = await DB.get('blob:' + s.id).catch(() => null); if (!b) continue; SRC_URL[s.id] = URL.createObjectURL(b); }
    else SRC_URL[s.id] = s.url;
    state.sources.push(s);
  }
  for (const s of [...state.sources].reverse()) if (!s.hidden) renderSource(s);
  for (const t of state.tapes) for (const l of t.inks) maskFromDataURL(l.id, l.mask);
  for (const sc of state.scars) maskFromDataURL(sc.id.startsWith('s') ? sc.id.slice(1) : sc.id, sc.mask);
  rerenderAll();
  return true;
}

// ---------- tutorial: four steps that tick off as you actually do them ----------
const TUT = [
  { title: 'Lay a strip of tape', text: '<b>Press and drag</b> across a magazine page on the left to pull out a strip. Let go and it is pressed onto the page. Pick a width in the top bar.',
    pic: '<svg viewBox="0 0 150 96"><rect x="14" y="10" width="122" height="76" rx="2" fill="#e9d9c6"/><circle cx="60" cy="40" r="16" fill="#d9472e" opacity=".8"/><rect x="24" y="52" width="100" height="18" rx="1" fill="rgba(255,250,230,.75)" stroke="rgba(0,0,0,.15)" class="tp-anim-tape"/></svg>' },
  { title: 'Rub it down', text: '<b>Rub back and forth over the middle</b> of the strip. Where you have not rubbed there is still air underneath and it looks milky; rubbed areas go clear, and <b>only those take the ink</b> when you peel.',
    pic: '<svg viewBox="0 0 150 96"><rect x="14" y="10" width="122" height="76" rx="2" fill="#e9d9c6"/><circle cx="60" cy="40" r="16" fill="#d9472e" opacity=".8"/><rect x="24" y="40" width="100" height="18" rx="1" fill="rgba(255,250,230,.6)" stroke="rgba(0,0,0,.15)"/><rect x="24" y="40" width="100" height="18" fill="#fff" class="tp-anim-milk"/><g class="tp-anim-finger"><ellipse cx="74" cy="46" rx="9" ry="13" fill="#f1c9a8" stroke="#b58a6a"/></g></svg>' },
  { title: 'Grab an end and fold it back', text: 'Grab a corner <b>near either end</b> and pull back along the strip. The glue lets go in little jumps, and the folded part shows the ink on its sticky side. Past halfway the whole strip comes off into your hand.',
    pic: '<svg viewBox="0 0 150 96"><rect x="14" y="10" width="122" height="76" rx="2" fill="#e9d9c6"/><rect x="24" y="40" width="100" height="18" rx="1" fill="#f3efe6" stroke="rgba(0,0,0,.1)"/><rect x="24" y="40" width="100" height="18" rx="1" fill="rgba(200,120,90,.55)" stroke="rgba(0,0,0,.15)" class="tp-anim-stuck"/><rect x="24" y="40" width="60" height="18" rx="1" fill="rgba(255,255,255,.9)" stroke="rgba(0,0,0,.2)" class="tp-anim-flap"/></svg>' },
  { title: 'Stick it on the board', text: 'Drag it to the right and let go. You can press it onto another page, rub and peel again, so <b>one strip carries several pictures</b>; stacked strips each show through a little. Wheel to rotate, double-click to flip, right-click for more.',
    pic: '<svg viewBox="0 0 150 96"><rect x="4" y="10" width="50" height="76" rx="2" fill="#e9d9c6"/><rect x="62" y="6" width="84" height="84" rx="2" fill="#f6f3ec" stroke="#b8b2a5"/><rect x="10" y="40" width="40" height="16" rx="1" fill="rgba(200,120,90,.55)" stroke="rgba(0,0,0,.15)" class="tp-anim-move"/></svg>' },
  { title: 'That is it', text: 'The more you stack, the dreamier it gets. For new material, drop images on the left, paste, or drag an image straight over from another browser tab. “? How to” in the top bar brings this back.', pic: '' },
];
let tutStep = -1;
const tutEl = $('#tut');
function tutShow(i) {
  tutStep = i; const t = TUT[i]; tutEl.hidden = false;
  $('#tut-pic').innerHTML = t.pic; $('#tut-title').textContent = t.title; $('#tut-text').innerHTML = t.text;
  $('#tut-step').textContent = i < 4 ? `Step ${i + 1} of 4` : 'Done';
  $('#tut-next').textContent = i < 4 ? 'Next →' : 'Go';
  $('#tut-skip').hidden = i >= 4;
  tutEl.classList.toggle('tut-done', i >= 4);
  document.body.className = document.body.className.replace(/\btut-\d\b/g, '').trim(); if (i < 4) document.body.classList.add('tut-' + (i + 1));
}
function tutEnd() { tutStep = -1; tutEl.hidden = true; document.body.className = document.body.className.replace(/\btut-\d\b/g, '').trim(); state.tut = true; save(); }
function tutHit(step) { if (tutStep === step - 1) { sTick(); tutShow(step); } }
$('#tut-next').addEventListener('click', () => tutStep >= 4 ? tutEnd() : tutShow(tutStep + 1));
$('#tut-skip').addEventListener('click', tutEnd);
$('#btn-tut').addEventListener('click', () => tutShow(0));

// ---------- ui wiring ----------
boardEl.addEventListener('pointerdown', e => { if (e.target === boardEl || e.target.id === 'board-hint' || e.target.closest('#board-hint')) onContainerDown(e, boardEl, null); });
boardEl.addEventListener('contextmenu', e => e.preventDefault());
$('#width-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.width = +b.dataset.w; for (const x of $('#width-seg').children) x.classList.toggle('on', x === b); sTick(); save(); });
const inkRange = $('#ink-range'), inkVal = $('#ink-val');
function showInk() { inkRange.value = state.ink; inkVal.textContent = state.ink + '%'; }
inkRange.addEventListener('input', () => { state.ink = +inkRange.value; inkVal.textContent = state.ink + '%'; });
inkRange.addEventListener('change', () => { sTick(); save(); });
$('#btn-undo').addEventListener('click', undo);
$('#btn-sound').addEventListener('click', e => { state.sound = !state.sound; e.currentTarget.setAttribute('aria-pressed', state.sound); if (state.sound) sTick(); save(); });
$('#btn-export').addEventListener('click', exportPNG);
$('#btn-clear').addEventListener('click', () => {
  if (!state.tapes.some(t => t.on === 'board') || !confirm('Tear every strip off the board?')) return;
  pushUndo(); state.tapes = state.tapes.filter(t => t.on !== 'board'); rerenderAll(); sCrumple(); save();
});
let toastT = null;
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
document.addEventListener('pointerdown', () => ac(), { once: true });

(async () => {
  fitTray();
  const had = await load();
  for (const x of $('#width-seg').children) x.classList.toggle('on', +x.dataset.w === state.width);
  $('#btn-sound').setAttribute('aria-pressed', state.sound); showInk();
  const onlyOldSample = state.sources.length && state.sources.every(x => x.name === 'sample page');
  if (onlyOldSample) { for (const x of [...state.sources]) { state.tapes = state.tapes.filter(t => !(t.on === 'src' && t.srcId === x.id)); state.scars = state.scars.filter(sc => sc.srcId !== x.id); const el = srcEl(x.id); if (el) el.remove(); DB.del('blob:' + x.id).catch(() => {}); } state.sources = []; }
  if (!had || !state.sources.length) await addSamples();
  else {                                                        // a save from before: bring in sample pages it never had
    const seen = new Set(state.seenSamples || state.sources.map(x => x.name));
    const fresh = SAMPLES.map(x => x[1]).filter(n => !seen.has(n));
    if (fresh.length) await addSamples(fresh);
  }
  state.seenSamples = SAMPLES.map(x => x[1]); save();
  if (!trayEl.querySelector('.src')) showTrayEmpty();
  handleHash();
  if (!state.tut) tutShow(0);
  requestAnimationFrame(lightLoop);
})();
