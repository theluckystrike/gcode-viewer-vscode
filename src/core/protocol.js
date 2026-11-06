'use strict';
// Message checks and the size plan. Shared by the extension host and the tests. No vscode import here.

const MB = 1024 * 1024;

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

/** Files over the limit get a clear message and are never read. */
function sizePlan(size, maxFileMB) {
  const limitMB = Number.isFinite(maxFileMB) && maxFileMB > 0 ? Math.min(maxFileMB, 2048) : 500;
  if (size > limitMB * MB) {
    return {
      load: false, limitMB,
      message: `This file is ${fmtSize(size)}. GCode Viewer opens files up to ${fmtSize(limitMB * MB)} so VS Code stays responsive (setting gcodeViewer.maxFileMB). The file was not read.`,
    };
  }
  return { load: true, limitMB };
}

const MODES = ['auto', 'print', 'cnc'];
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Only known webview messages pass, with checked fields. Everything else is dropped. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready':
    case 'rendered':
    case 'reopenWith':
      return { ok: true, msg: { type: m.type } };
    case 'reload':
      if (m.mode !== undefined && !MODES.includes(m.mode)) return { ok: false };
      return { ok: true, msg: { type: 'reload', mode: m.mode || 'auto' } };
    case 'reveal':
      if (!isInt(m.line, 1, 0xffffffff)) return { ok: false };
      return { ok: true, msg: { type: 'reveal', line: m.line } };
    case 'copy':
      if (typeof m.text !== 'string' || m.text.length > 100000) return { ok: false };
      return { ok: true, msg: { type: 'copy', text: m.text } };
    default:
      return { ok: false };
  }
}

const GEO_KEYS = ['pts', 'kind', 'feat', 'feed', 'line', 'tEnd', 'layerStart', 'layerZ', 'layerLine', 'layerTime'];
const GEO_TYPES = { pts: Float32Array, kind: Uint8Array, feat: Uint8Array, feed: Float32Array, line: Uint32Array, tEnd: Float32Array, layerStart: Uint32Array, layerZ: Float32Array, layerLine: Uint32Array, layerTime: Float32Array };

/** Replies from the parser worker. */
function validateWorkerMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'progress') return Number.isFinite(m.done) && Number.isFinite(m.total);
  if (m.type === 'error' || m.type === 'notGcode') return typeof m.message === 'string';
  if (m.type !== 'model' || !m.model || !m.model.geo) return false;
  const g = m.model.geo;
  for (const k of GEO_KEYS) if (!(g[k] instanceof GEO_TYPES[k])) return false;
  const n = g.kind.length;
  if (g.feat.length !== n || g.feed.length !== n || g.line.length !== n || g.tEnd.length !== n) return false;
  if (n > 0 && g.pts.length !== (n + 1) * 3) return false;
  return true;
}

module.exports = { MB, fmtSize, sizePlan, validateWebviewMessage, validateWorkerMessage, GEO_KEYS, MODES };
