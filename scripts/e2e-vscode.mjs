// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated samples,
// drives the webview with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('./make-samples.js');

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
// extra test files next to the samples: a NetCDF-looking .nc, a sparse 600 MB file and a 60 MB program
fs.writeFileSync(path.join(ws, 'ocean-data.nc'), Buffer.concat([Buffer.from('CDF\x01', 'latin1'), Buffer.alloc(4096)]));
const huge = path.join(ws, 'huge.gcode'); { const fd = fs.openSync(huge, 'w'); fs.writeSync(fd, 'G1 X1\n'); fs.ftruncateSync(fd, 600 * 1024 * 1024); fs.closeSync(fd); }
const big = path.join(ws, 'big-vase-x30.gcode'); { const v = S.vase(); const fd = fs.openSync(big, 'w'); for (let i = 0; i < 30; i++) fs.writeSync(fd, v); fs.closeSync(fd); }
for (const f of fs.readdirSync(ws)) if (fs.statSync(path.join(ws, f)).size < 50e6) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, { 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left' });
const shots = [];
const shot = async (name) => { const f = path.join(shotDir, `gcode-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 600), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = (expr) => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.gcodeViewerProbe ? window.gcodeViewerProbe() : null)`));
const getWv = async (title) => vs.waitFor(async () => (await vs.webviews()).find((w) => w.title === title && w.w > 0), 30000);
const open = async (file) => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(800); wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file); return Date.now() - t0; };
const loaded = async (ms = 30000) => { const ok = await vs.waitFor(async () => { const p = await probe(); return p?.loaded; }, ms, 200); if (!ok) throw new Error('not loaded: ' + await E(`document.body.innerText.slice(0, 400)`)); await sleep(500); return probe(); };
const btn = (act) => `document.querySelector('[data-act="${act}"]')`;
const stat = (p, k) => (p.stats.find((r) => r[0] === k) || [])[1];
const mouse = (type, x, y, extra = {}) => vs.s.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, vs.wb);
const clickRange = async (act, frac) => { const off = await vs.wvOffset(); const b = JSON.parse(await E(`JSON.stringify(${btn(act)}.getBoundingClientRect())`)); await vs.click(off.x + b.x + 8 + (b.width - 16) * frac, off.y + b.y + b.height / 2); };
const selectValue = (act, v) => E(`(() => { const s = ${btn(act)}; s.focus(); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
const statusLine = () => vs.wbEval(`(() => { const e = [...document.querySelectorAll('.statusbar-item')].find(x => /Ln \\d+, Col \\d+/.test(x.textContent)); return e ? e.textContent.trim() : ''; })()`);
const activeTab = () => vs.wbEval(`(() => { const t = document.querySelector('.tab.active'); return t ? t.textContent.trim() : ''; })()`);

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('cube-with-hole.gcode opens by default in 3D, colored by feature, all 100 layers', async () => {
    const ms = await open('cube-with-hole.gcode'); const p = await loaded();
    if (p.mode !== 'print' || p.layers !== 100 || p.top !== 99 || p.workDrawn < 10000 || p.color !== 'feature' || !/100 \(from slicer comments\)/.test(stat(p, 'Layers'))) throw new Error(JSON.stringify(p));
    const legend = await E(`[...document.querySelectorAll('.legend .lrow')].map(r => r.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
    await shot('cube-feature');
    return { openMs: ms, printTime: stat(p, 'Print time'), filament: stat(p, 'Filament'), size: stat(p, 'Size'), legend };
  });
  await step('layer slider (real click at 40%) and One layer toggle', async () => {
    await clickRange('layer', 0.4); await sleep(300);
    const p = await probe();
    await vs.wvClick(wv, btn('single')); await sleep(300);
    const q = await probe();
    const text = await E(`document.querySelector('.layertext').textContent`);
    await shot('cube-one-layer');
    await vs.wvClick(wv, btn('single')); await sleep(200);
    if (!(p.top > 30 && p.top < 50) || p.range[0] !== 0 || !q.single || q.range[0] === 0 || q.workDrawn >= p.workDrawn) throw new Error(JSON.stringify({ p, q }));
    return { layer: p.top + 1, text, drawnAll: p.workDrawn, drawnOne: q.workDrawn };
  });
  await step('Up and Down keys step one layer', async () => {
    const p0 = await probe();
    const c = await vs.wvOffset(); await vs.click(c.x + 60, c.y + 200); await sleep(200);
    await vs.key('ArrowUp', 'ArrowUp'); await vs.key('ArrowUp', 'ArrowUp'); await vs.key('ArrowDown', 'ArrowDown'); await sleep(200);
    const p1 = await probe();
    if (p1.top !== p0.top + 1) throw new Error(JSON.stringify({ before: p0.top, after: p1.top }));
    return { before: p0.top + 1, after: p1.top + 1 };
  });
  await step('Go to line opens the text beside the preview at the ;LAYER: line', async () => {
    const p = await probe();
    const want = fs.readFileSync(path.join(ws, 'cube-with-hole.gcode'), 'utf8').split('\n').indexOf(`;LAYER:${p.top}`) + 1;
    await vs.wvClick(wv, btn('goto'));
    const st = await vs.waitFor(async () => { const s = await statusLine(); return s.includes(`Ln ${want},`) ? s : null; }, 10000);
    await sleep(500);
    await shot('go-to-line');
    if (!st) throw new Error('status line: ' + await statusLine() + ' want ' + want);
    await vs.command('View: Close Editor'); await sleep(600);
    await open('cube-with-hole.gcode'); await loaded();
    return { layer: p.top + 1, line: want, status: st };
  });
  await step('click a move in the 3D view: picked line matches the G-code line of that move', async () => {
    const p = await probe();
    const seg = await E(`window.gcodeViewerFirstWork(${p.top}, 1)`);
    const [x0, y0, z0, x1, y1, z1] = JSON.parse(await E(`JSON.stringify(window.gcodeViewerSegment(${seg}))`));
    const [sx, sy] = JSON.parse(await E(`JSON.stringify(window.gcodeViewerProject(${(x0 + x1) / 2}, ${(y0 + y1) / 2}, ${(z0 + z1) / 2}))`));
    const off = await vs.wvOffset();
    await vs.click(off.x + sx, off.y + sy); await sleep(400);
    const q = await probe();
    const want = await E(`window.gcodeViewerLine(${seg})`);
    const panel = await E(`document.querySelector('.pick').innerText.replace(/\\s+/g, ' ')`);
    await shot('picked-move');
    const lineText = fs.readFileSync(path.join(ws, 'cube-with-hole.gcode'), 'utf8').split('\n')[want - 1];
    if (!q.picked || Math.abs(q.picked.line - want) > 2) throw new Error(JSON.stringify({ picked: q.picked, want, panel }));
    return { picked: q.picked.line, expected: want, gcode: lineText, panel };
  });
  await step('Color by speed and by layer; Travel toggle shows travel moves', async () => {
    await vs.wvClick(wv, btn('layer')); await vs.key('End', 'End'); await sleep(200);
    await selectValue('color', 'speed'); await sleep(300);
    const p = await probe();
    const legend = await E(`document.querySelector('.legend').innerText.replace(/\\s+/g, ' ')`);
    await vs.wvClick(wv, btn('travel')); await sleep(300);
    const q = await probe();
    await shot('cube-speed-travel');
    await vs.wvClick(wv, btn('travel')); await selectValue('color', 'layer'); await sleep(300);
    const r = await probe();
    await selectValue('color', 'feature');
    if (p.color !== 'speed' || !/20 mm\/s.*60 mm\/s/.test(legend) || !q.travel || q.travelDrawn < 1000 || r.color !== 'layer') throw new Error(JSON.stringify({ p, q, legend }));
    return { legend, travelDrawn: q.travelDrawn };
  });
  await step('Play animates the print with a nozzle marker; Pause stops it; the progress bar seeks', async () => {
    await vs.wvClick(wv, btn('play')); await sleep(1800);
    const p = await probe();
    await shot('cube-playing');
    await vs.wvClick(wv, btn('play')); await sleep(300);
    const q = await probe(); await sleep(500); const q2 = await probe();
    await clickRange('progress', 0.5); await sleep(300);
    const r = await probe();
    if (!p.playing || !(p.t > 0) || !p.nozzle || q.playing || q.t !== q2.t || Math.abs(r.t / r.total - 0.5) > 0.03) throw new Error(JSON.stringify({ p, q, r }));
    await vs.key('End', 'End');
    return { tAfter18s: p.t, total: p.total, nozzle: p.nozzle, seekTo: r.t, layerAtHalf: r.top + 1 };
  });
  await step('Copy puts the stats on the clipboard', async () => {
    let clip = '';
    for (let i = 0; i < 3 && !clip.startsWith('File\tcube-with-hole.gcode'); i++) { await vs.wvClick(wv, btn('copy')); await sleep(400); clip = execSync('pbpaste', { encoding: 'utf8' }); }
    if (!/^File\tcube-with-hole\.gcode/.test(clip) || !/Layers\t100/.test(clip)) throw new Error(clip.slice(0, 200));
    return { lines: clip.split('\n').length };
  });
  await step('spiral-vase.gcode: 360 layers, speed colors', async () => {
    await open('spiral-vase.gcode'); const p = await loaded();
    await selectValue('color', 'speed'); await sleep(400);
    await shot('vase-speed');
    await selectValue('color', 'feature');
    if (p.layers !== 360 || p.mode !== 'print') throw new Error(JSON.stringify(p));
    return { layers: p.layers, time: stat(p, 'Print time'), filament: stat(p, 'Filament') };
  });
  await step('cnc-pocket.nc opens in CNC mode with Z passes, tools, arcs and rapids', async () => {
    await open('cnc-pocket.nc'); const p = await loaded();
    const legend = await E(`document.querySelector('.legend').innerText.replace(/\\s+/g, ' ')`);
    await shot('cnc-pocket');
    if (p.mode !== 'cnc' || p.layers !== 4 || !p.travel || stat(p, 'Tools') !== 'T1, T2' || !/Arc \(G2\/G3\)/.test(legend) || !/Plunge/.test(legend)) throw new Error(JSON.stringify({ p, legend }));
    await clickRange('layer', 0.0); await sleep(200);
    const q = await probe();
    const t = await E(`document.querySelector('.layertext').textContent`);
    return { passes: p.layers, cycleTime: stat(p, 'Cycle time'), tools: stat(p, 'Tools'), firstPass: t, drawnFirstPass: q.workDrawn };
  });
  await step('ocean-data.nc (NetCDF bytes): clear message and a reopen button', async () => {
    await open('ocean-data.nc'); const p = await loaded();
    const t = await E(`document.querySelector('.notice').innerText`);
    await shot('netcdf-message');
    if (p.notGcode !== 'netcdf' || !/NetCDF data file/.test(t) || !/Reopen with another editor/.test(t)) throw new Error(t);
    return { notice: t.replace(/\s+/g, ' ') };
  });
  await step('huge.gcode (sparse 600 MB): clear message, the file is not read', async () => {
    await open('huge.gcode'); const p = await loaded();
    const t = await E(`document.querySelector('.notice').innerText`);
    await shot('over-500mb-message');
    if (p.notice !== 'big' || !/600\.0 MB\. GCode Viewer opens files up to 500\.0 MB.*not read/.test(t)) throw new Error(t);
    return { notice: t };
  });
  await step('big-vase-x30.gcode (60 MB): read in the worker while the workbench stays responsive', async () => {
    const t0 = Date.now();
    vs.open(big); await sleep(300);
    const lat = [];
    let p = null;
    for (let i = 0; i < 300 && !p; i++) {
      const a = Date.now(); await vs.wbEval('1+1'); lat.push(Date.now() - a);
      const w = (await vs.webviews()).find((x) => x.title === 'big-vase-x30.gcode' && x.w > 0);
      if (w) { wv = w; try { const q = await probe(); if (q && q.loaded) p = q; } catch {} }
      await sleep(100);
    }
    if (!p) throw new Error('not loaded');
    const ms = Date.now() - t0;
    await shot('big-60mb');
    lat.sort((a, b) => a - b);
    if (p.layers !== 360 * 30 || lat[lat.length - 1] > 1500) throw new Error(JSON.stringify({ layers: p.layers, maxLat: lat[lat.length - 1] }));
    return { mb: +(fs.statSync(big).size / 1048576).toFixed(1), openToDrawnMs: ms, moves: p.segments, readIn: stat(p, 'Read in'), workbenchLatencyMaxMs: lat[lat.length - 1], workbenchLatencyMedianMs: lat[lat.length >> 1] };
  });
  await step('file changed on disk: the view reads it again', async () => {
    const f = path.join(ws, 'edited.gcode');
    fs.writeFileSync(f, ';LAYER:0\nG1 X10 Y0 Z0.2 E1 F1200\nG1 X10 Y10 E2\n');
    await open('edited.gcode'); const p = await loaded();
    await sleep(1500); // let the file watcher start
    fs.appendFileSync(f, ';LAYER:1\nG1 X0 Y10 Z0.4 E3\nG1 X0 Y0 E4\n');
    const t0 = Date.now();
    const q = await vs.waitFor(async () => { const r = await probe(); return r.layers === 2 ? r : null; }, 20000);
    if (q) q.reloadMs = Date.now() - t0;
    fs.rmSync(f);
    if (p.layers !== 1 || !q) throw new Error(JSON.stringify({ p, q }));
    return { before: p.layers, after: q.layers, reloadMs: q.reloadMs };
  });
  await step('Default Light Modern theme: background and grid follow the theme', async () => {
    const sf = path.join(vs.ud, 'User', 'settings.json');
    const set = (theme) => { const j = JSON.parse(fs.readFileSync(sf, 'utf8')); j['workbench.colorTheme'] = theme; fs.writeFileSync(sf, JSON.stringify(j, null, 1)); };
    set('Default Light Modern'); await sleep(2000);
    await open('cube-with-hole.gcode'); const p = await loaded();
    await sleep(500);
    await shot('cube-light-theme');
    set('Default Dark Modern'); await sleep(800);
    if (p.bg !== 'light') throw new Error(JSON.stringify(p));
    return { bg: p.bg };
  });
} finally {
  R.console = vs.console.filter((c) => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /gcode|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  for (const f of [huge, big, path.join(ws, 'ocean-data.nc')]) fs.rmSync(f, { force: true });
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ steps: R.steps.map((s) => [s.ok ? 'PASS' : 'FAIL', s.name, s.error || '']), console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}
