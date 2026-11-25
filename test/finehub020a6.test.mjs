// 0.2.0-alpha.6: fine hub mesh (src/hub-mesh.js) as the default, axis-aware tessellation ± and the separate CAD floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { importStep } from '../src/import-core.js';
import { remeshBody, HUB_FINE, hubParams } from '../src/hub-mesh.js';
import { momentUnc, momentUncParts } from '../src/statics.js';
import { bodyBBox, bodyRef, matchBodies, cadFloor, CAD_FLOOR } from '../src/bodies.js';
import { exportBalance, restoreBalance, BALANCE_DEFAULT } from '../src/balance-session.js';
import { derive } from '../src/mass.js';
import { latin1, unlatin1 } from '../src/step-meta.js';
const occtP = createRequire(import.meta.url)('../vendor/occt-import-js/occt-import-js.js')();
const FX = n => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)));
const V0 = Math.PI * 30 * 30 * 20; // scroll-hub.stp body 0: cylinder r 30, h 20, axis offset x 1.5

let imp = null;
const scroll = async () => imp ??= importStep(await occtP, FX('scroll-hub.stp'), { mode: 'accurate' });

test('fine re-mesh of the hub body: closer to the exact solid than the import, ± from two passes, vectors kept', async () => {
  const r = await scroll(), h = r.bodies[0], occt = await occtP;
  const f = remeshBody(occt, FX('scroll-hub.stp'), 0, { expect: { bbox: bodyBBox(h), count: r.bodies.length, mesh: h.mesh } });
  assert.ok(f.mesh.deflection <= h.mesh.deflection && f.mesh.angular <= h.mesh.angular, 'never coarser than the import mesh');
  assert.equal(f.mesh.fine, true); assert.equal(f.mesh.passes, 2); assert.ok(f.mesh.tris <= HUB_FINE.maxFine);
  const d = derive(f.vol), di = derive(h.vol);
  assert.ok(Math.abs(d.m / V0 - 1) < 2e-7, 'fine V ' + d.m);
  assert.ok(Math.abs(d.m - V0) <= Math.abs(di.m - V0) + 1e-9, 'fine is not worse than import');
  assert.ok(Math.abs(d.c[0] - 1.5) < 1e-5 && Math.abs(d.c[1]) < 1e-5, 'CG ' + d.c);
  assert.ok(f.unc.dV <= (h.unc.mesh || h.unc).dV + 1e-12, 'fine ± not larger than import ±');
  assert.ok(Array.isArray(f.unc.dcv) && f.unc.dcv.length === 2 && f.unc.dcv.every(v => v.length === 3));
  assert.ok(!f.unc.cad, 'this fixture declares 1e-7 mm: no CAD floor');
  assert.ok(f.passes[1].tris > 1.5 * f.passes[0].tris, 'pass 2 is the refined pass');
});

test('fine re-mesh respects its triangle budget (coarsens) and rejects a mismatched solid', async () => {
  const r = await scroll(), h = r.bodies[0], occt = await occtP, L = { ...HUB_FINE, maxFine: 3000 };
  const f = remeshBody(occt, FX('scroll-hub.stp'), 0, { expect: { bbox: bodyBBox(h), count: r.bodies.length }, L });
  assert.ok(f.mesh.scale > 1 && f.mesh.tris <= 3000 * 1.3, `scale ${f.mesh.scale} tris ${f.mesh.tris}`);
  const bb = bodyBBox(h).map((v, k) => v + (k === 0 || k === 3 ? 10 : 0));
  assert.throws(() => remeshBody(occt, FX('scroll-hub.stp'), 0, { expect: { bbox: bb, count: r.bodies.length } }), /bounding box/);
  assert.throws(() => remeshBody(occt, FX('scroll-hub.stp'), 0, { expect: { bbox: bodyBBox(h), count: r.bodies.length + 1 } }), /map onto the bodies/);
  assert.throws(() => remeshBody(occt, FX('scroll-hub.stp'), 1, { cancelled: () => true }), /cancelled/);
  const p = hubParams(100); assert.equal(p.fine.linearDeflection, p.base.linearDeflection / 4); assert.equal(p.fine.angularDeflection, p.base.angularDeflection / 2);
});

test('single-solid file: the whole file is the hub (no subset); CAD floor applied from the file tolerance', async () => {
  const occt = await occtP, text = latin1(FX('cylinder.stp')), r = importStep(occt, FX('cylinder.stp'), {});
  const f = remeshBody(occt, FX('cylinder.stp'), 0, { expect: { bbox: bodyBBox(r.bodies[0]), count: 1 } });
  assert.ok(Math.abs(derive(f.vol).m / (Math.PI * 15 * 15 * 30) - 1) < 2e-7);
  const t2 = text.replace('LENGTH_MEASURE(1.E-07)', 'LENGTH_MEASURE(0.1)');
  const g = remeshBody(occt, unlatin1(t2), 0, { expect: { bbox: bodyBBox(r.bodies[0]), count: 1 } });
  assert.equal(g.unc.cad, 0.1); assert.ok(Math.abs(g.unc.cadDc - CAD_FLOOR.cg * 0.1) < 1e-15); assert.ok(g.unc.mesh.dc < g.unc.cadDc);
  assert.equal(g.unc.dc, g.unc.cadDc);
});

test('momentUnc: only the perpendicular part of the tessellation CG change counts; the CAD floor stays isotropic', () => {
  const axial = { dV: 0, dc: 1e-3, dcv: [[0, 0, 1e-3]] };
  assert.equal(momentUnc(100, 50, axial, [0, 0, 1]), 0, 'axial CG change does not move U');
  assert.ok(Math.abs(momentUnc(100, 50, axial) - 0.1) < 1e-12, 'without an axis: the 3-D distance (as before)');
  assert.ok(Math.abs(momentUnc(100, 50, axial, [1, 0, 0]) - 0.1) < 1e-12, 'perpendicular to an x axis');
  const old = { dV: 1e-4, dc: 2e-3 }; assert.ok(Math.abs(momentUnc(10, 20, old, [0, 0, 1]) - (10 * 2e-3 + 20 * 1e-4)) < 1e-12, 'no vectors: unchanged');
  const fl = cadFloor({ dV: 1e-5, dc: 1e-3, dcv: [[0, 0, 1e-3]] }, 0.1), p = momentUncParts(239, 39.5, fl, [0, 0, 2]);
  assert.ok(p.floorSets && p.mesh < 1e-3 && Math.abs(p.total - (239 * 0.02 + 39.5 * 1e-3)) < 1e-9, JSON.stringify(p));
  assert.equal(p.floor, p.total);
  const big = cadFloor({ dV: 0.01, dc: 0.5, dcv: [[0.5, 0, 0]] }, 0.1), q = momentUncParts(10, 5, big, [0, 0, 1]);
  assert.ok(!q.floorSets && Math.abs(q.total - (10 * 0.5 + 5 * 0.01)) < 1e-12, 'mesh ± above the floor sets U');
  assert.equal(cadFloor({ dV: 1, dc: 1 }, 1e-7).cad, undefined, 'tiny file tolerance: no floor');
});

test('session: hub mesh setting Fine by default, round-trips and is schema-checked', () => {
  assert.equal(BALANCE_DEFAULT().hubMesh, 'fine');
  const bal = { ...BALANCE_DEFAULT(), hubMesh: 'fast' }, j = JSON.parse(JSON.stringify(exportBalance(bal, [])));
  assert.equal(j.hubMesh, 'fast'); assert.equal(restoreBalance(j, []).bal.hubMesh, 'fast');
  const bad = restoreBalance({ ...j, hubMesh: '<img onerror=x>' }, []); assert.equal(bad.bal.hubMesh, 'fine'); assert.ok(bad.notes.some(n => /hub mesh/.test(n)));
  const old = { ...j }; delete old.hubMesh; const o = restoreBalance(old, []); assert.equal(o.bal.hubMesh, 'fine'); assert.equal(o.notes.length, 0);
  assert.equal(exportBalance({ ...bal, hubMesh: 'weird' }, []).hubMesh, 'fine');
});

test('fingerprint uses the import volume: a fine re-mesh does not break session body matching', async () => {
  const r = await scroll(), saved = r.bodies.map((b, i) => JSON.parse(JSON.stringify(bodyRef(b, i))));
  const cur = r.bodies.map(b => ({ ...b, importVol: b.vol, vol: { ...b.vol, m: b.vol.m * 1.01 } })); // vol changed 1 % (> the 1e-3 tolerance)
  const m = matchBodies(saved, cur); assert.deepEqual(m.map, r.bodies.map((_, i) => i));
  assert.equal(bodyRef(cur[0], 0).vol, r.bodies[0].vol.m);
});
