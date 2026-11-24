import { permissibleU } from './statics.js';
import { cleanGenMeta, GEN_NAME } from './session-schema.js';
import { MATERIALS, CUSTOM, validRho } from './materials.js';
// Session storage of the generated counterweight (0.2.0-alpha.3): the mesh itself (base64 Float64 positions +
// Uint32 indices) plus the generation inputs key and the result summary. Over GEN_SESSION_MAX bytes only the
// summary is stored and the session notes that the piece has to be regenerated.
export const GEN_SESSION_MAX = 8e6;
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
export function packGenerated(body, meta, max = GEN_SESSION_MAX) {
  const pos = Float64Array.from(body.pos), idx = Uint32Array.from(body.idx), bytes = pos.byteLength + idx.byteLength;
  const base = { name: body.name, rho: body.rho, mat: body.mat, on: body.on, meta };
  if (bytes > max) return { ...base, mesh: null, needsRegenerate: true, note: `mesh ${(bytes / 1e6).toFixed(1)} MB is over the ${(max / 1e6).toFixed(0)} MB session limit — regenerate after loading` };
  return { ...base, mesh: { pos: b64(new Uint8Array(pos.buffer)), idx: b64(new Uint8Array(idx.buffer)) } };
}
// Restore (alpha.2 hardening): only schema-valid fields — name from the generator's own pattern, density in range,
// material id, boolean on, a summary with known numeric fields (src/session-schema.js), and a mesh whose base64
// decodes to finite positions and in-range indices under the size cap. Anything else → "regenerate".
const B64 = /^[A-Za-z0-9+/]*={0,2}$/, MAT_IDS = new Set([...MATERIALS.map(m => m.id), CUSTOM]);
export function unpackGenerated(j, max = GEN_SESSION_MAX) {
  if (j == null) return null;
  if (typeof j !== 'object' || Array.isArray(j)) return { needsRegenerate: true, meta: null, bad: 1, note: 'the saved generated piece is not valid — regenerate' };
  const { o: meta, bad } = cleanGenMeta(j.meta);
  const regen = why => ({ needsRegenerate: true, meta, bad, note: why });
  if (!j.mesh) return regen(j.needsRegenerate ? 'the generated piece was too large to store in the session — regenerate' : 'the saved session has no generated mesh — regenerate');
  if (!validRho(j.rho)) return regen('the saved generated piece has no valid density — regenerate');
  const m = j.mesh;
  if (typeof m.pos !== 'string' || typeof m.idx !== 'string' || !B64.test(m.pos) || !B64.test(m.idx) || (m.pos.length + m.idx.length) * 0.75 > max * 1.01) return regen('the saved generated mesh is not valid — regenerate');
  try {
    const pu = unb64(m.pos), iu = unb64(m.idx);
    if (!pu.length || !iu.length || pu.length % 24 || iu.length % 12) throw new Error('bad mesh size');
    const pos = new Float64Array(pu.buffer), idx = new Uint32Array(iu.buffer), nv = pos.length / 3;
    for (const v of pos) if (!Number.isFinite(v) || Math.abs(v) > 1e7) throw new Error('bad position');
    for (const i of idx) if (i >= nv) throw new Error('bad index');
    return { name: typeof j.name === 'string' && GEN_NAME.test(j.name) ? j.name : 'Generated CW', rho: j.rho, mat: MAT_IDS.has(j.mat) ? j.mat : null, on: typeof j.on === 'boolean' ? j.on : true, pos, idx, meta, bad };
  } catch (e) { return regen('the saved generated mesh could not be read (' + e.message + ') — regenerate'); }
}
// Default leftover tolerance (g·mm): the check-mode tolerance if set (g·mm, or G grade at the RPM for rotor mass M),
// else 0.2 % of the needed correction (at least 0.05 g·mm).
export function genDefaultTol(tol, rpm, M, Tmag) {
  if (tol?.kind === 'gmm' && tol.value > 0) return { tol: tol.value, how: 'check-mode tolerance' };
  if (tol?.kind === 'G' && tol.value > 0 && rpm > 0 && M > 0) return { tol: permissibleU(tol.value, M, rpm), how: `G${tol.value} at ${rpm} rpm (hub mass)` };
  return { tol: Math.max(0.002 * Tmag, 0.05), how: '0.2 % of the needed correction' };
}
