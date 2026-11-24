// Tessellation planning: deflection relative to the bounding-box diagonal D (mm, clamped) plus triangle
// budgets. Root cause of the 0.1.1 freeze: fixed fine settings (bbox ratio 1e-4 / 2.5e-5, 0.02 / 0.01 rad)
// that cost 1.5M–12M triangles and 100–600 s of blocking WASM on ordinary filleted parts.
// Triangle count is predicted from a coarse probe pass as T ≈ T0 · max(d0/d, (θ0/θ)²) (linear- vs
// angle-limited faces; conservative), and the mesh is coarsened until the prediction fits the budget.
export const LIMITS = {
  ratio: 5.8e-5,          // linear deflection / D  (= 1e-4 of the average bbox side, as in 0.1.x)
  minDefl: 1e-4, maxDefl: 1, // mm
  angular: { fast: 0.05, accurate: 0.02 }, maxAngular: 0.5,
  perBody: 600e3, total: 1.2e6, // triangles in the final pass
  refine: 4,              // pass 2: deflection/4, angle/2 → ≈4× triangles
};
// L5: a coarsened / fast-fallback mesh is only worth a warning when its estimated error matters for any body:
// relative volume (mass) error > 1e-4, or CoM uncertainty > 1 µm. 1e-4 is 0.01 % of mass, well below typical
// density uncertainty (±0.5 %) and a uniform mass error does not move the balance; 1 µm of CoM error is 1 g·mm of
// static imbalance per kg (the residual display turns green below 0.5 g·mm; ISO 21940 G2.5 at 10 000 rpm allows
// e ≈ 2.4 µm). The estimate is the conservative |fine − extrapolated| (accurate) or probe-based (fast) value.
// Below both limits the note is shown as a quiet info card.
export const ERR = { rel: 1e-4, com: 1e-3 /* mm */ };
export const PROBE = { linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.01, angularDeflection: 0.5 };

// OCCT parameters; scale ≥ 1 coarsens (deflection ×scale, angle ×√scale), pass 2 refines.
export function passParams(D, mode, scale = 1, pass = 1, L = LIMITS) {
  const k = pass === 2 ? L.refine : 1;
  const d = Math.min(L.maxDefl, Math.max(L.minDefl, L.ratio * D * scale)) / k;
  return { linearDeflectionType: 'absolute_value', linearDeflection: d, angularDeflection: Math.min(L.maxAngular, L.angular[mode] * Math.sqrt(scale)) / Math.sqrt(k) };
}

export function predict(probeTris, D, p) {
  const d0 = PROBE.linearDeflection * D / Math.sqrt(3), th0 = PROBE.angularDeflection; // probe: ratio × average side
  const f = Math.max(d0 / p.linearDeflection, (th0 / p.angularDeflection) ** 2, 1);
  return probeTris.map(t => t * f);
}

// Plan from the probe: coarsening scale so that the final pass fits both budgets, and whether the refined
// (accurate) pass is planned. warn: budget problems; note: accuracy-related (gated by ERR after meshing).
export function plan(probeTris, D, mode, L = LIMITS) {
  const warn = [], note = [], refine = mode === 'accurate', k = refine ? L.refine : 1;
  const fit = s => { const t = predict(probeTris, D, passParams(D, mode, s, 1, L)).map(v => v * k); return Math.max(t.reduce((a, b) => a + b, 0) / L.total, Math.max(0, ...t) / L.perBody); };
  let s = 1, capped = false;
  for (let i = 0; i < 40 && fit(s) > 1; i++) {
    const n = s * Math.max(1.25, Math.min(4, fit(s))), a = passParams(D, mode, s, 1, L), b = passParams(D, mode, n, 1, L);
    if (a.linearDeflection === b.linearDeflection && a.angularDeflection === b.angularDeflection) { capped = true; break; } // clamps reached
    s = n;
  }
  if (capped) warn.push(`coarsest mesh settings reached and the predicted size still exceeds the triangle budget`);
  if (s > 1) note.push(`mesh coarsened ×${s < 1e4 ? s.toFixed(1) : s.toExponential(1)} to stay within ${fmtK(L.total)} triangles (${fmtK(L.perBody)} per body)`);
  return { scale: s, refine, warn, note, base: passParams(D, mode, s, 1, L), fine: refine ? passParams(D, mode, s, 2, L) : null };
}
// After the base pass: run the refined pass only if ≈refine × actual triangles fits the budgets.
export function refineOk(tris, L = LIMITS) {
  const total = tris.reduce((a, b) => a + b, 0) * L.refine, max = Math.max(0, ...tris) * L.refine;
  return total <= L.total && max <= L.perBody;
}
export function diagonal(meshes) {
  const lo = [1 / 0, 1 / 0, 1 / 0], hi = [-1 / 0, -1 / 0, -1 / 0];
  for (const m of meshes) { const p = m.attributes.position.array; for (let i = 0; i < p.length; i++) { const k = i % 3; if (p[i] < lo[k]) lo[k] = p[i]; if (p[i] > hi[k]) hi[k] = p[i]; } }
  return lo[0] <= hi[0] ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
}
export const triCounts = meshes => meshes.map(m => m.index.array.length / 3);
export const fmtK = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k';

// ---------- per-body budgets (0.2.0, from the NX STEP diagnosis) ----------
// One large filleted body used to coarsen every body in the file (×158 on a 9-body NX file: its smallest part
// got 0.25 mm deflection and a ~1e-3 volume error). Now each body gets its own deflection from its
// OWN bbox diagonal and its own coarsening scale (powers of 2) so that only bodies over `perBody` are coarsened;
// if the total is still over budget, the biggest body is coarsened further. Bodies with similar settings share
// a tessellation pass (occt-import-js meshes a whole representation per call; the import feeds it a STEP subset
// per group). Deflections snap up to powers of √2 and at most GROUPS groups are kept by merging neighbours
// into the coarser setting (never finer, so the budget still holds).
export const GROUPS = 3;
const snapUp = d => 2 ** (Math.ceil(2 * Math.log2(d) - 1e-9) / 2);
export const groupParams = (d, a, pass, L = LIMITS) => pass === 2
  ? { linearDeflectionType: 'absolute_value', linearDeflection: d / L.refine, angularDeflection: a / Math.sqrt(L.refine) }
  : { linearDeflectionType: 'absolute_value', linearDeflection: d, angularDeflection: a };
// Triangle prediction per body: the 0.1.x model T ≈ T0·f with f = max(d0/d, (θ0/θ)²) is very conservative at
// fine settings (×20 on a small planar-heavy body). With a second probe at PROBE2 (f = 4) each body gets its own
// growth exponent α = log(T2/T1)/log 4, clamped to [ALPHA_MIN, 1], and T ≈ T2·(f/4)^α.
export const PROBE2 = { linearDeflectionType: 'bounding_box_ratio', linearDeflection: PROBE.linearDeflection / 4, angularDeflection: PROBE.angularDeflection / 2 };
export const ALPHA_MIN = 0.6;
export const alphaOf = (t1, t2) => Math.min(1, Math.max(ALPHA_MIN, Math.log(Math.max(t2, 1) / Math.max(t1, 1)) / Math.log(4)));
export function predict2(t1, t2, D, p) {
  const f = Math.max(PROBE.linearDeflection * D / Math.sqrt(3) / p.linearDeflection, (PROBE.angularDeflection / p.angularDeflection) ** 2, 1);
  return f <= 4 ? t1 * f ** alphaOf(t1, t2) : t2 * (f / 4) ** alphaOf(t1, t2);
}
export function planPerBody(probeTris, diags, D, mode, L = LIMITS, maxGroups = GROUPS, probe2Tris = null) {
  const k = mode === 'accurate' ? L.refine : 1, warn = [], note = [];
  const par = (i, s) => { const p = passParams(diags[i], mode, s, 1, L); return { d: snapUp(p.linearDeflection), a: p.angularDeflection }; };
  const pred = (i, s) => { const p = par(i, s), g = groupParams(p.d, p.a, 1, L); return (probe2Tris ? predict2(probeTris[i], probe2Tris[i], D, g) : predict([probeTris[i]], D, g)[0]) * k; };
  const s = probeTris.map(() => 1);
  let capped = false;
  for (let i = 0; i < s.length; i++) for (let n = 0; n < 60 && pred(i, s[i]) > L.perBody; n++) {
    const before = pred(i, s[i]); s[i] *= 2; if (!(pred(i, s[i]) < before)) { capped = true; break; }
  }
  for (let n = 0; n < 400; n++) {
    const t = s.map((x, i) => pred(i, x)); if (t.reduce((a, b) => a + b, 0) <= L.total) break;
    const j = t.indexOf(Math.max(...t)), before = t[j]; s[j] *= 2; if (!(pred(j, s[j]) < before)) { capped = true; break; }
  }
  if (capped) warn.push('coarsest mesh settings reached and the predicted size still exceeds the triangle budget');
  // groups of identical settings, sorted fine → coarse, merged to ≤ maxGroups
  const map = new Map();
  s.forEach((x, i) => { const p = par(i, x), key = `${p.d}|${p.a}`; if (!map.has(key)) map.set(key, { d: p.d, a: p.a, bodies: [] }); map.get(key).bodies.push(i); });
  let groups = [...map.values()].sort((x, y) => x.d - y.d || x.a - y.a);
  while (groups.length > maxGroups) {
    let best = 0, r = 1 / 0;
    for (let i = 0; i + 1 < groups.length; i++) { const q = (groups[i + 1].d / groups[i].d) * (groups[i + 1].a / groups[i].a); if (q < r) { r = q; best = i; } }
    const a = groups[best], b = groups[best + 1];
    groups.splice(best, 2, { d: Math.max(a.d, b.d), a: Math.max(a.a, b.a), bodies: [...a.bodies, ...b.bodies].sort((x, y) => x - y) });
  }
  const coarsened = s.map(x => x > 1), nC = coarsened.filter(Boolean).length;
  if (nC) note.push(`${nC} of ${s.length} bod${nC === 1 ? 'y' : 'ies'} coarsened (×${Math.max(...s)} max) to stay within ${fmtK(L.perBody)} triangles per body / ${fmtK(L.total)} total; the other bodies keep their own fine mesh`);
  return { scale: s, coarsened, warn, note, refine: mode === 'accurate',
    groups: groups.map(g => ({ bodies: g.bodies, base: groupParams(g.d, g.a, 1, L), fine: mode === 'accurate' ? groupParams(g.d, g.a, 2, L) : null })) };
}
export function bboxes(meshes) {
  return meshes.map(m => { const p = m.attributes.position.array, lo = [1 / 0, 1 / 0, 1 / 0], hi = [-1 / 0, -1 / 0, -1 / 0];
    for (let i = 0; i < p.length; i++) { const k = i % 3; if (p[i] < lo[k]) lo[k] = p[i]; if (p[i] > hi[k]) hi[k] = p[i]; } return [...lo, ...hi]; });
}
