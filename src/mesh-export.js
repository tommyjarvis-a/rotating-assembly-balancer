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
export function toFacetedStep(bodies, { name = 'counterweight', density = true, progress = () => { } } = {}) {
  const L = []; let n = 0; const E = s => (L.push(`#${++n}=${s};`), `#${n}`);
  const f = v => { const s = (Math.abs(v) < 1e-12 ? 0 : v).toPrecision(15).replace(/0+$/, '').replace(/\.$/, '.').replace(/0+e/, 'e').replace(/\.e/, '.e'); return s.includes('.') || s.includes('e') ? s.replace('e', 'E') : s + '.'; };
  const str = s => `'${String(s).replace(/'/g, "''")}'`;
  const appCtx = E(`APPLICATION_CONTEXT('automotive design')`);
  E(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const mech = E(`MECHANICAL_CONTEXT('',${appCtx},'mechanical')`), pdc = E(`DESIGN_CONTEXT('',${appCtx},'design')`);
  const lu = E(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`), au = E(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`), su = E(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = E(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${lu},'distance_accuracy_value','')`);
  const ctx = E(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lu},${au},${su}))REPRESENTATION_CONTEXT('',''))`);
  const total = bodies.reduce((s, b) => s + b.idx.length / 3, 0); let done = 0, dens, skipped = 0;
  for (const b of bodies) {
    const nm = safeName(b.name), pts = new Map(), P = i => { let e = pts.get(i); if (!e) { e = E(`CARTESIAN_POINT('',(${f(b.pos[3 * i])},${f(b.pos[3 * i + 1])},${f(b.pos[3 * i + 2])}))`); pts.set(i, e); } return e; };
    const faces = [];
    for (let t = 0; t < b.idx.length; t += 3) {
      if ((++done & 4095) === 0) progress(done / total);
      const [i, j, k] = [b.idx[t], b.idx[t + 1], b.idx[t + 2]], a = vtx(b.pos, i), nr = unit(cross(a, vtx(b.pos, j), vtx(b.pos, k))), rx = unit([0, 1, 2].map(c => b.pos[3 * j + c] - a[c]));
      if (!nr || !rx || i === j || j === k || i === k) { skipped++; continue; } // zero-area facet: no plane; adds no volume
      const pl = E(`PLANE('',${E(`AXIS2_PLACEMENT_3D('',${P(i)},${E(`DIRECTION('',(${nr.map(f).join(',')}))`)},${E(`DIRECTION('',(${rx.map(f).join(',')}))`)})`)})`);
      faces.push(E(`FACE_SURFACE('',(${E(`FACE_OUTER_BOUND('',${E(`POLY_LOOP('',(${P(i)},${P(j)},${P(k)}))`)},.T.)`)}),${pl},.T.)`));
    }
    const solid = E(`FACETED_BREP(${str(nm)},${E(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
    const rep = E(`FACETED_BREP_SHAPE_REPRESENTATION(${str(nm)},(${solid}),${ctx})`);
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
  return { text: `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('${fn} faceted solid(s), mm'),'2;1');\nFILE_NAME('${fn}.stp','${ts}',(''),(''),'rotating-assembly-balancer','rotating-assembly-balancer','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n${L.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`, skipped };
}
