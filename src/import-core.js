import { CAD_FLOOR, applyCadFloor } from './bodies.js';
import { readDensities, fileUncertainty, solidTable, subsetStep, latin1, unlatin1 } from './step-meta.js';
import { buildBodies, buildEntries } from './bodies.js';
import { PROBE, PROBE2, ERR, LIMITS, plan, planPerBody, refineOk, diagonal, triCounts, fmtK, bboxes } from './mesh-plan.js';
// STEP → bodies with mass properties under a triangle budget. Runs in the import worker and in Node tests.
// 1) coarse probe (cheap): bbox diagonal D and per-body triangle counts to extrapolate from;
// 2) per-body plan (0.2.0): each body's deflection comes from its own size and only bodies over the per-body
//    budget are coarsened. Bodies are meshed in ≤ GROUPS passes, each on a STEP subset holding just that
//    group's solids (needs a file without assembly structure where solids map 1:1 onto meshes; verified by
//    count and bounding box, otherwise the whole-file plan below is used);
// 3) whole-file plan (0.1.x): base pass at clamp(ratio·D), coarsened when the prediction exceeds the budget;
// 4) accurate mode: refined pass (≈4× triangles) if the actual base count allows it, then Richardson.
const CURVED = /\b(B_SPLINE_SURFACE\w*|CYLINDRICAL_SURFACE|CONICAL_SURFACE|SPHERICAL_SURFACE|TOROIDAL_SURFACE|SURFACE_OF_\w+|OFFSET_SURFACE|RATIONAL_B_SPLINE_SURFACE|ADVANCED_FACE|MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\s*\(/;
export const planarFaceted = text => !!text && /\bFACETED_BREP\s*\(/.test(text) && !CURVED.test(text);
export function importStep(occt, buf, { mode = 'accurate', defRho = 7850, name = '', progress = () => { }, perBody = true } = {}) {
  const t0 = Date.now(), stats = { passes: [] };
  const read = (p, label, data = buf) => {
    progress(label); const r = occt.ReadStepFile(data, { linearUnit: 'millimeter', ...p });
    if (!r.success) throw new Error('Could not read the file (not a valid STEP?)');
    stats.passes.push({ ...p, tris: triCounts(r.meshes).reduce((a, b) => a + b, 0), ms: Date.now() - t0 }); return r;
  };
  const probe = read(PROBE, 'Reading STEP (coarse probe)');
  if (!probe.meshes.length) throw new Error('No solid bodies found in the file');
  let text = ''; try { text = latin1(buf); } catch { }
  let dens = []; try { dens = readDensities(text); } catch { }
  let table = null; try { table = text ? solidTable(text) : null; } catch { }
  const mapped = !!table && !table.assembly && table.solids.length === probe.meshes.length;
  const solidNames = mapped ? table.solids.map(s => s.name) : null;
  const D = diagonal(probe.meshes), warn = [], note = [], info = [];
  let bodies = null, scale = 1, how = 'file';
  // 0.2.0-alpha.4: a planar faceted file (FACETED_BREP of planar FACE_SURFACEs, e.g. this app's counterweight export)
  // tessellates exactly at any deflection: one pass is the exact mesh, so the probe is the result (no ± needed).
  if (planarFaceted(text) && table && table.solids.length === probe.meshes.length) {
    bodies = buildBodies([probe], dens, defRho, name, null, { solidNames });
    bodies.forEach(b => { b.unc = { dV: 0, dc: 0, exact: true }; b.mesh = { group: 1, deflection: 0, angular: 0, tris: b.idx.length / 3, coarsened: false, scale: 1, passes: 1, faceted: true }; });
    how = 'faceted'; info.push('planar faceted STEP (triangles): the mesh is the exact solid, read in one pass');
  }
  if (!bodies && perBody && mapped && probe.meshes.length > 1) {
    try { const r = perBodyImport(); if (r) { bodies = r; how = 'per-body'; } } catch (e) { info.push(`per-body meshing skipped (${e.message}); used one mesh setting for the whole file`); }
  }
  function perBodyImport() {
    const pb0 = bboxes(probe.meshes), diags = pb0.map(b => Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]));
    const p2 = read(PROBE2, 'Reading STEP (calibration probe)');
    if (p2.meshes.length !== probe.meshes.length) throw new Error('calibration probe body count differs');
    const pl = planPerBody(triCounts(probe.meshes), diags, D, mode, undefined, undefined, triCounts(p2.meshes));
    const tol = 2 * PROBE.linearDeflection * D + 1e-6 * D;
    const entries = new Array(probe.meshes.length); let total = 0;
    pl.groups.forEach((g, gi) => {
      const all = g.bodies.length === probe.meshes.length, data = all ? buf : unlatin1(subsetStep(text, table, g.bodies.map(i => table.solids[i].id)));
      const lab = `Meshing group ${gi + 1} of ${pl.groups.length} (${g.bodies.length} bod${g.bodies.length === 1 ? 'y' : 'ies'})`;
      const base = read(g.base, lab + (pl.refine ? ', pass 1 of 2' : ''), data);
      if (base.meshes.length !== g.bodies.length) throw new Error(`subset gave ${base.meshes.length} meshes for ${g.bodies.length} solids`);
      const bb = bboxes(base.meshes);
      g.bodies.forEach((bi, k) => { if (!bb[k].every((v, j) => Math.abs(v - pb0[bi][j]) <= tol)) throw new Error(`body ${bi + 1} did not match its probe bounding box`); });
      let fine = null; const tris = triCounts(base.meshes);
      if (pl.refine) {
        if (refineOk(tris) && total + 4 * tris.reduce((a, b) => a + b, 0) <= LIMITS.total) fine = read(g.fine, lab + ', pass 2 of 2', data);
        else note.push(`group ${gi + 1}: the refined pass would exceed the triangle budget; single-pass (fast) mass properties for its bodies`);
      }
      const last = fine || base; total += triCounts(last.meshes).reduce((a, b) => a + b, 0);
      g.bodies.forEach((bi, k) => { entries[bi] = { mesh: last.meshes[k], coarse: fine ? base.meshes[k] : null, probe: fine ? null : probe.meshes[bi], low: pl.coarsened[bi], solidName: solidNames[bi], product: probe.meshes[bi].name,
        meshInfo: { group: gi + 1, deflection: last === fine ? g.fine.linearDeflection : g.base.linearDeflection, angular: last === fine ? g.fine.angularDeflection : g.base.angularDeflection, tris: triCounts([last.meshes[k]])[0], coarsened: pl.coarsened[bi], scale: pl.scale[bi], passes: fine ? 2 : 1 } }; });
    });
    warn.push(...pl.warn); note.push(...pl.note); scale = Math.max(...pl.scale);
    stats.groups = pl.groups.length;
    progress('Mass properties');
    return buildEntries(entries, dens, defRho, name, { solidNames });
  }
  if (!bodies) {
    const pl = plan(triCounts(probe.meshes), D, mode); warn.push(...pl.warn); note.push(...pl.note); scale = pl.scale;
    const base = read(pl.base, 'Meshing (pass 1' + (pl.refine ? ' of 2)' : ')')), passes = [base];
    if (pl.refine) {
      if (refineOk(triCounts(base.meshes))) passes.push(read(pl.fine, 'Meshing (pass 2 of 2, refined)'));
      else note.push(`accurate mode would exceed the triangle budget (≈${fmtK(4 * triCounts(base.meshes).reduce((a, b) => a + b, 0))}); fell back to fast (single-pass) mass properties`);
    }
    progress('Mass properties');
    const last = passes.at(-1).params ?? (passes.length === 2 ? pl.fine : pl.base);
    bodies = buildBodies(passes, dens, defRho, name, probe, { solidNames, coarsened: probe.meshes.map(() => pl.scale > 1) });
    bodies.forEach((b, i) => { b.mesh = { group: 1, deflection: last.linearDeflection, angular: last.angularDeflection, tris: b.idx.length / 3, coarsened: pl.scale > 1, scale: pl.scale, passes: passes.length }; });
  }
  // L5: coarsening / fallback notes become warnings only if the estimated error matters (see ERR)
  if (note.length) {
    const dV = Math.max(0, ...bodies.map(b => b.unc?.dV ?? 1 / 0)), dc = Math.max(0, ...bodies.map(b => b.unc?.dc ?? 1 / 0));
    const big = !(dV <= ERR.rel && dc <= ERR.com), est = isFinite(dV) ? `estimated error ≤ ${dV.toExponential(1)} relative volume, ${(dc * 1000).toPrecision(2)} µm CoM` : 'no error estimate';
    const low = bodies.some(b => b.unc?.low) ? ' (coarsened bodies: the estimate may be low)' : '';
    (big ? warn : info).push(note.join('; ') + `; ${est}${low}` + (big ? ' — accuracy is lower, see the per-body uncertainty' : ` (below ${ERR.rel.toExponential(0)} / ${ERR.com * 1000} µm)`));
  }
  let fu = null; try { fu = fileUncertainty(text); } catch { }
  if (fu != null && fu >= CAD_FLOOR.minTol) { applyCadFloor(bodies, fu); info.push(`the file declares a ${+fu.toPrecision(3)} mm modelling uncertainty: CAD edge-tolerance gaps can shift volume and CG at any mesh size, so every per-body ± is floored at ${(CAD_FLOOR.rel * fu).toExponential(0)} of volume and ${+(CAD_FLOOR.cg * fu * 1000).toPrecision(2)} µm CG and marked "≥"`); }
  const fin = bodies.reduce((a, b) => a + b.idx.length / 3, 0);
  Object.assign(stats, { fileUncertainty: fu, ms: Date.now() - t0, D, scale, plan: how, mode: how === 'faceted' ? 'exact (faceted)' : bodies.every(b => b.mesh?.passes === 2) ? 'accurate' : bodies.some(b => b.mesh?.passes === 2) ? 'mixed' : 'fast', tris: fin });
  return { bodies, warn, info, stats };
}
