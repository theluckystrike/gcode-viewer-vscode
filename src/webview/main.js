// Webview: three.js toolpath view for 3D printer and CNC G-code. All DOM text goes in with textContent.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import G from '../core/gcode.js';

const vscode = acquireVsCodeApi();
const { KIND, PRINT_FEATURES, CNC_KINDS, segmentAtTime, layerOfSegment, fmtDuration, filamentGrams } = G;
const SPEEDS = [1, 10, 60, 300, 1000, 5000];
const TRAVEL_COLOR = 0x6f8fbf;

// ---------- tiny DOM helper (text only, never HTML) ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v; // CSSOM, allowed by the CSP (a style attribute is not)
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

// ---------- layout ----------
const app = document.getElementById('app');
app.textContent = '';
const ui = {};
const btn = (label, title, on, act, extra = {}) => h('button', { type: 'button', title, onclick: on, 'data-act': act, ...extra, text: label });
const state = { travel: false, single: false, grid: true, panel: true, color: 'feature', top: 0, t: null, playing: false, speed: 60, loaded: false, notice: null, picked: null, mode: 'print' };

ui.fit = btn('Fit', 'Fit the toolpath in view (F)', () => fitView(), 'fit');
ui.iso = btn('3D', 'Angled view', () => setView('iso'), 'iso');
ui.topv = btn('Top', 'View from above', () => setView('top'), 'top');
ui.front = btn('Front', 'View from the front', () => setView('front'), 'front');
ui.color = h('select', { 'aria-label': 'Color by', title: 'Color the toolpath by', 'data-act': 'color' });
ui.color.addEventListener('change', () => { state.color = ui.color.value; recolor(); });
const toggle = (label, title, key, act) => {
  const b = btn(label, title, () => setToggle(key, !state[key]), act, { 'aria-pressed': String(!!state[key]) });
  ui['t_' + key] = b; return b;
};
ui.modeSel = h('select', { 'aria-label': 'Read as', title: 'Read the file as 3D printer or CNC G-code', 'data-act': 'mode' },
  h('option', { value: 'print', text: '3D print' }), h('option', { value: 'cnc', text: 'CNC' }));
ui.modeSel.addEventListener('change', () => { vscode.postMessage({ type: 'reload', mode: ui.modeSel.value }); showNotice('Reading the file again as ' + (ui.modeSel.value === 'cnc' ? 'CNC' : '3D print') + ' G-code...', ''); });
ui.panelBtn = btn('Panel', 'Show or hide the stats panel (P)', () => setToggle('panel', !state.panel), 'panel', { 'aria-pressed': 'true' });
ui.toolbar = h('div', { class: 'toolbar', role: 'toolbar' },
  ui.fit, ui.iso, ui.topv, ui.front, h('span', { class: 'sep' }),
  h('label', { class: 'lbl', text: 'Color' }), ui.color,
  toggle('Travel', 'Show travel moves (T)', 'travel', 'travel'), toggle('One layer', 'Show only the current layer (S)', 'single', 'single'), toggle('Grid', 'Build plate grid (G)', 'grid', 'grid'),
  h('span', { class: 'sep' }), ui.modeSel, h('span', { class: 'grow' }), ui.panelBtn);

ui.layer = h('input', { type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Layer', 'data-act': 'layer' });
ui.layerDown = btn('−', 'Previous layer (Down arrow)', () => setLayer(state.top - 1), 'layerdown');
ui.layerUp = btn('+', 'Next layer (Up arrow)', () => setLayer(state.top + 1), 'layerup');
ui.layerText = h('span', { class: 'layertext' });
ui.goto = btn('Go to line', 'Open the text at the first line of this layer', () => reveal(currentLayerLine()), 'goto');
ui.layerLabel = h('span', { class: 'lbl', text: 'Layer' });
ui.layerBar = h('div', { class: 'bar layerbar' }, ui.layerLabel, ui.layerDown, ui.layer, ui.layerUp, ui.layerText, ui.goto);
ui.layer.addEventListener('input', () => setLayer(Number(ui.layer.value)));

ui.play = btn('Play', 'Play the print as an animation (Space)', () => setPlaying(!state.playing), 'play');
ui.speed = h('select', { 'aria-label': 'Playback speed', title: 'Playback speed', 'data-act': 'speed' }, SPEEDS.map((s) => h('option', { value: String(s), text: `${s}×` })));
ui.speed.value = '60';
ui.speed.addEventListener('change', () => { state.speed = Number(ui.speed.value); });
ui.progress = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: '1000', 'aria-label': 'Print progress', 'data-act': 'progress' });
ui.progress.addEventListener('input', () => { setPlaying(false); setTime(Number(ui.progress.value) / 1000 * totalTime()); });
ui.timeText = h('span', { class: 'timetext' });
ui.playBar = h('div', { class: 'bar playbar' }, ui.play, ui.speed, ui.progress, ui.timeText);

ui.stage = h('div', { class: 'stage' });
ui.notice = h('div', { class: 'notice', hidden: true });
ui.stage.append(ui.notice);
ui.stats = h('div', { class: 'stats' });
ui.legend = h('div', { class: 'legend' });
ui.pick = h('div', { class: 'pick' });
ui.copy = h('button', { type: 'button', class: 'link', title: 'Copy the stats as text', text: 'Copy', 'data-act': 'copy', onclick: () => copyStats() });
ui.side = h('aside', { class: 'side' },
  h('section', {}, h('h2', {}, 'Stats ', ui.copy), ui.stats),
  h('section', {}, ui.legendTitle = h('h2', { text: 'Legend' }), ui.legend),
  h('section', {}, h('h2', { text: 'Selected move' }), ui.pick));
ui.status = h('div', { class: 'status' }, ui.hint = h('span', { class: 'hint' }), h('span', { class: 'grow' }), ui.timing = h('span', { class: 'timing' }));
ui.toast = h('div', { class: 'toast', hidden: true });
app.append(ui.toolbar, ui.layerBar, h('div', { class: 'main' }, ui.stage, ui.side), ui.playBar, ui.status, ui.toast);
const supportLine = document.getElementById('zovo-support');
if (supportLine) ui.status.append(supportLine);

function setHint(t) { ui.hint.textContent = t || ''; }
function showNotice(text, kind) {
  ui.notice.hidden = !text;
  ui.notice.textContent = '';
  ui.notice.className = 'notice' + (kind ? ' ' + kind : '');
  if (text) ui.notice.append(h('div', { text }));
  state.notice = text ? (kind || 'info') : null;
}
let toastTimer = null;
function toast(t) { ui.toast.textContent = t; ui.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2500); }
function setControlsEnabled(on) {
  for (const el of document.querySelectorAll('.toolbar button, .toolbar select, .layerbar button, .layerbar input, .playbar button, .playbar select, .playbar input')) if (el !== ui.panelBtn && el !== ui.modeSel) el.disabled = !on;
}
setControlsEnabled(false);

// ---------- three.js setup ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
} catch (e) {
  showNotice('WebGL is not available in this VS Code window, so the toolpath cannot be drawn. ' + (e && e.message ? e.message : ''), 'error');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
ui.stage.prepend(renderer.domElement);
renderer.domElement.setAttribute('aria-label', '3D toolpath view');
renderer.domElement.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); showNotice('The graphics context was lost (the GPU may be busy or out of memory). Close and reopen the file.', 'error'); });

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
camera.up.set(0, 0, 1); // G-code is Z up
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = true;
controls.addEventListener('change', () => invalidate());

let workLines = null, travelLines = null, gridHelper = null, nozzle = null, pickMark = null;
let workIdx = null, travelIdx = null; // global segment index of each drawn segment
let model = null, geo = null, init = null;
let dirty = true, lastTs = 0, firstFrame = true;
const center = new THREE.Vector3();
let radius = 50;
function invalidate() { dirty = true; }

function resize() {
  const r = ui.stage.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width)), hgt = Math.max(1, Math.floor(r.height));
  renderer.setSize(w, hgt, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = hgt + 'px';
  camera.aspect = w / hgt;
  camera.updateProjectionMatrix();
  invalidate();
}
new ResizeObserver(resize).observe(ui.stage);

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
  lastTs = ts;
  const moved = controls.update();
  if (state.playing && geo) {
    const total = totalTime();
    let t = (state.t == null ? 0 : state.t) + dt * state.speed;
    if (t >= total) { t = total; setPlaying(false); }
    setTime(t, true);
  }
  if (!dirty && !moved) return;
  dirty = false;
  renderer.render(scene, camera);
  if (firstFrame && state.loaded) { firstFrame = false; vscode.postMessage({ type: 'rendered' }); }
}

// ---------- background ----------
function themeColor() {
  const v = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
  try { return new THREE.Color(v || '#1e1e1e'); } catch { return new THREE.Color(0x1e1e1e); }
}
function isLight() { const c = scene.background; return c && c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722 > 0.5; }
function applyBackground() {
  scene.background = themeColor();
  document.body.dataset.bg = isLight() ? 'light' : 'dark';
  if (travelLines) travelLines.material.color.set(isLight() ? 0x3a5a99 : TRAVEL_COLOR);
  buildGrid();
  invalidate();
}
new MutationObserver(() => applyBackground()).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

// ---------- model ----------
const fmt = (n, d = 1) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (n) => Number(n).toLocaleString('en-US');
function totalTime() { return geo && geo.tEnd.length ? geo.tEnd[geo.tEnd.length - 1] : 0; }
function layerCount() { return geo ? geo.layerStart.length : 0; }
const layerWord = () => (state.mode === 'cnc' ? 'Z pass' : 'Layer');

function disposeLines() {
  for (const o of [workLines, travelLines]) if (o) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
  workLines = travelLines = null;
}

function buildLines() {
  disposeLines();
  const n = geo.kind.length, P = geo.pts, K = geo.kind;
  let nw = 0, nt = 0;
  for (let i = 0; i < n; i++) { const k = K[i]; if (k === KIND.TRAVEL) nt++; else if (k !== KIND.SKIP) nw++; }
  const wp = new Float32Array(nw * 6), tp = new Float32Array(nt * 6);
  workIdx = new Uint32Array(nw); travelIdx = new Uint32Array(nt);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const k = K[i];
    if (k === KIND.SKIP) continue;
    const o = i * 3;
    if (k === KIND.TRAVEL) { tp.set(P.subarray(o, o + 6), b * 6); travelIdx[b++] = i; } else { wp.set(P.subarray(o, o + 6), a * 6); workIdx[a++] = i; }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.BufferAttribute(wp, 3));
  wg.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(nw * 6), 3, true));
  workLines = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ vertexColors: true }));
  workLines.frustumCulled = false;
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(tp, 3));
  travelLines = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: isLight() ? 0x3a5a99 : TRAVEL_COLOR, transparent: true, opacity: state.mode === 'cnc' ? 0.85 : 0.45 }));
  travelLines.frustumCulled = false;
  travelLines.visible = state.travel;
  scene.add(workLines, travelLines);
}

// colour helpers
const hex = (s) => new THREE.Color(s);
const FEAT_COL = PRINT_FEATURES.map((f) => hex(f[1]));
const CNC_COL = CNC_KINDS.map((f) => hex(f[1]));
const RAMP = ['#2c7bb6', '#00a6ca', '#00ccbc', '#90eb9d', '#ffff8c', '#f9d057', '#f29e2e', '#e76818', '#d7191c'].map(hex);
function ramp(t) {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return RAMP[i].clone().lerp(RAMP[i + 1], x - i);
}
const TOOL_COL = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8', '#fff176', '#4db6ac', '#f06292'].map(hex);

function colorOptions() {
  return state.mode === 'cnc'
    ? [['move', 'Move type'], ['speed', 'Feed rate'], ['layer', 'Z pass'], ['tool', 'Tool']]
    : [['feature', 'Feature'], ['speed', 'Speed'], ['layer', 'Layer']];
}

function recolor() {
  if (!workLines) return;
  const col = workLines.geometry.attributes.color;
  const arr = col.array;
  const n = workIdx.length;
  const mode = state.color;
  const fmin = model.feedMin, fmax = model.feedMax;
  const L = layerCount();
  let li = 0;
  const c = new THREE.Color();
  for (let j = 0; j < n; j++) {
    const i = workIdx[j];
    if (mode === 'feature') c.copy(FEAT_COL[geo.feat[i]] || FEAT_COL[0]);
    else if (mode === 'move') c.copy(CNC_COL[geo.kind[i]] || CNC_COL[1]);
    else if (mode === 'tool') c.copy(TOOL_COL[geo.feat[i] % TOOL_COL.length]);
    else if (mode === 'speed') c.copy(ramp(fmax > fmin ? (geo.feed[i] - fmin) / (fmax - fmin) : 0.5));
    else {
      while (li + 1 < L && geo.layerStart[li + 1] <= i) li++;
      c.copy(ramp(L > 1 ? li / (L - 1) : 0.5));
    }
    const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
    const o = j * 6;
    arr[o] = arr[o + 3] = r; arr[o + 1] = arr[o + 4] = g; arr[o + 2] = arr[o + 5] = b;
  }
  col.needsUpdate = true;
  renderLegend();
  invalidate();
}

function lowerBound(a, v) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }

// draw global segments [g0, g1)
let range = [0, 0];
function drawRange(g0, g1) {
  range = [g0, g1];
  if (workLines) { const a = lowerBound(workIdx, g0), b = lowerBound(workIdx, g1); workLines.geometry.setDrawRange(a * 2, (b - a) * 2); }
  if (travelLines) { const a = lowerBound(travelIdx, g0), b = lowerBound(travelIdx, g1); travelLines.geometry.setDrawRange(a * 2, (b - a) * 2); }
  invalidate();
}

function layerEnd(l) { return l + 1 < layerCount() ? geo.layerStart[l + 1] : geo.kind.length; }
function currentLayerLine() { return geo && layerCount() ? geo.layerLine[state.top] || 1 : 1; }

function updateLayerText() {
  if (!geo || !layerCount()) { ui.layerText.textContent = 'No layers'; return; }
  const l = state.top;
  const z = geo.layerZ[l];
  ui.layerText.textContent = `${fmtInt(l + 1)} / ${fmtInt(layerCount())} · Z ${fmt(z, 2)} mm · line ${fmtInt(geo.layerLine[l])}`;
}

function setLayer(l, keepTime) {
  if (!geo || !layerCount()) return;
  l = Math.max(0, Math.min(layerCount() - 1, l));
  state.top = l;
  ui.layer.value = String(l);
  updateLayerText();
  if (!keepTime) {
    setPlaying(false);
    state.t = null;
    const end = layerEnd(l);
    ui.progress.value = String(Math.round((end > 0 && totalTime() > 0 ? geo.tEnd[end - 1] / totalTime() : 1) * 1000));
    updateTimeText(end > 0 ? geo.tEnd[end - 1] : 0);
    drawRange(state.single ? geo.layerStart[l] : 0, end);
    if (nozzle) nozzle.visible = false;
  }
}

function setTime(t, fromPlay) {
  if (!geo || !geo.kind.length) return;
  const total = totalTime();
  t = Math.max(0, Math.min(total, t));
  state.t = t;
  let s = segmentAtTime(geo.tEnd, t); // segment being drawn at time t
  if (s >= geo.kind.length) s = geo.kind.length - 1;
  const l = Math.max(0, layerOfSegment(geo.layerStart, s));
  if (l !== state.top) { state.top = l; ui.layer.value = String(l); updateLayerText(); }
  drawRange(state.single ? geo.layerStart[l] : 0, t >= total ? geo.kind.length : s);
  // nozzle position inside segment s
  const t0 = s > 0 ? geo.tEnd[s - 1] : 0, t1 = geo.tEnd[s];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
  const P = geo.pts, o = s * 3;
  if (nozzle) {
    nozzle.position.set(P[o] + (P[o + 3] - P[o]) * f, P[o + 1] + (P[o + 4] - P[o + 1]) * f, P[o + 2] + (P[o + 5] - P[o + 2]) * f);
    nozzle.visible = t < total;
  }
  if (!fromPlay || Math.random() < 0.25) ui.progress.value = String(Math.round(total > 0 ? (t / total) * 1000 : 1000));
  updateTimeText(t);
  invalidate();
}

function updateTimeText(t) { ui.timeText.textContent = `${fmtDuration(t)} / ${fmtDuration(totalTime())}`; }

function setPlaying(on) {
  if (on && geo) {
    if (state.t == null || state.t >= totalTime()) {
      // start from the beginning of the shown layer (or the start when the whole print is shown)
      const l = state.top;
      state.t = l >= layerCount() - 1 || l <= 0 ? 0 : geo.layerTime[l];
    }
  }
  state.playing = !!on && !!geo;
  if (state.playing && pickMark) pickMark.visible = false;
  ui.play.textContent = state.playing ? 'Pause' : 'Play';
  ui.play.setAttribute('aria-pressed', String(state.playing));
}

function setToggle(key, on) {
  state[key] = on;
  const b = ui['t_' + key] || (key === 'panel' ? ui.panelBtn : null);
  if (b) b.setAttribute('aria-pressed', String(on));
  if (key === 'travel' && travelLines) travelLines.visible = on;
  if (key === 'grid' && gridHelper) gridHelper.visible = on;
  if (key === 'panel') { ui.side.hidden = !on; resize(); }
  if (key === 'single') { if (state.t != null) setTime(state.t); else setLayer(state.top); }
  invalidate();
}

function buildGrid() {
  if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); gridHelper = null; }
  if (!model || !model.bounds.all) return;
  const b = model.bounds.work || model.bounds.all;
  const span = Math.max(b[3] - b[0], b[4] - b[1], 10);
  const step = span > 400 ? 50 : span > 120 ? 10 : span > 30 ? 5 : 1;
  const size = Math.ceil((span * 1.4) / (step * 2)) * step * 2;
  const light = isLight();
  gridHelper = new THREE.GridHelper(size, size / step, light ? 0x9a9a9a : 0x5a5a5a, light ? 0xd4d4d4 : 0x333333);
  gridHelper.rotation.x = Math.PI / 2; // XY plane
  gridHelper.position.set(Math.round((b[0] + b[3]) / 2 / step) * step, Math.round((b[1] + b[4]) / 2 / step) * step, state.mode === 'cnc' ? Math.min(0, b[2]) - 0.01 : 0);
  gridHelper.visible = state.grid;
  scene.add(gridHelper);
}

function buildNozzle() {
  if (nozzle) { scene.remove(nozzle); nozzle.geometry.dispose(); nozzle.material.dispose(); }
  const s = Math.max(0.6, radius * 0.025);
  const g = new THREE.ConeGeometry(s * 0.45, s * 1.4, 16);
  g.rotateX(-Math.PI / 2); // tip points down (-Z)
  g.translate(0, 0, s * 0.7);
  nozzle = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff3d71 }));
  nozzle.visible = false;
  scene.add(nozzle);
}

function fitView() {
  if (!model) return;
  const b = model.bounds.work || model.bounds.all;
  if (!b) return;
  center.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
  radius = Math.max(1, 0.5 * Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]));
  setView(state.view || 'iso');
}
function setView(v) {
  state.view = v;
  const d = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
  const dir = v === 'top' ? new THREE.Vector3(0, -0.0001, 1) : v === 'front' ? new THREE.Vector3(0, -1, 0.02) : new THREE.Vector3(-0.55, -1, 0.75);
  dir.normalize();
  camera.position.copy(center).addScaledVector(dir, d);
  camera.near = Math.max(0.01, d / 1000); camera.far = d * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  invalidate();
}

// ---------- panel ----------
function row(k, v) { return h('div', { class: 'row' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })); }
let statRows = [];
function renderStats() {
  const m = model;
  const rows = [];
  rows.push(['File', `${init.name} · ${init.sizeText}`]);
  rows.push(['Read as', m.mode === 'cnc' ? 'CNC program' : '3D printer G-code']);
  if (m.slicer) rows.push(['Made by', m.slicer]);
  if (m.flavor) rows.push(['Flavor', m.flavor]);
  rows.push([m.mode === 'cnc' ? 'Z passes' : 'Layers', fmtInt(m.layersTotal) + (m.layerSource === 'comments' ? ' (from slicer comments)' : ' (from Z heights)')]);
  rows.push(['Lines', fmtInt(m.lines)]);
  rows.push(['Moves', `${fmtInt(m.moves)}${m.arcs ? ` (${fmtInt(m.arcs)} arcs)` : ''}`]);
  rows.push([m.mode === 'cnc' ? 'Cycle time' : 'Print time', `${fmtDuration(m.timeS)} (estimate from feed rates)`]);
  if (m.slicerTime != null) rows.push(['Slicer time', fmtDuration(m.slicerTime)]);
  if (m.mode !== 'cnc') {
    const g = filamentGrams(m.filamentMm, init.filament.diameter, init.filament.density);
    rows.push(['Filament', `${fmt(m.filamentMm / 1000, 2)} m · ${fmt(g, 1)} g`]);
    if (m.slicerFilamentMm != null) rows.push(['Slicer filament', `${fmt(m.slicerFilamentMm / 1000, 2)} m${m.slicerFilamentG != null ? ` · ${fmt(m.slicerFilamentG, 1)} g` : ''}`]);
    if (m.retracts) rows.push(['Retractions', fmtInt(m.retracts)]);
    if (m.temps.nozzle || m.temps.bed) rows.push(['Temperatures', `nozzle ${m.temps.nozzle} °C · bed ${m.temps.bed} °C`]);
  } else {
    rows.push(['Cut length', `${fmt(m.workLen / 1000, 2)} m`]);
    rows.push(['Rapid length', `${fmt(m.travelLen / 1000, 2)} m`]);
    if (m.tools.length) rows.push(['Tools', m.tools.join(', ')]);
    if (m.spindleMax) rows.push(['Spindle', `up to ${fmtInt(m.spindleMax)} rpm`]);
    if (m.dwells) rows.push(['Dwells', fmtInt(m.dwells)]);
  }
  const b = m.bounds.work;
  if (b) {
    rows.push(['Size', `${fmt(b[3] - b[0])} × ${fmt(b[4] - b[1])} × ${fmt(b[5] - b[2])} mm`]);
    rows.push(['X range', `${fmt(b[0])} to ${fmt(b[3])}`]); rows.push(['Y range', `${fmt(b[1])} to ${fmt(b[4])}`]); rows.push(['Z range', `${fmt(b[2], 2)} to ${fmt(b[5], 2)}`]);
  }
  if (m.feedMax) rows.push([m.mode === 'cnc' ? 'Feed' : 'Speed', m.mode === 'cnc' ? `${fmtInt(m.feedMin)} to ${fmtInt(m.feedMax)} mm/min` : `${fmt(m.feedMin / 60, 0)} to ${fmt(m.feedMax / 60, 0)} mm/s`]);
  rows.push(['Read in', `${fmtInt(m.parseMs)} ms`]);
  statRows = rows;
  ui.stats.textContent = '';
  for (const [k, v] of rows) ui.stats.append(row(k, v));
  for (const w of m.warnings) ui.stats.append(h('div', { class: 'warn', text: w }));
}

function renderLegend() {
  ui.legend.textContent = '';
  const m = model;
  if (!m) return;
  const mode = state.color;
  ui.legendTitle.textContent = 'Legend · ' + (colorOptions().find((o) => o[0] === mode) || ['', ''])[1];
  const sw = (c) => h('span', { class: 'sw', style: `background:#${c.getHexString()}` });
  if (mode === 'feature' || mode === 'move') {
    const total = m.featureStats.reduce((s, f) => s + (mode === 'move' && f.id === 0 ? 0 : f.len), 0) || 1;
    for (const f of m.featureStats) {
      const share = mode === 'move' && f.id === 0 ? '' : ` ${fmt((f.len / total) * 100, 0)}%`;
      ui.legend.append(h('div', { class: 'lrow' }, sw(hex(f.color)), h('span', { class: 'lname', text: f.name }), h('span', { class: 'lval', text: `${fmt(f.len / 1000, 2)} m · ${fmtDuration(f.time)}${share}` })));
    }
    if (mode === 'feature' && !m.hasFeatureComments) ui.legend.append(h('div', { class: 'muted', text: 'The file has no ;TYPE: feature comments, so all extrusion has one color.' }));
  } else if (mode === 'tool') {
    m.tools.forEach((t, i) => ui.legend.append(h('div', { class: 'lrow' }, sw(TOOL_COL[i % TOOL_COL.length]), h('span', { class: 'lname', text: t }))));
  } else {
    const lo = mode === 'speed' ? m.feedMin : 1, hi = mode === 'speed' ? m.feedMax : Math.max(1, layerCount());
    const unit = mode === 'speed' ? (m.mode === 'cnc' ? ' mm/min' : ' mm/s') : '';
    const v = (x) => (mode === 'speed' && m.mode !== 'cnc' ? fmt(x / 60, 0) : fmtInt(Math.round(x)));
    const bar = h('div', { class: 'ramp' });
    bar.style.background = `linear-gradient(to right, ${RAMP.map((c) => '#' + c.getHexString()).join(', ')})`;
    ui.legend.append(bar, h('div', { class: 'rampv' }, h('span', { text: v(lo) + unit }), h('span', { text: v(hi) + unit })));
  }
  ui.legend.append(h('div', { class: 'lrow' }, h('span', { class: 'sw', style: 'background:#' + new THREE.Color(isLight() ? 0x3a5a99 : TRAVEL_COLOR).getHexString() }), h('span', { class: 'lname', text: m.mode === 'cnc' ? 'Rapid (G0), with Travel on' : 'Travel, with Travel on' }), h('span', { class: 'lval', text: `${fmt(m.travelLen / 1000, 2)} m` })));
}

function renderPick() {
  ui.pick.textContent = '';
  const p = state.picked;
  if (!p) { ui.pick.append(h('div', { class: 'muted', text: 'Click a line in the view to see its G-code line.' })); return; }
  const i = p.seg;
  const k = geo.kind[i];
  const kindName = state.mode === 'cnc' ? CNC_KINDS[k] ? CNC_KINDS[k][0] : 'Move' : k === KIND.TRAVEL ? 'Travel' : (PRINT_FEATURES[geo.feat[i]] || PRINT_FEATURES[0])[0];
  const l = layerOfSegment(geo.layerStart, i);
  const feed = geo.feed[i];
  ui.pick.append(row('Line', fmtInt(geo.line[i])), row('Type', kindName), row(layerWord(), `${fmtInt(l + 1)}`),
    row('Speed', state.mode === 'cnc' ? `${fmtInt(feed)} mm/min` : `${fmt(feed / 60, 0)} mm/s`),
    row('At', `${fmtDuration(geo.tEnd[i])} into the ${state.mode === 'cnc' ? 'program' : 'print'}`),
    h('button', { type: 'button', class: 'link', 'data-act': 'gotopick', text: `Go to line ${fmtInt(geo.line[i])}`, onclick: () => reveal(geo.line[i]) }));
}

function reveal(line) { if (line >= 1) vscode.postMessage({ type: 'reveal', line }); }

function copyStats() {
  if (!model) return;
  const text = statRows.map(([k, v]) => `${k}\t${v}`).concat(model.warnings).join('\n');
  vscode.postMessage({ type: 'copy', text });
}

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 4 || !workLines) return;
  pickAt(e.clientX, e.clientY);
});
function pickAt(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const dist = camera.position.distanceTo(controls.target);
  raycaster.params.Line.threshold = (dist * Math.tan((camera.fov * Math.PI) / 360) * 2 / r.height) * 5;
  const targets = [workLines]; if (state.travel) targets.push(travelLines);
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) { state.picked = null; if (pickMark) pickMark.visible = false; renderPick(); invalidate(); return null; }
  // the visible top of the stack is usually what the user meant: prefer the highest layer among close hits
  const best = hits.slice(0, 8).reduce((a, b2) => (b2.point.z > a.point.z + 1e-3 ? b2 : a));
  const local = Math.floor(best.index / 2);
  const seg = best.object === workLines ? workIdx[local] : travelIdx[local];
  state.picked = { seg };
  if (!pickMark) { pickMark = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })); scene.add(pickMark); }
  pickMark.scale.setScalar(Math.max(0.25, radius * 0.008));
  pickMark.position.copy(best.point);
  pickMark.visible = true;
  renderPick();
  invalidate();
  return seg;
}

// ---------- keys ----------
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!state.loaded) return;
  const k = e.key;
  if (k === 'ArrowUp' || k === 'ArrowRight') { setLayer(state.top + 1); e.preventDefault(); } else if (k === 'ArrowDown' || k === 'ArrowLeft') { setLayer(state.top - 1); e.preventDefault(); } else if (k === 'Home') setLayer(0);
  else if (k === 'End') setLayer(layerCount() - 1);
  else if (k === ' ') { setPlaying(!state.playing); e.preventDefault(); } else if (k === 'f' || k === 'F') fitView();
  else if (k === 't' || k === 'T') setToggle('travel', !state.travel);
  else if (k === 's' || k === 'S') setToggle('single', !state.single);
  else if (k === 'g' || k === 'G') setToggle('grid', !state.grid);
  else if (k === 'p' || k === 'P') setToggle('panel', !state.panel);
});

// ---------- messages ----------
function onModel(m, ms) {
  model = m; geo = m.geo; state.mode = m.mode;
  ui.modeSel.value = m.mode;
  ui.color.textContent = '';
  for (const [v, label] of colorOptions()) ui.color.append(h('option', { value: v, text: label }));
  if (!colorOptions().some((o) => o[0] === state.color)) state.color = colorOptions()[0][0];
  ui.color.value = state.color;
  ui.layerLabel.textContent = layerWord();
  ui.t_travel.textContent = m.mode === 'cnc' ? 'Rapids' : 'Travel';
  ui.t_travel.title = m.mode === 'cnc' ? 'Show G0 rapid moves (T)' : 'Show travel moves (T)';
  if (m.mode === 'cnc' && !state.travelSetByUser) { state.travel = true; ui.t_travel.setAttribute('aria-pressed', 'true'); }
  ui.t_single.textContent = m.mode === 'cnc' ? 'One pass' : 'One layer';
  if (!geo.kind.length) {
    disposeLines();
    showNotice(`No moves were found in ${init.name}. It may not be G-code. Lines read: ${fmtInt(m.lines)}.`, 'error');
    ui.notice.append(h('div', { class: 'actions' }, h('button', { type: 'button', 'data-act': 'reopen', text: 'Reopen with another editor', onclick: () => vscode.postMessage({ type: 'reopenWith' }) })));
    state.loaded = true; setControlsEnabled(false); return;
  }
  showNotice(null);
  scene.background = themeColor();
  buildLines();
  const first = !state.everLoaded;
  state.everLoaded = true;
  fitRadius();
  buildGrid(); buildNozzle();
  recolor();
  ui.layer.max = String(Math.max(0, layerCount() - 1));
  state.picked = null; if (pickMark) pickMark.visible = false;
  renderStats(); renderPick();
  setControlsEnabled(true);
  if (first) fitView();
  setLayer(layerCount() - 1);
  ui.timing.textContent = `${fmtInt(m.segments)} moves drawn · read in ${fmtInt(ms)} ms`;
  setHint(m.mode === 'cnc' ? 'Drag to orbit, right-drag to pan, scroll to zoom. Up and Down step through Z passes.' : 'Drag to orbit, right-drag to pan, scroll to zoom. Up and Down step through layers. Click a line to find it in the file.');
  state.loaded = true;
  invalidate();
}
function fitRadius() {
  const b = model.bounds.work || model.bounds.all;
  if (b) { center.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2); radius = Math.max(1, 0.5 * Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2])); }
}
ui.t_travel.addEventListener('click', () => { state.travelSetByUser = true; });

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') {
    init = m;
    if (!m.plan.load) { state.loaded = true; showNotice(m.plan.message, 'big'); setHint(''); return; }
    if (!state.everLoaded) showNotice(`Reading ${m.name} (${m.sizeText})...`, '');
    if (m.mode === 'print' || m.mode === 'cnc') ui.modeSel.value = m.mode;
  } else if (m.type === 'progress') {
    if (!state.everLoaded) showNotice(`Reading ${init ? init.name : 'the file'}... ${Math.round((m.done / m.total) * 100)}%`, '');
    else setHint(`Reading again... ${Math.round((m.done / m.total) * 100)}%`);
  } else if (m.type === 'model') {
    try { onModel(m.model, m.ms); } catch (e) { showNotice('The toolpath could not be drawn. ' + (e && e.message ? e.message : String(e)), 'error'); state.loaded = true; }
  } else if (m.type === 'notGcode') {
    state.loaded = true;
    showNotice(m.message, 'error');
    ui.notice.append(h('div', { class: 'actions' }, h('button', { type: 'button', 'data-act': 'reopen', text: 'Reopen with another editor', onclick: () => vscode.postMessage({ type: 'reopenWith' }) })));
    state.notGcode = m.kind;
  } else if (m.type === 'error') {
    state.loaded = true;
    if (m.soft) { toast(m.message); return; }
    showNotice('The file could not be read. ' + m.message, 'error');
  } else if (m.type === 'copied') toast('Copied the stats.');
  else if (m.type === 'changed') toast('The file changed on disk. Reading it again.');
});

// state for the release check in a real VS Code window
window.gcodeViewerProbe = () => ({
  loaded: state.loaded, notice: state.notice, notGcode: state.notGcode || null, mode: state.mode, color: state.color,
  layers: layerCount(), top: state.top, single: state.single, travel: state.travel, playing: state.playing, t: state.t, total: totalTime(),
  range, workDrawn: workLines ? workLines.geometry.drawRange.count / 2 : 0, travelDrawn: travelLines && travelLines.visible ? travelLines.geometry.drawRange.count / 2 : 0,
  picked: state.picked ? { seg: state.picked.seg, line: geo.line[state.picked.seg] } : null,
  nozzle: nozzle && nozzle.visible ? nozzle.position.toArray().map((v) => +v.toFixed(2)) : null,
  stats: statRows, bg: document.body.dataset.bg, segments: geo ? geo.kind.length : 0,
});
// screen position of a world point, for the release check's real clicks
window.gcodeViewerProject = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(camera); const r = renderer.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; };
window.gcodeViewerFirstWork = (layer, feat) => {
  if (!geo || layer < 0 || layer >= layerCount()) return -1;
  for (let i = geo.layerStart[layer]; i < layerEnd(layer); i++) {
    if (geo.kind[i] === KIND.TRAVEL || geo.kind[i] === KIND.SKIP || (feat != null && geo.feat[i] !== feat)) continue;
    const o = i * 3; if (Math.hypot(geo.pts[o + 3] - geo.pts[o], geo.pts[o + 4] - geo.pts[o + 1]) > 4) return i;
  }
  return -1;
};
window.gcodeViewerLine = (i) => (geo ? geo.line[i] : 0);
window.gcodeViewerSegment = (i) => (geo ? Array.from(geo.pts.subarray(i * 3, i * 3 + 6)) : null);

applyBackground();
resize();
requestAnimationFrame(frame);
vscode.postMessage({ type: 'ready' });
