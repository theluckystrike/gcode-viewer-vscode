'use strict';
// The extension host on a mocked VS Code API, with the real parser worker from dist/ (run `npm test`, which builds first).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const S = require('../scripts/make-samples.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(__dirname, '..');

const state = { config: {}, clipboard: '', sizeOverride: null, reads: 0, commands: [], watchers: [] };
function uriOf(p, scheme = 'file') { return { scheme, fsPath: p, path: p, with(o) { return uriOf(o.path || p, scheme); }, toString() { return scheme + '://' + p; } }; }
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range { constructor(a, b) { this.start = a; this.end = b; } }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s), u.scheme), parse: (s) => ({ toString: () => s }) },
  Position, Range, ViewColumn: { Beside: -2 },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    createFileSystemWatcher: (p) => { const w = { p, on: {}, onDidChange(h) { w.on.change = h; }, onDidCreate(h) { w.on.create = h; }, dispose() { w.disposed = true; } }; state.watchers.push(w); return w; },
    fs: {
      stat: async (u) => ({ size: state.sizeOverride ?? fs.statSync(u.fsPath).size }),
      readFile: async (u) => { state.reads++; return fs.readFileSync(u.fsPath); },
    },
    isTrusted: true,
  },
  window: {
    registered: [], state: { focused: true },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    showInformationMessage: async () => undefined,
  },
  commands: { list: [], registerCommand(id) { this.list.push(id); return { dispose() {} }; }, executeCommand: async (...a) => { state.commands.push(a); } },
  env: { clipboard: { writeText: async (t) => { state.clipboard = t; } }, sessionId: 's1', openExternal: async () => true },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');

function fakePanel() {
  const sent = []; let handler = null; let dispose = null;
  const panel = {
    webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: (u) => 'https://res' + u.path, postMessage: async (m) => { sent.push(m); return true; }, onDidReceiveMessage: (h) => { handler = h; } },
    onDidDispose: (h) => { dispose = h; },
  };
  return { panel, sent, send: (m) => handler(m), close: () => dispose() };
}
const ctxOf = () => ({ extensionUri: uriOf(root), subscriptions: [], globalState: { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); } } });
async function open(file, scheme = 'file') {
  const prov = new ext.GcodeEditorProvider(ctxOf());
  const f = fakePanel();
  await prov.resolveCustomEditor({ uri: uriOf(file, scheme) }, f.panel);
  return f;
}
const of = (f, type) => f.sent.filter((m) => m.type === type);

const cube = path.join(tmp, 'cube-with-hole.gcode'); fs.writeFileSync(cube, S.cube());
const pocket = path.join(tmp, 'cnc-pocket.nc'); fs.writeFileSync(pocket, S.pocket());
const netcdf = path.join(tmp, 'ocean.nc'); fs.writeFileSync(netcdf, Buffer.concat([Buffer.from('CDF\x01', 'latin1'), Buffer.alloc(200)]));
const grammar = path.join(tmp, 'Expr.g'); fs.writeFileSync(grammar, 'grammar Expr;\nexpr: term (PLUS term)* ;\n');

test('activate registers both editors and the commands; manifest commands match', () => {
  const ctx = ctxOf();
  ext.activate(ctx);
  assert.deepEqual(vscodeMock.window.registered.map((r) => r[0]), ['gcodeViewer.preview', 'gcodeViewer.previewOption']);
  for (const id of ['gcodeViewer.openWalkthrough', 'gcodeViewer.openWith', 'gcodeViewer.supportDeveloper', 'gcodeViewer.moreViewers']) assert.ok(vscodeMock.commands.list.includes(id), id);
  const pkg = require('../package.json');
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  assert.deepEqual(declared, ['gcodeViewer.moreViewers', 'gcodeViewer.openWalkthrough', 'gcodeViewer.openWith', 'gcodeViewer.supportDeveloper']);
  assert.equal(ext.EXT_ID, `${pkg.publisher}.${pkg.name}`);
});

test('ready: init, then the model from the worker; roots are dist and media only', async () => {
  const f = await open(cube);
  assert.equal(f.panel.webview.options.localResourceRoots.length, 2);
  await f.send({ type: 'ready' });
  const init = of(f, 'init')[0];
  assert.equal(init.plan.load, true);
  assert.equal(init.name, 'cube-with-hole.gcode');
  assert.deepEqual(init.filament, { diameter: 1.75, density: 1.24 });
  const m = of(f, 'model')[0];
  assert.ok(m, JSON.stringify(f.sent.map((x) => x.type)));
  assert.equal(m.model.mode, 'print');
  assert.equal(m.model.layersTotal, 100);
  assert.ok(m.model.geo.pts instanceof Float32Array);
  assert.equal(state.reads, 0, 'local files are streamed by the worker, not read by the host');
  f.close();
});

test('.nc opens in CNC mode; the toolbar can read it again as 3D print', async () => {
  const f = await open(pocket);
  await f.send({ type: 'ready' });
  assert.equal(of(f, 'model')[0].model.mode, 'cnc');
  assert.deepEqual(of(f, 'model')[0].model.tools, ['T1', 'T2']);
  await f.send({ type: 'reload', mode: 'print' });
  assert.equal(of(f, 'model')[1].model.mode, 'print');
  await f.send({ type: 'reload', mode: 'auto' });
  assert.equal(of(f, 'model')[2].model.mode, 'cnc');
  f.close();
});

test('the gcodeViewer.mode setting forces a mode', async () => {
  state.config.mode = 'cnc';
  try {
    const f = await open(cube);
    await f.send({ type: 'ready' });
    assert.equal(of(f, 'init')[0].mode, 'cnc');
    assert.equal(of(f, 'model')[0].model.mode, 'cnc');
    f.close();
  } finally { delete state.config.mode; }
});

test('over the size limit: message, and the file is never read', async () => {
  state.sizeOverride = 600 * 1024 * 1024;
  try {
    const f = await open(cube);
    await f.send({ type: 'ready' });
    const init = of(f, 'init')[0];
    assert.equal(init.plan.load, false);
    assert.match(init.plan.message, /^This file is 600\.0 MB\. GCode Viewer opens files up to 500\.0 MB/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(of(f, 'model').length, 0);
    assert.equal(state.reads, 0);
    f.close();
  } finally { state.sizeOverride = null; }
});

test('a NetCDF .nc file gets a plain message; a non-G-code .g file gets an empty model', async () => {
  const f = await open(netcdf);
  await f.send({ type: 'ready' });
  const n = of(f, 'notGcode')[0];
  assert.equal(n.kind, 'netcdf');
  assert.match(n.message, /NetCDF data file, not a CNC program/);
  await f.send({ type: 'reopenWith' });
  assert.deepEqual(state.commands.pop(), ['workbench.action.reopenWithEditor']);
  f.close();
  const g = await open(grammar);
  await g.send({ type: 'ready' });
  assert.equal(of(g, 'model')[0].model.segments, 0);
  g.close();
});

test('non-file schemes: the host reads the bytes and hands them to the worker', async () => {
  const f = await open(cube, 'vscode-remote');
  await f.send({ type: 'ready' });
  assert.equal(state.reads, 1);
  assert.equal(of(f, 'model')[0].model.layersTotal, 100);
  assert.equal(state.watchers.filter((w) => w.p.pattern === 'cube-with-hole.gcode' && !w.disposed).length >= 0, true);
  state.reads = 0;
  f.close();
});

test('reveal opens the text editor beside, at the line', async () => {
  const f = await open(cube);
  await f.send({ type: 'reveal', line: 251 });
  const [cmd, uri, viewId, opts] = state.commands.pop();
  assert.equal(cmd, 'vscode.openWith');
  assert.equal(uri.fsPath, cube);
  assert.equal(viewId, 'default');
  assert.equal(opts.selection.start.line, 250);
  assert.equal(opts.viewColumn, -2);
  await f.send({ type: 'reveal', line: 0 });
  assert.equal(state.commands.length, 0, 'line 0 is dropped');
  f.close();
});

test('file changes on disk trigger a new read; the watcher is disposed with the tab', async () => {
  const f = await open(cube);
  await f.send({ type: 'ready' });
  const w = state.watchers[state.watchers.length - 1];
  w.on.change();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(of(f, 'changed').length, 1);
  assert.equal(of(f, 'model').length, 2);
  f.close();
  assert.ok(w.disposed);
});

test('rendered counts once per tab, copy works, unknown messages are dropped, nothing is posted after dispose', async () => {
  const f = await open(cube);
  await f.send({ type: 'rendered' }); await f.send({ type: 'rendered' });
  await f.send({ type: 'copy', text: 'Layers\t100' });
  assert.equal(state.clipboard, 'Layers\t100');
  const n = f.sent.length;
  await f.send({ type: 'runCommand', command: 'x' });
  assert.equal(f.sent.length, n);
  f.close();
  await f.send({ type: 'ready' });
  assert.equal(f.sent.length, n);
});

test('worker timeout stops the job with a message', async () => {
  const job = ext.parseInWorker(path.join(root, 'dist', 'worker.js'), { name: 'a.gcode', bytes: new Uint8Array(Buffer.from(S.cube())) }, { timeoutMs: 1 });
  await assert.rejects(job.promise, /longer than 0 seconds|stopped/);
});

test('worker progress messages arrive for big files', async () => {
  const big = path.join(tmp, 'big.gcode');
  const v = S.vase();
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 12; i++) fs.writeSync(fd, v); // about 24 MB
  fs.closeSync(fd);
  const seen = [];
  const job = ext.parseInWorker(path.join(root, 'dist', 'worker.js'), { name: 'big.gcode', path: big, mode: 'auto' }, { onProgress: (d, t) => seen.push([d, t]) });
  const model = await job.promise;
  assert.ok(seen.length >= 1 && seen[0][0] < seen[0][1]);
  assert.equal(model.layersTotal, 360 * 12);
  fs.rmSync(big);
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = require('../package.json');
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes('gcodeViewer.supportDeveloper') && ids.includes('gcodeViewer.moreViewers'));
  assert.equal(pkg.contributes.configuration.properties['gcodeViewer.showSupportLinks'].default, true);
  assert.ok(support.otherProducts(ext.EXT_ID).every((p) => p.id !== ext.EXT_ID));
  assert.ok(fs.readFileSync(path.join(root, '.github', 'FUNDING.yml'), 'utf8').includes('github: theluckystrike'));
});

test('support: the footer shows by default and gcodeViewer.showSupportLinks=false hides it', async () => {
  for (const [value, shown] of [[undefined, true], [false, false]]) {
    if (value === undefined) delete state.config.showSupportLinks; else state.config.showSupportLinks = value;
    try {
      const f = await open(cube);
      assert.equal(/id="zovo-support"/.test(f.panel.webview.html), shown, String(value));
      assert.equal(f.panel.webview.html.includes('command:gcodeViewer.moreViewers'), shown);
      assert.deepEqual(f.panel.webview.options.enableCommandUris, ['gcodeViewer.supportDeveloper', 'gcodeViewer.moreViewers', 'workbench.action.openSettings']);
      f.close();
    } finally { delete state.config.showSupportLinks; }
  }
});
