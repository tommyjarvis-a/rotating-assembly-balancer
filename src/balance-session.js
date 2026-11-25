import { bodyRef, matchBodies } from './bodies.js';
import { normalizeAdded } from './materials.js';
import { pinTyped } from './statics.js';
import { BAND_DEFAULT } from './band.js';
import { cleanBand, cleanGenSettings } from './session-schema.js';
// Session format for the 0.2.0 balance inputs (top-level "balance" object). Older sessions have none and load
// with the defaults. Pin: a picked pin keeps its world axis (p, d) so e and the angle follow later axis edits;
// a typed pin keeps e and the angle. Orbiting load: none, a body (matched like the other session bodies), or a
// typed mass in g.
export const BALANCE_DEFAULT = () => ({ added: normalizeAdded(null), pin: null, load: { kind: 'none', body: -1, mass: null }, rpm: null, tol: { kind: 'gmm', value: null }, band: BAND_DEFAULT(), gen: { cell: null, tol: null }, hubMesh: 'fine' });
// 0.2.0-alpha.6: hub mass-property mesh: 'fine' (default; own large triangle budget, re-meshed in a worker) or 'fast'
// (the coarser import mesh, for big files)
export const HUB_MESH_MODES = ['fine', 'fast'];
export function exportBalance(bal, bodies) {
  const pin = bal.pin && (bal.pin.src === 'pick' ? { src: 'pick', p: bal.pin.p, d: bal.pin.d, r: bal.pin.r ?? null } : { src: 'typed', e: bal.pin.e, ang: bal.pin.ang });
  const L = bal.load || {}, load = L.kind === 'body' && bodies[L.body] ? { kind: 'body', body: bodyRef(bodies[L.body], L.body) } : L.kind === 'mass' && L.mass > 0 ? { kind: 'mass', mass: L.mass } : { kind: 'none' };
  return { added: bal.added, pin, load, rpm: bal.rpm ?? null, tol: bal.tol, band: bal.band, gen: bal.gen, hubMesh: HUB_MESH_MODES.includes(bal.hubMesh) ? bal.hubMesh : 'fine', note: 'angles in degrees in the spin-axis frame (0° = +u, 90° = +v, right-handed about the axis direction); e in mm; masses in g; band [start, end] mm along the axis from the axis point' };
}
export function restoreBalance(j, bodies) {
  const out = BALANCE_DEFAULT(), notes = []; if (!j || typeof j !== 'object') return { bal: out, notes };
  out.added = normalizeAdded(j.added);
  const p = j.pin;
  if (p?.src === 'pick' && Array.isArray(p.p) && Array.isArray(p.d) && [...p.p, ...p.d].every(Number.isFinite)) out.pin = { src: 'pick', p: p.p.slice(0, 3), d: p.d.slice(0, 3), r: Number.isFinite(p.r) ? p.r : null };
  else if (p?.src === 'typed') { const t = pinTyped(+p.e, +p.ang); if (!t.error) out.pin = t; else notes.push('saved pin ignored (' + t.error + ')'); }
  const L = j.load;
  if (L?.kind === 'mass' && +L.mass > 0) out.load = { kind: 'mass', body: -1, mass: +L.mass };
  else if (L?.kind === 'body' && L.body) { const m = matchBodies([L.body], bodies); if (m.map[0] >= 0) out.load = { kind: 'body', body: m.map[0], mass: null }; else notes.push(`orbiting load body not found (${m.notice})`); }
  if (+j.rpm > 0) out.rpm = +j.rpm;
  if (j.tol && (j.tol.kind === 'gmm' || j.tol.kind === 'G')) out.tol = { kind: j.tol.kind, value: Number.isFinite(+j.tol.value) && j.tol.value !== null ? +j.tol.value : null };
  const cb = cleanBand(j.band), cg = cleanGenSettings(j.gen); out.band = cb.o; out.gen = cg.o;
  if (cb.bad + cg.bad) notes.push(`${cb.bad + cg.bad} invalid generator setting${cb.bad + cg.bad > 1 ? 's' : ''} ignored`);
  if (j.hubMesh !== undefined) { if (HUB_MESH_MODES.includes(j.hubMesh)) out.hubMesh = j.hubMesh; else notes.push('invalid hub mesh setting ignored (Fine used)'); }
  return { bal: out, notes };
}
