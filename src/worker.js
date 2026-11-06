'use strict';
// Reads and parses a G-code file off the extension host thread. The file is streamed in 4 MB chunks,
// so no whole-file string is ever built.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const { createParser, sniff } = require('./core/gcode');

const CHUNK = 4 * 1024 * 1024;

parentPort.once('message', (job) => {
  try {
    const t0 = Date.now();
    let fd = null, size, bytes = null;
    if (job.path) { fd = fs.openSync(job.path, 'r'); size = fs.fstatSync(fd).size; } else { bytes = job.bytes; size = bytes.length; }
    const read = (pos, len) => {
      if (bytes) return bytes.subarray(pos, Math.min(size, pos + len));
      const b = Buffer.allocUnsafe(Math.min(len, size - pos));
      const n = fs.readSync(fd, b, 0, b.length, pos);
      return b.subarray(0, n);
    };
    try {
      const head = read(0, 1 << 20);
      const s = sniff(head, job.name);
      if (!s.ok) { parentPort.postMessage({ type: 'notGcode', kind: s.kind, message: s.reason }); return; }
      const mode = job.mode === 'print' || job.mode === 'cnc' ? job.mode : s.mode;
      const parser = createParser({ mode, layerSource: s.layerSource, maxMoves: job.maxMoves, rapidFeed: job.rapidFeed });
      let pos = 0, lastReport = 0;
      while (pos < size) {
        const b = read(pos, CHUNK);
        if (b.length === 0) break;
        parser.push(Buffer.from(b.buffer, b.byteOffset, b.length).toString('latin1'));
        pos += b.length;
        if (pos - lastReport >= 16 * 1024 * 1024 && pos < size) { lastReport = pos; parentPort.postMessage({ type: 'progress', done: pos, total: size }); }
      }
      const model = parser.end();
      model.autoMode = s.mode;
      model.parseMs = Date.now() - t0;
      const g = model.geo;
      parentPort.postMessage({ type: 'model', model }, Object.values(g).map((a) => a.buffer));
    } finally { if (fd !== null) fs.closeSync(fd); }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
});
