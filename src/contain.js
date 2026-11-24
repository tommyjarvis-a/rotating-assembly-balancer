// Containment check (0.2.0 check mode): are a body's vertices inside a closed triangle mesh (the Boundary)?
// Point-in-mesh by ray parity along +X, +Y and +Z with a majority vote. Each ray is axis-aligned, so the test
// is 2-D in the projection plane; the edge function uses a top-left tie rule (a symbolic perturbation), so a
// ray through a shared edge or vertex is counted by exactly one of the triangles — parity stays right on
// edge hits. Points within `tol` of the surface count as inside ("on" the boundary: touching is allowed).
// Plus a triangle-intersection check: body edges that properly cross a boundary triangle.
// Pure JS; runs in src/check-worker.js.
const G = 64; // grid cells per side of the projection grids
export function buildIndex(pos, idx) {
  const lo = [1 / 0, 1 / 0, 1 / 0], hi = [-1 / 0, -1 / 0, -1 / 0];
  for (let i = 0; i < pos.length; i++) { const k = i % 3; if (pos[i] < lo[k]) lo[k] = pos[i]; if (pos[i] > hi[k]) hi[k] = pos[i]; }
  const nt = idx.length / 3, grids = [0, 1, 2].map(ax => {
    const a = (ax + 1) % 3, b = (ax + 2) % 3, sa = (hi[a] - lo[a]) / G || 1, sb = (hi[b] - lo[b]) / G || 1, cells = Array.from({ length: G * G }, () => []);
    for (let t = 0; t < nt; t++) {
      let a0 = 1 / 0, a1 = -1 / 0, b0 = 1 / 0, b1 = -1 / 0;
      for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; a0 = Math.min(a0, pos[3 * v + a]); a1 = Math.max(a1, pos[3 * v + a]); b0 = Math.min(b0, pos[3 * v + b]); b1 = Math.max(b1, pos[3 * v + b]); }
      const i0 = cl((a0 - lo[a]) / sa), i1 = cl((a1 - lo[a]) / sa), j0 = cl((b0 - lo[b]) / sb), j1 = cl((b1 - lo[b]) / sb);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) cells[i * G + j].push(t);
    }
    return { ax, a, b, sa, sb, cells };
  });
  return { pos, idx, lo, hi, grids, diag: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
}
const cl = x => Math.max(0, Math.min(G - 1, Math.floor(x)));
// top-left style tie rule for edge (p→q) in 2-D: include the edge if it is a "top" or "left" edge
const tieIn = (pa, pb, qa, qb) => { const da = qa - pa, db = qb - pb; return db < 0 || (db === 0 && da > 0); };
function edgeIn(pa, pb, qa, qb, xa, xb) {
  const w = (qa - pa) * (xb - pb) - (qb - pb) * (xa - pa);
  return w > 0 || (w === 0 && tieIn(pa, pb, qa, qb));
}
// Parity of crossings of the ray from point x along +axis. Returns { odd, on } (on: hit at the point itself).
function rayParity(I, g, x) {
  const { pos, idx, lo } = I, { ax, a, b, sa, sb } = g, xa = x[a], xb = x[b];
  if (xa < lo[a] || xa > I.hi[a] || xb < lo[b] || xb > I.hi[b] || x[ax] > I.hi[ax]) return { odd: false, on: false };
  const cell = g.cells[cl((xa - lo[a]) / sa) * G + cl((xb - lo[b]) / sb)]; let n = 0, on = false;
  for (const t of cell) {
    const i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
    let A = [pos[3 * i0 + a], pos[3 * i0 + b]], B = [pos[3 * i1 + a], pos[3 * i1 + b]], C = [pos[3 * i2 + a], pos[3 * i2 + b]];
    const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]); if (area === 0) continue; // edge-on in this projection
    let P = [i0, i1, i2]; if (area < 0) { [B, C] = [C, B]; P = [i0, i2, i1]; }
    if (!(edgeIn(A[0], A[1], B[0], B[1], xa, xb) && edgeIn(B[0], B[1], C[0], C[1], xa, xb) && edgeIn(C[0], C[1], A[0], A[1], xa, xb))) continue;
    // height of the triangle's plane at (xa, xb) along the ray axis (barycentric)
    const l1 = ((C[0] - B[0]) * (xb - B[1]) - (C[1] - B[1]) * (xa - B[0])) / Math.abs(area), l2 = ((A[0] - C[0]) * (xb - C[1]) - (A[1] - C[1]) * (xa - C[0])) / Math.abs(area), l3 = 1 - l1 - l2;
    const h = l1 * pos[3 * P[0] + ax] + l2 * pos[3 * P[1] + ax] + l3 * pos[3 * P[2] + ax];
    if (h > x[ax]) n++; else if (h === x[ax]) on = true;
  }
  return { odd: n % 2 === 1, on };
}
function pointTriDist2(p, a, b, c) { // squared distance point → triangle (Ericson, Real-Time Collision Detection 5.1.5)
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return d2s(p, a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return d2s(p, b);
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return d2s(p, add3(a, ab, v)); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return d2s(p, c);
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return d2s(p, add3(a, ac, w)); }
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); return d2s(p, add3(b, sub(c, b), w)); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; return d2s(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add3 = (a, d, t) => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], d2s = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const V = (pos, i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
// Distance from x to the surface, if below tol (uses the Z grid cells around x); else Infinity.
export function nearSurface(I, x, tol) {
  const g = I.grids[2], { a, b, sa, sb } = g, i0 = cl((x[a] - tol - I.lo[a]) / sa), i1 = cl((x[a] + tol - I.lo[a]) / sa), j0 = cl((x[b] - tol - I.lo[b]) / sb), j1 = cl((x[b] + tol - I.lo[b]) / sb);
  let best = 1 / 0; const seen = new Set();
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const t of g.cells[i * G + j]) {
    if (seen.has(t)) continue; seen.add(t);
    const d = pointTriDist2(x, V(I.pos, I.idx[3 * t]), V(I.pos, I.idx[3 * t + 1]), V(I.pos, I.idx[3 * t + 2])); if (d < best) best = d;
  }
  return Math.sqrt(best) <= tol ? Math.sqrt(best) : 1 / 0;
}
// 'in' | 'out' | 'on' for point x.
export function classify(I, x, tol = 0) {
  if (tol > 0 && Number.isFinite(nearSurface(I, x, tol))) return 'on';
  let votes = 0;
  for (const g of I.grids) { const r = rayParity(I, g, x); if (r.on) return 'on'; if (r.odd) votes++; }
  return votes >= 2 ? 'in' : 'out';
}
// Segment p→q against triangle (Möller–Trumbore); proper crossing strictly inside the segment.
function segTri(p, q, a, b, c, eps) {
  const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a), h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]], det = dot(e1, h);
  if (Math.abs(det) < 1e-14 * Math.hypot(...d) * Math.hypot(...e1) * Math.hypot(...e2)) return false;
  const f = 1 / det, s = sub(p, a), u = f * dot(s, h); if (u <= 0 || u >= 1) return false;
  const qv = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = f * dot(d, qv); if (v <= 0 || u + v >= 1) return false;
  const t = f * dot(e2, qv); return t > eps && t < 1 - eps;
}
// Containment of body (pos, idx) in boundary index I. Vertices are de-duplicated by exact position.
// strict: only points strictly inside count as inside (used for hub overlap: touching is not overlap).
// Returns { n (unique vertices), outside: [vertex indices into pos], frac, crossings, inside: bool }.
export function containment(I, pos, idx, { tol = 1e-6 * I.diag, maxEdgeTests = 4e6, strict = false, cancelled = () => false } = {}) {
  const seen = new Map(), outside = []; let n = 0;
  for (let i = 0; i < pos.length / 3; i++) {
    if ((i & 1023) === 0 && cancelled()) throw new Error('cancelled');
    const key = pos[3 * i] + ',' + pos[3 * i + 1] + ',' + pos[3 * i + 2]; if (seen.has(key)) { if (seen.get(key)) outside.push(i); continue; }
    n++; const c = classify(I, V(pos, i), tol), out = strict ? c !== 'in' : c === 'out'; seen.set(key, out); if (out) outside.push(i);
  }
  const uniqOut = [...seen.values()].filter(Boolean).length;
  // edge crossings (concave boundaries): body edges that cross the boundary surface away from their ends
  let crossings = 0, tests = 0, skipped = false; const edges = new Set();
  const g = I.grids[2], { a, b, sa, sb } = g, eps = tol / Math.max(I.diag, 1e-12);
  outer: for (let t = 0; t < idx.length / 3; t++) for (let k = 0; k < 3; k++) {
    const i = idx[3 * t + k], j = idx[3 * t + (k + 1) % 3], key = i < j ? i * 4294967296 + j : j * 4294967296 + i; if (edges.has(key)) continue; edges.add(key);
    const p = V(pos, i), q = V(pos, j), i0 = cl((Math.min(p[a], q[a]) - I.lo[a]) / sa), i1 = cl((Math.max(p[a], q[a]) - I.lo[a]) / sa), j0 = cl((Math.min(p[b], q[b]) - I.lo[b]) / sb), j1 = cl((Math.max(p[b], q[b]) - I.lo[b]) / sb);
    const cand = new Set(); for (let x = i0; x <= i1; x++) for (let y = j0; y <= j1; y++) for (const tt of g.cells[x * G + y]) cand.add(tt);
    tests += cand.size; if (tests > maxEdgeTests) { skipped = true; break outer; }
    for (const tt of cand) if (segTri(p, q, V(I.pos, I.idx[3 * tt]), V(I.pos, I.idx[3 * tt + 1]), V(I.pos, I.idx[3 * tt + 2]), eps)) { crossings++; break; }
    if ((edges.size & 4095) === 0 && cancelled()) throw new Error('cancelled');
  }
  return { n, nOut: uniqOut, outside, frac: n ? uniqOut / n : 0, crossings, crossSkipped: skipped, inside: uniqOut === 0 && crossings === 0 };
}
