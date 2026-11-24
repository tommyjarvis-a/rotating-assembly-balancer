// Lightweight STEP text scan for density / material attributes (AP214/AP242 property patterns).
// Returns [{ product, density /* kg/m³ */, material, raw }]. Heuristic: CAD exporters differ.
export function parseEntities(text) {
  const d = text.indexOf('DATA;'), body = d < 0 ? text : text.slice(d + 5), ents = new Map();
  let cur = '', q = false;
  for (const ch of body) {
    if (ch === "'") q = !q;
    if (ch === ';' && !q) { const m = /^\s*#(\d+)\s*=\s*([\s\S]*)$/.exec(cur); if (m) ents.set(+m[1], m[2].trim()); cur = ''; } else cur += ch;
  }
  return ents;
}
const refs = s => [...s.replace(/'[^']*'/g, '').matchAll(/#(\d+)/g)].map(m => +m[1]);
const type = s => (/^\(?\s*([A-Z0-9_]+)/.exec(s) || [])[1];
const str1 = s => (/'((?:[^']|'')*)'/.exec(s) || [])[1]?.replace(/''/g, "'");

function unitFactor(ents, id, seen = new Set()) {
  const s = ents.get(id); if (!s || seen.has(id)) return null; seen.add(id);
  if (/DERIVED_UNIT\s*\(\s*\(/.test(s) && type(s) === 'DERIVED_UNIT') {
    let k = 1, ok = false;
    for (const r of refs(s)) {
      const e = ents.get(r); if (!e) return null;
      const m = /DERIVED_UNIT_ELEMENT\s*\(\s*#(\d+)\s*,\s*([-\d.E+]+)\s*\)/i.exec(e); if (!m) return null;
      const u = ents.get(+m[1]) || '', exp = +m[2];
      const pre = { '.KILO.': 1e3, '.CENTI.': 1e-2, '.MILLI.': 1e-3, '.MICRO.': 1e-6 }[(/SI_UNIT\s*\(\s*(\.[A-Z]+\.)/.exec(u) || [])[1]] ?? 1;
      if (/MASS_UNIT/.test(u)) { k *= (pre / 1e3) ** exp; ok = true; } else if (/LENGTH_UNIT/.test(u)) k *= pre ** exp; else return null;
    }
    return ok ? k : null;
  }
  return null;
}
// Magnitude fallback when the unit is missing or unreadable.
const guess = v => v > 300 ? v : v > 0.3 && v < 30 ? v * 1e3 : v > 3e-7 && v < 3e-5 ? v * 1e9 : v > 3e-4 && v < 3e-2 ? v * 1e6 : null;

function productOf(ents, id, depth = 0) {
  const s = ents.get(id); if (!s || depth > 6) return null;
  if (type(s) === 'PRODUCT') return str1(s);
  for (const r of refs(s)) { const p = productOf(ents, r, depth + 1); if (p != null) return p; }
  return null;
}

export function readDensities(text) {
  const ents = parseEntities(text), out = [], mats = new Map();
  for (const [, s] of ents) if (type(s) === 'MATERIAL_DESIGNATION') for (const r of refs(s)) { const p = productOf(ents, r); if (p != null) mats.set(p, str1(s)); }
  for (const [id, s] of ents) {
    if (type(s) !== 'PROPERTY_DEFINITION_REPRESENTATION') continue;
    const [pdId, repId] = refs(s), pd = ents.get(pdId) || '', rep = ents.get(repId) || '';
    for (const it of refs(rep)) {
      const e = ents.get(it) || '';
      if (!/MEASURE_REPRESENTATION_ITEM/.test(e) || !/density/i.test(e + pd + str1(rep))) continue;
      const m = /\(\s*([-\d.E+]+)\s*\)\s*,\s*#(\d+)/i.exec(e); if (!m) continue;
      const v = +m[1], k = unitFactor(ents, +m[2]), rho = k != null ? v * k : guess(v);
      if (rho > 0) { const product = productOf(ents, refs(pd).at(-1)); out.push({ product, density: rho, material: mats.get(product) ?? null, raw: `#${id}` }); }
    }
  }
  return out;
}

// ---------- solid bodies (0.2.0): names and per-body subsets ----------
// Solid items of the shape representations, in item order. occt-import-js meshes one free shape (product)
// at a time and keeps the item order within a representation, so for a file without assembly structure
// (no NEXT_ASSEMBLY_USAGE_OCCURRENCE / MAPPED_ITEM) the k-th solid is the k-th mesh. The import verifies
// this (count and bounding boxes) before relying on it.
const SOLID = /^(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP)$/;
const REP = /SHAPE_REPRESENTATION$/;
export function solidTable(text) {
  const ents = parseEntities(text), reps = [], solids = [];
  for (const [id, s] of ents) {
    const t = type(s); if (!t || !REP.test(t)) continue;
    const items = itemsOf(s), sol = items.filter(r => SOLID.test(type(ents.get(r) || '') || ''));
    if (sol.length) { reps.push({ id, items, solids: sol }); for (const r of sol) solids.push({ id: r, rep: id, name: str1(ents.get(r)) ?? '' }); }
  }
  return { solids, reps, assembly: /NEXT_ASSEMBLY_USAGE_OCCURRENCE|MAPPED_ITEM/.test(text) };
}
// Second argument of a representation: the items tuple "(#a,#b,…)".
function itemsOf(s) {
  const r = itemsSpan(s); return r ? refs(s.slice(r[0], r[1])) : [];
}
function itemsSpan(s) { // [start, end) of the items tuple contents inside an entity body string
  let i = s.indexOf('('), q = false; if (i < 0) return null;
  for (i = i + 1; i < s.length; i++) { const ch = s[i]; if (ch === "'") q = !q; else if (!q && ch === ',') break; }
  const a = s.indexOf('(', i); if (a < 0) return null;
  let depth = 0; for (let j = a; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) return [a + 1, j]; }
  return null;
}
// Copy of the STEP text in which only the solids in `keep` (entity ids) remain in their representations.
// Non-solid items (placements) are kept. Representations left without a solid are emptied of solids only.
export function subsetStep(text, table, keep) {
  const keepSet = new Set(keep), edits = [];
  for (const rep of table.reps) {
    const m = new RegExp(`(?:^|[;\\s])#${rep.id}\\s*=`, 'm').exec(text); if (!m) continue;
    const start = m.index + m[0].length; let end = start, q = false;
    for (; end < text.length; end++) { const ch = text[end]; if (ch === "'") q = !q; else if (!q && ch === ';') break; }
    const bodyStr = text.slice(start, end), sp = itemsSpan(bodyStr); if (!sp) continue;
    const items = rep.items.filter(r => !rep.solids.includes(r) || keepSet.has(r));
    edits.push([start + sp[0], start + sp[1], items.map(r => '#' + r).join(',')]);
  }
  edits.sort((x, y) => y[0] - x[0]); let out = text;
  for (const [a, b, t] of edits) out = out.slice(0, a) + t + out.slice(b);
  return out;
}
export const latin1 = buf => { let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return s; };
export const unlatin1 = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
// Declared modelling uncertainty (GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT distance_accuracy_value) in mm, or null.
export function fileUncertainty(text) {
  const m = /UNCERTAINTY_MEASURE_WITH_UNIT\s*\(\s*(?:LENGTH_MEASURE\s*\()?\s*([-\d.E+]+)\s*\)?\s*,\s*#(\d+)/i.exec(text); if (!m) return null;
  const v = +m[1], ents = new RegExp(`#${m[2]}\\s*=([^;]*);`).exec(text)?.[1] || '';
  const pre = { '.MILLI.': 1, '.CENTI.': 10, '.MICRO.': 1e-3 }[(/SI_UNIT\s*\(\s*(\.[A-Z]+\.)/.exec(ents) || [])[1]];
  const k = pre ?? (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\./.test(ents) ? 1000 : /INCH/i.test(ents) ? 25.4 : null);
  return Number.isFinite(v) && k ? v * k : null;
}
