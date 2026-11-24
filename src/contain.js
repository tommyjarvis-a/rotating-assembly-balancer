// Containment check (0.2.0 check mode): are a body's vertices inside a closed triangle mesh (the Boundary)?
// Point-in-mesh by ray parity along +X, +Y and +Z with a majority vote. Each ray is axis-aligned, so the test
// is 2-D in the projection plane; the edge function uses a top-left tie rule (a symbolic perturbation), so a
// ray through a shared edge or vertex is counted by exactly one of the triangles — parity stays right on
// edge hits. Points within `tol` of the surface count as inside ("on" the boundary: touching is allowed).
// Plus a triangle-intersection check: body edges that properly cross a boundary triangle.
// Pure JS; runs in src/check-worker.js.
const gridSide = nt => Math.max(64, Math.min(512, Math.ceil(Math.sqrt(nt)))); // projection-grid cells per side (alpha.4: grows with the mesh)
export function buildIndex(pos, idx) {
  const lo = [1 / 0, 1 / 0, 1 / 0], hi = [-1 / 0, -1 / 0, -1 / 0];
  for (let i = 0; i < pos.length; i++) { const k = i % 3; if (pos[i] < lo[k]) lo[k] = pos[i]; if (pos[i] > hi[k]) hi[k] = pos[i]; }
  const nt = idx.length / 3, G = gridSide(nt), grids = [0, 1, 2].map(ax => {
    const a = (ax + 1) % 3, b = (ax + 2) % 3, sa = (hi[a] - lo[a]) / G || 1, sb = (hi[b] - lo[b]) / G || 1, cells = Array.from({ length: G * G }, () => []);
    for (let t = 0; t < nt; t++) {
      let a0 = 1 / 0, a1 = -1 / 0, b0 = 1 / 0, b1 = -1 / 0;
      for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; a0 = Math.min(a0, pos[3 * v + a]); a1 = Math.max(a1, pos[3 * v + a]); b0 = Math.min(b0, pos[3 * v + b]); b1 = Math.max(b1, pos[3 * v + b]); }
      const i0 = cl((a0 - lo[a]) / sa, G), i1 = cl((a1 - lo[a]) / sa, G), j0 = cl((b0 - lo[b]) / sb, G), j1 = cl((b1 - lo[b]) / sb, G);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) cells[i * G + j].push(t);
    }
    return { ax, a, b, sa, sb, cells, G };
  });
  return { pos, idx, lo, hi, grids, diag: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
}
const cl = (x, G) => Math.max(0, Math.min(G - 1, Math.floor(x)));
// top-left style tie rule for edge (p→q) in 2-D: include the edge if it is a "top" or "left" edge
const tieIn = (pa, pb, qa, qb) => { const da = qa - pa, db = qb - pb; return db < 0 || (db === 0 && da > 0); };
function edgeIn(pa, pb, qa, qb, xa, xb) {
  const w = (qa - pa) * (xb - pb) - (qb - pb) * (xa - pa);
  return w > 0 || (w === 0 && tieIn(pa, pb, qa, qb));
}
// Parity of crossings of the ray from point x along +axis. Returns { odd, on } (on: hit at the point itself).
function rayParity(I, g, x) {
  const { pos, idx, lo } = I, { ax, a, b, sa, sb, G } = g, xa = x[a], xb = x[b];
  if (xa < lo[a] || xa > I.hi[a] || xb < lo[b] || xb > I.hi[b] || x[ax] > I.hi[ax]) return { odd: false, on: false };
  const cell = g.cells[cl((xa - lo[a]) / sa, G) * G + cl((xb - lo[b]) / sb, G)]; let n = 0, on = false;
  const xa0 = x[ax], skip = xa0 - 1e-9 * (Math.abs(xa0) + 1);
  for (let c = 0; c < cell.length; c++) { // scalar form (alpha.4 perf), same arithmetic as before
    const t = cell[c], i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
    const h0 = pos[3 * i0 + ax], h1 = pos[3 * i1 + ax], h2 = pos[3 * i2 + ax]; if (h0 < skip && h1 < skip && h2 < skip) continue; // wholly behind the ray start
    const A0 = pos[3 * i0 + a], A1 = pos[3 * i0 + b]; let B0 = pos[3 * i1 + a], B1 = pos[3 * i1 + b], C0 = pos[3 * i2 + a], C1 = pos[3 * i2 + b], P1 = h1, P2 = h2;
    const area = (B0 - A0) * (C1 - A1) - (B1 - A1) * (C0 - A0); if (area === 0) continue; // edge-on in this projection
    if (area < 0) { let q = B0; B0 = C0; C0 = q; q = B1; B1 = C1; C1 = q; P1 = h2; P2 = h1; }
    if (!(edgeIn(A0, A1, B0, B1, xa, xb) && edgeIn(B0, B1, C0, C1, xa, xb) && edgeIn(C0, C1, A0, A1, xa, xb))) continue;
    // height of the triangle's plane at (xa, xb) along the ray axis (barycentric)
    const l1 = ((C0 - B0) * (xb - B1) - (C1 - B1) * (xa - B0)) / Math.abs(area), l2 = ((A0 - C0) * (xb - C1) - (A1 - C1) * (xa - C0)) / Math.abs(area), l3 = 1 - l1 - l2;
    const h = l1 * h0 + l2 * P1 + l3 * P2;
    if (h > xa0) n++; else if (h === xa0) on = true;
  }
  return { odd: n % 2 === 1, on };
}
function closestOnTri(p, a, b, c) { // closest point on a triangle (Ericson, Real-Time Collision Detection 5.1.5)
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return add3(a, ab, v); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return add3(a, ac, w); }
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); return add3(b, sub(c, b), w); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}
const pointTriDist2 = (p, a, b, c) => d2s(p, closestOnTri(p, a, b, c));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add3 = (a, d, t) => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], d2s = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const V = (pos, i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
// 0.2.0-alpha.4 (perf): a lazily built 3-D uniform grid of the triangles (CSR lists) for the local queries below —
// the 2-D projection columns hold every triangle along the column, which is slow on large CAD meshes.
function grid3(I) {
  if (I.g3) return I.g3;
  const { pos, idx, lo, hi } = I, nt = idx.length / 3, ext = [0, 1, 2].map(k => Math.max(hi[k] - lo[k], 1e-9 * (I.diag || 1), 1e-12));
  let cs = Math.cbrt(ext[0] * ext[1] * ext[2] / Math.min(2e6, Math.max(64, 2 * nt)));
  cs = Math.max(cs, Math.max(...ext) / 256);
  let n, start, list;
  for (; ;) {
    n = ext.map(e => Math.max(1, Math.ceil(e / cs)));
    const cnt = new Uint32Array(n[0] * n[1] * n[2] + 1), rng = new Int32Array(6 * nt); let tot = 0;
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) { let m0 = 1 / 0, m1 = -1 / 0; for (let v = 0; v < 3; v++) { const c = pos[3 * idx[3 * t + v] + k]; if (c < m0) m0 = c; if (c > m1) m1 = c; } rng[6 * t + 2 * k] = Math.max(0, Math.min(n[k] - 1, Math.floor((m0 - lo[k]) / cs))); rng[6 * t + 2 * k + 1] = Math.max(0, Math.min(n[k] - 1, Math.floor((m1 - lo[k]) / cs))); }
      tot += (rng[6 * t + 1] - rng[6 * t] + 1) * (rng[6 * t + 3] - rng[6 * t + 2] + 1) * (rng[6 * t + 5] - rng[6 * t + 4] + 1);
    }
    if (tot > 24 * nt + 4e6) { cs *= 1.6; continue; } // huge triangles relative to the cells: coarser grid
    for (let t = 0; t < nt; t++) for (let z = rng[6 * t + 4]; z <= rng[6 * t + 5]; z++) for (let y = rng[6 * t + 2]; y <= rng[6 * t + 3]; y++) for (let x = rng[6 * t]; x <= rng[6 * t + 1]; x++) cnt[x + n[0] * (y + n[1] * z) + 1]++;
    start = new Uint32Array(cnt.length); for (let c = 1; c < cnt.length; c++) start[c] = start[c - 1] + cnt[c];
    list = new Uint32Array(tot); const fill = start.slice(0, -1);
    for (let t = 0; t < nt; t++) for (let z = rng[6 * t + 4]; z <= rng[6 * t + 5]; z++) for (let y = rng[6 * t + 2]; y <= rng[6 * t + 3]; y++) for (let x = rng[6 * t]; x <= rng[6 * t + 1]; x++) list[fill[x + n[0] * (y + n[1] * z)]++] = t;
    break;
  }
  return I.g3 = { cs, n, start, list, stamp: new Uint32Array(nt), q: 0 };
}
// Calls f(t) once for every triangle whose cell box meets the box [p0, p1] (all triangles if that box is huge).
function eachNear(I, p0, p1, f) {
  const g = grid3(I), { cs, n, start, list, stamp } = g, nt = I.idx.length / 3;
  if (++g.q === 0xffffffff) { stamp.fill(0); g.q = 1; } const q = g.q;
  const r = [0, 1, 2].map(k => [Math.max(0, Math.floor((p0[k] - I.lo[k]) / cs)), Math.min(n[k] - 1, Math.floor((p1[k] - I.lo[k]) / cs))]);
  if (r.some(([a, b]) => b < a)) return;
  const cells = (r[0][1] - r[0][0] + 1) * (r[1][1] - r[1][0] + 1) * (r[2][1] - r[2][0] + 1);
  if (cells > nt) { for (let t = 0; t < nt; t++) f(t); return; }
  for (let z = r[2][0]; z <= r[2][1]; z++) for (let y = r[1][0]; y <= r[1][1]; y++) for (let x = r[0][0]; x <= r[0][1]; x++) {
    const c = x + n[0] * (y + n[1] * z); for (let s = start[c]; s < start[c + 1]; s++) { const t = list[s]; if (stamp[t] !== q) { stamp[t] = q; f(t); } }
  }
}
const box = (x, r) => [[x[0] - r, x[1] - r, x[2] - r], [x[0] + r, x[1] + r, x[2] + r]];
// Distance from x to the surface, if below tol; else Infinity.
export function nearSurface(I, x, tol) {
  let best = 1 / 0; const [p0, p1] = box(x, tol);
  eachNear(I, p0, p1, t => { const d = pointTriDist2(x, V(I.pos, I.idx[3 * t]), V(I.pos, I.idx[3 * t + 1]), V(I.pos, I.idx[3 * t + 2])); if (d < best) best = d; });
  return Math.sqrt(best) <= tol ? Math.sqrt(best) : 1 / 0;
}
// Nearest surface point to x within tol: { d, q, t } (q = the point, t = its triangle), or null.
export function nearestPoint(I, x, tol) {
  let best = 1 / 0, q = null, bt = -1; const [p0, p1] = box(x, tol);
  eachNear(I, p0, p1, t => { const c = closestOnTri(x, V(I.pos, I.idx[3 * t]), V(I.pos, I.idx[3 * t + 1]), V(I.pos, I.idx[3 * t + 2])), d = d2s(x, c); if (d < best) { best = d; q = c; bt = t; } });
  return Math.sqrt(best) <= tol ? { d: Math.sqrt(best), q, t: bt } : null;
}
// 'in' | 'out' | 'on' for point x.
export function classify(I, x, tol = 0) {
  if (tol > 0 && Number.isFinite(nearSurface(I, x, tol))) return 'on';
  let votes = 0;
  for (const g of I.grids) { const r = rayParity(I, g, x); if (r.on) return 'on'; if (r.odd) votes++; }
  return votes >= 2 ? 'in' : 'out';
}
// Segment p→q against triangle: a proper crossing — the ends are on opposite sides of the triangle's plane, each
// more than tol (mm, the touching tolerance) from it, and the crossing point is strictly inside the triangle. An edge
// lying on or touching the boundary surface (e.g. a counterweight OD on a curved bore) is not a crossing (M9).
function segTri(p, q, a, b, c, tol) {
  const e1 = sub(b, a), e2 = sub(c, a), n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], nl = Math.hypot(...n); if (!(nl > 0)) return false;
  const dp = dot(n, sub(p, a)) / nl, dq = dot(n, sub(q, a)) / nl;
  if (!((dp > tol && dq < -tol) || (dp < -tol && dq > tol))) return false;
  const t = dp / (dp - dq), x = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])], r = sub(x, a);
  const d00 = dot(e1, e1), d01 = dot(e1, e2), d11 = dot(e2, e2), d20 = dot(r, e1), d21 = dot(r, e2), den = d00 * d11 - d01 * d01; if (!(den > 0)) return false;
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  return v > 0 && w > 0 && v + w < 1;
}
// Containment of body (pos, idx) in boundary index I. Vertices are de-duplicated by exact position.
// strict: only points strictly inside count as inside (used for hub overlap: touching is not overlap).
// Returns { n (unique vertices), outside: [vertex indices into pos], frac, crossings, inside: bool }.
export function containment(I, pos, idx, { tol = 1e-6 * I.diag, maxEdgeTests = 4e6, strict = false, cancelled = () => false, edgeList = false } = {}) {
  const seen = new Map(), outside = []; let n = 0;
  for (let i = 0; i < pos.length / 3; i++) {
    if ((i & 1023) === 0 && cancelled()) throw new Error('cancelled');
    const key = pos[3 * i] + ',' + pos[3 * i + 1] + ',' + pos[3 * i + 2]; if (seen.has(key)) { if (seen.get(key)) outside.push(i); continue; }
    n++; const c = classify(I, V(pos, i), tol), out = strict ? c !== 'in' : c === 'out'; seen.set(key, out); if (out) outside.push(i);
  }
  const uniqOut = [...seen.values()].filter(Boolean).length;
  // edge crossings (concave boundaries): body edges that cross the boundary surface away from their ends
  let crossings = 0, tests = 0, skipped = false; const edges = new Set(), crossEdges = [];
  const eps = tol;
  outer: for (let t = 0; t < idx.length / 3; t++) for (let k = 0; k < 3; k++) {
    const i = idx[3 * t + k], j = idx[3 * t + (k + 1) % 3], key = i < j ? i * 4294967296 + j : j * 4294967296 + i; if (edges.has(key)) continue; edges.add(key);
    const p = V(pos, i), q = V(pos, j), cand = [];
    eachNear(I, [0, 1, 2].map(c => Math.min(p[c], q[c]) - eps), [0, 1, 2].map(c => Math.max(p[c], q[c]) + eps), tt => cand.push(tt)); // 3-D grid cells the edge's box meets
    tests += cand.length; if (tests > maxEdgeTests) { skipped = true; break outer; }
    for (const tt of cand) if (segTri(p, q, V(I.pos, I.idx[3 * tt]), V(I.pos, I.idx[3 * tt + 1]), V(I.pos, I.idx[3 * tt + 2]), eps)) { crossings++; if (edgeList) crossEdges.push(i, j); break; }
    if ((edges.size & 4095) === 0 && cancelled()) throw new Error('cancelled');
  }
  return { n, nOut: uniqOut, outside, frac: n ? uniqOut / n : 0, crossings, crossEdges, crossSkipped: skipped, inside: uniqOut === 0 && crossings === 0 };
}

// 0.2.0-alpha.4 (M11): THE containment check of a body against the Boundary (and its overlap with the Hub), shared by
// Check containment (check-worker.js) and the generator's own verification, so the two always agree. maxOut is
// measured: the largest distance outside the boundary surface over the outside vertices and over 16 samples along
// every crossing edge (0 when inside).
export function checkBody(B, H, pos, idx, tol, { cancelled = () => false, maxEdgeTests = 4e6 } = {}) {
  const r = containment(B, pos, idx, { tol, maxEdgeTests, cancelled, edgeList: true });
  let maxOut = 0; const far = B.diag, pts = [], mark = x => { if (pts.length < 15000) pts.push(x[0], x[1], x[2]); };
  const outd = x => { if (classify(B, x) !== 'out') return 0; for (let r = Math.max(4 * tol, 1e-3 * far); ; r *= 4) { const n = nearestPoint(B, x, Math.min(r, far)); if (n) return n.d; if (r >= far) return 0; } }; // growing search radius
  for (const v of r.outside) mark(V(pos, v));
  for (let e = 0; e < r.crossEdges.length; e += 2) { const p = V(pos, r.crossEdges[e]), q = V(pos, r.crossEdges[e + 1]); for (let k = 1; k < 16; k++) { const x = add3(p, sub(q, p), k / 16), d = outd(x); if (d > 0) { mark(x); maxOut = Math.max(maxOut, d); } } }
  // measured protrusion: every vertex, and 7 samples along every edge whose ends are both near the surface
  const nv = pos.length / 3, near = new Uint8Array(nv), band = Math.max(4 * tol, 1e-3 * B.diag), seenE = new Set();
  for (let i = 0; i < nv; i++) { if ((i & 1023) === 0 && cancelled()) throw new Error('cancelled'); const x = V(pos, i); maxOut = Math.max(maxOut, outd(x)); near[i] = Number.isFinite(nearSurface(B, x, band)) ? 1 : 0; }
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
    const i = idx[t + k], j = idx[t + (k + 1) % 3]; if (!near[i] || !near[j]) continue; const key = i < j ? i * 4294967296 + j : j * 4294967296 + i; if (seenE.has(key)) continue; seenE.add(key);
    const p = V(pos, i), q = V(pos, j); for (let s2 = 1; s2 < 8; s2++) maxOut = Math.max(maxOut, outd(add3(p, sub(q, p), s2 / 8)));
  }
  let hubOverlap = null;
  if (H) { const h = containment(H, pos, idx, { tol, maxEdgeTests: 0, strict: true }); hubOverlap = { nIn: h.n - h.nOut, frac: h.n ? (h.n - h.nOut) / h.n : 0 }; }
  return { n: r.n, nOut: r.nOut, outside: r.outside, frac: r.frac, crossings: r.crossings, crossSkipped: r.crossSkipped, inside: r.inside, maxOut, outPts: Float64Array.from(pts), hubOverlap };
}
// Touching tolerance of Check containment: max(1e-6 · boundary diagonal, 2 × the largest mesh deflection involved).
export const containTol = (diag, deflections) => Math.max(1e-6 * diag, 2 * Math.max(0, ...deflections));

// ---------- 0.2.0-alpha.3 helpers for the generator ----------
// Heights (along axis ax) of every surface crossing of the line through (xa, xb) in the other two coordinates,
// sorted. Uses the same top-left tie rule, so a line through a shared edge is counted once. Pairs of heights
// [h0, h1], [h2, h3], … are the inside intervals of a closed mesh.
export function columnHeights(I, ax, xa, xb) {
  const g = I.grids[ax], { a, b, sa, sb, G } = g, { pos, idx, lo } = I, out = [];
  if (xa < lo[a] || xa > I.hi[a] || xb < lo[b] || xb > I.hi[b]) return out;
  for (const t of g.cells[cl((xa - lo[a]) / sa, G) * G + cl((xb - lo[b]) / sb, G)]) {
    const i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
    let A = [pos[3 * i0 + a], pos[3 * i0 + b]], B = [pos[3 * i1 + a], pos[3 * i1 + b]], C = [pos[3 * i2 + a], pos[3 * i2 + b]];
    const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]); if (area === 0) continue;
    let P = [i0, i1, i2]; if (area < 0) { [B, C] = [C, B]; P = [i0, i2, i1]; }
    if (!(edgeIn(A[0], A[1], B[0], B[1], xa, xb) && edgeIn(B[0], B[1], C[0], C[1], xa, xb) && edgeIn(C[0], C[1], A[0], A[1], xa, xb))) continue;
    const l1 = ((C[0] - B[0]) * (xb - B[1]) - (C[1] - B[1]) * (xa - B[0])) / Math.abs(area), l2 = ((A[0] - C[0]) * (xb - C[1]) - (A[1] - C[1]) * (xa - C[0])) / Math.abs(area), l3 = 1 - l1 - l2;
    out.push(l1 * pos[3 * P[0] + ax] + l2 * pos[3 * P[1] + ax] + l3 * pos[3 * P[2] + ax]);
  }
  return out.sort((x, y) => x - y);
}
export const insideIntervals = (hs, h) => { for (let i = 0; i + 1 < hs.length; i += 2) if (h > hs[i] && h < hs[i + 1]) return true; return false; };
// Smallest parameter t in [0, 1] where segment p→q meets the mesh surface, or null.
export function segmentHit(I, p, q) {
  const d = sub(q, p); let best = null;
  eachNear(I, [0, 1, 2].map(c => Math.min(p[c], q[c])), [0, 1, 2].map(c => Math.max(p[c], q[c])), t => {
    const A = V(I.pos, I.idx[3 * t]), e1 = sub(V(I.pos, I.idx[3 * t + 1]), A), e2 = sub(V(I.pos, I.idx[3 * t + 2]), A);
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]], det = dot(e1, h); if (Math.abs(det) < 1e-300) return;
    const f = 1 / det, s = sub(p, A), u = f * dot(s, h); if (u < 0 || u > 1) return;
    const qv = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = f * dot(d, qv); if (v < 0 || u + v > 1) return;
    const tt = f * dot(e2, qv); if (tt >= 0 && tt <= 1 && (best == null || tt < best)) best = tt;
  });
  return best;
}
