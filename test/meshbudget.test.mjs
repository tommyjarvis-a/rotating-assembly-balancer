// 0.2.0 mesh-accuracy fix (work order rab-step-diag): per-body mesh budgets, honest uncertainty, STEP solid names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { LIMITS, planPerBody, predict, predict2, alphaOf, groupParams, GROUPS, passParams } from '../src/mesh-plan.js';
import { solidTable, subsetStep, unlatin1, fileUncertainty } from '../src/step-meta.js';
import { importStep } from '../src/import-core.js';
import { buildEntries } from '../src/bodies.js';
import { derive } from '../src/mass.js';
import { toolMoments } from '../src/tools.js';
import { FIX } from './fixtures.mjs';
const occtP = createRequire(import.meta.url)('../vendor/occt-import-js/occt-import-js.js')();
const txt = n => readFileSync(new URL(`./fixtures/${n}.stp`, import.meta.url), 'latin1');
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

test('per-body plan: only the body over the per-body budget is coarsened; small bodies keep a deflection from their own size', () => {
  // synthetic: one heavy filleted body among small ones
  const probe = [500, 4000, 40000, 1700, 1800], probe2 = [1000, 18000, 115000, 6500, 5600], diags = [15, 120, 140, 60, 40], D = 180;
  const pl = planPerBody(probe, diags, D, 'accurate', LIMITS, GROUPS, probe2);
  assert.ok(pl.coarsened[2], 'big body coarsened'); assert.ok(!pl.coarsened[0], 'the small body is not coarsened');
  assert.equal(Math.max(...pl.scale), pl.scale[2], 'the heavy body is coarsened most');
  assert.ok(pl.groups.length <= GROUPS); assert.deepEqual(pl.groups.flatMap(g => g.bodies).sort(), [0, 1, 2, 3, 4]);
  const of = i => pl.groups.find(g => g.bodies.includes(i));
  assert.ok(of(0).base.linearDeflection < passParams(D, 'accurate').linearDeflection, 'small body finer than the 0.1.x whole-file setting');
  assert.ok(of(0).base.linearDeflection <= of(2).base.linearDeflection);
  // predicted final-pass triangles fit both budgets
  const t = probe.map((p, i) => predict2(p, probe2[i], D, of(i).base) * LIMITS.refine);
  assert.ok(Math.max(...t) <= LIMITS.perBody * 1.0001 && t.reduce((a, b) => a + b) <= LIMITS.total * 1.0001, String(t.map(Math.round)));
  assert.ok(pl.note.some(n => /of 5 bodies coarsened/.test(n)), pl.note.join());
  // one-probe fallback model is the conservative 0.1.x predictor
  const p1 = planPerBody([100, 200], [10, 20], 30, 'fast'); assert.deepEqual(p1.coarsened, [false, false]); assert.equal(p1.note.length, 0);
  assert.ok(alphaOf(1000, 4000) === 1 && alphaOf(1000, 1000) === 0.6);
  const g = groupParams(0.1, 0.02, 2); assert.equal(g.linearDeflection, 0.1 / LIMITS.refine); assert.equal(g.linearDeflectionType, 'absolute_value');
  assert.ok(predict2(1000, 4000, 100, g) <= predict([1000], 100, g)[0] * 1.0001);
});

test('STEP solid table, subsets and names: one representation with several unnamed / duplicate-named solids', () => {
  const t = txt('cg-assembly'), tb = solidTable(t);
  assert.deepEqual(tb.solids.map(s => s.name), ['block', 'boss', 'REMOVE_slot']); assert.equal(tb.assembly, false);
  const sub = subsetStep(t, tb, [tb.solids[1].id]); assert.equal(solidTable(sub).solids.length, 1); assert.equal(solidTable(sub).solids[0].name, 'boss');
  // fabricate a typical NX export: all three solids in ONE representation, unnamed, unnamed, PARTBODY
  const one = t.replace(/MANIFOLD_SOLID_BREP\('block'/, "MANIFOLD_SOLID_BREP(''").replace(/MANIFOLD_SOLID_BREP\('boss'/, "MANIFOLD_SOLID_BREP(''").replace(/MANIFOLD_SOLID_BREP\('REMOVE_slot'/, "MANIFOLD_SOLID_BREP('PARTBODY'");
  const t1 = solidTable(one); assert.deepEqual(t1.solids.map(s => s.name), ['', '', 'PARTBODY']);
  assert.equal(fileUncertainty(t), 1e-7); assert.equal(fileUncertainty('no context'), null);
  // display names: STEP solid name, else "Body n" when the solids share a product
  const mesh = name => ({ name, attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } }, index: { array: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] } });
  const bs = buildEntries([0, 1, 2, 3].map(i => ({ mesh: mesh('part_objects'), product: 'part_objects', solidName: ['', '', 'PARTBODY', 'PARTBODY'][i] })), [], 7850, 'test.stp', { solidNames: ['', '', 'PARTBODY', 'PARTBODY'] });
  assert.deepEqual(bs.map(b => b.name), ['Body 1', 'Body 2', 'PARTBODY #1', 'PARTBODY #2']);
  const single = buildEntries([{ mesh: mesh('shaft') }], [], 7850, 'x.stp'); assert.equal(single[0].name, 'shaft');
});

test('honest uncertainty: two passes report max(|fine − Richardson|, |fine − coarse|), coarsened bodies are flagged low', () => {
  const cube = k => ({ name: 'c', attributes: { position: { array: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1].map(v => 10 * k * v) } },
    index: { array: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] } });
  const [b] = buildEntries([{ mesh: cube(1.001), coarse: cube(1), low: true }], [], 7850);
  const vf = 1000 * 1.001 ** 3, vc = 1000, R = (4 * vf - vc) / 3;
  assert.ok(Math.abs(b.unc.dV - Math.abs(vf - vc) / vc) < 1e-12, `${b.unc.dV}`); // pass-to-pass (≈3× the Richardson delta)
  assert.ok(b.unc.dV > Math.abs(vf - R) / R * 2.9); assert.equal(b.unc.low, true);
});

test('importStep per-body path on multi-body fixtures: names from the STEP solids, accuracy unchanged, within budget', async () => {
  const occt = await occtP;
  for (const [k, tol] of [['rotor-unbalanced', 1e-6], ['cg-assembly', 1e-7], ['scroll-hub', 1e-6]]) {
    const r = importStep(occt, unlatin1(txt(k)), { mode: 'accurate', name: k + '.stp' });
    assert.equal(r.stats.plan, 'per-body', k); assert.equal(r.stats.mode, 'accurate', k); assert.deepEqual(r.warn, [], k);
    FIX[k].forEach(t => { const b = r.bodies.find(x => x.name === (t.sign < 0 ? 'REMOVE_' : '') + t.name), a = derive(toolMoments({ ...t, rho: 1e6, sign: 1 })); assert.ok(b, t.name); assert.ok(rel(b.vol.m, a.m) < tol, `${k}/${t.name} ${b.vol.m} vs ${a.m}`); assert.ok(b.mesh.tris > 0); });
    assert.ok(r.stats.ms < 15000, `${k} ${r.stats.ms} ms`);
    // per-body deflection: the small pin of scroll-hub gets a finer mesh than the big boundary
    if (k === 'scroll-hub') { const pin = r.bodies.find(b => b.name === 'pin'), bnd = r.bodies.find(b => b.name === 'boundary'); assert.ok(pin.mesh.deflection <= bnd.mesh.deflection); }
  }
  const whole = importStep(occt, unlatin1(txt('rotor-unbalanced')), { mode: 'accurate', perBody: false }); assert.equal(whole.stats.plan, 'file');
});

test('faceted STEP (FACETED_BREP, planar FACE_SURFACE + POLY_LOOP) re-imports with exact volume (slice 3 export path)', async () => {
  const r = importStep(await occtP, unlatin1(txt('faceted-cube')), { mode: 'accurate', name: 'faceted-cube.stp' });
  assert.equal(r.bodies.length, 1); assert.ok(Math.abs(r.bodies[0].vol.m - 1000) < 1e-9, String(r.bodies[0].vol.m)); assert.equal(r.bodies[0].name, 'cw');
});
