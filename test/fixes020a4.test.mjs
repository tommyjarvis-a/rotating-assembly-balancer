// 0.2.0-alpha.4 regression tests for the aa48991 (alpha.3) gate: M10 uncertainty-aware verdict, M11 containment as a
// hard part of the generator (shared Check function, measured protrusion), L12 atomic / validated session CG,
// L13 restored-piece summary not trusted, L14 hub contact tolerance, L15 worker-side view buffers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate } from '../src/generator.js';
import { autoBand } from '../src/band.js';
import { correctionTarget, pinTyped, orbitU, checkBalance, momentUnc, verdictU, staticOf } from '../src/statics.js';
import { meshMoments, KGM3, scale } from '../src/mass.js';
import { buildIndex, checkBody, containTol } from '../src/contain.js';
import { frame } from '../src/imbalance.js';
import { restoreSession } from '../src/bodies.js';
import { cleanGenMeta } from '../src/session-schema.js';
import { viewBuffers, verifyPiece } from '../src/gen-verify.js';

// extruded star prism: re-entrant (concave) boundary corners all round
function starMesh(n, r0, r1, h, rot = 0) {
  const pos = [], idx = [], m = 2 * n, R = i => (i % 2 ? r0 : r1);
  for (const z of [-h / 2, h / 2]) for (let i = 0; i < m; i++) { const a = rot + Math.PI * i / n; pos.push(R(i) * Math.cos(a), R(i) * Math.sin(a), z); }
  const cb = pos.length / 3; pos.push(0, 0, -h / 2); const ct = cb + 1; pos.push(0, 0, h / 2);
  for (let i = 0; i < m; i++) { const j = (i + 1) % m; idx.push(i, j, j + m, i, j + m, i + m, cb, j, i, ct, m + i, m + j); }
  return { pos, idx };
}
function cylMesh(c, r, h, n = 64, k = 4) {
  const pos = [], idx = [];
  for (let j = 0; j <= k; j++) for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; pos.push(c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2] - h / 2 + h * j / k); }
  for (let j = 0; j < k; j++) for (let i = 0; i < n; i++) { const a = j * n + i, b = j * n + (i + 1) % n; idx.push(a, b, b + n, a, b + n, a + n); }
  const cb = pos.length / 3; pos.push(c[0], c[1], c[2] - h / 2); const ct = cb + 1; pos.push(c[0], c[1], c[2] + h / 2);
  for (let i = 0; i < n; i++) idx.push(cb, (i + 1) % n, i, ct, k * n + i, k * n + (i + 1) % n);
  return { pos, idx };
}
const Z = { p: [0, 0, 0], d: [0, 0, 1] }, STEEL = 7850;
// g021-like cases on a synthetic rotor: 'pin' (e 10 ∠45, 10 g orbiting load, auto band next to the pin) and
// 'defaults' (no pin: auto band = the hub's full extent); star-shaped Boundary with concave corners
function scene(withPin) {
  const hub = cylMesh([0, 2, 0], 30, 20), boundary = starMesh(9, 36, 46, 40, 0.11), fr = frame(Z.p, Z.d);
  const hubMom = scale(meshMoments(hub.pos, hub.idx), STEEL * KGM3), pin = withPin ? pinTyped(10, 45) : null, loadU = pin ? orbitU(10, pin) : [0, 0];
  const band = autoBand(hub.pos, Z, fr, pin ? pin.ang : null), T = correctionTarget({ parts: [hubMom], points: [loadU], axis: Z, planes: [{}], constraints: { axialBand: band.w } });
  return { hub, boundary, hubMom, pin, loadU, band, T };
}
const DEFL = 0.01, CTOL = containTol(92, [DEFL]); // boundary deflection → generator margin, Check tolerance (2 × deflection)
const run = (S, o = {}) => generate({ boundary: S.boundary, hub: S.hub, axis: Z, band: S.band.w, target: S.T.planes[0].U, rho: STEEL, cell: 1.5, tol: 0.5, margin: DEFL, checkTol: CTOL, contactTol: Math.max(1e-3 * 1.5, Math.min(0.02, 0.05 * 1.5)), ...o });
const cache = {}; const piece = k => cache[k] ??= run(scene(k === 'pin'));

test('M10: residual uncertainty — PASS only if |R| + U ≤ tol, FAIL if |R| − U > tol, else can\'t resolve; check mode uses it', () => {
  assert.equal(verdictU(1, 0.5, 2), 'pass'); assert.equal(verdictU(10, 1, 5), 'fail'); assert.equal(verdictU(0.038, 4.8, 0.0795), 'unresolved'); assert.equal(verdictU(1, 0, null), null);
  assert.equal(verdictU(2, 0, 2), 'pass', 'boundary inclusive');
  // hub of 239 g with CG ± 0.020 mm → 4.78 g·mm (the gate's test.stp numbers), plus |U|·dV
  assert.ok(Math.abs(momentUnc(239, 39.7555, { dV: 0, dc: 0.02 }) - 4.78) < 1e-9); assert.ok(Math.abs(momentUnc(-10, 100, { dV: 1e-3, dc: 0 }) - 0.1) < 1e-12); assert.equal(momentUnc(5, 5, null), 0);
  const base = [39.7555, 0], tol = { kind: 'gmm', value: 0.0795 };
  let c = checkBalance({ base, cw: [-39.7176, 0], M: 240, tol, unc: 4.78 }); assert.equal(c.verdict, 'unresolved'); assert.equal(c.pass, false); assert.equal(c.unc, 4.78);
  c = checkBalance({ base, cw: [-39.7176, 0], M: 240, tol, unc: 0 }); assert.equal(c.verdict, 'pass');
  c = checkBalance({ base, cw: [-20, 0], M: 240, tol, unc: 4.78 }); assert.equal(c.verdict, 'fail');
});

for (const k of ['pin', 'defaults']) test(`M11: ${k} case — the generated piece is inside the Boundary by the shared Check function (edge crossings included), measured protrusion 0, still PASS-able`, () => {
  const S = scene(k === 'pin'), r = piece(k);
  assert.equal(r.contained, true); assert.equal(r.outsideBoundary, 0); assert.equal(r.crossBoundary, 0); assert.equal(r.maxOut, 0, 'measured, every vertex + edge samples');
  // independent: the same function Check containment runs (check-worker.js), world coordinates, Check tolerance
  const B = buildIndex(Float64Array.from(S.boundary.pos), S.boundary.idx), v = checkBody(B, buildIndex(Float64Array.from(S.hub.pos), S.hub.idx), r.pos, r.idx, CTOL);
  assert.equal(v.inside, true); assert.equal(v.nOut, 0); assert.equal(v.crossings, 0); assert.equal(v.hubOverlap.nIn, 0);
  // even at a strict tolerance nothing is outside: vertices sit the margin inside
  const strict = checkBody(B, null, r.pos, r.idx, 1e-9); assert.equal(strict.nOut, 0); assert.ok(strict.maxOut <= 1e-9, String(strict.maxOut));
  assert.equal(r.components, 1); assert.equal(r.open, 0); assert.ok(r.inset > 0);
  const left = Math.hypot(S.T.total.U[0] + staticOf(scale(meshMoments(r.pos, r.idx), STEEL * KGM3), Z).U[0], S.T.total.U[1] + staticOf(scale(meshMoments(r.pos, r.idx), STEEL * KGM3), Z).U[1]);
  assert.ok(left <= 0.5, `leftover ${left}`);
});

test('M11: without enforcement the same case leaves the Boundary — reported as not contained with a measured protrusion (blocks PASS)', () => {
  const r = run(scene(true), { containPasses: 0, forbidRounds: 0 });
  assert.equal(r.contained, false); assert.ok(r.crossBoundary + r.outsideBoundary > 0); assert.ok(r.maxOut > 0.05, String(r.maxOut)); assert.ok(r.outPts.length > 0, 'points to mark red');
  const S = scene(true), v = checkBody(buildIndex(Float64Array.from(S.boundary.pos), S.boundary.idx), null, r.pos, r.idx, CTOL);
  assert.equal(v.inside, r.contained); assert.equal(v.crossings, r.crossBoundary); assert.equal(v.maxOut, r.maxOut, 'generator readout == Check containment');
});

test('L14: hub contact judged within a small tolerance (not 0.5 mm); the measured closest distance is reported', () => {
  const r = piece('defaults'); assert.ok(r.contactTol <= 0.075 + 1e-12, String(r.contactTol)); assert.ok(r.hubVertices > 0); assert.ok(r.hubGap <= r.contactTol, String(r.hubGap));
});

test('L13: restored pieces are re-verified (verifyPiece) — a moved or scaled mesh is caught; stored summary values are checked', () => {
  const S = scene(false), r = piece('defaults'), args = (pos) => ({ boundary: { pos: Float64Array.from(S.boundary.pos), idx: Uint32Array.from(S.boundary.idx) }, hub: { pos: Float64Array.from(S.hub.pos), idx: Uint32Array.from(S.hub.idx) }, pos, idx: r.idx, tol: CTOL, contactTol: r.contactTol });
  let v = verifyPiece(args(r.pos)); assert.equal(v.contained, true); assert.ok(v.hubVertices > 0);
  const moved = r.pos.map((x, i) => i % 3 === 0 ? x + 100 : x); v = verifyPiece(args(moved)); assert.equal(v.contained, false); assert.ok(v.nOut > 0); assert.equal(v.hubVertices, 0);
  const scaled = r.pos.map(x => x * 1.5); v = verifyPiece(args(scaled)); assert.equal(v.contained, false);
  assert.deepEqual(cleanGenMeta({ tol: -5, cells: -1, contained: 'yes', checkTol: 0, maxOut: 0.1, outsideBoundary: 3 }), { o: { maxOut: 0.1, outsideBoundary: 3 }, bad: 4 });
  assert.equal(cleanGenMeta({ tol: 1e6, contained: true }).o.tol, 1e6, 'accepted as data, but never used for the verdict (app uses the current tolerance)');
});

test('L12: an invalid assembly CG is rejected as a whole with a note; restore never throws (incl. the malicious fixture)', () => {
  const bodies = () => [{ name: 'a', stepName: 'a', product: 'a', vol: { m: 1, M1: [0, 0, 0] }, rho: 7850, on: true, pos: [], idx: [] }];
  for (const cg of [{ c: ['x', 0, 0], mass: 1 }, { c: [0, 0, 0], mass: 'NaN' }, { c: [0, 0], mass: 1 }, { c: null }, 'cg', { c: [0, 0, 0], mass: 1, bodies: 'x' }]) {
    const out = restoreSession({ bodies: [], assemblyCG: cg }, bodies()); assert.equal(out.cg, null); assert.equal(out.cgRejected, true); assert.ok(out.roleNotes.includes('invalid assembly CG ignored'));
  }
  const fx = JSON.parse(readFileSync(new URL('./fixtures/malicious-session.json', import.meta.url))); assert.doesNotThrow(() => restoreSession(fx, bodies()));
});

test('L15: the worker builds the view buffers (Float32 positions, unit normals) so the main thread only attaches them', () => {
  const r = piece('defaults'), { pos32, nrm } = viewBuffers(r.pos, r.idx);
  assert.ok(pos32 instanceof Float32Array && pos32.length === r.pos.length && nrm.length === r.pos.length);
  for (let i = 0; i < nrm.length; i += 3) assert.ok(Math.abs(Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) - 1) < 1e-5);
});

test('perf (alpha.4): the 3-D grid queries (nearSurface, nearestPoint, segmentHit) equal a brute-force scan; ray parity unchanged', async () => {
  const { nearSurface, nearestPoint, segmentHit, classify } = await import('../src/contain.js');
  const S = starMesh(9, 36, 46, 40, 0.11), I = buildIndex(Float64Array.from(S.pos), S.idx), nt = S.idx.length / 3;
  const V = i => [S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2]];
  const cp = (p, a, b, c) => { // brute force: dense barycentric sampling is too coarse; use the projected-plane + edges formula
    const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const seg = (u, v) => { const d = sub(v, u), t = Math.max(0, Math.min(1, dot(sub(p, u), d) / dot(d, d))); return Math.hypot(...sub(p, [u[0] + d[0] * t, u[1] + d[1] * t, u[2] + d[2] * t])); };
    const e1 = sub(b, a), e2 = sub(c, a), n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], nl = Math.hypot(...n);
    const dpl = dot(sub(p, a), n) / nl, q = [p[0] - dpl * n[0] / nl, p[1] - dpl * n[1] / nl, p[2] - dpl * n[2] / nl];
    const inside = [[a, b], [b, c], [c, a]].every(([u, v]) => { const x = sub(v, u), y = sub(q, u); return dot([x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], n) >= 0; });
    return inside ? Math.abs(dpl) : Math.min(seg(a, b), seg(b, c), seg(c, a));
  };
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 300; k++) {
    const x = [(rnd() - 0.5) * 110, (rnd() - 0.5) * 110, (rnd() - 0.5) * 50], r = 0.5 + rnd() * 6;
    let best = 1 / 0; for (let t = 0; t < nt; t++) best = Math.min(best, cp(x, V(S.idx[3 * t]), V(S.idx[3 * t + 1]), V(S.idx[3 * t + 2])));
    const ns = nearSurface(I, x, r), np = nearestPoint(I, x, r);
    if (best <= r) { assert.ok(Math.abs(ns - best) < 1e-9, `${ns} vs ${best}`); assert.ok(np && Math.abs(np.d - best) < 1e-9); } else { assert.equal(ns, 1 / 0); assert.equal(np, null); }
    const y = [x[0] + (rnd() - 0.5) * 30, x[1] + (rnd() - 0.5) * 30, x[2]], hit = segmentHit(I, x, y), cx = classify(I, x), cy = classify(I, y);
    if (cx !== cy && cx !== 'on' && cy !== 'on') assert.ok(hit != null && hit >= 0 && hit <= 1, 'a segment between inside and outside hits the surface');
  }
  // inside the star's core, outside beyond the tips, outside in a notch
  assert.equal(classify(I, [0, 0, 0]), 'in'); assert.equal(classify(I, [60, 0, 0]), 'out');
  const notch = 0.11 + Math.PI / 9; assert.equal(classify(I, [40 * Math.cos(notch), 40 * Math.sin(notch), 0]), 'out');
});
