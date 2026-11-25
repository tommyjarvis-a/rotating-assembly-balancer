// 0.2.0-alpha.6: fine re-mesh of ONE body (the Hub) for its mass properties. The import plan coarsens big bodies to
// stay within the shared triangle budget (test file hub: ×128); the hub sets the imbalance, so it gets its own large
// budget here: two passes (d, d/4 with half the angle) on a STEP subset holding just that solid, Richardson
// extrapolation and the ± from the two passes (bodies.js meshUnc, CG change kept as vectors so only the part
// perpendicular to the axis enters U). The display / contact geometry stays the import mesh (a 1M-triangle hub
// would slow the view, containment and the generator); only vol (moments) and the ± are replaced.
// Runs in src/hub-worker.js (and Node tests); heavy, so the app shows progress and Cancel.
import { latin1, unlatin1, solidTable, subsetStep, fileUncertainty } from './step-meta.js';
import { meshMoments, richardson } from './mass.js';
import { meshUnc, cadFloor } from './bodies.js';
import { triCounts, bboxes } from './mesh-plan.js';
export const HUB_FINE = {
  ratio: 2.5e-4,     // base pass linear deflection / the body's bbox diagonal (test file hub ≈ 0.026 mm)
  minDefl: 1e-4,     // mm
  angular: 0.07,     // base pass angle (rad); the fine pass halves it
  refine: 4,         // fine pass: deflection / 4
  maxFine: 2.5e6,    // triangle budget of the fine pass for this one body (import: 600 k per body, 1.2 M total)
  grow: 2,           // coarsening step when the base pass predicts more than maxFine / (refine · 1.1)
  tries: 8,
};
export const HUB_MESH_MODES = ['fine', 'fast'];
// cap: the import's final pass { deflection, angular } — the fine mesh is never coarser than the import mesh (small
// bodies are imported with finer absolute settings than ratio · diag).
export const hubParams = (diag, s = 1, L = HUB_FINE, cap = null) => {
  let d = L.ratio * diag, a = L.angular;
  if (cap?.deflection > 0) d = Math.min(d, cap.deflection * L.refine); if (cap?.angular > 0) a = Math.min(a, cap.angular * 2);
  d = Math.max(L.minDefl, d * s); a = Math.min(0.5, a * Math.sqrt(s));
  return { base: { linearDeflectionType: 'absolute_value', linearDeflection: d, angularDeflection: a },
    fine: { linearDeflectionType: 'absolute_value', linearDeflection: d / L.refine, angularDeflection: a / 2 } };
};
// buf: the whole STEP file; index: the body's solid index (import order); expect: { bbox, count } from the import
// (count = bodies in the file) to check the subset is the same solid; expect.mesh: the import mesh (see hubParams).
export function remeshBody(occt, buf, index, { expect = null, progress = () => { }, L = HUB_FINE, cancelled = () => false } = {}) {
  const t0 = Date.now(), passes = [];
  const text = latin1(buf), table = solidTable(text);
  let data;
  if (table && !table.assembly && table.solids.length > index && (!expect?.count || table.solids.length === expect.count)) data = table.solids.length === 1 ? buf : unlatin1(subsetStep(text, table, [table.solids[index].id]));
  else throw new Error('this file has assembly structure or its solids do not map onto the bodies; the fine hub mesh needs a plain multi-solid or single-solid STEP');
  const read = (p, label) => {
    if (cancelled()) throw new Error('cancelled');
    progress(label); const r = occt.ReadStepFile(data, { linearUnit: 'millimeter', ...p });
    if (!r.success || r.meshes.length !== 1) throw new Error(r.success ? `the subset gave ${r.meshes.length} meshes for one solid` : 'could not read the STEP subset');
    passes.push({ ...p, tris: triCounts(r.meshes)[0], ms: Date.now() - t0 }); return r.meshes[0];
  };
  const bb0 = expect?.bbox, diag = bb0 ? Math.hypot(bb0[3] - bb0[0], bb0[4] - bb0[1], bb0[5] - bb0[2]) : null;
  let s = 1, P = null, base = null;
  if (diag == null) { const pr = read({ linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.01, angularDeflection: 0.5 }, 'Hub: probe'); const b = bboxes([pr])[0]; return remeshBody(occt, buf, index, { expect: { ...expect, bbox: b }, progress, L, cancelled }); }
  for (let i = 0; i < L.tries; i++) {
    P = hubParams(diag, s, L, expect?.mesh); base = read(P.base, `Hub fine mesh: pass 1 of 2 (deflection ${+P.base.linearDeflection.toPrecision(3)} mm)`);
    const t = triCounts([base])[0]; if (t * L.refine * 1.1 <= L.maxFine) break;
    s *= Math.max(L.grow, t * L.refine * 1.1 / L.maxFine); base = null;
  }
  if (!base) throw new Error('the hub is too large for the fine triangle budget');
  const bb = bboxes([base])[0], tol = 0.02 * diag + 1e-6;
  if (bb0 && !bb.every((v, j) => Math.abs(v - bb0[j]) <= tol)) throw new Error('the re-meshed solid does not match the hub body (bounding box)');
  const fine = read(P.fine, `Hub fine mesh: pass 2 of 2 (deflection ${+P.fine.linearDeflection.toPrecision(3)} mm, ≈${Math.round(4.4 * triCounts([base])[0] / 1e3)} k triangles)`);
  progress('Hub fine mesh: mass properties');
  const mm = m => meshMoments(m.attributes.position.array, m.index.array);
  const c = mm(base), f = mm(fine), vol = richardson(c, f);
  let unc = meshUnc(c, f, vol), fu = null; try { fu = fileUncertainty(text); } catch { }
  if (fu != null) unc = cadFloor(unc, fu);
  return { vol, unc, mesh: { fine: true, deflection: P.fine.linearDeflection, angular: P.fine.angularDeflection, tris: triCounts([fine])[0], baseTris: triCounts([base])[0], scale: s, passes: 2 }, passes, ms: Date.now() - t0 };
}
