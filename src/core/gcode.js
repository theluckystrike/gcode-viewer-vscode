'use strict';
// Streaming G-code reader for 3D printer and CNC programs. No vscode import, no DOM: runs in the worker and in tests.
// Feed text with push(chunk) (lines may be split across chunks) and call end() for the model.
//
// Each stored move is one straight segment from vertex i to vertex i+1 of a polyline (arcs are split into
// segments). Per segment: kind, feature (print) or tool (CNC), feed in mm/min, source line, and the time at
// its end in seconds. Layers (print) or Z passes (CNC) are ranges of segments.

const KIND = { TRAVEL: 0, WORK: 1, ARC: 2, PLUNGE: 3, SKIP: 4 };

// Feature names and colours for 3D printing. Index 0 is used when the slicer wrote no feature comments.
const PRINT_FEATURES = [
  ['Extrusion', '#e8a33d'], ['Outer wall', '#ff7d38'], ['Inner wall', '#ffd84d'], ['Overhang wall', '#4a6cff'],
  ['Infill', '#c0392b'], ['Solid infill', '#9b59d0'], ['Top surface', '#f25c5c'], ['Bottom / skin', '#7f6bd6'],
  ['Bridge', '#4d8fc4'], ['Gap fill', '#e6e6e6'], ['Skirt / brim', '#00a887'], ['Support', '#3ddc5a'],
  ['Support interface', '#1f8f3a'], ['Prime tower', '#a7dca0'], ['Ironing', '#ff9a76'], ['Custom', '#5ed1b4'],
];
const CNC_KINDS = [['Rapid (G0)', '#ff5c5c'], ['Cut (G1)', '#4fc3f7'], ['Arc (G2/G3)', '#ffd54f'], ['Plunge', '#c77dff']];

function featureOf(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s.trim()) return 0;
  if (/support.*interface|interface.*support|support.*roof|support.*floor/.test(s)) return 12;
  if (/support/.test(s)) return 11;
  if (/overhang/.test(s)) return 3;
  if (/outer|external/.test(s)) return 1;
  if (/bridge/.test(s)) return 8;
  if (/gap/.test(s)) return 9;
  if (/top/.test(s)) return 6;
  if (/bottom|skin/.test(s)) return 7;
  if (/solid/.test(s)) return 5;
  if (/ironing/.test(s)) return 14;
  if (/skirt|brim/.test(s)) return 10;
  if (/tower|wipe|prime/.test(s)) return 13;
  if (/wall|perimeter|shell|inner/.test(s)) return 2;
  if (/fill/.test(s)) return 4;
  if (/custom|start|end/.test(s)) return 15;
  return 0;
}

/** Hours, minutes and seconds from slicer text such as "1h 2m 3s", "1d 2h 3m" or "3723". */
function parseDuration(text) {
  const s = String(text).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let t = 0; let hit = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/gi; let m;
  while ((m = re.exec(s))) { hit = true; t += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2].toLowerCase()]; }
  return hit ? t : null;
}

function filamentGrams(mm, diameter, density) {
  const r = diameter / 2;
  return (mm * Math.PI * r * r) / 1000 * density;
}

const CNC_EXT = /\.(nc|ngc|tap|cnc)$/i;

/**
 * Look at the first part of a file before the full read: is it text, which slicer, which mode, do layer comments exist.
 * bytes: Uint8Array of the head (1 MB is plenty).
 */
function sniff(bytes, name) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length === 0) return { ok: false, kind: 'empty', reason: 'The file is empty.' };
  const sig = String.fromCharCode(...b.subarray(0, 4));
  if (sig === 'CDF\x01' || sig === 'CDF\x02' || sig === 'CDF\x05') return { ok: false, kind: 'netcdf', reason: 'This .nc file is a NetCDF data file, not a CNC program.' };
  if (b[0] === 0x89 && sig.slice(1) === 'HDF') return { ok: false, kind: 'hdf5', reason: 'This .nc file is a NetCDF-4 (HDF5) data file, not a CNC program.' };
  if (sig === 'GCDE') return { ok: false, kind: 'bgcode', reason: 'This is binary G-code (.bgcode from PrusaSlicer). Export plain text G-code to view it here.' };
  let zeros = 0;
  const n = Math.min(b.length, 65536);
  for (let i = 0; i < n; i++) if (b[i] === 0) zeros++;
  if (zeros > 0) return { ok: false, kind: 'binary', reason: 'This file contains binary data, so it is not text G-code.' };
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.length, 1 << 20)).toString('latin1');
  const hasE = /^[ \t]*(?:N\d+\s*)?G0?[0-3](?![0-9])[^;(\n]*\bE-?\d*\.?\d/im.test(head) || /^[ \t]*G0?1\b[^;\n]*E[0-9.]/im.test(head);
  const motion = (head.match(/^[ \t]*(?:N\d+\s*)?G0?[0-3](?![0-9.])/gim) || []).length;
  const layerComments = /^[ \t]*;\s*(LAYER:\s*-?\d|LAYER_CHANGE|CHANGE_LAYER|layer \d+, *Z *=|BEGIN_LAYER)/im.test(head);
  const slicer = slicerOf(head);
  const cncExt = CNC_EXT.test(String(name || ''));
  const mode = hasE ? 'print' : (motion > 0 || cncExt ? 'cnc' : (cncExt ? 'cnc' : 'print'));
  return { ok: true, mode, layerSource: layerComments ? 'comments' : 'z', slicer, motionInHead: motion, hasE };
}

function slicerOf(text) {
  const tests = [
    [/Cura_SteamEngine\s*([\d.]+)?/i, 'Cura'], [/PrusaSlicer\s*([\d.]+\S*)?/i, 'PrusaSlicer'], [/OrcaSlicer\s*([\d.]+\S*)?/i, 'OrcaSlicer'],
    [/BambuStudio\s*([\d.]+\S*)?/i, 'Bambu Studio'], [/SuperSlicer\s*([\d.]+\S*)?/i, 'SuperSlicer'], [/Simplify3D\(R\)?\s*Version\s*([\d.]+)?/i, 'Simplify3D'],
    [/ideaMaker\s*([\d.]+)?/i, 'ideaMaker'], [/KISSlicer/i, 'KISSlicer'], [/Slic3r\s*([\d.]+)?/i, 'Slic3r'], [/Fusion 360|Autodesk CAM/i, 'Fusion 360'],
    [/Estlcam/i, 'Estlcam'], [/Carbide Create/i, 'Carbide Create'], [/FreeCAD/i, 'FreeCAD'], [/Easel/i, 'Easel'],
  ];
  for (const [re, label] of tests) { const m = re.exec(text); if (m) return m[1] ? `${label} ${m[1]}` : label; }
  return '';
}

class Grow {
  constructor(Type, n) { this.T = Type; this.a = new Type(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) this.grow(); this.a[this.n++] = v; }
  grow() { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
  out() { return this.a.slice(0, this.n); }
}

/**
 * opts: { mode: 'print'|'cnc', layerSource: 'comments'|'z', maxMoves, rapidFeed (mm/min) }
 */
function createParser(opts = {}) {
  const mode = opts.mode === 'cnc' ? 'cnc' : 'print';
  const cnc = mode === 'cnc';
  const useComments = opts.layerSource === 'comments';
  const maxMoves = Number.isFinite(opts.maxMoves) && opts.maxMoves > 0 ? Math.floor(opts.maxMoves) : 5000000;
  const rapidFeed = Number.isFinite(opts.rapidFeed) && opts.rapidFeed > 0 ? opts.rapidFeed : 5000;
  const zThresh = cnc ? 1e-4 : 0.02;

  // stored geometry
  const pts = new Grow(Float32Array, 3 * 65536);
  const kind = new Grow(Uint8Array, 65536);
  const feat = new Grow(Uint8Array, 65536);
  const feedA = new Grow(Float32Array, 65536);
  const lineA = new Grow(Uint32Array, 65536);
  const tEnd = new Grow(Float32Array, 65536);
  const lStart = new Grow(Uint32Array, 1024), lZ = new Grow(Float32Array, 1024), lLine = new Grow(Uint32Array, 1024), lTime = new Grow(Float32Array, 1024);

  // machine state
  let x = 0, y = 0, z = 0, e = 0;
  let absXYZ = true, absE = true, unit = 1, plane = 17, motion = cnc ? 0 : 1, feed = 0, tool = 0;
  let feature = 0, haveFeature = false;
  let lineNo = 0, rest = '';
  let segCount = 0, truncated = false, started = false;
  // layers
  let layerCount = 0, layerZ = NaN, lastWorkEnd = 0, pendingMark = -1, pendingLine = 0, zSetSeg = 0, zSetLine = 1;
  // stats
  let time = 0, filament = 0, workLen = 0, travelLen = 0, moves = 0, arcs = 0, retracts = 0, dwells = 0, toolChanges = 0;
  let feedMin = Infinity, feedMax = 0, noFeedMoves = 0, inchLines = 0, badWords = 0, spindleMax = 0, homeCount = 0;
  const work = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const all = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const featLen = new Float64Array(256), featTime = new Float64Array(256);
  const kindLen = new Float64Array(4), kindTime = new Float64Array(4);
  const tools = new Map(); // CNC: tool number -> index into tool names
  const toolNames = [];
  const temps = { nozzle: 0, bed: 0 };
  const info = { slicer: '', flavor: '', slicerTime: null, slicerFilamentMm: null, slicerFilamentG: null };
  const warnings = new Set();
  let headText = '';

  function toolIndex(t) {
    if (!tools.has(t)) { tools.set(t, toolNames.length); toolNames.push(`T${t}`); }
    return tools.get(t);
  }

  function bound(b, px, py, pz) {
    if (px < b[0]) b[0] = px; if (py < b[1]) b[1] = py; if (pz < b[2]) b[2] = pz;
    if (px > b[3]) b[3] = px; if (py > b[4]) b[4] = py; if (pz > b[5]) b[5] = pz;
  }

  function startLayer(seg, lz, line) {
    layerCount++;
    if (truncated) return;
    lStart.push(seg); lZ.push(lz); lLine.push(line); lTime.push(seg > 0 ? tEnd.a[seg - 1] : 0);
  }

  // store one straight segment from the current position to (nx, ny, nz)
  function store(k, f, nx, ny, nz, fd, t) {
    if (truncated) return;
    if (segCount >= maxMoves) { truncated = true; return; }
    if (!started) { started = true; pts.push(x); pts.push(y); pts.push(z); }
    pts.push(nx); pts.push(ny); pts.push(nz);
    kind.push(k); feat.push(f); feedA.push(fd); lineA.push(lineNo); tEnd.push(t);
    segCount++;
  }

  function onWorking(nz) {
    if (useComments) {
      if (layerCount === 0) startLayer(0, nz, pendingMark >= 0 ? pendingLine : lineNo);
      else if (pendingMark >= 0) startLayer(pendingMark, nz, pendingLine);
      else return;
      pendingMark = -1;
    } else if (layerCount === 0) startLayer(0, nz, lineNo);
    else if (Math.abs(nz - layerZ) > zThresh) {
      // CNC: a new Z pass starts right after the last cut of the previous pass (retract, rapids, plunge and ramps
      // belong to the new pass). 3D print: it starts at the move that set the new Z.
      const at = cnc ? lastWorkEnd : Math.min(zSetSeg, segCount);
      startLayer(at, nz, cnc ? (at < segCount ? lineA.a[at] : lineNo) : zSetLine);
    }
    else return;
    layerZ = nz;
  }

  // one move (possibly an arc piece) in mm
  function move(isRapid, isArc, nx, ny, nz, ne) {
    const dx = nx - x, dy = ny - y, dz = nz - z, de = ne - e;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (Math.abs(dz) > 1e-6) { zSetSeg = segCount; zSetLine = lineNo; }
    let fd = isRapid && cnc ? rapidFeed : feed;
    if (!(fd > 0)) { fd = cnc ? 1000 : 1800; noFeedMoves++; }
    const secs = (dist > 1e-9 ? dist : Math.abs(de)) / (fd / 60);
    time += secs;
    filament += de;
    if (dist <= 1e-9) {
      if (de < -1e-9) retracts++;
      e = ne; return;
    }
    bound(all, nx, ny, nz);
    let k, f = 0, planarCut = false;
    if (cnc) {
      if (isRapid) k = KIND.TRAVEL;
      else if (isArc) k = KIND.ARC;
      else if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && dz < 0) k = KIND.PLUNGE;
      else k = KIND.WORK;
      f = toolIndex(tool);
      kindLen[k] += dist; kindTime[k] += secs;
      if (k === KIND.TRAVEL) travelLen += dist; else { workLen += dist; bound(work, nx, ny, nz); if (fd < feedMin) feedMin = fd; if (fd > feedMax) feedMax = fd; }
      if ((k === KIND.WORK || k === KIND.ARC) && Math.abs(dz) < 1e-6) { onWorking(nz); planarCut = true; }
    } else if (de > 1e-9) {
      k = KIND.WORK; f = feature;
      workLen += dist; featLen[f] += dist; featTime[f] += secs;
      bound(work, x, y, z); bound(work, nx, ny, nz);
      if (fd < feedMin) feedMin = fd; if (fd > feedMax) feedMax = fd;
      onWorking(nz);
    } else {
      k = KIND.TRAVEL; travelLen += dist; f = feature;
    }
    store(k, f, nx, ny, nz, fd, time);
    if (planarCut) lastWorkEnd = segCount;
    x = nx; y = ny; z = nz; e = ne;
  }

  function jump(nx, ny, nz) {
    if (nx === x && ny === y && nz === z) return;
    if (started) store(KIND.SKIP, 0, nx, ny, nz, 0, time);
    x = nx; y = ny; z = nz;
  }

  function handleComment(c) {
    // c is the text after ';' or inside ( )
    const t = c.trimStart();
    const ch = t.charCodeAt(0);
    if (lineNo <= 400 && headText.length < 20000) headText += t + '\n';
    // feature / type
    if (ch === 84 || ch === 70 || ch === 102 || ch === 116) { // T F f t
      const m = /^(?:TYPE|FEATURE)\s*:\s*(.*)$/i.exec(t) || /^feature\s+(.+)$/i.exec(t);
      if (m) { feature = featureOf(m[1]); haveFeature = true; return; }
      if (/^TIME:\s*\d/.test(t)) { info.slicerTime = Number(t.slice(5)); return; }
      if (/^FLAVOR:/.test(t)) { info.flavor = t.slice(7).trim(); return; }
      if (/^Filament used:/i.test(t)) { const v = parseFloat(t.slice(14)); if (Number.isFinite(v)) info.slicerFilamentMm = /m\b/.test(t) && !/mm/.test(t) ? v * 1000 : v; return; }
    }
    if (useComments && (ch === 76 || ch === 67 || ch === 108 || ch === 66)) { // L C l B
      if (/^LAYER:\s*-?\d/.test(t) || /^LAYER_CHANGE\b/.test(t) || /^CHANGE_LAYER\b/.test(t) || /^layer \d+, *Z *=/i.test(t) || /^BEGIN_LAYER/.test(t)) {
        if (pendingMark < 0) { pendingMark = segCount; pendingLine = lineNo; }
        return;
      }
    }
    if (ch === 101 || ch === 102 || ch === 116 || ch === 109) { // e f t m (Prusa/Orca footer)
      let m = /^estimated printing time(?: \(normal mode\))?\s*=\s*(.+)$/i.exec(t) || /^total estimated time:\s*(.+)$/i.exec(t) || /^model printing time:\s*([^;]+)/i.exec(t);
      if (m) { const d = parseDuration(m[1]); if (d != null && info.slicerTime == null) info.slicerTime = d; return; }
      m = /^filament used \[mm\]\s*=\s*([\d.]+)/i.exec(t);
      if (m) { info.slicerFilamentMm = Number(m[1]); return; }
      m = /^(?:total )?filament used \[g\]\s*=\s*([\d.]+)/i.exec(t);
      if (m) { info.slicerFilamentG = Number(m[1]); return; }
    }
  }

  const val = new Float64Array(26);
  let has = 0; // bitmask of letters present
  const L = (c) => 1 << (c - 65);
  const AX = L(88) | L(89) | L(90) | L(69) | L(73) | L(74) | L(75) | L(82) | L(65) | L(66) | L(67);
  const gList = [];

  function parseLine(s) {
    lineNo++;
    let end = s.length;
    if (end && s.charCodeAt(end - 1) === 13) end--;
    let semi = s.indexOf(';');
    if (semi >= 0 && semi < end) { handleComment(s.slice(semi + 1, end)); end = semi; }
    let code = end === s.length ? s : s.slice(0, end);
    if (code.indexOf('(') >= 0) {
      code = code.replace(/\(([^)]*)\)?/g, (_, c) => { handleComment(c); return ' '; });
    }
    has = 0; gList.length = 0;
    let mcode = -1, sawG = false, sawM = false;
    const n = code.length;
    let i = 0;
    while (i < n) {
      let c = code.charCodeAt(i);
      if (c >= 97 && c <= 122) c -= 32;
      if (c < 65 || c > 90) { if (c === 42) break; i++; continue; } // '*' checksum ends the line
      let j = i + 1;
      while (j < n && code.charCodeAt(j) === 32) j++;
      const a = j;
      while (j < n) { const d = code.charCodeAt(j); if ((d >= 48 && d <= 57) || d === 46 || d === 45 || d === 43) j++; else break; }
      if (j === a) {
        if (c === 71 || c === 77 || c === 84 || c === 78) badWords++;
        else if (c === 88 || c === 89 || c === 90) { has |= L(c); val[c - 65] = NaN; } // "G28 X Y": axis without value
        i = j; continue;
      }
      const v = Number(code.slice(a, j));
      i = j;
      if (!Number.isFinite(v)) { badWords++; continue; }
      if (c === 71) { gList.push(v); sawG = true; } else if (c === 77) { if (mcode < 0) mcode = v; sawM = true; } else if (c === 78) { /* N line number */ } else { has |= L(c); val[c - 65] = v; }
    }
    if (!sawG && !sawM && !has) return;

    let moveG = -1, consumed = false;
    for (const g of gList) {
      if (g === 0 || g === 1 || g === 2 || g === 3) { moveG = g; motion = g; } else if (g === 90) { absXYZ = true; absE = true; } else if (g === 91) { absXYZ = false; absE = false; } else if (g === 20) { unit = 25.4; inchLines++; } else if (g === 21) unit = 1;
      else if (g === 17 || g === 18 || g === 19) plane = g;
      else if (g === 4) { consumed = true; dwells++; const p = has & L(80) ? val[15] : 0, sv = has & L(83) ? val[18] : 0; const secs = sv > 0 ? sv : (cnc ? p : p / 1000); if (secs > 0 && secs < 86400) time += secs; } else if (g === 92) {
        consumed = true;
        if (has & L(69)) e = val[4] * unit;
        if (has & (L(88) | L(89) | L(90))) jump(has & L(88) ? val[23] * unit : x, has & L(89) ? val[24] * unit : y, has & L(90) ? val[25] * unit : z);
        if (!(has & (L(69) | L(88) | L(89) | L(90)))) { e = 0; jump(0, 0, 0); }
      } else if (g === 28) {
        consumed = true; homeCount++;
        const any = has & (L(88) | L(89) | L(90));
        jump(!any || has & L(88) ? 0 : x, !any || has & L(89) ? 0 : y, !any || has & L(90) ? 0 : z);
      } else if (g === 10 || g === 11) { consumed = true; if (g === 10 && !cnc) retracts++; } else if (g === 80) motion = -1;
      else consumed = consumed || (g >= 53 && g <= 59.3) || g === 43 || g === 49 || g === 40 || g === 41 || g === 42 || g === 94 || g === 64 || g === 61 || g === 29;
    }
    if (sawM) {
      if (mcode === 82) absE = true; else if (mcode === 83) absE = false;
      else if (mcode === 104 || mcode === 109) { if (has & L(83) && val[18] > temps.nozzle) temps.nozzle = val[18]; } else if (mcode === 140 || mcode === 190) { if (has & L(83) && val[18] > temps.bed) temps.bed = val[18]; } else if (mcode === 3 || mcode === 4) { if (has & L(83) && val[18] > spindleMax) spindleMax = val[18]; } else if (mcode === 6) { toolChanges++; if (has & L(84)) tool = val[19]; }
      if (moveG < 0) consumed = true;
    }
    if (has & L(84) && !sawM) { // T word on its own line
      const t = val[19];
      if (t !== tool) { tool = t; if (!cnc) toolChanges++; }
    }
    if (has & L(70)) { const f = val[5] * unit; if (f > 0) feed = f; }
    if (cnc && (has & L(83)) && !sawM && val[18] > spindleMax) spindleMax = val[18];
    if (consumed || !(has & AX)) return;
    const g = moveG >= 0 ? moveG : motion;
    if (g < 0 || g > 3) return;
    moves++;
    const ax = (bit, idx, cur) => (has & bit ? (Number.isNaN(val[idx]) ? cur : (absXYZ ? val[idx] * unit : cur + val[idx] * unit)) : cur);
    const nx = ax(L(88), 23, x), ny = ax(L(89), 24, y), nz = ax(L(90), 25, z);
    const ne = has & L(69) ? (absE ? val[4] * unit : e + val[4] * unit) : e;
    if (g === 2 || g === 3) arc(g === 2, nx, ny, nz, ne);
    else move(g === 0, false, nx, ny, nz, ne);
  }

  function arc(cw, nx, ny, nz, ne) {
    arcs++;
    // plane axes: (u, v) arc plane, w linear
    const P = plane === 18 ? [2, 0, 1] : plane === 19 ? [1, 2, 0] : [0, 1, 2];
    const off = plane === 18 ? [10, 8] : plane === 19 ? [9, 10] : [8, 9]; // K,I / J,K / I,J
    const s = [x, y, z], t = [nx, ny, nz];
    const su = s[P[0]], sv = s[P[1]], sw = s[P[2]], tu = t[P[0]], tv = t[P[1]], tw = t[P[2]];
    let cu, cvv;
    if (has & L(82)) {
      let r = val[17] * unit;
      const du = tu - su, dv = tv - sv, d = Math.hypot(du, dv);
      if (d < 1e-9 || Math.abs(r) < d / 2 - 1e-6) { warnings.add('An arc with an R value too small for its end point was drawn as a straight line.'); move(false, false, nx, ny, nz, ne); return; }
      const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
      const mu = (su + tu) / 2, mv = (sv + tv) / 2;
      let sgn = cw ? -1 : 1; if (r < 0) { sgn = -sgn; r = -r; }
      cu = mu - sgn * h * dv / d; cvv = mv + sgn * h * du / d;
    } else {
      const ou = has & L(65 + off[0]) ? val[off[0]] * unit : 0, ov = has & L(65 + off[1]) ? val[off[1]] * unit : 0;
      cu = su + ou; cvv = sv + ov;
    }
    const r0 = Math.hypot(su - cu, sv - cvv);
    if (!(r0 > 1e-9)) { move(false, false, nx, ny, nz, ne); return; }
    let a0 = Math.atan2(sv - cvv, su - cu), a1 = Math.atan2(tv - cvv, tu - cu);
    let sweep = a1 - a0;
    if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; } else if (sweep <= 1e-9) sweep += 2 * Math.PI;
    const full = Math.abs(tu - su) < 1e-9 && Math.abs(tv - sv) < 1e-9;
    if (full) sweep = cw ? -2 * Math.PI : 2 * Math.PI;
    const r1 = Math.hypot(tu - cu, tv - cvv);
    const len = Math.abs(sweep) * r0;
    const steps = Math.max(2, Math.min(720, Math.ceil(Math.max(Math.abs(sweep) / (Math.PI / 36), len / 1.0))));
    const e0 = e;
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      const a = a0 + sweep * f, r = r0 + (r1 - r0) * f;
      const q = [0, 0, 0];
      q[P[0]] = k === steps ? tu : cu + r * Math.cos(a);
      q[P[1]] = k === steps ? tv : cvv + r * Math.sin(a);
      q[P[2]] = sw + (tw - sw) * f;
      move(false, true, q[0], q[1], q[2], e0 + (ne - e0) * f);
    }
  }

  function push(chunk) {
    let text = rest ? rest + chunk : chunk;
    let i = 0;
    for (;;) {
      const j = text.indexOf('\n', i);
      if (j < 0) break;
      parseLine(i === 0 && j === text.length ? text : text.slice(i, j));
      i = j + 1;
    }
    rest = i < text.length ? text.slice(i) : '';
    text = null;
  }

  function end() {
    if (rest) { parseLine(rest); rest = ''; }
    info.slicer = slicerOf(headText);
    if (noFeedMoves > 0) warnings.add(`${noFeedMoves.toLocaleString('en-US')} moves had no feed rate (F) yet, so a default speed was used for the time estimate.`);
    if (inchLines > 0) warnings.add('The program uses inches (G20). Everything is shown in mm.');
    if (badWords > 0) warnings.add(`${badWords.toLocaleString('en-US')} words could not be read and were skipped.`);
    if (truncated) warnings.add(`Only the first ${maxMoves.toLocaleString('en-US')} moves are drawn (setting gcodeViewer.maxMoves). Stats and time cover the whole file.`);
    const names = cnc ? CNC_KINDS.map((k) => k[0]) : PRINT_FEATURES.map((f) => f[0]);
    const featureStats = [];
    if (cnc) for (let k = 0; k < 4; k++) { if (kindLen[k] > 0) featureStats.push({ id: k, name: CNC_KINDS[k][0], color: CNC_KINDS[k][1], len: kindLen[k], time: kindTime[k] }); } else for (let f = 0; f < PRINT_FEATURES.length; f++) if (featLen[f] > 0) featureStats.push({ id: f, name: PRINT_FEATURES[f][0], color: PRINT_FEATURES[f][1], len: featLen[f], time: featTime[f] });
    const fin = (b) => (Number.isFinite(b[0]) ? b : null);
    return {
      mode, layerSource: useComments ? 'comments' : 'z', truncated, maxMoves,
      lines: lineNo, moves, segments: segCount, arcs, retracts, dwells, toolChanges, homes: homeCount,
      layersTotal: layerCount,
      timeS: time, filamentMm: Math.max(0, filament), workLen, travelLen,
      feedMin: Number.isFinite(feedMin) ? feedMin : 0, feedMax,
      bounds: { work: fin(work) || fin(all), all: fin(all) },
      featureNames: names, featureStats, hasFeatureComments: haveFeature,
      tools: cnc ? toolNames.slice() : [], spindleMax, temps,
      slicer: info.slicer, flavor: info.flavor, slicerTime: info.slicerTime, slicerFilamentMm: info.slicerFilamentMm, slicerFilamentG: info.slicerFilamentG,
      warnings: [...warnings],
      geo: {
        pts: started ? pts.out() : new Float32Array(0), kind: kind.out(), feat: feat.out(), feed: feedA.out(), line: lineA.out(), tEnd: tEnd.out(),
        layerStart: lStart.out(), layerZ: lZ.out(), layerLine: lLine.out(), layerTime: lTime.out(),
      },
    };
  }

  return { push, end };
}

/** Convenience for tests and small inputs. */
function parseText(text, opts) {
  const p = createParser(opts);
  p.push(text);
  return p.end();
}

/** Index of the first segment whose end time is >= t (binary search). */
function segmentAtTime(tEnd, t) {
  let lo = 0, hi = tEnd.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tEnd[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Layer index that holds segment s. */
function layerOfSegment(layerStart, s) {
  let lo = 0, hi = layerStart.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (layerStart[mid] <= s) lo = mid; else hi = mid - 1; }
  return lo;
}

function fmtDuration(s) {
  if (!Number.isFinite(s) || s < 0) return '?';
  s = Math.round(s);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

module.exports = { KIND, PRINT_FEATURES, CNC_KINDS, featureOf, parseDuration, filamentGrams, sniff, slicerOf, createParser, parseText, segmentAtTime, layerOfSegment, fmtDuration, CNC_EXT };
