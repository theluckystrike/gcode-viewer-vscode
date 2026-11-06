'use strict';
// Writes the generated sample programs used by the tests, the README screenshots and the VS Code release check.
// Every file is made from scratch here. No slicer output and no third-party file is used.
//   node scripts/make-samples.js <dir>
// cube-with-hole.gcode  20 mm cube with a round hole, Cura-style ;LAYER: and ;TYPE: comments, absolute E, G2 arcs
// spiral-vase.gcode     wavy spiral vase, PrusaSlicer-style ;LAYER_CHANGE and ;TYPE: comments, relative E
// cnc-pocket.nc         CNC program: two tools, a rectangular pocket in 3 Z passes, a helical bore, drilled holes
const fs = require('fs');
const path = require('path');

const f3 = (v) => Number(v.toFixed(3)).toString();
const f5 = (v) => Number(v.toFixed(5)).toString();

// ---------------- cube with a round hole ----------------
function cube() {
  const out = [];
  const W = (s) => out.push(s);
  const cx = 110, cy = 110, half = 10, holeR = 5, lh = 0.2, layers = 100, lw = 0.45;
  const ePerMm = (lh * lw) / (Math.PI * 0.875 * 0.875);
  let e = 0, x = 0, y = 0, z = 0;
  const travel = (nx, ny) => { W(`G1 F2700 E${f5(e - 5)}`); W(`G0 F9000 X${f3(nx)} Y${f3(ny)}`); W(`G1 F2700 E${f5(e)}`); x = nx; y = ny; };
  const line = (nx, ny, f) => { e += Math.hypot(nx - x, ny - y) * ePerMm; W(`G1 F${f} X${f3(nx)} Y${f3(ny)} E${f5(e)}`); x = nx; y = ny; };
  const square = (h, f) => { travel(cx - h, cy - h); line(cx + h, cy - h, f); line(cx + h, cy + h, f); line(cx - h, cy + h, f); line(cx - h, cy - h, f); };
  // full circle as two G2 half arcs (as an arc-fitting slicer plugin writes them)
  const circle = (r, f) => {
    travel(cx + r, cy);
    const half = Math.PI * r; e += half * ePerMm; W(`G2 F${f} X${f3(cx - r)} Y${f3(cy)} I${f3(-r)} J0 E${f5(e)}`);
    e += half * ePerMm; W(`G2 F${f} X${f3(cx + r)} Y${f3(cy)} I${f3(r)} J0 E${f5(e)}`); x = cx + r; y = cy;
  };
  W('; Sample made by scripts/make-samples.js (GCode Viewer for VS Code). Not from a slicer.');
  W(';FLAVOR:Marlin');
  W(';Layer height: 0.2');
  W(`;LAYER_COUNT:${layers}`);
  W('M140 S60'); W('M104 S210'); W('M190 S60'); W('M109 S210');
  W('G21 ; millimetres'); W('G90 ; absolute XYZ'); W('M82 ; absolute E'); W('G28 ; home'); W('G92 E0');
  W('G0 F3000 Z5');
  for (let L = 0; L < layers; L++) {
    z = +(lh * (L + 1)).toFixed(3);
    W(`;LAYER:${L}`);
    W(`G0 F600 Z${f3(z)}`);
    const solid = L < 4 || L >= layers - 4;
    const fWall = L === 0 ? 1200 : 1800, fOuter = L === 0 ? 1200 : 1500, fFill = L === 0 ? 1200 : solid ? 2400 : 3600;
    if (L === 0) {
      W(';TYPE:SKIRT');
      for (let k = 0; k < 2; k++) square(half + 6 + k * lw, 1200);
    }
    W(';TYPE:WALL-INNER');
    square(half - lw * 1.5, fWall);
    circle(holeR + lw * 1.5, fWall);
    W(';TYPE:WALL-OUTER');
    square(half - lw / 2, fOuter);
    circle(holeR + lw / 2, fOuter);
    W(solid ? ';TYPE:SKIN' : ';TYPE:FILL');
    const lo = -half + lw * 2.2, hi = half - lw * 2.2;
    const spacing = solid ? lw : 3;
    const alongX = L % 2 === 0;
    let flip = false;
    for (let s = lo; s <= hi + 1e-9; s += spacing) {
      // a fill line across the square, split around the hole
      const d = Math.abs(s);
      const rIn = holeR + lw * 2.2;
      const pieces = d < rIn ? [[lo, -Math.sqrt(rIn * rIn - d * d)], [Math.sqrt(rIn * rIn - d * d), hi]] : [[lo, hi]];
      const ordered = flip ? pieces.map(([a, b]) => [b, a]).reverse() : pieces;
      for (const [a, b] of ordered) {
        if (Math.abs(b - a) < 0.5) continue;
        const p0 = alongX ? [cx + a, cy + s] : [cx + s, cy + a];
        const p1 = alongX ? [cx + b, cy + s] : [cx + s, cy + b];
        if (Math.hypot(p0[0] - x, p0[1] - y) > 1.5) travel(p0[0], p0[1]); else { W(`G0 F9000 X${f3(p0[0])} Y${f3(p0[1])}`); x = p0[0]; y = p0[1]; }
        line(p1[0], p1[1], fFill);
      }
      flip = !flip;
    }
  }
  W(';TYPE:CUSTOM'); W('G1 F2700 E' + f5(e - 5)); W('G0 F3000 Z' + f3(z + 10)); W('G0 X0 Y200'); W('M104 S0'); W('M140 S0'); W('M84');
  return out.join('\n') + '\n';
}

// ---------------- spiral vase ----------------
function vase() {
  const out = [];
  const W = (s) => out.push(s);
  const cx = 110, cy = 110, lh = 0.25, height = 90, perRev = 120, lw = 0.5;
  const ePerMm = (lh * lw) / (Math.PI * 0.875 * 0.875);
  const radius = (zz, th) => 24 + 7 * Math.sin(zz / 14) + 1.6 * Math.sin(6 * th + zz / 9);
  let x = 0, y = 0;
  W('; Sample made by scripts/make-samples.js (GCode Viewer for VS Code). Not from a slicer.');
  W('M140 S60'); W('M104 S215'); W('G28'); W('G21'); W('G90'); W('M83 ; relative E'); W('M190 S60'); W('M109 S215');
  const go = (nx, ny, nz, f) => { W(`G1 X${f3(nx)} Y${f3(ny)}${nz != null ? ` Z${f3(nz)}` : ''} F${f}`); x = nx; y = ny; };
  const ext = (nx, ny, nz, f) => { const d = Math.hypot(nx - x, ny - y); W(`G1 X${f3(nx)} Y${f3(ny)}${nz != null ? ` Z${f3(nz)}` : ''} E${f5(d * ePerMm)} F${f}`); x = nx; y = ny; };
  // brim and 3 solid bottom layers made of rings
  for (let L = 0; L < 3; L++) {
    const z = lh * (L + 1);
    W(';LAYER_CHANGE'); W(`;Z:${f3(z)}`); W(`;HEIGHT:${lh}`);
    go(cx + 40, cy, z, 7200);
    if (L === 0) {
      W(';TYPE:Skirt/Brim');
      for (let k = 0; k < 4; k++) { const r = 36 + k * lw; go(cx + r, cy, null, 7200); for (let i = 1; i <= perRev; i++) { const a = (i / perRev) * 2 * Math.PI; ext(cx + r * Math.cos(a), cy + r * Math.sin(a), null, 1200); } }
    }
    W(';TYPE:External perimeter');
    const r0 = radius(z, 0);
    go(cx + r0, cy, null, 7200);
    for (let i = 1; i <= perRev; i++) { const a = (i / perRev) * 2 * Math.PI; const r = radius(z, a); ext(cx + r * Math.cos(a), cy + r * Math.sin(a), null, 1500); }
    W(';TYPE:Solid infill');
    for (let r = r0 - 1.5 * lw; r > 2; r -= lw * 1.6) {
      go(cx + r, cy, null, 7200);
      for (let i = 1; i <= 72; i++) { const a = (i / 72) * 2 * Math.PI; const rr = r * radius(z, a) / r0; ext(cx + rr * Math.cos(a), cy + rr * Math.sin(a), null, 2400); }
    }
    W(';WIPE_START'); W('G1 E-0.8 F2100'); W(';WIPE_END');
  }
  // spiral: z rises continuously, one ;LAYER_CHANGE per turn
  let z = lh * 3;
  const turns = Math.round((height - z) / lh);
  W(';TYPE:External perimeter');
  W('G1 E0.8 F2100');
  for (let t = 0; t < turns; t++) {
    W(';LAYER_CHANGE'); W(`;Z:${f3(z + lh)}`); W(`;HEIGHT:${lh}`);
    for (let i = 1; i <= perRev; i++) {
      const a = (i / perRev) * 2 * Math.PI;
      const zz = z + lh * (i / perRev);
      const r = radius(zz, a);
      const f = Math.round(1200 + 1200 * (r - 15) / 20); // narrower parts print slower
      ext(cx + r * Math.cos(a), cy + r * Math.sin(a), zz, f);
    }
    z += lh;
  }
  W(';TYPE:Custom'); W('G1 E-1 F2100'); W(`G1 Z${f3(z + 10)} F600`); W('M104 S0'); W('M140 S0'); W('M84');
  return out.join('\n') + '\n';
}

// ---------------- CNC pocket ----------------
function pocket() {
  const out = [];
  let n = 10;
  const W = (s) => { out.push(`N${n} ${s}`); n += 10; };
  out.push('%');
  out.push('(Sample made by scripts/make-samples.js for GCode Viewer. Not from a CAM program.)');
  out.push('(Stock 100 x 70 x 12 mm, zero at the top left corner of the stock top)');
  W('G21 G90 G17 G94');
  W('G54');
  W('(T1 6 mm flat end mill: rectangular pocket 60 x 40 x 6, 3 passes)');
  W('T1 M6');
  W('S12000 M3');
  W('G0 Z5');
  const px0 = 20, py0 = -55, pw = 60, ph = 40, rc = 4, step = 2.4;
  const roundedRect = (x0, y0, w, h, r, f) => {
    // counter-clockwise rectangle with G3 corner arcs, starting at the middle of the bottom edge
    W(`G1 X${f3(x0 + w - r)} Y${f3(y0)} F${f}`);
    W(`G3 X${f3(x0 + w)} Y${f3(y0 + r)} I0 J${f3(r)}`);
    W(`G1 Y${f3(y0 + h - r)}`);
    W(`G3 X${f3(x0 + w - r)} Y${f3(y0 + h)} I${f3(-r)} J0`);
    W(`G1 X${f3(x0 + r)}`);
    W(`G3 X${f3(x0)} Y${f3(y0 + h - r)} R${f3(r)}`);
    W(`G1 Y${f3(y0 + r)}`);
    W(`G3 X${f3(x0 + r)} Y${f3(y0)} I${f3(r)} J0`);
    W(`G1 X${f3(x0 + w / 2)}`);
  };
  for (const depth of [-2, -4, -6]) {
    W(`(Pass Z${depth})`);
    W(`G0 X${f3(px0 + pw / 2)} Y${f3(py0 + ph / 2)}`);
    W('G0 Z1');
    W(`G1 Z${depth} F300`);
    // offsets from the centre out
    const maxK = Math.floor((Math.min(pw, ph) / 2 - 3) / step);
    for (let k = maxK; k >= 0; k--) {
      const inset = 3 + k * step;
      const x0 = px0 + inset, y0 = py0 + inset, w = pw - 2 * inset, h = ph - 2 * inset;
      if (w <= 0 || h <= 0) continue;
      W(`G1 X${f3(x0 + w / 2)} Y${f3(y0)} F1200`);
      roundedRect(x0, y0, w, h, Math.min(rc, w / 2, h / 2) * (k === 0 ? 1 : 0.5), 1500);
    }
    W('G0 Z5');
  }
  W('(Helical bore 16 mm diameter, 8 mm deep, 1 mm per turn)');
  const bx = 88, by = -20, br = 5;
  W(`G0 X${f3(bx + br)} Y${f3(by)}`);
  W('G0 Z1');
  W('G1 Z0 F300');
  for (let d = -1; d >= -8; d--) W(`G2 X${f3(bx + br)} Y${f3(by)} Z${d} I${f3(-br)} J0 F800`);
  W(`G2 X${f3(bx + br)} Y${f3(by)} I${f3(-br)} J0`);
  W('G0 Z5');
  W('(T2 4 mm drill: four holes)');
  W('M5');
  W('T2 M6');
  W('S6000 M3');
  for (const [hx, hy] of [[10, -10], [90, -60], [10, -60], [50, -10]]) {
    W(`G0 X${hx} Y${hy}`);
    W('G0 Z2');
    W('G1 Z-10 F150');
    W('G4 P0.5');
    W('G0 Z5');
  }
  W('M5');
  W('G0 Z25');
  W('G0 X0 Y0');
  W('M30');
  out.push('%');
  return out.join('\n') + '\n';
}

const SAMPLES = { 'cube-with-hole.gcode': cube, 'spiral-vase.gcode': vase, 'cnc-pocket.nc': pocket };

function writeAll(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, fn] of Object.entries(SAMPLES)) {
    const text = fn();
    if (text.length > 5 * 1024 * 1024) throw new Error(`${name} would be over 5 MB`);
    fs.writeFileSync(path.join(dir, name), text);
    written.push([name, text.length]);
  }
  return written;
}

if (require.main === module) {
  const dir = process.argv[2] || 'samples';
  for (const [name, size] of writeAll(dir)) console.log(`${name}  ${(size / 1024).toFixed(1)} KB`);
}

module.exports = { cube, vase, pocket, writeAll, SAMPLES };
