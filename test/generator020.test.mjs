import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, defaultCell, toFrame, fromFrame } from '../src/generator.js';
import { autoBand, faceBand, typedBand, normalizeBand, BAND_DEFAULT } from '../src/band.js';
import { packGenerated, unpackGenerated, genDefaultTol } from '../src/gen-session.js';
import { exportBalance, restoreBalance, BALANCE_DEFAULT } from '../src/balance-session.js';
import { correctionTarget, staticOf, pinTyped, orbitU, angleDeg, permissibleU } from '../src/statics.js';
import { meshMoments, KGM3, scale } from '../src/mass.js';
import { buildIndex, columnHeights, segmentHit } from '../src/contain.js';
import { frame } from '../src/imbalance.js';

// closed cylinder (axis through c along unit d), n facets, k rings
function cylMesh(c, d, r, h, n = 64, k = 4) {
  const hh = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let u = cr(hh, d); const un = Math.hypot(...u); u = u.map(v => v / un); const v = cr(d, u), pos = [], idx = [];
  const P = (a, z) => [0, 1, 2].map(i => c[i] + r * Math.cos(a) * u[i] + r * Math.sin(a) * v[i] + z * d[i]);
  for (let j = 0; j <= k; j++) for (let i = 0; i < n; i++) pos.push(...P(2 * Math.PI * i / n, -h / 2 + h * j / k));
  for (let j = 0; j < k; j++) for (let i = 0; i < n; i++) { const a = j * n + i, b = j * n + (i + 1) % n; idx.push(a, b, b + n, a, b + n, a + n); }
  const cb = pos.length / 3; pos.push(...[0, 1, 2].map(i => c[i] - h / 2 * d[i])); const ct = cb + 1; pos.push(...[0, 1, 2].map(i => c[i] + h / 2 * d[i]));
  for (let i = 0; i < n; i++) { idx.push(cb, (i + 1) % n, i); idx.push(ct, k * n + i, k * n + (i + 1) % n); }
  return { pos, idx };
}
const STEEL = 7850, Z = { p: [0, 0, 0], d: [0, 0, 1] };
// synthetic rotor: steel hub r 30 × 20 mm offset 2 mm along +Y (heavy at 90°), drive pin at e 6 mm, 90°, 20 g
// orbiting load; Boundary ring r 45 × 40 mm on the axis
function scene(axis = Z) {
  const fr = frame(axis.p, axis.d), W = (u, v, w) => [0, 1, 2].map(k => axis.p[k] + fr.R[k] * u + fr.R[3 + k] * v + fr.R[6 + k] * w);
  const wd = fr.R.slice(6, 9), hub = cylMesh(W(0, 2, 0), wd, 30, 20), boundary = cylMesh(W(0, 0, 0), wd, 45, 40, 96);
  const hubMom = scale(meshMoments(hub.pos, hub.idx), STEEL * KGM3), pin = pinTyped(6, 90), loadU = orbitU(20, pin);
  const band = autoBand(hub.pos, axis, fr, pin.ang);
  const T = correctionTarget({ parts: [hubMom], points: [loadU], axis, planes: [{}], constraints: { axialBand: band.w } });
  return { fr, hub, boundary, hubMom, pin, loadU, band, T };
}
// lightest annular sector (ri…ro, full band height H) that gives moment Tm: a simple near-optimal reference
function sectorMass(Tm, ri0, ro, H, rho) {
  let best = 1 / 0;
  for (let ri = ri0; ri < ro - 0.05; ri += 0.05) {
    const k = rho * KGM3 * H, Mmax = k * (2 / 3) * (ro ** 3 - ri ** 3); if (Mmax < Tm) continue;
    const phi = 2 * Math.asin(Tm / Mmax); best = Math.min(best, k * phi / 2 * (ro ** 2 - ri ** 2));
  }
  return best;
}

test('generator: synthetic hub + boundary ring — leftover under tolerance, one piece touching the hub, inside boundary and band, opposite the pin, near-minimal mass', () => {
  const S = scene(), T = S.T.planes[0], tol = 0.5;
  assert.ok(Math.abs(S.band.w[0] + 10) < 1e-9 && Math.abs(S.band.w[1] - 10) < 1e-9, 'auto band = hub extent next to the pin');
  const r = generate({ boundary: S.boundary, hub: S.hub, axis: Z, band: S.band.w, target: T.U, rho: STEEL, cell: 1, tol });
  // independent mass properties of the returned mesh
  const m = scale(meshMoments(r.pos, r.idx), STEEL * KGM3), st = staticOf(m, Z), left = [S.T.total.U[0] + st.U[0], S.T.total.U[1] + st.U[1]];
  assert.ok(Math.hypot(...left) <= tol, `leftover ${Math.hypot(...left)} g·mm ≤ ${tol}`);
  assert.ok(Math.abs(Math.hypot(...r.residual) - Math.hypot(...left)) < 1e-6, 'reported residual matches');
  assert.ok(Math.abs(r.mass - m.m) < 1e-9);
  assert.equal(r.components, 1, 'one connected piece'); assert.equal(r.open, 0, 'closed, manifold mesh');
  assert.ok(r.hubVertices > 0 && r.hubGap === 0, 'touches the hub');
  assert.ok(r.dipBoundary < 1e-9, 'convex boundary: no chord leaves it'); assert.ok(r.dipHub < 0.01, `hub facet-chord dip ${r.dipHub} mm`);
  assert.equal(r.outsideBoundary, 0); assert.equal(r.crossBoundary, 0, 'no edge crosses the boundary surface'); assert.equal(r.insideHub, 0); assert.equal(r.outsideBand, 0);
  for (let i = 0; i < r.pos.length; i += 3) { assert.ok(Math.hypot(r.pos[i], r.pos[i + 1]) <= 45 + 1e-6); assert.ok(r.pos[i + 2] >= -10 - 1e-9 && r.pos[i + 2] <= 10 + 1e-9); }
  const rel = ((st.ang - S.pin.ang) % 360 + 360) % 360; assert.ok(Math.abs(rel - 180) < 5, `piece at ${rel}° from the pin`);
  const ref = sectorMass(T.mag, 30, 45, 20, STEEL);
  assert.ok(r.mass <= 1.15 * ref, `mass ${r.mass} g vs sector reference ${ref} g`);
  assert.ok(r.mass >= 0.85 * ref, 'not implausibly light');
  assert.ok(r.iterations >= 1 && r.iterations <= 8);
});

test('generator: tilted spin axis (frame transform) and a typed band', () => {
  const axis = { p: [5, -3, 12], d: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)] }, S = scene(axis), tol = 0.5, band = [-4, 6];
  const r = generate({ boundary: S.boundary, hub: S.hub, axis, band, target: S.T.planes[0].U, rho: STEEL, cell: 1.2, tol });
  const st = staticOf(scale(meshMoments(r.pos, r.idx), STEEL * KGM3), axis), left = [S.T.total.U[0] + st.U[0], S.T.total.U[1] + st.U[1]];
  assert.ok(Math.hypot(...left) <= tol, `leftover ${Math.hypot(...left)}`);
  assert.equal(r.components, 1); assert.equal(r.open, 0); assert.ok(r.hubVertices > 0); assert.equal(r.outsideBoundary, 0); assert.equal(r.insideHub, 0);
  const F = toFrame(r.pos, frame(axis.p, axis.d)); for (let i = 2; i < F.length; i += 3) assert.ok(F[i] >= -4 - 1e-7 && F[i] <= 6 + 1e-7);
  const back = fromFrame(F, frame(axis.p, axis.d)); assert.ok(back.every((v, i) => Math.abs(v - r.pos[i]) < 1e-9));
});

test('generator: Cancel stops the run; impossible bands and empty targets are errors; a too-small region is reported', () => {
  const S = scene(), T = S.T.planes[0].U; let calls = 0;
  assert.throws(() => generate({ boundary: S.boundary, hub: S.hub, axis: Z, band: S.band.w, target: T, rho: STEEL, cell: 1, tol: 0.5, cancelled: () => ++calls > 3 }), e => e.cancelled === true);
  assert.throws(() => generate({ boundary: S.boundary, hub: S.hub, axis: Z, band: [14, 18], target: T, rho: STEEL, cell: 1, tol: 0.5 }), /touches the hub/);
  assert.throws(() => generate({ boundary: S.boundary, hub: S.hub, axis: Z, band: [30, 40], target: T, rho: STEEL, cell: 1, tol: 0.5 }), /does not overlap/);
  assert.throws(() => generate({ boundary: S.boundary, hub: S.hub, axis: Z, band: S.band.w, target: [0, 0], rho: STEEL, cell: 1, tol: 0.5 }), /zero/);
  const small = cylMesh([0, 0, 0], [0, 0, 1], 31.5, 40, 96);
  const r = generate({ boundary: small, hub: S.hub, axis: Z, band: S.band.w, target: T, rho: STEEL, cell: 0.5, tol: 0.5, maxIter: 1 });
  assert.ok(r.capped && r.notes.some(n => /cannot hold enough/.test(n)));
});

test('generator: cell-count guard and default cell size', () => {
  assert.equal(defaultCell(120), 1); assert.equal(defaultCell(12), 0.1); assert.equal(defaultCell(600), 5);
  const S = scene(), r = generate({ boundary: S.boundary, hub: S.hub, axis: Z, band: S.band.w, target: S.T.planes[0].U, rho: STEEL, cell: 0.1, tol: 2, maxNodes: 50000, maxIter: 2 });
  assert.ok(r.grid[0] * r.grid[1] * r.grid[2] <= 50000 && r.cell > 0.1 && r.notes.some(n => /cell-count guard/.test(n)));
});

test('contain helpers: column heights of a closed mesh, segment hit parameter', () => {
  const c = cylMesh([0, 0, 0], [0, 0, 1], 10, 8), I = buildIndex(c.pos, c.idx), hs = columnHeights(I, 2, 1.3, -2.1);
  assert.equal(hs.length, 2); assert.ok(Math.abs(hs[0] + 4) < 1e-9 && Math.abs(hs[1] - 4) < 1e-9);
  assert.equal(columnHeights(I, 2, 20, 0).length, 0);
  const t = segmentHit(I, [0, 0, 0], [0, 0, 8]); assert.ok(Math.abs(t - 0.5) < 1e-12);
  assert.equal(segmentHit(I, [0, 0, 0], [0, 0, 1]), null);
});

test('axial band: auto (pin / no pin), planar face + thickness, typed; session round-trip', () => {
  const fr = frame([0, 0, 0], [0, 0, 1]), stepped = { pos: [...cylMesh([0, 0, 0], [0, 0, 1], 30, 20).pos, 0, 28, 25, 0, 29, 26, 0, 27, 24] }; // a spike at +Y up to w 26
  assert.deepEqual(autoBand(stepped.pos, Z, fr, null).w, [-10, 26]);
  assert.deepEqual(autoBand(stepped.pos, Z, fr, 90).w, [-10, 26]);
  assert.deepEqual(autoBand(stepped.pos, Z, fr, 270).w, [-10, 10]);
  const f = faceBand({ p: [3, 4, 7], d: [0, 0, -1] }, Z, -5); assert.deepEqual(f.w, [2, 7]); assert.equal(f.warn, '');
  assert.ok(faceBand({ p: [0, 0, 7], d: [0, 0.05, 1] }, Z, 2).warn);
  assert.ok(faceBand({ p: [0, 0, 7], d: [1, 0, 0] }, Z, 2).error); assert.ok(faceBand(null, Z, 2).error); assert.ok(faceBand({ p: [0, 0, 0], d: [0, 0, 1] }, Z, 0).error);
  assert.deepEqual(typedBand(5, -1).w, [-1, 5]); assert.ok(typedBand(1, 1).error); assert.ok(typedBand(NaN, 1).error);
  // correctionTarget carries it
  assert.deepEqual(correctionTarget({ parts: [], points: [[1, 0]], axis: Z, constraints: { axialBand: [-1, 5] } }).constraints.axialBand, [-1, 5]);
  const bal = { ...BALANCE_DEFAULT(), band: { mode: 'face', face: { p: [1, 2, 3], d: [0, 0, 1] }, thick: 4, start: null, end: null }, gen: { cell: 0.8, tol: 1.5 } };
  const back = restoreBalance(JSON.parse(JSON.stringify(exportBalance(bal, []))), []).bal;
  assert.deepEqual(back.band, bal.band); assert.deepEqual(back.gen, bal.gen);
  assert.deepEqual(restoreBalance({}, []).bal.band, BAND_DEFAULT()); assert.deepEqual(normalizeBand({ mode: 'bogus', start: 'x' }), BAND_DEFAULT());
});

test('generated piece: session pack / unpack (and the size cap), default tolerance', () => {
  const c = cylMesh([0, 0, 0], [0, 0, 1], 3, 2, 12, 1), body = { name: 'Generated CW', rho: 7850, mat: 'steel', on: true, pos: Float64Array.from(c.pos), idx: Uint32Array.from(c.idx) };
  const j = JSON.parse(JSON.stringify(packGenerated(body, { key: 'k', cells: 3 }))), u = unpackGenerated(j);
  assert.deepEqual([...u.pos], [...body.pos]); assert.deepEqual([...u.idx], [...body.idx]); assert.equal(u.meta.key, 'k');
  const big = packGenerated(body, { key: 'k' }, 100); assert.ok(big.needsRegenerate && !big.mesh); assert.ok(unpackGenerated(big).needsRegenerate);
  assert.ok(unpackGenerated({ mesh: { pos: 'AAAA', idx: 'AAAA' } }).needsRegenerate);
  assert.equal(genDefaultTol({ kind: 'gmm', value: 3 }, null, 100, 500).tol, 3);
  assert.equal(genDefaultTol({ kind: 'G', value: 6.3 }, 3000, 400, 500).tol, permissibleU(6.3, 400, 3000));
  assert.equal(genDefaultTol({ kind: 'G', value: 6.3 }, null, 400, 500).tol, 1);
  assert.equal(genDefaultTol(null, null, 400, 5).tol, 0.05);
});

test('alpha.2 hardening: generator session fields are schema-checked (band, cell, tolerance, generated piece and its summary)', async () => {
  const { cleanBand, cleanGenSettings, cleanGenMeta } = await import('../src/session-schema.js');
  const X = '<img src=x onerror="window.__xss=1">';
  let r = cleanBand({ mode: X, start: X, end: '5', thick: 1e99, face: { p: [X, 0, 0], d: [0, 0, 1] } });
  assert.deepEqual(r.o, BAND_DEFAULT()); assert.equal(r.bad, 5);
  r = cleanBand({ mode: 'face', face: { p: [1, 2, 3], d: [0, 0, 1] }, thick: -4 }); assert.equal(r.bad, 0); assert.deepEqual(r.o.face, { p: [1, 2, 3], d: [0, 0, 1] });
  assert.deepEqual(cleanGenSettings({ cell: X, tol: -1 }), { o: { cell: null, tol: null }, bad: 2 });
  assert.deepEqual(cleanGenSettings({ cell: 0.8, tol: 1.5 }).o, { cell: 0.8, tol: 1.5 });
  r = cleanGenMeta({ cells: X, iterations: 3, notes: [X.repeat(20)], key: 'k', frame: { o: [0, 0, 0] }, residual: [0.1, 'x'] });
  assert.deepEqual(r.o, { iterations: 3, key: 'k' }); assert.equal(r.bad, 3);
  // generated piece
  const c = cylMesh([0, 0, 0], [0, 0, 1], 3, 2, 12, 1), body = { name: 'Generated CW', rho: 7850, mat: 'steel', on: true, pos: Float64Array.from(c.pos), idx: Uint32Array.from(c.idx) };
  const j = JSON.parse(JSON.stringify(packGenerated(body, { key: 'k', cells: 3 })));
  let u = unpackGenerated({ ...j, name: X, mat: X, on: X, meta: { cells: X } });
  assert.equal(u.name, 'Generated CW'); assert.equal(u.mat, null); assert.equal(u.on, true); assert.deepEqual(u.meta, {}); assert.equal(u.bad, 1);
  assert.ok(unpackGenerated({ ...j, rho: X }).needsRegenerate);
  assert.ok(unpackGenerated({ ...j, mesh: { pos: X, idx: j.mesh.idx } }).needsRegenerate);
  const nanPos = Buffer.from(new Float64Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
  assert.ok(unpackGenerated({ ...j, mesh: { pos: nanPos, idx: Buffer.from(new Uint32Array([0, 1, 2]).buffer).toString('base64') } }).needsRegenerate);
  assert.ok(unpackGenerated(j, 100).needsRegenerate, 'size cap');
  assert.ok(unpackGenerated('x').needsRegenerate);
  assert.equal(unpackGenerated({ ...j, name: 'Generated CW 3' }).name, 'Generated CW 3');
  // the malicious session fixture's generator fields
  const fx = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/malicious-session.json', import.meta.url)));
  const rb = restoreBalance(fx.balance, []); assert.ok(rb.notes.some(n => /invalid generator setting/.test(n))); assert.equal(rb.bal.band.start, null); assert.equal(rb.bal.gen.cell, null);
  const g = unpackGenerated(fx.generated); assert.equal(g.name, 'Generated CW'); assert.equal(g.meta.cells, undefined); assert.equal(g.mat, null); // notes stay free text, escaped where shown
});
