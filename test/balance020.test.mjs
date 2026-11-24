// 0.2.0-alpha.1: roles, materials, spin-axis line math, static imbalance, drive pin, orbiting load, ISO 1940,
// check mode, containment, solver hook, balance session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, setRole, normalizeRoles, roleIndex, inResiduals } from '../src/roles.js';
import { MATERIALS, materialId, applyMaterial, addedMaterial, normalizeAdded, gcc } from '../src/materials.js';
import { normalizeDir, lineDistance, angleDeg, staticOf, pinFromAxis, pinTyped, orbitU, isoG, nearestGrade, meetsGrade, permissibleU, isoReadout, checkBalance, correctionTarget, polar, wrap180, inBand, GRADES } from '../src/statics.js';
import { fitCylinderTris, fitPlane, regionTris, makeAxis } from '../src/fit.js';
import { buildIndex, classify, containment } from '../src/contain.js';
import { meshMoments, scale, KGM3, add, zero } from '../src/mass.js';
import { exportBalance, restoreBalance, BALANCE_DEFAULT } from '../src/balance-session.js';
import { restoreSession, bodyRef } from '../src/bodies.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const body = (name, extra = {}) => ({ name, role: '', on: true, sign: 1, rho: 7850, vol: { m: 1000, M1: [0, 0, 0], S: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, bbox: [0, 0, 0, 10, 10, 10], ...extra });

// ---------- synthetic meshes ----------
function boxMesh(lo, hi) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi, P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  return { pos: P.flat(), idx: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] };
}
// closed cylinder (axis through c along unit d), n facets, k rings; side triangles first
function cylMesh(c, d, r, h, n = 64, k = 4) {
  const hh = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let u = cr(hh, d); const un = Math.hypot(...u); u = u.map(v => v / un); const v = cr(d, u), pos = [], idx = [];
  const P = (a, z) => [0, 1, 2].map(i => c[i] + r * Math.cos(a) * u[i] + r * Math.sin(a) * v[i] + z * d[i]);
  for (let j = 0; j <= k; j++) for (let i = 0; i < n; i++) pos.push(...P(2 * Math.PI * i / n, -h / 2 + h * j / k));
  for (let j = 0; j < k; j++) for (let i = 0; i < n; i++) { const a = j * n + i, b = j * n + (i + 1) % n; idx.push(a, b, b + n, a, b + n, a + n); }
  const cb = pos.length / 3; pos.push(...[0, 1, 2].map(i => c[i] - h / 2 * d[i])); const ct = cb + 1; pos.push(...[0, 1, 2].map(i => c[i] + h / 2 * d[i]));
  for (let i = 0; i < n; i++) { idx.push(cb, (i + 1) % n, i); idx.push(ct, k * n + i, k * n + (i + 1) % n); }
  return { pos, idx, sideTris: k * n * 2 };
}
const Z = { p: [0, 0, 0], d: [0, 0, 1] };

test('roles: one Hub and one Boundary (picking a new one clears the old), any number of existing counterweights', () => {
  assert.deepEqual(ROLES.map(r => r.id), ['', 'hub', 'boundary', 'cw', 'ignore']);
  const b = [body('a'), body('b'), body('c'), body('d')];
  assert.deepEqual(setRole(b, 0, 'hub'), []); assert.deepEqual(setRole(b, 1, 'hub'), [0]);
  assert.equal(b[0].role, ''); assert.equal(b[1].role, 'hub');
  setRole(b, 2, 'boundary'); assert.deepEqual(setRole(b, 0, 'boundary'), [2]); assert.equal(b[2].role, '');
  setRole(b, 2, 'cw'); setRole(b, 3, 'cw'); assert.deepEqual(roleIndex(b), { hub: 1, boundary: 0, cw: [2, 3], ignore: [] });
  setRole(b, 1, 'ignore'); assert.equal(roleIndex(b).hub, -1);
  assert.throws(() => setRole(b, 0, 'keepout'), /unknown role/);
  assert.ok(!inResiduals({ ...b[0], role: 'boundary' }) && !inResiduals({ ...b[0], role: 'ignore' }) && inResiduals({ ...b[0], role: 'hub' }) && inResiduals({ ...b[0], role: 'cw' }) && !inResiduals({ ...b[0], role: 'hub', on: false }));
  const bad = [body('x', { role: 'hub' }), body('y', { role: 'hub' }), body('z', { role: 'keepout' }), body('w', { role: undefined })];
  const notes = normalizeRoles(bad);
  assert.deepEqual(bad.map(x => x.role), ['hub', '', '', '']); assert.equal(notes.length, 2);
});

test('materials: steel and tungsten heavy alloy presets, custom density, added material follows the hub', () => {
  assert.deepEqual(MATERIALS.map(m => m.rho), [7850, 17000, 17600, 18000, 18500]);
  assert.equal(materialId(7850), 'steel'); assert.equal(materialId(18500), 'wha185'); assert.equal(materialId(7800), 'custom'); assert.equal(gcc(17600), 17.6);
  const b = body('hub'); assert.ok(applyMaterial(b, 'wha176')); assert.equal(b.rho, 17600); assert.equal(b.mat, 'wha176');
  assert.ok(applyMaterial(b, 'custom', 17300)); assert.equal(b.rho, 17300); assert.ok(!applyMaterial(b, 'custom', -1)); assert.ok(!applyMaterial(b, 'nope'));
  b.mat = 'steel'; b.rho = 7850;
  assert.equal(addedMaterial({ mode: 'hub' }, b).rho, 7850); assert.ok(addedMaterial({ mode: 'hub' }, b).follows);
  assert.equal(addedMaterial({ mode: 'hub' }, null), null);
  assert.equal(addedMaterial({ mode: 'wha180' }, b).rho, 18000); assert.equal(addedMaterial({ mode: 'custom', rho: 17250 }, b).rho, 17250);
  assert.deepEqual(normalizeAdded(undefined), { mode: 'hub', rho: null }); assert.deepEqual(normalizeAdded({ mode: 'custom', rho: '17100' }), { mode: 'custom', rho: 17100 });
  assert.deepEqual(normalizeAdded({ mode: 'custom', rho: 0 }), { mode: 'hub', rho: null });
});

test('axis line math: perpendicular point–line distance and one-time direction normalization', () => {
  near(lineDistance([3, 4, 100], [0, 0, 0], [0, 0, 5]), 5, 1e-12);
  near(lineDistance([1, 1, 1], [0, 0, 0], [1, 1, 1]), 0, 1e-12);
  near(lineDistance([0, 2, 0], [1, 0, 0], [1, 0, 0]), 2, 1e-12);
  // tilted line through p: distance of p + t·d + s·n equals |s| for any t
  const d = normalizeDir([1, 2, 2]).d, n = [2, -1, 0].map(v => v / Math.sqrt(5)), p = [5, -3, 8];
  for (const [t, s] of [[0, 1], [10, 7.5], [-4, 0.25]]) near(lineDistance(p.map((v, k) => v + t * d[k] + s * n[k]), p, [1, 2, 2]), s, 1e-12);
  assert.deepEqual(normalizeDir([0, 0, 2]), { d: [0, 0, 1] }); near(Math.hypot(...normalizeDir([1, 2, 2]).d), 1, 1e-15);
  assert.ok(normalizeDir([0, 0, 0]).error); assert.ok(normalizeDir([1, NaN, 0]).error);
  const once = normalizeDir([3, 0, 4]).d, twice = normalizeDir(once).d; assert.deepEqual(once, [0.6, 0, 0.8]); assert.deepEqual(twice, once);
  assert.deepEqual(makeAxis([0, 0, 0], [0, 0, 2]).d, [0, 0, 1]);
});

test('static imbalance: |U| = m × CG offset; angle 0° = +u, 90° = +v (right-handed about the axis)', () => {
  // 1 kg point-like mass at (2, 0, 7) mm about world Z → U = 2000 g·mm at 0°
  const mom = { m: 1000, M1: [2000, 0, 7000], S: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  let s = staticOf(mom, Z); near(s.mag, 2000, 1e-9); near(s.ang, 0, 1e-12); near(s.offset, 2, 1e-12);
  s = staticOf({ ...mom, M1: [0, 3000, 0] }, Z); near(s.ang, 90, 1e-12); near(s.offset, 3, 1e-12);
  s = staticOf({ ...mom, M1: [-1000, -1000, 0] }, Z); near(s.ang, 225, 1e-12);
  // real mesh: box 10×10×10 centred at (5+3, 4, 5): CG offset from Z = hypot(8, 4)
  const bx = boxMesh([3, -1, 0], [13, 9, 10]), mm = scale(meshMoments(bx.pos, bx.idx), 7850 * KGM3), sb = staticOf(mm, Z);
  near(sb.offset, Math.hypot(8, 4), 1e-9); near(sb.mag, mm.m * Math.hypot(8, 4), 1e-6); near(sb.ang, Math.atan2(4, 8) * 180 / Math.PI, 1e-9);
  // tilted axis: offset is the perpendicular distance, |U| = m·offset still
  const ax = { p: [1, 2, 3], d: normalizeDir([1, 1, 3]).d }, st = staticOf(mm, ax);
  near(st.offset, lineDistance(mm.M1.map(v => v / mm.m), ax.p, ax.d), 1e-9); near(st.mag, mm.m * st.offset, 1e-6);
  near(angleDeg(-1, 0), 180, 1e-12); near(wrap180(350), -10, 1e-12); near(wrap180(-190), 170, 1e-12);
});

test('ISO 1940: G = e·ω (mm/s), nearest standard grade, finest grade met, permissible U', () => {
  near(isoG(0.001, 60000 / (2 * Math.PI)), 1, 1e-12); // e 1 µm at ω 1000 rad/s → G 1
  assert.equal(nearestGrade(2.3), 2.5); assert.equal(nearestGrade(4.5), 6.3); assert.equal(nearestGrade(1e5), 4000); assert.equal(nearestGrade(0.01), 0.4);
  assert.equal(meetsGrade(2.5), 2.5); assert.equal(meetsGrade(2.51), 6.3); assert.equal(meetsGrade(5000), null); assert.equal(GRADES.length, 11);
  // G2.5 at 3000 rpm, rotor 2 kg → U_per = 2.5 · 2000 / 314.159 ≈ 15.92 g·mm
  near(permissibleU(2.5, 2000, 3000), 2.5 * 2000 / (2 * Math.PI * 50), 1e-12);
  const r = isoReadout(15.915494309189533, 2000, 3000); near(r.G, 2.5, 1e-9); assert.equal(r.meets, 2.5); assert.equal(isoReadout(10, 2000, null), null);
});

test('cylinder-axis fit on a synthetic cylinder (no face ids: mesh region) and planar-face normal', () => {
  const d = normalizeDir([0.2, -0.1, 1]).d, c = [12, -7, 30], m = cylMesh(c, d, 4, 20, 72, 3);
  const tris = regionTris(m.pos, m.idx, 5); assert.equal(tris.length, m.sideTris, 'region stops at the sharp cap edges');
  const f = fitCylinderTris(m.pos, m.idx, tris); assert.ok(!f.error, f.error);
  near(Math.abs(f.d[0] * d[0] + f.d[1] * d[1] + f.d[2] * d[2]), 1, 1e-9, 'axis direction'); near(lineDistance(c, f.p, f.d), 0, 1e-9, 'axis passes through the centre');
  near(f.r, 4 * Math.cos(Math.PI / 72), 4e-3 * 4, 'radius (chordal)');
  const capTris = [m.sideTris, m.sideTris + 2, m.sideTris + 4];
  const pl = fitPlane(m.pos, m.idx, regionTris(m.pos, m.idx, capTris[0])); assert.ok(!pl.error, pl.error);
  near(Math.abs(pl.d[0] * d[0] + pl.d[1] * d[1] + pl.d[2] * d[2]), 1, 1e-12, 'cap normal ∥ axis');
  assert.ok(fitPlane(m.pos, m.idx, tris).error, 'a cylinder is not planar');
});

test('drive pin: e and angle from a synthetic offset cylinder, parallel check and projection, typed fallback', () => {
  // pin r 3 at e = 8 mm, 30° in the Z frame
  const at = polar(8, 30), m = cylMesh([at[0], at[1], 15], [0, 0, 1], 3, 12, 48, 2), f = fitCylinderTris(m.pos, m.idx, regionTris(m.pos, m.idx, 0));
  const pin = pinFromAxis(f, Z); near(pin.e, 8, 1e-9); near(pin.ang, 30, 1e-9); assert.ok(!pin.projected); assert.ok(pin.tiltDeg < 1e-6);
  // about a tilted spin axis the frame changes but e stays the perpendicular distance
  const ax = { p: [0, 0, 0], d: normalizeDir([0, 0.3, 1]).d }, m2 = cylMesh([5, 0, 0], ax.d, 2, 10, 48, 2), p2 = pinFromAxis(fitCylinderTris(m2.pos, m2.idx, regionTris(m2.pos, m2.idx, 0)), ax);
  near(p2.e, 5, 1e-9); assert.ok(!p2.projected);
  // 1° tilt → warned and projected parallel; within 0.5° → not
  const tilt = d => ({ p: [8, 0, 0], d: [Math.sin(d * Math.PI / 180), 0, Math.cos(d * Math.PI / 180)] });
  const t1 = pinFromAxis(tilt(1), Z); assert.ok(t1.projected && /off parallel/.test(t1.warn)); near(t1.tiltDeg, 1, 1e-9); near(t1.e, 8, 1e-12);
  assert.ok(!pinFromAxis(tilt(0.4), Z).projected);
  assert.deepEqual(pinTyped(6, -90), { e: 6, ang: 270, src: 'typed', tiltDeg: 0, projected: false }); assert.ok(pinTyped(-1, 0).error);
});

test('orbiting load at the pin: total imbalance and needed counterweight', () => {
  const pin = pinTyped(10, 90), load = orbitU(250, pin); near(load[0], 0, 1e-9); near(load[1], 2500, 1e-9);
  const hub = { m: 2000, M1: [3000, 0, 0], S: Array(9).fill(0) }; // 3000 g·mm at 0°
  const t = correctionTarget({ parts: [hub], points: [load], axis: Z });
  near(t.total.mag, Math.hypot(3000, 2500), 1e-9); near(t.total.ang, Math.atan2(2500, 3000) * 180 / Math.PI, 1e-9);
  near(t.planes[0].mag, t.total.mag, 1e-9); near(wrap180(t.planes[0].ang - t.total.ang), 180, 1e-9);
  assert.deepEqual(orbitU(0, pin), [0, 0]); assert.deepEqual(orbitU(100, null), [0, 0]);
});

test('solver API: list of correction planes (static now, two-plane later) and the axial-band hook', () => {
  const hub = { m: 1000, M1: [500, 0, 10000], S: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const one = correctionTarget({ parts: [hub], axis: Z, constraints: { axialBand: [2, 18] } });
  assert.equal(one.kind, 'static'); assert.deepEqual(one.constraints.axialBand, [2, 18]); near(one.planes[0].mag, 500, 1e-12);
  assert.throws(() => correctionTarget({ parts: [hub], axis: Z, constraints: { axialBand: [5, 1] } }), /axialBand/);
  assert.throws(() => correctionTarget({ parts: [hub], axis: Z, planes: [{}, {}, {}] }), /planes/);
  const two = correctionTarget({ parts: [hub], axis: Z, planes: [{ z: 0 }, { z: 20 }] }); assert.equal(two.kind, 'two-plane');
  near(two.planes[0].U[0] + two.planes[1].U[0], -500, 1e-9); // static sum still cancels
  assert.ok(inBand(5, [2, 18]) && !inBand(19, [2, 18]) && inBand(100, null));
});

test('check mode: residual, % corrected, over/under, angle error, PASS/FAIL by g·mm and by G grade', () => {
  const base = [1000, 0];
  let c = checkBalance({ base, cw: [-900, 0], M: 2000, rpm: 3000, tol: { kind: 'gmm', value: 150 } });
  near(c.resid.mag, 100, 1e-9); near(c.pct, 0.9, 1e-12); near(c.ratio, 0.9, 1e-12); assert.equal(c.state, 'under'); assert.equal(c.pass, true); near(c.resid.ang, 0, 1e-9);
  c = checkBalance({ base, cw: [-1200, 0], M: 2000, rpm: 3000, tol: { kind: 'gmm', value: 150 } });
  near(c.ratio, 1.2, 1e-12); assert.equal(c.state, 'over'); assert.equal(c.pass, false); near(c.resid.mag, 200, 1e-9); near(c.resid.ang, 180, 1e-9); near(c.pct, 0.8, 1e-12);
  c = checkBalance({ base, cw: [-1005, 0], M: 2000, rpm: 3000, tol: null }); assert.equal(c.state, 'matched'); assert.equal(c.pass, null);
  // perpendicular / angle error: counterweight 10° off the ideal direction
  const off = polar(1000, 190); c = checkBalance({ base, cw: off, M: 2000, rpm: 3000, tol: null });
  near(c.angErr, 10, 1e-9); assert.ok(c.angFlag); near(Math.abs(c.perp), Math.sin(10 * Math.PI / 180), 1e-12); near(c.ratio, Math.cos(10 * Math.PI / 180), 1e-12);
  assert.ok(!checkBalance({ base, cw: polar(1000, 182), M: 2000, rpm: 3000, tol: null }).angFlag);
  // G-grade tolerance: G2.5 at 3000 rpm, M 2000 g → 15.915 g·mm
  const lim = permissibleU(2.5, 2000, 3000);
  c = checkBalance({ base, cw: [-1000 + lim * 0.99, 0], M: 2000, rpm: 3000, tol: { kind: 'G', value: 2.5 } }); assert.equal(c.pass, true); near(c.limit, lim, 1e-12); assert.equal(c.iso.meets, 2.5);
  c = checkBalance({ base, cw: [-1000 + lim * 1.01, 0], M: 2000, rpm: 3000, tol: { kind: 'G', value: 2.5 } }); assert.equal(c.pass, false); assert.equal(c.iso.meets, 6.3);
  assert.equal(checkBalance({ base, cw: [-1000, 0], M: 2000, rpm: null, tol: { kind: 'G', value: 2.5 } }).pass, null, 'G tolerance needs an RPM');
  // counterweight angle relative to the pin
  c = checkBalance({ base, cw: [-1000, 0], M: 2000, rpm: null, tol: null, pinAng: 0 }); near(c.cwRelPin, 180, 1e-9);
});

test('containment on synthetic boxes: inside, touching, partly outside, edge/vertex-aligned rays, concave crossing', () => {
  const B = boxMesh([0, 0, 0], [10, 10, 10]), I = buildIndex(B.pos, B.idx);
  const inner = boxMesh([2, 2, 2], [8, 8, 8]); let r = containment(I, inner.pos, inner.idx);
  assert.ok(r.inside); assert.equal(r.nOut, 0); assert.equal(r.n, 8);
  const touch = boxMesh([0, 0, 0], [10, 5, 5]); r = containment(I, touch.pos, touch.idx); assert.ok(r.inside, 'faces on the boundary count as inside');
  const half = boxMesh([5, 2, 2], [15, 8, 8]); r = containment(I, half.pos, half.idx); assert.equal(r.nOut, 4); near(r.frac, 0.5, 1e-12); assert.ok(!r.inside); assert.ok(r.crossings > 0);
  // rays through the face diagonals (shared triangle edges) and through vertices: parity must stay right
  for (const p of [[5, 5, 5], [2, 2, 2], [3, 3, 7], [1, 1, 1], [9, 9, 9], [4, 6, 4]]) assert.equal(classify(I, p), 'in', String(p));
  for (const p of [[-1, -1, -1], [11, 5, 5], [5, 5, 10.5], [-2, -2, 5], [12, 12, 12]]) assert.equal(classify(I, p), 'out', String(p));
  // the same along all diagonal grid points of a finer lattice (many exact edge hits)
  let wrong = 0; for (let x = -1; x <= 11; x++) for (let y = -1; y <= 11; y++) for (const z of [-1, 3, 5, 11]) { const inn = x > 0 && x < 10 && y > 0 && y < 10 && z > 0 && z < 10, c = classify(I, [x, y, z]); if ((c === 'in') !== inn && c !== 'on') wrong++; } assert.equal(wrong, 0);
  // concave (L-shaped) boundary: a prism with every vertex inside whose edge crosses the notch
  const L = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]], pos = [], idx = [];
  for (const z of [0, 10]) for (const [x, y] of L) pos.push(x, y, z);
  const tri = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]]; for (const [a, b, c] of tri) { idx.push(a, c, b); idx.push(6 + a, 6 + b, 6 + c); }
  for (let i = 0; i < 6; i++) { const j = (i + 1) % 6; idx.push(i, j, 6 + j, i, 6 + j, 6 + i); }
  const IL = buildIndex(pos, idx); assert.equal(classify(IL, [7, 7, 5]), 'out'); assert.equal(classify(IL, [2, 8, 5]), 'in'); near(meshMoments(pos, idx).m, 750, 1e-9);
  const wedge = { pos: [9, 4, 3, 4, 9, 3, 4, 4, 3, 9, 4, 6, 4, 9, 6, 4, 4, 6], idx: [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5] };
  r = containment(IL, wedge.pos, wedge.idx); assert.equal(r.nOut, 0, 'all vertices inside'); assert.ok(r.crossings > 0, 'but its edges cross the boundary'); assert.ok(!r.inside);
  // hub overlap mode (strict): touching is not overlap
  const s = containment(I, touch.pos, touch.idx, { strict: true }); assert.equal(s.n - s.nOut, 0);
});

test('balance session: round trip, legacy defaults, picked pin follows the axis, load body matched', () => {
  const bodies = [body('hub', { role: 'hub', mat: 'wha180', rho: 18000 }), body('scroll', { role: 'ignore', vol: { m: 500 }, bbox: [0, 0, 20, 5, 5, 25] })];
  const bal = { ...BALANCE_DEFAULT(), added: { mode: 'wha185', rho: null }, pin: { src: 'pick', p: [8, 0, 5], d: [0, 0, 1], r: 3 }, load: { kind: 'body', body: 1 }, rpm: 6000, tol: { kind: 'G', value: 2.5 } };
  const j = JSON.parse(JSON.stringify(exportBalance(bal, bodies)));
  const { bal: back, notes } = restoreBalance(j, bodies); assert.deepEqual(notes, []);
  assert.deepEqual(back.added, { mode: 'wha185', rho: null }); assert.equal(back.pin.src, 'pick'); assert.deepEqual(back.pin.p, [8, 0, 5]);
  assert.equal(back.load.kind, 'body'); assert.equal(back.load.body, 1); assert.equal(back.rpm, 6000); assert.deepEqual(back.tol, { kind: 'G', value: 2.5 });
  near(pinFromAxis(back.pin, { p: [2, 0, 0], d: [0, 0, 1] }).e, 6, 1e-12, 'e follows an axis moved after the pick');
  const typed = restoreBalance(exportBalance({ ...bal, pin: pinTyped(7, 45), load: { kind: 'mass', mass: 120 } }, bodies), bodies).bal;
  assert.equal(typed.pin.e, 7); assert.equal(typed.pin.ang, 45); assert.deepEqual(typed.load, { kind: 'mass', body: -1, mass: 120 });
  assert.deepEqual(restoreBalance(undefined, bodies).bal, BALANCE_DEFAULT(), 'older sessions load with defaults');
  const gone = restoreBalance(j, [bodies[0]]); assert.equal(gone.bal.load.kind, 'none'); assert.equal(gone.notes.length, 1);
});

test('session restore applies roles and materials; older sessions (no role) load with no roles; two hubs are normalized', () => {
  const cur = () => [body('hub', { vol: { m: 1000 }, bbox: [0, 0, 0, 10, 10, 10] }), body('bnd', { vol: { m: 9000 }, bbox: [-20, -20, -5, 20, 20, 30] }), body('cw', { vol: { m: 300 }, bbox: [-9, 0, 0, -3, 5, 4] })];
  const c1 = cur(), saved = c1.map((b, i) => ({ ...bodyRef(b, i), on: true, rho: [18000, 7850, 17600][i], src: 'user', role: ['hub', 'boundary', 'cw'][i], mat: ['wha180', 'steel', 'wha176'][i] }));
  const c2 = cur(); restoreSession({ bodies: saved }, c2);
  assert.deepEqual(c2.map(b => b.role), ['hub', 'boundary', 'cw']); assert.deepEqual(c2.map(b => b.mat), ['wha180', 'steel', 'wha176']); assert.equal(c2[0].rho, 18000);
  const c3 = cur(); restoreSession({ bodies: saved.map(({ role, mat, ...b }) => b) }, c3); assert.deepEqual(c3.map(b => b.role), ['', '', '']);
  const c4 = cur(), out = restoreSession({ bodies: saved.map(b => ({ ...b, role: 'hub' })) }, c4); assert.deepEqual(c4.map(b => b.role), ['hub', '', '']); assert.equal(out.roleNotes.length, 2);
});
