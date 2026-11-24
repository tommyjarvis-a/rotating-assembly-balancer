import { KINDS, PARAMS, COMMON_PARAMS } from './tools.js';
import { MATERIALS, CUSTOM, validRho } from './materials.js';
// 0.2.0-alpha.2 (H4): schema checks for everything a session file can put back into the app. Restored values are
// type-checked, finite numbers in range, and strings from an allowlist or length-capped; anything else is dropped
// (the current value or the default stays) and counted so the session card can say so.
export const BODY_SRC = ['STEP', 'STEP (file)', 'default', 'user', 'added material'];
export const TOOL_ROLES = ['counterweight', 'swinglink'];
export const MAX_NAME = 80, MAX_PTS = 2000, MAX_ABS = 1e7;
const fin = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_ABS;
const MAT_IDS = new Set([...MATERIALS.map(m => m.id), CUSTOM]);
// one saved body entry → { rho?, src?, on?, role?, mat? } with only valid fields, plus the number dropped
export function cleanBody(b) {
  const o = {}; let bad = 0;
  if (!b || typeof b !== 'object') return { o, bad: 1 };
  if ('rho' in b) { if (validRho(b.rho) && typeof b.rho === 'number') o.rho = b.rho; else bad++; }
  if ('src' in b) { if (BODY_SRC.includes(b.src)) o.src = b.src; else { bad++; if ('rho' in o) o.src = 'user'; } }
  if ('on' in b) { if (typeof b.on === 'boolean') o.on = b.on; else bad++; }
  if ('role' in b) { if (typeof b.role === 'string' && b.role.length <= 16) o.role = b.role; else bad++; }
  if ('mat' in b) { if (typeof b.mat === 'string' && MAT_IDS.has(b.mat)) o.mat = b.mat; else bad++; }
  return { o, bad };
}
// one saved tool → constructor fields for makeTool, or null (unknown kind / not an object)
export function cleanTool(t) {
  if (!t || typeof t !== 'object' || typeof t.kind !== 'string' || !Object.hasOwn(KINDS, t.kind)) return { o: null, bad: 1 };
  const kind = t.kind, o = { kind }; let bad = 0;
  if (typeof t.name === 'string') o.name = t.name.slice(0, MAX_NAME); else if ('name' in t) bad++;
  if (TOOL_ROLES.includes(t.role)) o.role = t.role; else if ('role' in t) bad++;
  o.sign = t.sign === -1 ? -1 : 1;
  for (const k of [...PARAMS[kind], ...COMMON_PARAMS]) if (k in t) { if (fin(t[k])) o[k] = t[k]; else bad++; }
  if (kind === 'prism' && 'pts' in t) {
    const pts = Array.isArray(t.pts) ? t.pts.slice(0, MAX_PTS).filter(p => Array.isArray(p) && p.length === 2 && p.every(fin)).map(p => [p[0], p[1]]) : [];
    if (pts.length >= 3 && pts.length === t.pts.length) o.pts = pts; else bad++;
  }
  if (t.free != null) {
    if (typeof t.free !== 'object' || Array.isArray(t.free)) bad++;
    else { const ok = new Set([...PARAMS[kind], ...COMMON_PARAMS]); o.free = {}; for (const [k, v] of Object.entries(t.free)) { if (ok.has(k) && Array.isArray(v) && v.length === 2 && v.every(fin)) o.free[k] = [v[0], v[1]]; else bad++; } }
  }
  return { o, bad };
}
export const finiteVec = (v, n = 3) => Array.isArray(v) && v.length === n && v.every(fin);

// ---------- 0.2.0-alpha.3: generator fields ----------
const num = (v, lo = -MAX_ABS, hi = MAX_ABS) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
// axial band { mode, face { p, d }, thick, start, end } → checked copy (defaults for anything invalid) + count dropped
export function cleanBand(j) {
  const o = { mode: 'auto', face: null, thick: null, start: null, end: null }; let bad = 0;
  if (j == null) return { o, bad };
  if (typeof j !== 'object' || Array.isArray(j)) return { o, bad: 1 };
  if ('mode' in j) { if (['auto', 'face', 'typed'].includes(j.mode)) o.mode = j.mode; else bad++; }
  if (j.face != null) { if (finiteVec(j.face.p) && finiteVec(j.face.d) && Math.hypot(...j.face.d) > 0) o.face = { p: j.face.p.slice(), d: j.face.d.slice() }; else bad++; }
  for (const k of ['thick', 'start', 'end']) if (j[k] != null) { if (num(j[k])) o[k] = j[k]; else bad++; }
  return { o, bad };
}
// generator settings { cell (mm), tol (g·mm) } — positive, bounded
export function cleanGenSettings(j) {
  const o = { cell: null, tol: null }; let bad = 0;
  if (j == null) return { o, bad };
  if (typeof j !== 'object' || Array.isArray(j)) return { o, bad: 1 };
  if (j.cell != null) { if (num(j.cell, 1e-4, 1e4) && j.cell > 0) o.cell = j.cell; else bad++; }
  if (j.tol != null) { if (num(j.tol, 1e-9, 1e9) && j.tol > 0) o.tol = j.tol; else bad++; }
  return { o, bad };
}
// result summary of a generated piece: only known fields, numbers finite, notes short strings, key a short string
const META_NUM = ['cell', 'cellW', 'allowed', 'cells', 'iterations', 'tol', 'volume', 'mass', 'components', 'open', 'hubVertices', 'hubGap', 'contactTol', 'dipBoundary', 'dipHub', 'reverted', 'outsideBoundary', 'crossBoundary', 'insideHub', 'outsideBand', 'ms', 'tris', 'maxOut', 'inset', 'split', 'margin', 'checkTol'];
// L13: these must be ≥ 0 (counts, sizes, tolerances); tol and cell must be > 0. The containment / contact / tolerance
// fields are informational only: a restored piece is re-verified and judged against the current tolerance.
const META_POS = new Set(['cell', 'cellW', 'tol', 'checkTol', 'margin', 'contactTol']);
const META_VEC = { residual: 2, achieved: 2, target: 2, band: 2, grid: 3 };
export function cleanGenMeta(m) {
  const o = {}; let bad = 0;
  if (m == null) return { o: null, bad };
  if (typeof m !== 'object' || Array.isArray(m)) return { o: null, bad: 1 };
  for (const k of META_NUM) if (m[k] != null) { if (num(m[k]) && (META_POS.has(k) ? m[k] > 0 : k === 'volume' || k === 'mass' || m[k] >= 0)) o[k] = m[k]; else bad++; }
  for (const [k, n] of Object.entries(META_VEC)) if (m[k] != null) { if (finiteVec(m[k], n)) o[k] = m[k].slice(); else bad++; }
  for (const k of ['capped', 'contained']) if (m[k] != null) { if (typeof m[k] === 'boolean') o[k] = m[k]; else bad++; }
  if (m.notes != null) { if (Array.isArray(m.notes) && m.notes.length <= 10 && m.notes.every(s => typeof s === 'string' && s.length <= 300)) o.notes = m.notes.slice(); else bad++; }
  if (m.key != null) { if (typeof m.key === 'string' && m.key.length <= 4000) o.key = m.key; else bad++; }
  return { o, bad };
}
export const GEN_NAME = /^Generated CW( \d{1,4})?$/;
