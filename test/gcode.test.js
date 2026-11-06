'use strict';
// Parser tests: generated samples, hand-checked small programs, arcs, units, slicer comments and edge cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/core/gcode.js');
const S = require('../scripts/make-samples.js');

const parse = (text, opts = {}) => G.parseText(text, { mode: 'print', layerSource: 'z', ...opts });
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
const auto = (text, name) => { const s = G.sniff(Buffer.from(text, 'latin1'), name); return G.parseText(text, { mode: s.mode, layerSource: s.layerSource }); };

const cubeText = S.cube();
const vaseText = S.vase();
const cncText = S.pocket();
const cube = auto(cubeText, 'cube-with-hole.gcode');
const vase = auto(vaseText, 'spiral-vase.gcode');
const cnc = auto(cncText, 'cnc-pocket.nc');

test('cube sample: 100 layers from ;LAYER: comments, each layer starts at its comment line', () => {
  assert.equal(cube.mode, 'print');
  assert.equal(cube.layerSource, 'comments');
  assert.equal(cube.layersTotal, 100);
  assert.equal(cube.geo.layerStart.length, 100);
  const lines = cubeText.split('\n');
  for (const k of [0, 1, 50, 99]) {
    const want = lines.indexOf(`;LAYER:${k}`) + 1;
    assert.equal(cube.geo.layerLine[k], want, `layer ${k}`);
    near(cube.geo.layerZ[k], 0.2 * (k + 1), 1e-4, `z of layer ${k}`);
  }
  // layer ranges are increasing and cover the moves
  for (let i = 1; i < 100; i++) assert.ok(cube.geo.layerStart[i] > cube.geo.layerStart[i - 1]);
});

test('cube sample: features, arcs, retractions, filament and temperatures', () => {
  const names = cube.featureStats.map((f) => f.name);
  assert.deepEqual(names, ['Outer wall', 'Inner wall', 'Infill', 'Bottom / skin', 'Skirt / brim']);
  assert.equal(cube.arcs, 400); // 2 circles of 2 half arcs per layer
  assert.equal(cube.retracts, 1547);
  // net E at the end of the file is the last absolute E written before the final retract
  const es = [...cubeText.matchAll(/E(-?[\d.]+)/g)].map((m) => Number(m[1]));
  near(cube.filamentMm, es[es.length - 1], 1e-3, 'filament');
  assert.deepEqual(cube.temps, { nozzle: 210, bed: 60 });
  assert.equal(cube.flavor, 'Marlin');
  assert.ok(cube.hasFeatureComments);
  // the extruded part is the 20 mm cube plus the skirt, on a 220 mm bed centred at 110
  const b = cube.bounds.work;
  near(b[2], 0.2, 1e-4); near(b[5], 20, 1e-4);
  assert.ok(b[0] > 90 && b[3] < 130);
});

test('time estimate equals distance / feed for a hand-checked program', () => {
  const m = parse('G21\nG90\nM83\nG1 X10 F600\nG1 Y10 E1 F1200\nG1 E-2 F2400\nG4 P500\nG4 S2\n');
  // 10 mm at 10 mm/s + 10 mm at 20 mm/s + 2 mm of E at 40 mm/s + 0.5 s + 2 s dwell
  near(m.timeS, 1 + 0.5 + 0.05 + 0.5 + 2, 1e-9);
  near(m.filamentMm, 0, 1e-9); // 1 mm out, 2 mm back: net clamped to 0
  assert.equal(m.retracts, 1);
  assert.equal(m.segments, 2);
  assert.deepEqual(Array.from(m.geo.kind), [G.KIND.TRAVEL, G.KIND.WORK]);
  assert.deepEqual(Array.from(m.geo.line), [4, 5]);
  near(m.geo.tEnd[1], 1.5, 1e-6);
  assert.equal(G.fmtDuration(3723), '1h 02m');
  assert.equal(G.fmtDuration(65), '1m 05s');
});

test('filament weight: 1 m of 1.75 mm PLA is about 2.98 g', () => {
  near(G.filamentGrams(1000, 1.75, 1.24), 2.982, 0.001);
});

test('vase sample: spiral with ;LAYER_CHANGE comments, Z rises inside a layer, relative E', () => {
  assert.equal(vase.layerSource, 'comments');
  assert.equal(vase.layersTotal, 3 + Math.round((90 - 0.75) / 0.25));
  const z = vase.geo.layerZ;
  for (let i = 1; i < z.length; i++) assert.ok(z[i] > z[i - 1], `layer ${i} z rises`);
  const names = vase.featureStats.map((f) => f.name);
  assert.ok(names.includes('Outer wall') && names.includes('Solid infill') && names.includes('Skirt / brim'));
  // speed varies with radius, so the speed colours have a range
  assert.ok(vase.feedMin >= 1200 && vase.feedMax <= 2400 && vase.feedMax > vase.feedMin + 300);
  assert.ok(vase.filamentMm > 1000);
});

test('CNC sample: Z passes, tools, move kinds, helical arc and drilled holes', () => {
  assert.equal(cnc.mode, 'cnc');
  assert.equal(cnc.layerSource, 'z');
  assert.deepEqual(Array.from(cnc.geo.layerZ), [-2, -4, -6, -8]);
  assert.deepEqual(cnc.tools, ['T1', 'T2']);
  assert.equal(cnc.toolChanges, 2);
  assert.equal(cnc.spindleMax, 12000);
  assert.equal(cnc.dwells, 4);
  const kinds = cnc.featureStats.map((f) => f.name);
  assert.deepEqual(kinds, ['Rapid (G0)', 'Cut (G1)', 'Arc (G2/G3)', 'Plunge']);
  near(cnc.bounds.work[2], -10, 1e-6, 'drill depth');
  // the helix: 8 full turns of r = 5 going 1 mm down each, plus a flat finishing turn
  const helixLen = 8 * Math.hypot(2 * Math.PI * 5, 1) + 2 * Math.PI * 5;
  const arcLen = cnc.featureStats.find((f) => f.name === 'Arc (G2/G3)').len;
  assert.ok(arcLen > helixLen, 'arcs include the helix');
  // each pass starts after the last cut of the pass before (retract, rapid and plunge belong to the new pass)
  const k = cnc.geo.kind, ls = cnc.geo.layerStart;
  for (let p = 1; p < ls.length; p++) assert.notEqual(k[ls[p]], G.KIND.WORK, `pass ${p} starts with a non-cut move`);
});

test('arcs: G2 is clockwise, G3 counter-clockwise, I/J full circles, R format, G18 plane', () => {
  const quarter = (cw) => parse(`G21 G90 G0 X10 Y0\nG${cw ? 2 : 3} X0 Y${cw ? -10 : 10} I-10 J0 F600\n`, { mode: 'cnc' });
  for (const cw of [true, false]) {
    const m = quarter(cw);
    const P = m.geo.pts; const n = m.geo.kind.length;
    const mid = Math.floor((n + 1) / 2) * 3;
    near(Math.hypot(P[mid], P[mid + 1]), 10, 1e-3, 'radius');
    assert.ok(cw ? P[mid + 1] < 0 : P[mid + 1] > 0, 'side of the arc');
    near(m.workLen, Math.PI * 5, 0.05, 'quarter arc length');
  }
  const full = parse('G21 G90 G0 X5 Y0\nG2 X5 Y0 I-5 J0 F600\n', { mode: 'cnc' });
  near(full.workLen, 2 * Math.PI * 5, 0.05, 'full circle');
  const r = parse('G21 G90 G0 X10 Y0\nG3 X0 Y10 R10 F600\n', { mode: 'cnc' });
  near(r.workLen, Math.PI * 5, 0.05, 'R arc');
  const rBig = parse('G21 G90 G0 X10 Y0\nG3 X0 Y10 R-10 F600\n', { mode: 'cnc' });
  near(rBig.workLen, Math.PI * 15, 0.1, 'negative R takes the long way');
  // G18 is the ZX plane (normal +Y): going from +X to +Z is clockwise, so G2 is the short quarter and G3 the long way
  const xz = parse('G21 G90 G18 G0 X10 Z0\nG2 X0 Z10 I-10 K0 F600\n', { mode: 'cnc' });
  near(parse('G21 G90 G18 G0 X10 Z0\nG3 X0 Z10 I-10 K0 F600\n', { mode: 'cnc' }).workLen, Math.PI * 15, 0.1, 'G18 G3 long way');
  const P = xz.geo.pts;
  for (let i = 0; i < P.length; i += 3) near(P[i + 1], 0, 1e-6, 'Y stays 0 in the XZ plane');
  near(xz.workLen, Math.PI * 5, 0.05);
  const bad = parse('G21 G90 G0 X0 Y0\nG2 X10 Y0 R2 F600\n', { mode: 'cnc' });
  assert.equal(bad.segments, 1); // drawn as one straight cut (the G0 to the origin has no length)
  assert.ok(bad.warnings.some((w) => /R value too small/.test(w)));
});

test('inches, relative moves, G92 resets, G28 home, line numbers, checksums and ( ) comments', () => {
  const inch = parse('G20\nG90\nG1 X1 Y0 F10\n', { mode: 'cnc' });
  near(inch.bounds.all[3], 25.4, 1e-6);
  near(inch.timeS, 25.4 / (254 / 60), 1e-6);
  assert.ok(inch.warnings.some((w) => /inches/.test(w)));
  const rel = parse('G91\nG1 X5 F600\nG1 X5\nG90\nG1 X0\n', { mode: 'cnc' });
  assert.deepEqual(Array.from(rel.geo.pts.filter((_, i) => i % 3 === 0)), [0, 5, 10, 0]);
  const reset = parse('G90\nM82\nG1 X10 E5 F600\nG92 E0\nG1 X20 E5\nG92 X0\nG1 X5 E6\n');
  near(reset.filamentMm, 11, 1e-9);
  assert.equal(reset.geo.kind[2], G.KIND.SKIP, 'G92 X0 is a jump, not a drawn move');
  const home = parse('G90\nG1 X10 Y10 Z5 F600\nG28 X\nG1 Y20\n', { mode: 'cnc' });
  const P = home.geo.pts;
  assert.deepEqual(Array.from(P.slice(-3)), [0, 20, 5]);
  const numbered = parse('N10 G1 X5 F600*55\nN20 G1 X(comment) 6 ; note\nN30 (only a comment)\nN40 G1 X7 (tail comment\n', { mode: 'cnc' });
  assert.deepEqual(Array.from(numbered.geo.pts.filter((_, i) => i % 3 === 0)), [0, 5, 6, 7]);
  assert.deepEqual(Array.from(numbered.geo.line), [1, 2, 4]);
});

test('modal motion: axis words without G repeat the last motion; M and G92 lines do not move', () => {
  const m = parse('G90 G1 X1 F600\nX2\nY2\nM206 X50\nG92 E0\nG4 P10\n', { mode: 'cnc' });
  assert.equal(m.segments, 3);
  assert.equal(m.bounds.all[3], 2);
});

test('slicer comments: Cura and PrusaSlicer time and filament, slicer names', () => {
  const cura = parse(';FLAVOR:Marlin\n;TIME:6534\n;Filament used: 1.234m\n;Generated with Cura_SteamEngine 5.7.1\nG1 X1 E1 F600\n');
  assert.equal(cura.slicerTime, 6534);
  near(cura.slicerFilamentMm, 1234, 1e-6);
  assert.equal(cura.slicer, 'Cura 5.7.1');
  const prusa = parse('; generated by PrusaSlicer 2.8.1+arm64 on 2026-11-06\nG1 X1 E1 F600\n; filament used [mm] = 1234.56\n; filament used [g] = 3.70\n; estimated printing time (normal mode) = 1h 2m 3s\n');
  assert.equal(prusa.slicer, 'PrusaSlicer 2.8.1+arm64');
  assert.equal(prusa.slicerTime, 3723);
  near(prusa.slicerFilamentMm, 1234.56, 1e-9);
  near(prusa.slicerFilamentG, 3.7, 1e-9);
  assert.equal(G.parseDuration('1d 2h 3m 4s'), 93784);
  assert.equal(G.parseDuration('42'), 42);
  assert.equal(G.parseDuration('soon'), null);
});

test('feature names from Cura, PrusaSlicer, OrcaSlicer, Bambu and Simplify3D map to one list', () => {
  const name = (s) => G.PRINT_FEATURES[G.featureOf(s)][0];
  const cases = {
    'WALL-OUTER': 'Outer wall', 'WALL-INNER': 'Inner wall', FILL: 'Infill', SKIN: 'Bottom / skin', SKIRT: 'Skirt / brim', SUPPORT: 'Support', 'SUPPORT-INTERFACE': 'Support interface', 'PRIME-TOWER': 'Prime tower',
    'External perimeter': 'Outer wall', Perimeter: 'Inner wall', 'Overhang perimeter': 'Overhang wall', 'Internal infill': 'Infill', 'Solid infill': 'Solid infill', 'Top solid infill': 'Top surface', 'Bridge infill': 'Bridge', 'Gap fill': 'Gap fill', 'Skirt/Brim': 'Skirt / brim', 'Support material interface': 'Support interface', 'Wipe tower': 'Prime tower', Ironing: 'Ironing', Custom: 'Custom',
    'Outer wall': 'Outer wall', 'Sparse infill': 'Infill', 'Internal solid infill': 'Solid infill', 'Top surface': 'Top surface', 'Bottom surface': 'Bottom / skin', 'Floating vertical shell': 'Inner wall',
    'outer perimeter': 'Outer wall', 'inner perimeter': 'Inner wall', 'solid layer': 'Solid infill', 'dense support': 'Support', '': 'Extrusion', 'something new': 'Extrusion',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(name(raw), want, raw);
  const bambu = parse('; FEATURE: Outer wall\nG1 X1 E1 F600\n; feature infill\nG1 X2 E2\n');
  assert.deepEqual(bambu.featureStats.map((f) => f.name), ['Outer wall', 'Infill']);
});

test('sniff: NetCDF, HDF5, binary G-code, binary data, empty file and mode detection', () => {
  const b = (s) => Buffer.from(s, 'latin1');
  assert.equal(G.sniff(b('CDF\x01\x00\x00\x00\x0a'), 'ocean.nc').kind, 'netcdf');
  assert.equal(G.sniff(b('CDF\x02rest'), 'x.nc').kind, 'netcdf');
  assert.equal(G.sniff(b('\x89HDF\r\n\x1a\n'), 'x.nc').kind, 'hdf5');
  assert.equal(G.sniff(b('GCDE\x01\x00'), 'x.gcode').kind, 'bgcode');
  assert.equal(G.sniff(b('G1 X1\x00\x00'), 'x.gcode').kind, 'binary');
  assert.equal(G.sniff(b(''), 'x.gcode').kind, 'empty');
  assert.equal(G.sniff(b('G1 X10 Y10 E1.5 F1200\n'), 'part.gcode').mode, 'print');
  assert.equal(G.sniff(b('G0 X10\nG1 X20 Y5 F300\nM3 S1000\n'), 'laser.gcode').mode, 'cnc');
  assert.equal(G.sniff(b('(program)\nG0 X1\n'), 'p.nc').mode, 'cnc');
  assert.equal(G.sniff(b(';LAYER:0\nG1 X1 E1\n'), 'a.gcode').layerSource, 'comments');
  assert.equal(G.sniff(b('G1 X1 E1\n'), 'a.gcode').layerSource, 'z');
});

test('chunks split anywhere give the same model as one push', () => {
  const p = G.createParser({ mode: 'print', layerSource: 'comments' });
  let i = 0; let n = 1;
  while (i < cubeText.length) { const len = (n * 7919) % 4093 + 1; p.push(cubeText.slice(i, i + len)); i += len; n++; }
  const m = p.end();
  assert.equal(m.segments, cube.segments);
  assert.equal(m.layersTotal, cube.layersTotal);
  near(m.timeS, cube.timeS, 1e-6);
  assert.deepEqual(Array.from(m.geo.line.slice(0, 500)), Array.from(cube.geo.line.slice(0, 500)));
  assert.deepEqual(Array.from(m.geo.pts.slice(-30)), Array.from(cube.geo.pts.slice(-30)));
  // CRLF line ends
  const crlf = auto(cubeText.replace(/\n/g, '\r\n'), 'a.gcode');
  assert.equal(crlf.segments, cube.segments);
});

test('maxMoves: drawing stops, stats still cover the whole file', () => {
  const m = G.parseText(cubeText, { mode: 'print', layerSource: 'comments', maxMoves: 1000 });
  assert.equal(m.segments, 1000);
  assert.equal(m.geo.kind.length, 1000);
  assert.equal(m.geo.pts.length, 1001 * 3);
  assert.ok(m.truncated);
  assert.equal(m.layersTotal, 100);
  assert.ok(m.geo.layerStart.length < 100);
  near(m.timeS, cube.timeS, 1e-6);
  assert.ok(m.warnings.some((w) => /Only the first 1,000 moves/.test(w)));
});

test('segmentAtTime and layerOfSegment', () => {
  const t = new Float32Array([1, 2, 3, 4]);
  assert.equal(G.segmentAtTime(t, 0), 0);
  assert.equal(G.segmentAtTime(t, 2.5), 2);
  assert.equal(G.segmentAtTime(t, 9), 4);
  const ls = new Uint32Array([0, 10, 20]);
  assert.equal(G.layerOfSegment(ls, 0), 0);
  assert.equal(G.layerOfSegment(ls, 15), 1);
  assert.equal(G.layerOfSegment(ls, 99), 2);
  assert.equal(G.layerOfSegment(new Uint32Array(0), 3), -1);
});

test('garbage and odd input never throws', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const alphabet = 'GMXYZEFIJKRPST0123456789.-+ ;()*N\n\t%';
  let s = '';
  for (let i = 0; i < 200000; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  for (const mode of ['print', 'cnc']) assert.doesNotThrow(() => G.parseText(s, { mode, layerSource: 'z' }));
  const m = G.parseText('grammar Foo;\nrule: A | B ;\n', { mode: 'print', layerSource: 'z' });
  assert.equal(m.segments, 0);
});

test('speed: a 30 MB program parses in a few seconds', () => {
  const big = vaseText.repeat(15);
  const t0 = Date.now();
  const p = G.createParser({ mode: 'print', layerSource: 'comments' });
  for (let i = 0; i < big.length; i += 4 << 20) p.push(big.slice(i, i + (4 << 20)));
  const m = p.end();
  const ms = Date.now() - t0;
  assert.equal(m.layersTotal, vase.layersTotal * 15);
  assert.ok(ms < 6000, `took ${ms} ms`);
  console.log(`# 30 MB parse: ${(big.length / 1048576).toFixed(1)} MB, ${m.segments} moves, ${ms} ms`);
});
