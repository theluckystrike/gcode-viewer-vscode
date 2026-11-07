'use strict';
// Size plan, message checks, CSP and source scans of the webview and the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/core/protocol.js');
const { buildHtml } = require('../src/html.js');

const root = path.join(__dirname, '..');

test('size plan: files over 500 MB get a clear message and are not read', () => {
  assert.deepEqual(P.sizePlan(10 * P.MB, 500), { load: true, limitMB: 500 });
  const big = P.sizePlan(600 * P.MB, 500);
  assert.equal(big.load, false);
  assert.equal(big.message, 'This file is 600.0 MB. GCode Viewer opens files up to 500.0 MB so VS Code stays responsive (setting gcodeViewer.maxFileMB). The file was not read.');
  assert.equal(P.sizePlan(600 * P.MB, -1).limitMB, 500, 'bad setting falls back to 500');
  assert.equal(P.sizePlan(600 * P.MB, 99999).limitMB, 2048, 'setting is capped');
  assert.equal(P.fmtSize(1536), '1.5 KB');
});

test('webview messages: known types pass with checked fields, the rest is dropped', () => {
  const ok = (m) => P.validateWebviewMessage(m).ok;
  for (const t of ['ready', 'rendered', 'reopenWith']) assert.ok(ok({ type: t }));
  assert.deepEqual(P.validateWebviewMessage({ type: 'reload' }).msg, { type: 'reload', mode: 'auto' });
  assert.ok(ok({ type: 'reload', mode: 'cnc' }));
  assert.ok(!ok({ type: 'reload', mode: 'rm -rf' }));
  assert.ok(ok({ type: 'reveal', line: 12 }));
  for (const line of [0, -1, 1.5, '12', null, 2 ** 33]) assert.ok(!ok({ type: 'reveal', line }), String(line));
  assert.ok(ok({ type: 'copy', text: 'Layers\t100' }));
  assert.ok(!ok({ type: 'copy', text: 'x'.repeat(100001) }));
  assert.ok(!ok({ type: 'copy', text: 5 }));
  for (const m of [null, 'ready', {}, { type: 'runCommand', command: 'x' }, { type: 'openExternal' }]) assert.ok(!ok(m));
  // extra fields never pass through
  assert.deepEqual(P.validateWebviewMessage({ type: 'ready', evil: 1 }).msg, { type: 'ready' });
});

test('worker messages: typed arrays with matching lengths only', () => {
  const geo = (n) => ({
    pts: new Float32Array((n + 1) * 3), kind: new Uint8Array(n), feat: new Uint8Array(n), feed: new Float32Array(n), line: new Uint32Array(n), tEnd: new Float32Array(n),
    layerStart: new Uint32Array(1), layerZ: new Float32Array(1), layerLine: new Uint32Array(1), layerTime: new Float32Array(1),
  });
  assert.ok(P.validateWorkerMessage({ type: 'model', model: { geo: geo(4) } }));
  const bad = geo(4); bad.line = new Uint32Array(3);
  assert.ok(!P.validateWorkerMessage({ type: 'model', model: { geo: bad } }));
  const wrongType = geo(4); wrongType.kind = [0, 1, 1, 1];
  assert.ok(!P.validateWorkerMessage({ type: 'model', model: { geo: wrongType } }));
  assert.ok(P.validateWorkerMessage({ type: 'progress', done: 1, total: 2 }));
  assert.ok(P.validateWorkerMessage({ type: 'notGcode', kind: 'netcdf', message: 'x' }));
  assert.ok(!P.validateWorkerMessage({ type: 'model' }));
  assert.ok(!P.validateWorkerMessage(null));
});

test('HTML: strict CSP with a nonce, no remote origin, title escaped', () => {
  const html = buildHtml({ cspSource: 'https://webview.example', scriptUri: 'https://webview.example/dist/webview.js', styleUri: 'https://webview.example/media/webview.css', title: '<img src=x onerror=alert(1)>.gcode', nonce: 'abc123' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc123'/);
  assert.ok(!/unsafe-inline|unsafe-eval|https?:\/\/(?!webview\.example)/.test(csp), csp);
  assert.ok(!/connect-src/.test(csp), 'no connect-src: data only arrives by postMessage');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.gcode'));
  assert.ok(!html.includes('<img'));
  for (const m of html.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /nonce="abc123"/);
});

test('source scan: the webview writes text only and makes no network calls; every posted type passes the host check', () => {
  const src = fs.readFileSync(path.join(root, 'src/webview/main.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|importScripts/.test(src));
  assert.ok(!/https?:\/\//.test(src), 'no URLs in the webview source');
  const types = new Set([...src.matchAll(/postMessage\(\{ type: '([a-zA-Z]+)'/g)].map((m) => m[1]));
  assert.ok(types.size >= 5, [...types].join(','));
  const sample = { ready: {}, rendered: {}, reload: { mode: 'cnc' }, reveal: { line: 3 }, copy: { text: 'x' }, reopenWith: {} };
  for (const t of types) assert.ok(P.validateWebviewMessage({ type: t, ...(sample[t] || {}) }).ok, t);
});

test('source scan: the host and worker have no network modules and never write files', () => {
  for (const f of ['src/extension.js', 'src/worker.js', 'src/core/gcode.js', 'src/core/protocol.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram|child_process)['"]\)|fetch\(/.test(src), f);
    assert.ok(!/writeFile|fs\.write|createWriteStream|unlink|rmSync/.test(src), f);
  }
});

test('manifest: editors, file patterns, settings and 30 keywords', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.publisher, 'zovo');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/); // monetize.py rollouts bump it
  assert.ok(pkg.displayName.length <= 45);
  assert.equal(pkg.keywords.length, 30);
  const eds = Object.fromEntries(pkg.contributes.customEditors.map((e) => [e.viewType, e]));
  assert.deepEqual(eds['gcodeViewer.preview'].selector.map((s) => s.filenamePattern), ['*.gcode', '*.gco']);
  // .nc is shared with NetCDF data files, so GCode Viewer only offers itself for it (no default-editor clash)
  assert.ok(eds['gcodeViewer.previewOption'].selector.some((s) => s.filenamePattern === '*.nc'));
  assert.equal(eds['gcodeViewer.preview'].priority, 'default');
  assert.equal(eds['gcodeViewer.previewOption'].priority, 'option');
  assert.ok(eds['gcodeViewer.previewOption'].selector.some((s) => s.filenamePattern === '*.g'));
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['gcodeViewer.maxFileMB'].default, 500);
  for (const k of ['maxMoves', 'mode', 'filamentDiameter', 'filamentDensity', 'rapidFeed', 'askForRating', 'showSupportLinks']) assert.ok(props['gcodeViewer.' + k], k);
});

test('source scan: no inline style attributes in the webview (the CSP blocks them); styles go through CSSOM', () => {
  const src = fs.readFileSync(path.join(root, 'src/webview/main.js'), 'utf8');
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(src));
  assert.match(src, /k === 'style'\) e\.style\.cssText = v/);
});
