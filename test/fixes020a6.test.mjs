// 0.2.0-alpha.6 fixes from Gate 656ef85: L17 stop criterion |R| + U ≤ tol, L18 containment in narrow concave slots
// (Tester's concave-slot cases), L19 welded closed solids in the faceted STEP (reference-shell fallback), STEP REAL
// formatting, L20 STEP string / header escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generate } from '../src/generator.js';
import { ccInput, ccBodies } from './cc-cases.mjs';
import { toFacetedStep, prepBody, weld, closedCheck, fixDegenerate, stepReal, stepStr } from '../src/mesh-export.js';
import { meshMoments } from '../src/mass.js';
import { importStep } from '../src/import-core.js';
import { unlatin1 } from '../src/step-meta.js';
const occtP = createRequire(import.meta.url)('../vendor/occt-import-js/occt-import-js.js')();
const Rm = r => Math.hypot(...r.residual);

for (const name of ['default', 'pin', 'pin-big', 'pin-fine', 'coarse']) {
  test(`L18: concave 4 mm slots, case ${name}: the piece is contained (Check-containment test), closed, one piece`, async () => {
    const r = generate(await ccInput(name));
    assert.equal(r.contained, true, JSON.stringify({ maxOut: r.maxOut, cross: r.crossBoundary, nOut: r.outsideBoundary, notes: r.notes }));
    assert.equal(r.crossBoundary, 0); assert.equal(r.outsideBoundary, 0); assert.equal(r.components, 1); assert.equal(r.open, 0); assert.equal(r.insideHub, 0);
    if (name === 'pin-fine') assert.ok(r.cell === 0.5);
  });
}

test('L17: stop at |R| + U ≤ tol when reachable; U ≥ tol → minimal |R| (goal "minimal")', async () => {
  const base = await ccInput('default'), tol = base.tol;
  const a = generate({ ...base, unc: 0 }); assert.equal(a.goal, 'pass'); assert.ok(Rm(a) <= tol);
  const b = generate({ ...base, unc: 0.8 * tol }); assert.equal(b.goal, 'pass'); assert.equal(b.tol, tol); assert.ok(Math.abs(b.stopTol - 0.2 * tol) < 1e-12);
  assert.ok(Rm(b) + 0.8 * tol <= tol * (1 + 1e-12), `R ${Rm(b)} + U ${0.8 * tol} vs ${tol}`);
  const c = generate({ ...base, unc: 2 * tol }); assert.equal(c.goal, 'minimal'); assert.ok(Rm(c) <= Rm(b) + 1e-9, 'minimal goal is at least as good');
  assert.equal(c.contained, true);
});

const cubeSoup = (s = 10) => { // 6 faces, each with its own 4 vertices (as occt-import-js returns B-rep faces)
  const pos = [], idx = []; const F = [[[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]];
  for (const f of F) { const o = pos.length / 3; for (const p of f) pos.push(...p.map(x => x * s)); idx.push(o, o + 1, o + 2, o, o + 2, o + 3); }
  return { name: 'cube', pos: Float64Array.from(pos), idx: Uint32Array.from(idx), rho: 7850 };
};
test('L19: welding a per-face soup gives one closed oriented 2-manifold; open meshes fall back to a reference shell', () => {
  const c = cubeSoup(), p = prepBody(c);
  assert.equal(p.solid, true); assert.equal(p.pos.length / 3, 8); assert.ok(Math.abs(p.check.volume - 1000) < 1e-9);
  assert.equal(closedCheck(c.pos, c.idx).closed, false, 'unwelded soup is open');
  const flipped = { ...c, idx: Uint32Array.from(c.idx).map((v, i, a) => i % 3 === 1 ? a[i + 1] : i % 3 === 2 ? a[i - 1] : v) };
  assert.ok(prepBody(flipped).check.volume > 0, 'inside-out mesh oriented outward');
  const open = { ...c, idx: c.idx.slice(0, -6) }, r = toFacetedStep([open, { ...cubeSoup(5), name: 'Generated_CW' }], { name: 'hub_and_counterweight', requireSolid: b => b.name === 'Generated_CW' });
  assert.deepEqual(r.report.map(x => [x.name, x.solid]), [['cube_REFERENCE', false], ['Generated_CW', true]]); assert.match(r.report[0].reason, /open edges/);
  assert.match(r.text, /SHELL_BASED_SURFACE_MODEL\('cube_REFERENCE',\(#\d+\)\)/); assert.match(r.text, /OPEN_SHELL/); assert.equal((r.text.match(/CLOSED_SHELL/g) || []).length, 1);
  assert.throws(() => toFacetedStep([{ ...open, name: 'Generated_CW' }], { requireSolid: b => b.name === 'Generated_CW' }), /not a closed solid/);
  // collinear facet (a vertex on an edge) is removed topologically, so the shell stays closed
  const pos = Float64Array.from([0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 1, 0, 0]), idx = Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  const split = Uint32Array.from([0, 2, 1, 0, 4, 3, 4, 1, 3, 1, 2, 3, 2, 0, 3, 0, 1, 4]); // degenerate (0,1,4) + T-split side
  const fd = fixDegenerate(pos, split); assert.equal(fd.fixed, 1); assert.equal(closedCheck(pos, fd.idx).closed, true);
});

test('L19: hub + piece STEP of the concave fixture: both closed FACETED_BREPs; re-import gives the same volumes', async () => {
  const [H] = await ccBodies(), inp = await ccInput('default'), g = generate(inp);
  const r = toFacetedStep([{ name: 'hub', pos: Float64Array.from(H.pos), idx: Uint32Array.from(H.idx), rho: 7850 }, { name: 'Generated_CW', pos: g.pos, idx: g.idx, rho: 7850 }], { name: 'hub_and_counterweight', requireSolid: b => b.name === 'Generated_CW' });
  assert.deepEqual(r.report.map(x => x.solid), [true, true]); assert.ok(r.report[0].weld.merged > 0, 'hub vertices welded across B-rep faces');
  assert.equal((r.text.match(/CLOSED_SHELL/g) || []).length, 2);
  const back = importStep(await occtP, unlatin1(r.text), { mode: 'accurate' }).bodies;
  assert.ok(Math.abs(back[0].vol.m / meshMoments(H.pos, H.idx).m - 1) < 1e-9); assert.ok(Math.abs(back[1].vol.m / meshMoments(g.pos, g.idx).m - 1) < 1e-9);
});

test('STEP REAL: exponents keep their zeros (−6.5e-11 was written −6.5E-1); values round-trip', () => {
  assert.equal(stepReal(-6.51031671608569e-11), '-6.51031671608569E-11'); assert.equal(stepReal(1e-10), '1.E-10'); assert.equal(stepReal(2.5e20), '2.5E+20');
  assert.equal(stepReal(10), '10.'); assert.equal(stepReal(-0.5), '-0.5'); assert.equal(stepReal(1e-13), '0.');
  for (let i = 0; i < 2000; i++) { const v = (Math.random() - 0.5) * 10 ** (Math.random() * 24 - 11); const s = stepReal(v); if (s !== '0.') assert.ok(Math.abs(parseFloat(s) / v - 1) < 1e-14, `${v} → ${s}`); }
});

test('L20: STEP strings and header fields escaped (quotes, backslashes, non-ASCII, length)', async () => {
  assert.equal(stepStr("a'b\\c"), "'a''b\\\\c'"); assert.equal(stepStr('aéb'), "'a\\X2\\00E9\\X0\\b'"); assert.equal(stepStr('x'.repeat(500)).length, 202);
  assert.equal(stepStr('a\\X2\\00E9\\X0\\b'), "'a\\\\X2\\\\00E9\\\\X0\\\\b'", 'a literal escape sequence is not decoded by readers');
  const r = toFacetedStep([cubeSoup()], { name: "x');#1=FOO('" });
  assert.ok(!r.text.includes("x');#1=FOO('"), 'header injection escaped'); assert.ok(r.text.includes("FILE_NAME('x'');#1=FOO(''.stp'"), 'FILE_NAME escaped');
  const back = importStep(await occtP, unlatin1(r.text), {}); assert.equal(back.bodies.length, 1);
});
