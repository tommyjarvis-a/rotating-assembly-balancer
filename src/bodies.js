import { cleanBody, finiteVec } from './session-schema.js';
import { meshMoments, richardson, derive, scale, meshCheck } from './mass.js';
import { normalizeRoles } from './roles.js';
// Turn occt-import-js results (one per tessellation pass, finest last) into body records.
// Density: a STEP record whose product name matches the body wins (src 'STEP'). A file-wide value is
// used only when no record matches any body and the file holds a single distinct density
// (src 'STEP (file)'); otherwise the body gets the default (src 'default').
// Solids named REMOVE_* (removal tools written by this app's STEP export) get sign −1: negative mass.
// Uncertainty (0.2.0, honest): two passes → max(|fine − Richardson|, |fine − coarse|) (the pass-to-pass change,
// so it is not under-reported when the passes are not yet in the asymptotic range); one pass with a coarse
// probe → error ∝ 1/triangles, so |base − probe| / (N_base/N_probe − 1) (rough). A body whose mesh had to be
// coarsened gets unc.low = true: the estimate may still be low, shown as "≥".
export function buildBodies(passes, dens, defRho, fileName = '', probe = null, opts = {}) {
  const res = passes.at(-1), two = passes.length === 2 && passes[0].meshes.length === res.meshes.length;
  const one = !two && probe?.meshes.length === res.meshes.length;
  return buildEntries(res.meshes.map((m, i) => ({ mesh: m, coarse: two ? passes[0].meshes[i] : null, probe: one ? probe.meshes[i] : null,
    low: !!opts.coarsened?.[i], solidName: opts.solidNames?.[i] })), dens, defRho, fileName, opts);
}
// entries: [{ mesh (finest), coarse?, probe?, low?, solidName? }] in body order.
// Display name: the STEP solid (MANIFOLD_SOLID_BREP) name, else the product name, else "Body n" when the
// file has several solids, else the file name. Density matching always uses the product name.
export function buildEntries(entries, dens, defRho, fileName = '', opts = {}) {
  const names = new Set(entries.map(e => e.mesh.name)), matched = dens.some(d => names.has(d.product));
  const file1 = !matched && dens.length && new Set(dens.map(d => d.density)).size === 1 ? dens[0] : null;
  const many = entries.length > 1 && opts.solidNames, prodOf = e => e.product ?? e.mesh.name ?? '';
  const prodCount = new Map(); for (const e of entries) prodCount.set(prodOf(e), (prodCount.get(prodOf(e)) || 0) + 1);
  const list = entries.map((e, i) => {
    const m = { ...e.mesh, name: prodOf(e) }, pos = m.attributes.position.array, idx = m.index.array, fine = meshMoments(pos, idx);
    let vol = fine, unc = null;
    const delta = (x, y) => { const a = derive(x), b = derive(y); return { dV: Math.abs(b.m - a.m) / Math.abs(a.m), dc: Math.hypot(...b.c.map((v, k) => v - a.c[k])) }; };
    if (e.coarse) {
      const c = meshMoments(e.coarse.attributes.position.array, e.coarse.index.array); vol = richardson(c, fine);
      const r = delta(vol, fine), p = delta(c, fine); unc = { dV: Math.max(r.dV, p.dV), dc: Math.max(r.dc, p.dc) };
    } else if (e.probe) {
      const c = e.probe, k = Math.max(1, idx.length / c.index.array.length - 1), d = delta(fine, meshMoments(c.attributes.position.array, c.index.array));
      unc = { dV: d.dV / k, dc: d.dc / k, rough: true };
    }
    if (unc && e.low) unc.low = true;
    if (vol.m < 0) vol = scale(vol, -1);
    const own = dens.find(x => x.product === m.name), d = own || file1;
    const sn = e.solidName || '', name = sn || (m.name && !(many && prodCount.get(m.name) > 1) ? m.name : many ? `Body ${i + 1}` : m.name || fileName);
    return { name, stepName: sn || m.name || '', product: m.name || '', file: fileName, sign: /^REMOVE_/.test(sn || m.name || '') ? -1 : 1, vol, unc, rho: d ? Math.round(d.density * 1000) / 1000 : defRho, src: own ? 'STEP' : d ? 'STEP (file)' : 'default',
      material: d?.material ?? null, on: true, pos, idx, nrm: m.attributes.normal?.array, faces: (m.brep_faces || []).flatMap(f => [f.first, f.last]), ...meshCheck(pos, idx, fine.m),
      color: m.color && (m.color[0] * 255 << 16 | m.color[1] * 255 << 8 | m.color[2] * 255), mesh: e.meshInfo || null };
  });
  // L7: suffix duplicate display names (e.g. test.stp #1…#n). Density matching above used the STEP product name.
  return uniqueNames(list);
}

// L7: give duplicate display names a stable suffix (#1, #2, …), including the first copy.
// Unique names are left as they are, unless they collide with a name already in `existing`.
// L9: a file that declares a loose modelling uncertainty δ (mm) has CAD edge-tolerance gaps that change volume and CG
// at any mesh size (NX test file, δ = 0.1 mm: up to 9e-4 relative volume and 16 µm CG on a small body vs OCP B-rep).
// The per-body ± is floored empirically at rel·δ (relative volume, per mm of δ) and cg·δ (CG), and marked "≥".
export const CAD_FLOOR = { minTol: 0.01, rel: 0.01, cg: 0.2 };
export function applyCadFloor(bodies, fu) {
  if (!(fu >= CAD_FLOOR.minTol)) return bodies;
  for (const b of bodies) { const u = b.unc || { dV: 0, dc: 0 }; b.unc = { ...u, dV: Math.max(u.dV, CAD_FLOOR.rel * fu), dc: Math.max(u.dc, CAD_FLOOR.cg * fu), low: true, cad: fu }; }
  return bodies;
}
export function uniqueNames(incoming, existing = []) {
  const taken = new Set(existing.map(b => b.name)), nIn = new Map();
  for (const b of incoming) nIn.set(b.name, (nIn.get(b.name) || 0) + 1);
  const seq = new Map();
  for (const b of incoming) {
    const base = b.name, need = (nIn.get(base) || 0) > 1 || taken.has(base);
    if (!need) { taken.add(base); continue; }
    let k = seq.get(base) || 0, name;
    do { k += 1; name = `${base} #${k}`; } while (taken.has(name));
    seq.set(base, k); b.name = name; taken.add(name);
  }
  return incoming;
}

// Session identity: volume + bbox, plus REMOVE_ sign (hard key). The base name (without a " #n"
// suffix) is a hard key when it is unique on both sides; otherwise the fingerprint only decides
// among candidates that already share that base name and sign.
export const FINGERPRINT = { vol: 1e-3, bbox: 1e-3 }; // relative tolerances (vol; bbox as a fraction of the diagonal)
export function baseName(name) {
  return String(name ?? '').replace(/ #\d+$/, '');
}
export function bodyBBox(b) {
  if (Array.isArray(b.bbox) && b.bbox.length === 6 && b.bbox.every(Number.isFinite)) return b.bbox;
  const p = b.pos, lo = [1 / 0, 1 / 0, 1 / 0], hi = [-1 / 0, -1 / 0, -1 / 0];
  if (!p || !p.length) return [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < p.length; i++) { const k = i % 3; if (p[i] < lo[k]) lo[k] = p[i]; if (p[i] > hi[k]) hi[k] = p[i]; }
  return [...lo, ...hi];
}
export function bodyRef(b, i) {
  return { index: i, name: b.name, file: b.file || '', vol: b.vol?.m ?? b.vol, bbox: bodyBBox(b), sign: b.sign };
}
export function inferredSign(entry) {
  if (entry == null) return;
  if (typeof entry === 'string') return /^REMOVE_/.test(baseName(entry)) ? -1 : 1;
  if (Number.isFinite(entry.sign)) return entry.sign;
  if (entry.removal === true) return -1;
  if (entry.removal === false) return 1;
  if (entry.name) return /^REMOVE_/.test(baseName(entry.name)) ? -1 : undefined;
}
// Accept a legacy session entry (plain name string, or a body record without vol/bbox).
export function asSaved(entry, i = 0) {
  if (entry == null) return { index: i };
  if (typeof entry === 'string') return { name: entry, index: i, sign: inferredSign(entry) };
  return { index: entry.index ?? i, name: entry.name, file: entry.file, vol: entry.vol?.m ?? entry.vol, bbox: entry.bbox, sign: inferredSign(entry) };
}
export function fingerprintMatch(saved, body) {
  if (saved?.sign != null && body.sign != null && saved.sign !== body.sign) return false;
  const v0 = saved?.vol, v1 = body.vol?.m ?? body.vol;
  if (!(Number.isFinite(v0) && Number.isFinite(v1))) return false;
  if (Math.abs(v1 - v0) > FINGERPRINT.vol * Math.max(Math.abs(v0), Math.abs(v1), 1)) return false;
  const a = saved.bbox, b = bodyBBox(body);
  if (!Array.isArray(a) || a.length !== 6 || !b) return false;
  const diag = Math.hypot(a[3] - a[0], a[4] - a[1], a[5] - a[2]) || Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1;
  return a.every((v, i) => Math.abs(v - b[i]) <= FINGERPRINT.bbox * diag);
}
const uniqueVal = (arr, v) => !!v && arr.filter(x => x === v).length === 1;
// Map each saved record onto a current body. Sign must match. A base name that is unique on both
// sides is a hard key; otherwise the volume/bbox fingerprint decides only among same-name,
// same-sign candidates (preferring the saved index when it still qualifies). Unmatched or
// ambiguous entries stay at -1 and the result is marked stale with a notice. Legacy records
// without a fingerprint fall back to a unique name.
export function matchBodies(saved, current) {
  const recs = saved.map((e, i) => asSaved(e, i));
  const curBase = current.map(b => baseName(b.name)), savBase = recs.map(s => baseName(s.name));
  const used = new Set(), map = Array(saved.length).fill(-1), reasons = [];
  const candidates = s => {
    const sameSign = i => s.sign == null || current[i].sign == null || current[i].sign === s.sign;
    let idx = current.map((_, i) => i).filter(i => !used.has(i) && sameSign(i));
    const bn = baseName(s.name);
    if (!bn) return idx;
    const named = idx.filter(i => baseName(current[i].name) === bn);
    if (uniqueVal(savBase, bn) && uniqueVal(curBase, bn)) return named;
    return named;
  };
  for (let si = 0; si < recs.length; si++) {
    const s = recs[si], cand = candidates(s), prefer = s.index;
    if (Number.isInteger(prefer) && cand.includes(prefer) && fingerprintMatch(s, current[prefer])) {
      map[si] = prefer; used.add(prefer); continue;
    }
    const hits = cand.filter(i => fingerprintMatch(s, current[i]));
    if (hits.length === 1) { map[si] = hits[0]; used.add(hits[0]); continue; }
    if (hits.length > 1) { reasons.push(`ambiguous fingerprint for ${s.name || 'body'}[${s.index}]`); continue; }
    // legacy name-only: a unique (base) name of the right sign is enough
    if (!Number.isFinite(s.vol) && cand.length === 1) { map[si] = cand[0]; used.add(cand[0]); continue; }
    if (!Number.isFinite(s.vol) && cand.length > 1) { reasons.push(`ambiguous name '${s.name}'`); continue; }
    reasons.push(cand.length ? `no fingerprint match for ${s.name || 'body'}[${s.index}]` : `no body matching ${s.name || 'body'}[${s.index}]`);
  }
  const unmatched = map.map((v, i) => v < 0 ? i : -1).filter(i => i >= 0);
  return { map, unmatched, stale: unmatched.length > 0, notice: reasons.join('; ') };
}

// A restored CG is current only if the saved CG was not stale AND every saved body matches
// exactly with the same body count (H3). A missing stale flag in an older session is treated
// as stale. Otherwise keep the numbers but marked stale (exact match of a stale/legacy save)
// or drop them (mismatch / body-count change), and include a notice.
export function savedWasStale(saved) {
  if (!saved || !Object.prototype.hasOwnProperty.call(saved, 'stale') || saved.stale == null) return true;
  return !!saved.stale;
}
export function restoreCG(match, saved = {}, counts = {}) {
  const sels = (match.map || []).filter(i => i >= 0);
  const countOk = counts.saved == null || counts.current == null || counts.saved === counts.current;
  const sessionOk = counts.sessionStale == null || counts.sessionStale === false;
  const exact = !!(match && !match.stale && match.map.length && match.map.every(i => i >= 0) && countOk && sessionOk);
  const wasStale = savedWasStale(saved);
  const whyStale = wasStale && exact
    ? (Object.prototype.hasOwnProperty.call(saved, 'stale') && saved.stale != null
      ? 'saved assembly CG was stale' : 'session did not record whether the assembly CG was current')
    : '';
  const notice = [...new Set([match.notice, counts.sessionNotice, !countOk ? `body count changed (${counts.saved} → ${counts.current})` : '', whyStale].filter(Boolean).flatMap(s => String(s).split('; ')))].join('; ');
  if (exact && !wasStale) return { keep: true, stale: false, dropped: false, sels, c: saved.c, m: saved.mass ?? saved.m, notice: '' };
  if (exact) return { keep: true, stale: true, dropped: false, sels, c: saved.c, m: saved.mass ?? saved.m, notice };
  return { keep: false, stale: true, dropped: true, sels, c: null, m: null, notice };
}
// H2: the live key going stale can only set the flag; it never clears it. Only a successful
// Calculate CG may set stale = false.
export function holdStale(cg, key) {
  if (!cg || cg.error) return cg;
  if (cg.key !== key) return { ...cg, stale: true };
  return cg;
}
export function cgKey(sels, bodies) {
  return (sels || []).map(i => { const b = bodies[i]; return b ? `${i}:${b.name}:${b.rho}:${b.sign}:${b.vol?.m ?? b.vol}` : i + ':?'; }).join(',') + '#' + bodies.length;
}
export const CG_EXPORT_NOTE = 'mass-weighted CoM of the listed bodies, mm from WCS origin 0,0,0; bodies are matched on restore by sign, unique base name, and volume/bbox';
export function exportAssemblyCG(cg, bodies, sels = []) {
  if (!cg || cg.error || cg.dropped || !Array.isArray(cg.c)) return undefined;
  const idx = cg.indices || sels;
  return { c: cg.c, mass: cg.m, count: cg.n ?? idx.length, bodies: idx.map(i => bodyRef(bodies[i], i)), stale: !!cg.stale, note: CG_EXPORT_NOTE };
}
// Apply saved densities / on flags and restore the assembly CG onto `current` (mutated in place).
// Then apply holdStale as load-completion would, so a stale restore cannot become current.
export function restoreSession(session, current) {
  const densMatch = matchBodies(Array.isArray(session.bodies) ? session.bodies : [], current); let rejected = 0;
  for (let si = 0; si < densMatch.map.length; si++) {
    const ci = densMatch.map[si], b = (session.bodies || [])[si];
    if (ci >= 0 && b) {
      // H4: only schema-valid fields are applied (src/session-schema.js); 0.2.0 role and material are optional
      const { o, bad } = cleanBody(b); rejected += bad;
      Object.assign(current[ci], o);
    }
  }
  const roleNotes = normalizeRoles(current); if (rejected) roleNotes.push(`${rejected} invalid body field${rejected > 1 ? 's' : ''} ignored`);
  const j = session.assemblyCG;
  // L12: an assembly CG that fails the schema (c not 3 finite numbers, mass not a finite number or null, bodies not an
  // array) is rejected as a whole with a note; restore never throws on it
  if (j != null && (typeof j !== 'object' || !finiteVec(j.c) || !(typeof j.mass === 'number' && Number.isFinite(j.mass) || j.mass == null) || (j.bodies != null && !Array.isArray(j.bodies)))) {
    roleNotes.push('invalid assembly CG ignored'); return { densMatch, roleNotes, sels: [], cg: null, cgRejected: true, exported: undefined };
  }
  if (!j) return { densMatch, roleNotes, sels: [], cg: null, exported: undefined };
  const cgMatch = matchBodies((j.bodies || []).map(asSaved), current);
  const rest = restoreCG(cgMatch, j, { saved: Array.isArray(session.bodies) ? session.bodies.length : undefined, current: current.length, sessionStale: densMatch.stale, sessionNotice: densMatch.notice });
  const sels = rest.sels, key = cgKey(sels, current), names = sels.map(i => current[i].name);
  const cg = rest.keep
    ? { c: rest.c, m: rest.m, n: sels.length, names, indices: sels, key, stale: rest.stale, dropped: false, notice: rest.notice }
    : { dropped: true, stale: true, notice: rest.notice, key, names, indices: sels, c: null, m: null };
  const after = holdStale(cg, key);
  return { densMatch, roleNotes, cgMatch, rest, sels, cg: after, exported: exportAssemblyCG(after, current, sels) };
}
