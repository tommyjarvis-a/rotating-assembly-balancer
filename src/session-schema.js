import { KINDS, PARAMS, COMMON_PARAMS } from './tools.js';
import { MATERIALS, CUSTOM, validRho } from './materials.js';
// 0.2.0-alpha.2 (H4): schema checks for everything a session file can put back into the app. Restored values are
// type-checked, finite numbers in range, and strings from an allowlist or length-capped; anything else is dropped
// (the current value or the default stays) and counted so the session card can say so.
export const BODY_SRC = ['STEP', 'STEP (file)', 'default', 'user'];
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
