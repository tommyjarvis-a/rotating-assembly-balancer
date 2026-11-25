// 0.2.0-alpha.4: export of triangle meshes (the generated counterweight, optionally with the hub).
// STL: binary (default) or ASCII, one solid. STEP: AP214 (AUTOMOTIVE_DESIGN), one PRODUCT per body, each a
// FACETED_BREP whose faces are planar FACE_SURFACEs bounded by a 3-point POLY_LOOP (the form that re-imports with
// exact volume in OpenCascade; FACE + POLY_LOOP imports nothing and AP242 TESSELLATED_SOLID is not read by
// occt-import-js). Units mm, absolute model coordinates, density as a 'density' measure (kg/m³) per product.
// Faceted: planar triangles, not B-spline surfaces; NX imports it as a faceted / sewn solid.
const cross = (a, b, c) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; };
const vtx = (pos, i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
const unit = n => { const l = Math.hypot(...n); return l > 0 ? n.map(x => x / l) : null; };
// STEP / STL names: printable ASCII only (STEP strings need \X2\ escapes otherwise), quotes doubled for STEP.
export const safeName = (s, d = 'body') => (String(s ?? '').replace(/[^\x20-\x7e]/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)) || d;

// STEP REAL (0.2.0-alpha.6): 15 significant digits; trailing zeros are stripped from the mantissa only. The old
// formatter also stripped them from the exponent (−6.5e-11 was written −6.5E-1), which tilted the planes of some
// facets: plain OCCT then raised vertex tolerances to ~0.35 mm and its volume of the piece moved by +0.1…0.5 %.
export function stepReal(v) {
  if (!Number.isFinite(v)) throw new Error('non-finite coordinate');
  if (Math.abs(v) < 1e-12) return '0.'; // as before: sub-picometre values (mm) are written as 0
  let [m, e] = v.toPrecision(15).split('e'); m = m.includes('.') ? m.replace(/0+$/, '') : m + '.';
  return e ? `${m}E${e}` : m;
}
// L20 (0.2.0-alpha.6): STEP string literal: apostrophes doubled, backslashes doubled, characters outside printable
// ASCII encoded as \X2\hhhh\X0\ (UTF-16 code units, ISO 10303-21), at most max characters of the source string.
export function stepStr(s, max = 200) {
  let o = '';
  const src = Array.from(String(s ?? '')).slice(0, max).join('');
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x27) o += "''"; else if (c === 0x5c) o += '\\\\';
    else if (c >= 0x20 && c <= 0x7e) o += src[i];
    else { let h = ''; while (i < src.length) { const d = src.charCodeAt(i); if (d >= 0x20 && d <= 0x7e) break; h += d.toString(16).toUpperCase().padStart(4, '0'); i++; } i--; o += `\\X2\\${h}\\X0\\`; }
  }
  return `'${o}'`;
}
// L19 (0.2.0-alpha.6): weld a triangle soup (occt-import-js meshes repeat the vertices of every B-rep face) by
// quantized position within tol (neighbour cells searched, so points straddling a cell edge still merge), drop
// facets that collapse, and check the result is a closed, consistently oriented 2-manifold with positive volume.
export function weld(pos, idx, tol) {
  const n = pos.length / 3, map = new Int32Array(n), cells = new Map(), out = [], q = v => Math.floor(v / tol);
  for (let i = 0; i < n; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2], cx = q(x), cy = q(y), cz = q(z); let hit = -1;
    for (let dz = -1; dz <= 1 && hit < 0; dz++) for (let dy = -1; dy <= 1 && hit < 0; dy++) for (let dx = -1; dx <= 1 && hit < 0; dx++) {
      const l = cells.get(`${cx + dx},${cy + dy},${cz + dz}`); if (l) for (const j of l) if (Math.abs(out[3 * j] - x) <= tol && Math.abs(out[3 * j + 1] - y) <= tol && Math.abs(out[3 * j + 2] - z) <= tol) { hit = j; break; }
    }
    if (hit < 0) { hit = out.length / 3; out.push(x, y, z); const k = `${cx},${cy},${cz}`; (cells.get(k) || cells.set(k, []).get(k)).push(hit); }
    map[i] = hit;
  }
  const I = []; let dropped = 0;
  for (let t = 0; t < idx.length; t += 3) { const a = map[idx[t]], b = map[idx[t + 1]], c = map[idx[t + 2]]; if (a === b || b === c || a === c) { dropped++; continue; } I.push(a, b, c); }
  return { pos: Float64Array.from(out), idx: Uint32Array.from(I), merged: n - out.length / 3, dropped };
}
// Zero-area (collinear) facets have no plane, so they cannot be written as planar faces; leaving them out opens the
// shell (OCCT then heals it by raising vertex tolerances, which moved the piece volume by +0.1–0.3 %). Each one is
// removed topologically: with c on its longest edge ab, the neighbour (b, a, d) across ab becomes (b, c, d) + (c, a, d).
export function fixDegenerate(pos, idx, rel = 1e-10) {
  const I = Array.from(idx), alive = new Array(I.length / 3).fill(1), de = new Map(), K = (a, b) => a * 4294967296 + b;
  const setT = t => { for (let k = 0; k < 3; k++) de.set(K(I[3 * t + k], I[3 * t + (k + 1) % 3]), t); };
  const P = i => vtx(pos, i), L2 = (a, b) => (pos[3 * a] - pos[3 * b]) ** 2 + (pos[3 * a + 1] - pos[3 * b + 1]) ** 2 + (pos[3 * a + 2] - pos[3 * b + 2]) ** 2;
  const degen = t => { const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2], n = cross(P(a), P(b), P(c)), m = Math.max(L2(a, b), L2(b, c), L2(c, a)); return Math.hypot(...n) <= rel * m; };
  for (let t = 0; t < I.length / 3; t++) setT(t);
  let fixed = 0, stuck = 0; const queue = []; for (let t = 0; t < I.length / 3; t++) if (degen(t)) queue.push(t);
  for (let guard = 0; queue.length && guard < 100000; guard++) {
    const t = queue.shift(); if (!alive[t] || !degen(t)) continue;
    const v = [I[3 * t], I[3 * t + 1], I[3 * t + 2]], e = [0, 1, 2].map(k => L2(v[k], v[(k + 1) % 3])), k = e.indexOf(Math.max(...e));
    const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3], t2 = de.get(K(b, a));
    if (t2 == null || !alive[t2] || t2 === t) { stuck++; continue; }
    const w = [I[3 * t2], I[3 * t2 + 1], I[3 * t2 + 2]], j = w.indexOf(b), d = w[(j + 2) % 3];
    if (d === c) { stuck++; continue; }
    for (const x of [t, t2]) for (let q = 0; q < 3; q++) { const kk = K(I[3 * x + q], I[3 * x + (q + 1) % 3]); if (de.get(kk) === x) de.delete(kk); }
    alive[t] = 0; I[3 * t2] = b; I[3 * t2 + 1] = c; I[3 * t2 + 2] = d; setT(t2);
    const tn = I.length / 3; I.push(c, a, d); alive.push(1); setT(tn); fixed++;
    queue.push(t2, tn);
  }
  const out = []; for (let t = 0; t < I.length / 3; t++) if (alive[t]) out.push(I[3 * t], I[3 * t + 1], I[3 * t + 2]);
  return { idx: Uint32Array.from(out), fixed, stuck };
}
export function closedCheck(pos, idx) {
  const und = new Map(), dir = new Map(); let badDir = 0, vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k], b = idx[t + (k + 1) % 3], u = a < b ? a * 4294967296 + b : b * 4294967296 + a, d = a * 4294967296 + b;
      und.set(u, (und.get(u) || 0) + 1); if (dir.has(d)) badDir++; dir.set(d, 1);
    }
    const A = vtx(pos, idx[t]), B = vtx(pos, idx[t + 1]), C = vtx(pos, idx[t + 2]);
    vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
  }
  let open = 0, nonManifold = 0; for (const c of und.values()) { if (c === 1) open++; else if (c > 2) nonManifold++; }
  const closed = idx.length > 0 && open === 0 && nonManifold === 0 && badDir === 0;
  return { closed, open, nonManifold, badOrientation: badDir, volume: vol, edges: und.size, faces: idx.length / 3 };
}
// prepare one body for STEP: weld, check, orient outward; closed → solid, else a reference shell (reason given)
export function prepBody(b) {
  const lo = [1 / 0, 1 / 0, 1 / 0], hi = [-1 / 0, -1 / 0, -1 / 0]; for (let i = 0; i < b.pos.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], b.pos[i]); hi[k] = Math.max(hi[k], b.pos[i]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1, tol = Math.max(1e-9, 1e-7 * diag);
  const w = weld(b.pos, b.idx, tol), fd = fixDegenerate(w.pos, w.idx); w.idx = fd.idx; let c = closedCheck(w.pos, w.idx);
  if (c.closed && c.volume < 0) { for (let t = 0; t < w.idx.length; t += 3) { const x = w.idx[t + 1]; w.idx[t + 1] = w.idx[t + 2]; w.idx[t + 2] = x; } c = closedCheck(w.pos, w.idx); }
  const solid = c.closed && c.volume > 0;
  const reason = solid ? '' : c.open ? `${c.open} open edges` : c.nonManifold ? `${c.nonManifold} edges shared by more than 2 facets` : c.badOrientation ? `${c.badOrientation} inconsistently oriented edges` : 'zero or negative volume';
  return { ...b, pos: w.pos, idx: w.idx, solid, reason, weld: { tol, merged: w.merged, dropped: w.dropped, degenerate: fd.fixed, degenerateLeft: fd.stuck }, check: c };
}
export function toStl(body, { ascii = false, name } = {}) {
  const { pos, idx } = body, nt = idx.length / 3, nm = safeName(name ?? body.name, 'counterweight');
  if (ascii) {
    const f = v => (Math.abs(v) < 1e-300 ? 0 : v).toExponential(9), L = [`solid ${nm}`];
    for (let t = 0; t < nt; t++) {
      const a = vtx(pos, idx[3 * t]), b = vtx(pos, idx[3 * t + 1]), c = vtx(pos, idx[3 * t + 2]), n = unit(cross(a, b, c)) || [0, 0, 0];
      L.push(` facet normal ${n.map(f).join(' ')}`, '  outer loop', ...[a, b, c].map(p => `   vertex ${p.map(f).join(' ')}`), '  endloop', ' endfacet');
    }
    L.push(`endsolid ${nm}`); return L.join('\n') + '\n';
  }
  const buf = new ArrayBuffer(84 + 50 * nt), dv = new DataView(buf), head = `${nm} - rotating-assembly-balancer, mm`.slice(0, 80);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, nt, true);
  for (let t = 0, o = 84; t < nt; t++, o += 50) {
    const a = vtx(pos, idx[3 * t]), b = vtx(pos, idx[3 * t + 1]), c = vtx(pos, idx[3 * t + 2]), n = unit(cross(a, b, c)) || [0, 0, 0];
    [...n, ...a, ...b, ...c].forEach((v, k) => dv.setFloat32(o + 4 * k, v, true)); dv.setUint16(o + 48, 0, true);
  }
  return buf;
}

// bodies: [{ name, pos, idx, rho }]; returns the STEP text. progress(frac) is called every 4096 faces.
// L19: every body is welded and checked first (prepBody). A closed body is a FACETED_BREP (one CLOSED_SHELL, shared
// points so readers sew shared edges); a body that cannot be closed is written as a reference surface model
// (SHELL_BASED_SURFACE_MODEL of one OPEN_SHELL, product name suffixed _REFERENCE) unless it is required to be solid
// (requireSolid: the generated piece), which throws. report: [{ name, solid, reason, faces, volume, weld }].
export function toFacetedStep(bodies, { name = 'counterweight', density = true, progress = () => { }, requireSolid = () => false } = {}) {
  const L = []; let n = 0; const E = s => (L.push(`#${++n}=${s};`), `#${n}`);
  const f = stepReal;
  const str = s => stepStr(s); const report = [];
  const appCtx = E(`APPLICATION_CONTEXT('automotive design')`);
  E(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const mech = E(`MECHANICAL_CONTEXT('',${appCtx},'mechanical')`), pdc = E(`DESIGN_CONTEXT('',${appCtx},'design')`);
  const lu = E(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`), au = E(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`), su = E(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = E(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${lu},'distance_accuracy_value','')`);
  const ctx = E(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lu},${au},${su}))REPRESENTATION_CONTEXT('',''))`);
  const total = bodies.reduce((s, b) => s + b.idx.length / 3, 0); let done = 0, dens, skipped = 0;
  for (const b0 of bodies) {
    const b = prepBody(b0);
    if (!b.solid && requireSolid(b0)) throw new Error(`${safeName(b0.name)} is not a closed solid (${b.reason}); not exported`);
    const nm = safeName(b.name) + (b.solid ? '' : '_REFERENCE');
    report.push({ name: nm, solid: b.solid, reason: b.reason, faces: b.check.faces, volume: b.check.volume, weld: b.weld });
    const pts = new Map(), P = i => { let e = pts.get(i); if (!e) { e = E(`CARTESIAN_POINT('',(${f(b.pos[3 * i])},${f(b.pos[3 * i + 1])},${f(b.pos[3 * i + 2])}))`); pts.set(i, e); } return e; };
    const faces = [];
    for (let t = 0; t < b.idx.length; t += 3) {
      if ((++done & 4095) === 0) progress(done / total);
      const [i, j, k] = [b.idx[t], b.idx[t + 1], b.idx[t + 2]], a = vtx(b.pos, i), nr = unit(cross(a, vtx(b.pos, j), vtx(b.pos, k))), rx = unit([0, 1, 2].map(c => b.pos[3 * j + c] - a[c]));
      if (!nr || !rx || i === j || j === k || i === k) { skipped++; continue; } // zero-area facet: no plane; adds no volume
      const pl = E(`PLANE('',${E(`AXIS2_PLACEMENT_3D('',${P(i)},${E(`DIRECTION('',(${nr.map(f).join(',')}))`)},${E(`DIRECTION('',(${rx.map(f).join(',')}))`)})`)})`);
      faces.push(E(`FACE_SURFACE('',(${E(`FACE_OUTER_BOUND('',${E(`POLY_LOOP('',(${P(i)},${P(j)},${P(k)}))`)},.T.)`)}),${pl},.T.)`));
    }
    const rep = b.solid ? E(`FACETED_BREP_SHAPE_REPRESENTATION(${str(nm)},(${E(`FACETED_BREP(${str(nm)},${E(`CLOSED_SHELL('',(${faces.join(',')}))`)})`)}),${ctx})`)
      : E(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION(${str(nm)},(${E(`SHELL_BASED_SURFACE_MODEL(${str(nm)},(${E(`OPEN_SHELL('',(${faces.join(',')}))`)}))`)}),${ctx})`);
    const prod = E(`PRODUCT(${str(nm)},${str(nm)},'',(${mech}))`);
    E(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${prod}))`);
    const pd = E(`PRODUCT_DEFINITION('design','',${E(`PRODUCT_DEFINITION_FORMATION('','',${prod})`)},${pdc})`);
    E(`SHAPE_DEFINITION_REPRESENTATION(${E(`PRODUCT_DEFINITION_SHAPE('','',${pd})`)},${rep})`);
    if (density && b.rho > 0) {
      dens ??= E(`DERIVED_UNIT((${E(`DERIVED_UNIT_ELEMENT(${E(`(MASS_UNIT()NAMED_UNIT(*)SI_UNIT(.KILO.,.GRAM.))`)},1.)`)},${E(`DERIVED_UNIT_ELEMENT(${E(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.))`)},-3.)`)}))`);
      const pr = E(`PROPERTY_DEFINITION('material property','density',${pd})`);
      const mri = E(`MEASURE_REPRESENTATION_ITEM('density',POSITIVE_RATIO_MEASURE(${f(b.rho)}),${dens})`);
      E(`PROPERTY_DEFINITION_REPRESENTATION(${pr},${E(`REPRESENTATION('density',(${mri}),${ctx})`)})`);
    }
  }
  const ts = new Date().toISOString().slice(0, 19), fn = safeName(name, 'counterweight');
  return { report, text: `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((${stepStr(fn + ' faceted solid(s), mm', 250)}),'2;1');\nFILE_NAME(${stepStr(fn + '.stp', 250)},'${ts}',(''),(''),'rotating-assembly-balancer','rotating-assembly-balancer','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n${L.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`, skipped };
}
