// Tester's concave-slot cases (Gate 656ef85, L18) on test/fixtures/concave-slots-ap242.stp (OCCT-written: a hub
// cylinder offset 1.5 mm and a drum with 8 scallops and 8 radial 4 mm slots). Builds the generator inputs the way the
// app does (auto band, correction target, default tolerance, genTols) for use in tests and tools.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { importStep } from '../src/import-core.js';
import { autoBand } from '../src/band.js';
import { correctionTarget, bodyMoments, pinTyped, orbitU } from '../src/statics.js';
import { genDefaultTol } from '../src/gen-session.js';
import { defaultCell } from '../src/generator.js';
import { containTol } from '../src/contain.js';
import { frame } from '../src/imbalance.js';
export const CC_CASES = { default: {}, pin: { e: 10, ang: 45, m: 30 }, 'pin-big': { e: 20, ang: 112.5, m: 60 }, 'pin-fine': { e: 10, ang: 45, m: 30, cell: 0.5 }, coarse: { e: 10, ang: 45, m: 30, cell: 4 } };
let imp = null;
export async function ccBodies() {
  if (imp) return imp;
  const occt = await createRequire(import.meta.url)('../vendor/occt-import-js/occt-import-js.js')();
  const r = importStep(occt, new Uint8Array(readFileSync(new URL('./fixtures/concave-slots-ap242.stp', import.meta.url))), { mode: 'accurate' });
  return imp = r.bodies;
}
const diag = b => { const lo = [1 / 0, 1 / 0, 1 / 0], hi = [-1 / 0, -1 / 0, -1 / 0]; for (let i = 0; i < b.pos.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], b.pos[i]); hi[k] = Math.max(hi[k], b.pos[i]); } return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]); };
export async function ccInput(name, over = {}) {
  const [H, Bd] = await ccBodies(), c = { ...CC_CASES[name], ...over }, axis = { p: [0, 0, 0], d: [0, 0, 1] };
  const pin = c.e ? pinTyped(c.e, c.ang) : null, loadU = pin ? orbitU(c.m, pin) : [0, 0];
  const band = autoBand(H.pos, axis, frame(axis.p, axis.d), pin ? pin.ang : null);
  const hubMom = bodyMoments(H), T = correctionTarget({ parts: [hubMom], points: [loadU], axis, planes: [{}], constraints: { axialBand: band.w } }).planes[0];
  const cell = c.cell || defaultCell(diag(Bd)), tol = c.tol ?? genDefaultTol({ kind: 'gmm', value: null }, null, hubMom.m, T.mag).tol;
  const margin = Math.max(Bd.mesh?.deflection || 0, 1e-3 * cell);
  const contactTol = Math.max(1e-6 * diag(Bd), 1e-3 * cell, Math.min((H.mesh?.deflection || 0) + 1.5 * margin, 0.1 * cell));
  const f = b => ({ pos: Float64Array.from(b.pos), idx: Uint32Array.from(b.idx) });
  return { boundary: f(Bd), hub: f(H), axis, band: band.w, target: T.U, rho: 7850, cell, tol, contactTol, margin, checkTol: containTol(diag(Bd), [Bd.mesh?.deflection || 0]), T };
}
