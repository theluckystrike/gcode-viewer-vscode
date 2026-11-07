'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage, validateWorkerMessage, sizePlan, fmtSize } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'gcodeViewer.preview';
const VIEW_TYPE_OPTION = 'gcodeViewer.previewOption';
const EXT_ID = 'zovo.zovo-gcode-viewer';
const TIMEOUT_MS = 180000;
let rating = { success() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('gcodeViewer');
  return {
    maxFileMB: c.get('maxFileMB', 500),
    maxMoves: c.get('maxMoves', 5000000),
    mode: c.get('mode', 'auto'),
    filamentDiameter: c.get('filamentDiameter', 1.75),
    filamentDensity: c.get('filamentDensity', 1.24),
    rapidFeed: c.get('rapidFeed', 5000),
  };
}

/**
 * Parse in a worker thread so a big file never blocks the extension host.
 * job: { path } for local files (the worker streams it) or { bytes } for other file systems.
 */
function parseInWorker(workerPath, job, opts = {}) {
  let worker;
  let timer;
  const promise = new Promise((resolve, reject) => {
    worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: opts.heapMB || 4096 } });
    const ms = opts.timeoutMs || TIMEOUT_MS;
    const done = () => { clearTimeout(timer); worker.terminate(); };
    timer = setTimeout(() => { worker.terminate(); reject(new Error(`Reading the file took longer than ${Math.round(ms / 1000)} seconds and was stopped.`)); }, ms);
    worker.on('message', (m) => {
      if (!validateWorkerMessage(m)) { done(); reject(new Error('The G-code reader sent an unexpected reply.')); return; }
      if (m.type === 'progress') { if (opts.onProgress) opts.onProgress(m.done, m.total); return; }
      done();
      if (m.type === 'error') reject(new Error(m.message));
      else if (m.type === 'notGcode') resolve({ notGcode: true, kind: m.kind, message: m.message });
      else resolve(m.model);
    });
    worker.once('error', (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(/memory/i.test(String(e && e.message)) ? 'The file does not fit in memory. Lower gcodeViewer.maxMoves or open a smaller file.' : String((e && e.message) || e))); });
    worker.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`The G-code reader stopped (exit code ${code}).`)); });
    if (job.bytes) {
      const d = job.bytes;
      const ab = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d.buffer : Uint8Array.prototype.slice.call(d).buffer;
      worker.postMessage({ ...job, bytes: new Uint8Array(ab) }, [ab]);
    } else worker.postMessage(job);
  });
  return { promise, cancel: () => { clearTimeout(timer); if (worker) worker.terminate(); } };
}

class GcodeEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('gcodeViewer') };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'gcodeViewer'),
    });
    let disposed = false;
    let counted = false; // one success per opened tab, for the rating prompt
    let job = null;
    let modeOverride = null;
    let loading = null;
    const post = (m) => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));

    const load = async () => {
      if (job) job.cancel();
      const stat = await vscode.workspace.fs.stat(uri);
      const s = settings();
      const plan = sizePlan(stat.size, s.maxFileMB);
      const mode = modeOverride || s.mode;
      await post({
        type: 'init', name, size: stat.size, sizeText: fmtSize(stat.size), plan, mode,
        filament: { diameter: s.filamentDiameter, density: s.filamentDensity },
      });
      if (!plan.load) return;
      const t0 = Date.now();
      const jobIn = { name, mode, maxMoves: s.maxMoves, rapidFeed: s.rapidFeed };
      if (uri.scheme === 'file') jobIn.path = uri.fsPath; else jobIn.bytes = await vscode.workspace.fs.readFile(uri);
      const mine = parseInWorker(path.join(ctx.extensionUri.fsPath, 'dist', 'worker.js'), jobIn, {
        onProgress: (done, total) => { post({ type: 'progress', done, total }); },
      });
      job = mine;
      try {
        const model = await mine.promise;
        if (job !== mine) return; // a newer load replaced this one
        if (model.notGcode) { await post({ type: 'notGcode', kind: model.kind, message: model.message }); return; }
        await post({ type: 'model', model, ms: Date.now() - t0 });
      } catch (e) {
        if (job === mine) await post({ type: 'error', message: e.message });
      } finally { if (job === mine) job = null; }
    };
    const reload = () => { loading = load().catch((e) => post({ type: 'error', message: e && e.message ? e.message : String(e) })); return loading; };

    // Reload when the file changes on disk (for example when the slicer exports it again).
    let changeTimer = null;
    const watcher = uri.scheme === 'file'
      ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), name))
      : null;
    if (watcher) {
      const onChange = () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => { if (!disposed) { post({ type: 'changed' }); reload(); } }, 600); };
      watcher.onDidChange(onChange); watcher.onDidCreate(onChange);
    }

    const reveal = async (line) => {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', {
        viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(pos, pos),
      });
    };

    panel.webview.onDidReceiveMessage(async (raw) => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready') { await reload(); return; }
        if (msg.type === 'reload') { modeOverride = msg.mode === 'auto' ? null : msg.mode; await reload(); return; }
        if (msg.type === 'rendered') { if (!counted) { counted = true; rating.success(); } return; }
        if (msg.type === 'reveal') { await reveal(msg.line); return; }
        if (msg.type === 'reopenWith') { await vscode.commands.executeCommand('workbench.action.reopenWithEditor'); return; }
        if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); await post({ type: 'copied', chars: msg.text.length }); }
      } catch (e) {
        await post({ type: 'error', message: e && e.message ? e.message : String(e), soft: true });
      }
    });
    panel.onDidDispose(() => { disposed = true; clearTimeout(changeTimer); if (watcher) watcher.dispose(); if (job) job.cancel(); });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'gcodeViewer', message: (n) => `GCode Viewer has opened ${n} files for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'gcodeViewer', selfId: EXT_ID });
  const opts = { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } };
  const provider = new GcodeEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, opts),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE_OPTION, provider, opts),
    vscode.commands.registerCommand('gcodeViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#gcodeViewer.start`, false)),
    vscode.commands.registerCommand('gcodeViewer.openWith', async (uri) => {
      const target = uri instanceof vscode.Uri ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, /\.(gcode|gco)$/i.test(target.path) ? VIEW_TYPE : VIEW_TYPE_OPTION);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, GcodeEditorProvider, parseInWorker, VIEW_TYPE, VIEW_TYPE_OPTION, EXT_ID };
