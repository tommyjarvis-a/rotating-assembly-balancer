import { buildIndex, columnHeights, insideIntervals, segmentHit, classify, containment, nearSurface, nearestPoint, checkBody, containTol, EDGE_TESTS } from './contain.js';
import { meshMoments, KGM3, meshCheck } from './mass.js';
import { frame } from './imbalance.js';
// Counterweight generator (0.2.0-alpha.3, static). Pure JS; runs in src/gen-worker.js and in Node tests.
// All work is in the spin-axis frame (u, v, w; origin = axis point) from imbalance.js.
// 1) Voxelize: sample nodes on a grid (cell h in u, v; w spacing fitted so the axial band edges fall exactly
//    half-way between nodes). A node is allowed if it is inside the Boundary, outside the Hub and inside the band
//    (column ray-parity along w with the top-left tie rule, src/contain.js).
// 2) Select: one 6-connected set grown from the best allowed node next to the hub (seed), always taking the
//    frontier node with the largest projection of r⊥ on the counter direction t̂ (bridges are paid for: the set can
//    only reach far cells through the cells in between). Stop when Σ m·r⊥ · t̂ reaches |T|.
// 3) Refine at the margin: add a frontier node or remove a removable node (6-simple, keeps a hub contact) — the
//    move that most reduces |T − Σ m·r⊥| (this also fixes the angle error) — until under tolerance.
// 4) Mesh: marching tetrahedra (Freudenthal 6-tet split of each grid cube, consistent across cubes, so the surface
//    is closed and 2-manifold) of the binary node field. A surface vertex on a node edge that leaves the region is
//    placed exactly on what it crosses: the hub or boundary surface (segment hit) or the band plane; those are pinned.
// 5) Smooth: Taubin λ/μ (volume-preserving, no shrinkage) on the free vertices only; a smoothed vertex that leaves
//    the region (boundary, hub, band) is put back.
// 6) Exact mass properties of the mesh; if the leftover after meshing is over tolerance, re-target the voxel step by
//    the leftover and repeat (≤ maxIter). The best mesh is returned with the iteration count.
export const GEN = { cellsAcross: 120, maxNodes: 2.5e6, smoothIter: 6, lambda: 0.5, mu: -0.53, maxIter: 8, maxMoves: 40000, containPasses: 8, forbidRounds: 6, forbidR: 1.5, minTolFrac: 1e-6 };
const nice = x => { const e = 10 ** Math.floor(Math.log10(x)), f = x / e; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e; };
export const defaultCell = diag => Math.max(0.02, nice(diag / GEN.cellsAcross));
export function toFrame(pos, fr) {
  const R = fr.R, o = fr.o, out = new Float64Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { const x = pos[i] - o[0], y = pos[i + 1] - o[1], z = pos[i + 2] - o[2]; out[i] = R[0] * x + R[1] * y + R[2] * z; out[i + 1] = R[3] * x + R[4] * y + R[5] * z; out[i + 2] = R[6] * x + R[7] * y + R[8] * z; }
  return out;
}
export function fromFrame(pos, fr) {
  const R = fr.R, o = fr.o, out = new Float64Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { const a = pos[i], b = pos[i + 1], c = pos[i + 2]; for (let k = 0; k < 3; k++) out[i + k] = o[k] + R[k] * a + R[3 + k] * b + R[6 + k] * c; }
  return out;
}
const TETS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(([a, b]) => [0, 1 << a, (1 << a) | (1 << b), 7]);
class Heap { // max-heap of [key, id]
  constructor() { this.k = []; this.v = []; }
  push(key, id) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(id); while (i) { const p = (i - 1) >> 1; if (k[p] >= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; } }
  pop() { const k = this.k, v = this.v, id = v[0], lk = k.pop(), lv = v.pop(); if (k.length) { k[0] = lk; v[0] = lv; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < k.length && k[l] > k[m]) m = l; if (r < k.length && k[r] > k[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; } } return id; }
  get size() { return this.k.length; }
}

export function generate({ boundary, hub, axis, band, target, rho, cell, tol, maxNodes = GEN.maxNodes, progress = () => { }, cancelled = () => false, maxIter = GEN.maxIter, smoothIter = GEN.smoothIter, contactTol = null, margin = null, checkTol = null, containPasses = GEN.containPasses, unc = 0, forbidRounds = GEN.forbidRounds }) {
  const t0 = Date.now(), notes = [], chk = () => { if (cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true }); };
  if (!(rho > 0)) throw new Error('added material density must be positive');
  const Tm = Math.hypot(...target); if (!(Tm > 0)) throw new Error('nothing to balance: the target imbalance is zero');
  // L17 (0.2.0-alpha.6): the stop criterion is |R| + U ≤ tol (U = the input uncertainty of hub + load; the piece's own
  // mesh is exact). When U ≥ tol no piece can PASS: the goal is then the smallest |R| the cells allow ('minimal').
  const U0 = unc > 0 ? unc : 0, tolIn = tol, goal = tol - U0 > GEN.minTolFrac * Tm ? 'pass' : 'minimal';
  tol = goal === 'pass' ? tol - U0 : GEN.minTolFrac * Tm;
  const fr = frame(axis.p, axis.d), B = toFrame(boundary.pos, fr), H = toFrame(hub.pos, fr);
  progress('Indexing boundary and hub', 0.02);
  const IB = buildIndex(B, boundary.idx), IH = buildIndex(H, hub.idx);
  const bSign = Math.sign(meshMoments(B, boundary.idx).m) || 1;
  const w0 = Math.max(band[0], IB.lo[2]), w1 = Math.min(band[1], IB.hi[2]);
  if (!(w1 > w0)) throw new Error('the axial band does not overlap the boundary');
  // grid: nodes at lo + (i + 0.5) h, one padding node on each side
  let h = cell > 0 ? cell : defaultCell(IB.diag);
  const dims = hh => { const nu = Math.max(1, Math.ceil((IB.hi[0] - IB.lo[0]) / hh)), nv = Math.max(1, Math.ceil((IB.hi[1] - IB.lo[1]) / hh)), nw = Math.max(1, Math.round((w1 - w0) / hh)); return [nu + 2, nv + 2, nw + 2]; };
  let [NU, NV, NW] = dims(h);
  if (NU * NV * NW > maxNodes) { const h0 = h; h *= Math.cbrt(NU * NV * NW / maxNodes); [NU, NV, NW] = dims(h); while (NU * NV * NW > maxNodes) { h *= 1.03; [NU, NV, NW] = dims(h); } notes.push(`cell size raised from ${h0} to ${+h.toPrecision(3)} mm by the cell-count guard (${(maxNodes / 1e6).toFixed(1)}M nodes)`); }
  const mg = Math.min(0.25 * h, Math.max(margin > 0 ? margin : 0, 1e-6 * IB.diag, 1e-3 * h)); // inset from the boundary (M11)
  const hw = (w1 - w0) / (NW - 2), N = NU * NV * NW, at = (i, j, k) => i + NU * (j + NV * k);
  const U = i => IB.lo[0] + (i - 0.5) * h, Vv = j => IB.lo[1] + (j - 0.5) * h, W = k => w0 + (k - 0.5) * hw;
  const flag = new Uint8Array(N); // bit0 inside boundary, bit1 inside hub, bit2 inside band
  progress(`Voxelizing ${NU}×${NV}×${NW} nodes`, 0.05);
  for (let j = 0; j < NV; j++) {
    if ((j & 7) === 0) { chk(); progress(`Voxelizing ${NU}×${NV}×${NW} nodes`, 0.05 + 0.2 * j / NV); }
    for (let i = 0; i < NU; i++) {
      const u = U(i), v = Vv(j), hb = columnHeights(IB, 2, u, v), hh = columnHeights(IH, 2, u, v);
      for (let k = 0; k < NW; k++) { const w = W(k); flag[at(i, j, k)] = (insideIntervals(hb, w) ? 1 : 0) | (insideIntervals(hh, w) ? 2 : 0) | (k >= 1 && k <= NW - 2 ? 4 : 0); }
    }
  }
  const allowed = n => flag[n] === 5;
  const nb6 = n => { const i = n % NU, j = ((n / NU) | 0) % NV, k = (n / (NU * NV)) | 0, o = []; if (i > 0) o.push(n - 1); if (i < NU - 1) o.push(n + 1); if (j > 0) o.push(n - NU); if (j < NV - 1) o.push(n + NU); if (k > 0) o.push(n - NU * NV); if (k < NW - 1) o.push(n + NU * NV); return o; };
  const that = [target[0] / Tm, target[1] / Tm], mc = rho * KGM3 * h * h * hw;
  const qu = n => mc * U(n % NU), qv = n => mc * Vv(((n / NU) | 0) % NV), proj = n => U(n % NU) * that[0] + Vv(((n / NU) | 0) % NV) * that[1];
  let nAllowed = 0, best = -1, bestV = -1 / 0; const touchesHub = new Uint8Array(N);
  for (let n = 0; n < N; n++) if (allowed(n)) { nAllowed++; if (nb6(n).some(m => flag[m] & 2)) { touchesHub[n] = 1; const p = proj(n); if (p > bestV) { bestV = p; best = n; } } }
  if (!nAllowed) throw new Error('no allowed cells: the boundary minus the hub inside the band is empty at this cell size');
  if (best < 0) throw new Error('no allowed cell touches the hub inside the band (the band or the boundary does not reach the hub)');
  if (!(bestV > 0)) notes.push('no hub-adjacent cell lies on the counter side; the piece has to bridge round the hub');
  // ---- grow ----
  progress('Selecting cells', 0.3);
  const sel = new Uint8Array(N), nbSel = new Uint8Array(N), frontier = new Set(), selList = new Set();
  let Qu = 0, Qv = 0, hubContacts = 0;
  const add = n => { sel[n] = 1; selList.add(n); frontier.delete(n); Qu += qu(n); Qv += qv(n); if (touchesHub[n]) hubContacts++; for (const m of nb6(n)) { nbSel[m]++; if (!sel[m] && allowed(m)) frontier.add(m); } };
  const remove = n => { sel[n] = 0; selList.delete(n); Qu -= qu(n); Qv -= qv(n); if (touchesHub[n]) hubContacts--; let any = false; for (const m of nb6(n)) { nbSel[m]--; if (sel[m]) any = true; if (!sel[m] && nbSel[m] === 0) frontier.delete(m); } if (any && allowed(n)) frontier.add(n); };
  let Tv = target.slice(); const heap = new Heap(); add(best); for (const m of frontier) heap.push(proj(m), m);
  let capped = false;
  while ((Qu * that[0] + Qv * that[1]) < Math.hypot(...Tv)) {
    if ((selList.size & 1023) === 0) chk();
    let n = -1; while (heap.size) { const c = heap.pop(); if (!sel[c] && frontier.has(c)) { n = c; break; } }
    if (n < 0) { capped = true; break; }
    const before = new Set(frontier); add(n); for (const m of frontier) if (!before.has(m)) heap.push(proj(m), m);
  }
  if (capped) notes.push(`the allowed region cannot hold enough material: at most ${(Qu * that[0] + Qv * that[1]).toPrecision(4)} of ${Tm.toPrecision(4)} g·mm`);
  // 6-simple test for removal: the selected 6-neighbours stay connected inside the 3×3×3 block (26-block minus centre)
  const simple = n => {
    const i = n % NU, j = ((n / NU) | 0) % NV, k = (n / (NU * NV)) | 0, cells = [];
    for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { if (!a && !b && !c) continue; const x = i + a, y = j + b, z = k + c; if (x < 0 || y < 0 || z < 0 || x >= NU || y >= NV || z >= NW) continue; const m = at(x, y, z); if (sel[m]) cells.push([a, b, c, m]); }
    const six = cells.filter(([a, b, c]) => Math.abs(a) + Math.abs(b) + Math.abs(c) === 1); if (six.length <= 1) return six.length === 1;
    const inBlk = new Map(cells.map(c => [c[3], c])), seen = new Set([six[0][3]]), st = [six[0]];
    while (st.length) { const [a, b, c] = st.pop(); for (const [da, db, dc] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const x = a + da, y = b + db, z = c + dc; if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1 || (!x && !y && !z)) continue; const m = at(i + x, j + y, k + z); if (inBlk.has(m) && !seen.has(m)) { seen.add(m); st.push(inBlk.get(m)); } } }
    return six.every(c => seen.has(c[3]));
  };
  const tolV = () => 0.5 * tol;
  function refine() {
    for (let it = 0; it < GEN.maxMoves; it++) {
      if ((it & 63) === 0) chk();
      const Ru = Tv[0] - Qu, Rv = Tv[1] - Qv, R0 = Math.hypot(Ru, Rv); if (R0 <= tolV()) return;
      let bestAdd = null, bA = R0;
      for (const n of frontier) { const r = Math.hypot(Ru - qu(n), Rv - qv(n)); if (r < bA) { bA = r; bestAdd = n; } }
      const rems = [];
      for (const n of selList) { const r = Math.hypot(Ru + qu(n), Rv + qv(n)); if (r < R0) rems.push([r, n]); }
      rems.sort((a, b) => a[0] - b[0]); let bestRem = null, bR = R0;
      for (const [r, n] of rems.slice(0, 64)) { if (selList.size > 1 && (!touchesHub[n] || hubContacts > 1) && simple(n)) { bestRem = n; bR = r; break; } }
      if (bestRem == null && bestAdd == null) return;
      if (bestRem != null && bR <= bA * (1 + 1e-9)) remove(bestRem); else add(bestAdd);
    }
  }
  progress('Refining the selection', 0.4); if (!capped) refine();
  // ---- mesh ----
  const P = n => [U(n % NU), Vv(((n / NU) | 0) % NV), W((n / (NU * NV)) | 0)], ecache = new Map();
  const bandPlane = (pi, po) => { const pl = po[2] > w1 ? w1 : po[2] < w0 ? w0 : null; return pl == null || po[2] === pi[2] ? null : (pl - pi[2]) / (po[2] - pi[2]); };
  const edgeVert = (a, b) => { // a inside (selected), b outside
    const key = a * N + b; let e = ecache.get(key); if (e) return e;
    const pa = P(a), pb = P(b), f = flag[b]; let t = null, tag = 'free';
    if (allowed(b)) t = 0.5;
    else {
      const c = [];
      if (!(f & 1)) { const x = segmentHit(IB, pa, pb); c.push([x ?? 0.5, 'bnd']); }
      if (f & 2) { const x = segmentHit(IH, pa, pb); c.push([x ?? 0.5, 'hub']); }
      if (!(f & 4)) { const x = bandPlane(pa, pb); c.push([x ?? 0.5, 'band']); }
      if (f & 8) c.push([0.5, 'bnd']); // L18: a node forbidden after a containment failure (narrow concave feature)
      c.sort((x, y) => x[0] - y[0]); [t, tag] = c[0]; t = Math.min(1, Math.max(0, t));
    }
    e = { p: [0, 1, 2].map(k => pa[k] + t * (pb[k] - pa[k])), tag }; ecache.set(key, e); return e;
  };
  function mesh() {
    const cubes = new Set();
    for (const n of selList) { const i = n % NU, j = ((n / NU) | 0) % NV, k = (n / (NU * NV)) | 0; for (let c = 0; c < 8; c++) { const x = i - (c & 1), y = j - ((c >> 1) & 1), z = k - ((c >> 2) & 1); if (x >= 0 && y >= 0 && z >= 0 && x < NU - 1 && y < NV - 1 && z < NW - 1) cubes.add(at(x, y, z)); } }
    const vid = new Map(), pos = [], tags = []; let idx = [];
    const V = (a, b) => { const key = a * N + b; let i = vid.get(key); if (i == null) { const e = edgeVert(a, b); i = pos.length / 3; pos.push(...e.p); tags.push(e.tag); vid.set(key, i); } return i; };
    const tri = (x, y, z, ins, outs) => {
      const p = i => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], A = p(x), Bq = p(y), C = p(z);
      const n = [(Bq[1] - A[1]) * (C[2] - A[2]) - (Bq[2] - A[2]) * (C[1] - A[1]), (Bq[2] - A[2]) * (C[0] - A[0]) - (Bq[0] - A[0]) * (C[2] - A[2]), (Bq[0] - A[0]) * (C[1] - A[1]) - (Bq[1] - A[1]) * (C[0] - A[0])];
      const ci = [0, 1, 2].map(k => ins.reduce((s, q) => s + P(q)[k], 0) / ins.length), co = [0, 1, 2].map(k => outs.reduce((s, q) => s + P(q)[k], 0) / outs.length);
      if (n[0] * (co[0] - ci[0]) + n[1] * (co[1] - ci[1]) + n[2] * (co[2] - ci[2]) < 0) idx.push(x, z, y); else idx.push(x, y, z);
    };
    for (const c of cubes) {
      const i = c % NU, j = ((c / NU) | 0) % NV, k = (c / (NU * NV)) | 0, corner = q => at(i + (q & 1), j + ((q >> 1) & 1), k + ((q >> 2) & 1));
      for (const tet of TETS) {
        const nodes = tet.map(corner), ins = nodes.filter(m => sel[m]), outs = nodes.filter(m => !sel[m]);
        if (!ins.length || !outs.length) continue;
        if (ins.length === 1) tri(V(ins[0], outs[0]), V(ins[0], outs[1]), V(ins[0], outs[2]), ins, outs);
        else if (ins.length === 3) tri(V(ins[0], outs[0]), V(ins[1], outs[0]), V(ins[2], outs[0]), ins, outs);
        else { const a = V(ins[0], outs[0]), b = V(ins[0], outs[1]), c2 = V(ins[1], outs[1]), d = V(ins[1], outs[0]); tri(a, b, c2, ins, outs); tri(a, c2, d, ins, outs); }
      }
    }
    // Taubin smoothing of free vertices
    const nv = pos.length / 3, nbr = Array.from({ length: nv }, () => new Set());
    for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) { const a = idx[t + e], b = idx[t + (e + 1) % 3]; nbr[a].add(b); nbr[b].add(a); }
    const orig = Float64Array.from(pos); let cur = Float64Array.from(pos); const tmp = new Float64Array(pos.length);
    const step = f => { tmp.set(cur); for (let i = 0; i < nv; i++) { if (tags[i] !== 'free' || !nbr[i].size) continue; for (let k = 0; k < 3; k++) { let s = 0; for (const m of nbr[i]) s += tmp[3 * m + k]; cur[3 * i + k] = tmp[3 * i + k] + f * (s / nbr[i].size - tmp[3 * i + k]); } } };
    for (let s = 0; s < smoothIter; s++) { step(GEN.lambda); step(GEN.mu); }
    let reverted = 0;
    for (let i = 0; i < nv; i++) {
      if (tags[i] !== 'free') continue; const x = [cur[3 * i], cur[3 * i + 1], cur[3 * i + 2]];
      if (x[2] < w0 || x[2] > w1 || classify(IB, x) === 'out' || classify(IH, x) === 'in') { cur[3 * i] = orig[3 * i]; cur[3 * i + 1] = orig[3 * i + 1]; cur[3 * i + 2] = orig[3 * i + 2]; reverted++; }
    }
    return finish({ posF: cur, idx, tags, reverted, inset: 0, split: 0 });
  }
  const finish = m => { const { posF, idx } = m; let mom = meshMoments(posF, idx); if (mom.m < 0) { for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]]; mom = meshMoments(posF, idx); }
    return { ...m, Q: [mom.M1[0] * rho * KGM3, mom.M1[1] * rho * KGM3], vol: mom.m }; };
  // M11: containment is part of the result. Vertices outside the boundary or within the margin of it are put on
  // the boundary minus the margin; edges whose midpoint is outside, or that cross a boundary triangle, are split
  // there (neighbours split consistently, so the mesh stays closed) and the new vertex is placed the same way.
  const contained = m => { const tags = m.tags.slice(), en = enforce(m.posF, m.idx.slice(), tags); return finish({ ...m, posF: en.pos, idx: en.idx, tags, inset: en.moved, split: en.split }); };
  const triIn = t => { const p = k => [IB.pos[3 * IB.idx[3 * t + k]], IB.pos[3 * IB.idx[3 * t + k] + 1], IB.pos[3 * IB.idx[3 * t + k] + 2]], a = p(0), b = p(1), c = p(2);
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])], l = Math.hypot(...n) * bSign || 1;
    return n.map(v => -v / l); };
  // point on the boundary minus the margin nearest to x (or null: nothing near, or it would be inside the hub)
  // Repeated, so a point near a re-entrant boundary edge (two faces) ends up the margin away from both.
  const place = (x0, dm = mg) => {
    let y = x0.slice();
    for (let it = 0; it < 4; it++) {
      const r = nearestPoint(IB, y, 3 * h + dm); if (!r) return it ? y : null;
      const out = classify(IB, y) !== 'in'; if (!out && r.d >= dm * 0.999) break;
      const d = [r.q[0] - y[0], r.q[1] - y[1], r.q[2] - y[2]], dl = Math.hypot(...d);
      const n = dl > 1e-9 * h ? d.map(v => (out ? 1 : -1) * v / dl) : triIn(r.t); y = [0, 1, 2].map(k => r.q[k] + dm * n[k]);
      y[2] = Math.min(w1, Math.max(w0, y[2]));
    }
    return classify(IH, y) === 'in' || classify(IB, y) !== 'in' ? null : y;
  };
  function enforce(pos, idx, tags) {
    const P = Array.from(pos), ins = []; let I = idx, moved = 0, split = 0; // ins: per-vertex inset multiplier
    const X = i => [P[3 * i], P[3 * i + 1], P[3 * i + 2]], key = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;
    for (let pass = 0; pass < containPasses; pass++) {
      chk(); let changed = 0;
      for (let i = 0; i < P.length / 3; i++) {
        const x = X(i), out = classify(IB, x) !== 'in', dm = mg * (ins[i] || 1);
        if (!out && (tags[i] === 'hub' && !ins[i] || !Number.isFinite(nearSurface(IB, x, dm * 0.999)))) continue;
        const y = place(x, dm); if (y && (y[0] !== x[0] || y[1] !== x[1] || y[2] !== x[2])) { P[3 * i] = y[0]; P[3 * i + 1] = y[1]; P[3 * i + 2] = y[2]; moved++; changed++; }
      }
      const cr = containment(IB, Float64Array.from(P), I, { tol: 0.5 * mg, edgeList: true, maxEdgeTests: EDGE_TESTS }), cross = new Set();
      // an edge that still crosses (a chord round a re-entrant boundary edge): its ends go further in (2×, 4×, … the
      // margin, at most a quarter cell) on the next pass instead of being split again; once both are that deep it is split
      for (let e = 0; e < cr.crossEdges.length; e += 2) {
        const a = cr.crossEdges[e], b = cr.crossEdges[e + 1]; let deeper = 0;
        if (pass) for (const v of [a, b]) if (mg * (ins[v] || 1) * 2 <= 0.25 * h) { ins[v] = (ins[v] || 1) * 2; deeper++; }
        if (deeper) changed++; else cross.add(key(a, b));
      }
      const mid = new Map();
      for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
        const a = I[t + k], b = I[t + (k + 1) % 3], e = key(a, b); if (mid.has(e)) continue;
        const m = [0, 1, 2].map(c => (P[3 * a + c] + P[3 * b + c]) / 2);
        if (!cross.has(e) && (tags[a] === 'free' && tags[b] === 'free' || classify(IB, m) === 'in')) { mid.set(e, -1); continue; }
        const y = place(m);
        if (!y) { mid.set(e, -1); continue; }
        mid.set(e, P.length / 3); P.push(y[0], y[1], y[2]); tags.push('bnd'); split++; changed++;
      }
      if ([...mid.values()].some(v => v >= 0)) {
        const out = [];
        for (let t = 0; t < I.length; t += 3) {
          const v = [I[t], I[t + 1], I[t + 2]], m = [0, 1, 2].map(k => mid.get(key(v[k], v[(k + 1) % 3])) ?? -1), n = m.filter(x => x >= 0).length;
          if (!n) { out.push(...v); continue; }
          if (n === 3) { out.push(v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]); continue; }
          const r = n === 1 ? m.findIndex(x => x >= 0) : (m.findIndex(x => x < 0) + 1) % 3, a = v[r], b = v[(r + 1) % 3], c = v[(r + 2) % 3], m0 = m[r], m1 = m[(r + 1) % 3];
          if (n === 1) out.push(a, m0, c, m0, b, c); else out.push(m0, b, m1, a, m0, m1, a, m1, c);
        }
        I = out;
      }
      if (!changed) break;
    }
    return { pos: Float64Array.from(P), idx: I, moved, split };
  }
  // Iterations mesh without the (costly) containment step and use the moment change it made last time (dQ) as the
  // estimate; a candidate (estimate within tol, capped, or the last iteration) gets the containment step and its
  // exact moments. Only contained candidates can be the result.
  // L18 (0.2.0-alpha.6): a candidate that is still not contained after enforcement (chords round narrow re-entrant
  // features such as 4 mm slots) is not accepted: the grid nodes within GEN.forbidR cells of every offending point
  // are forbidden, the selection retreats from them (kept connected to the hub) and the loop goes on, up to
  // forbidRounds extra rounds. Only contained candidates can be the result when one exists.
  const forbid = pts => {
    let nf = 0; const r = GEN.forbidR * Math.max(h, hw), ri = Math.ceil(r / h) + 1, rk = Math.ceil(r / hw) + 1;
    for (let q = 0; q < pts.length; q += 3) {
      const x = pts[q], y = pts[q + 1], z = pts[q + 2], i0 = Math.round((x - IB.lo[0]) / h + 0.5), j0 = Math.round((y - IB.lo[1]) / h + 0.5), k0 = Math.round((z - w0) / hw + 0.5);
      for (let k = k0 - rk; k <= k0 + rk; k++) for (let j = j0 - ri; j <= j0 + ri; j++) for (let i = i0 - ri; i <= i0 + ri; i++) {
        if (i < 0 || j < 0 || k < 0 || i >= NU || j >= NV || k >= NW) continue; const n = at(i, j, k);
        if (!allowed(n) || Math.hypot(U(i) - x, Vv(j) - y, W(k) - z) > r) continue; flag[n] |= 8; nf++; if (sel[n]) remove(n); frontier.delete(n);
      }
    }
    // keep the part connected to the hub
    const seen = new Uint8Array(N), stack = [...selList].filter(n => touchesHub[n]); for (const n of stack) seen[n] = 1;
    while (stack.length) { const n = stack.pop(); for (const m of nb6(n)) if (sel[m] && !seen[m]) { seen[m] = 1; stack.push(m); } }
    for (const n of [...selList]) if (!seen[n]) remove(n);
    for (const n of [...frontier]) if (!allowed(n)) frontier.delete(n);
    return nf;
  };
  const openPts = m => { const c = new Map(), out = []; for (let t = 0; t < m.idx.length; t += 3) for (let k = 0; k < 3; k++) { const a = m.idx[t + k], b = m.idx[t + (k + 1) % 3], e = a < b ? a * 4294967296 + b : b * 4294967296 + a; c.set(e, (c.get(e) || 0) + 1); }
    for (const [e, n] of c) if (n !== 2) { const a = Math.floor(e / 4294967296); out.push(m.posF[3 * a], m.posF[3 * a + 1], m.posF[3 * a + 2]); } return out; };
  const cTolF = checkTol > 0 ? checkTol : containTol(IB.diag, []);
  let bestMesh = null, iter = 0, dQ = [0, 0], rounds = 0, forbidden = 0;
  const better = (m, b) => !b || (m.ok && !b.ok) || (m.ok === b.ok && Math.hypot(...m.R) < Math.hypot(...b.R));
  for (iter = 1; iter <= maxIter + 2 * rounds; iter++) {
    chk(); progress(`Meshing (iteration ${iter})`, 0.5 + 0.45 * (iter - 1) / maxIter);
    const raw = mesh(); let R = [target[0] - raw.Q[0] - dQ[0], target[1] - raw.Q[1] - dQ[1]];
    if (Math.hypot(...R) <= tol || capped || iter >= maxIter || (goal === 'minimal' && iter >= 2)) { // minimal: every iteration is a candidate, the best contained one wins
      progress(`Keeping the piece inside the Boundary (iteration ${iter})`, 0.5 + 0.45 * (iter - 0.5) / maxIter);
      const m = contained(raw); dQ = [m.Q[0] - raw.Q[0], m.Q[1] - raw.Q[1]]; R = [target[0] - m.Q[0], target[1] - m.Q[1]]; m.R = R; m.iter = iter; m.cells = selList.size;
      const cv = containment(IB, m.posF, m.idx, { tol: cTolF, cancelled, maxEdgeTests: EDGE_TESTS, edgeList: true }), open = meshCheck(m.posF, m.idx, m.vol).open;
      m.ok = cv.inside && !cv.crossSkipped && !open;
      if (better(m, bestMesh)) bestMesh = m;
      if (m.ok && (Math.hypot(...R) <= tol || capped)) break;
      if (!m.ok && rounds < forbidRounds) {
        const bad = []; for (const v of cv.outside) bad.push(m.posF[3 * v], m.posF[3 * v + 1], m.posF[3 * v + 2]);
        for (let e = 0; e < cv.crossEdges.length; e += 2) for (const v of [cv.crossEdges[e], cv.crossEdges[e + 1]]) bad.push(m.posF[3 * v], m.posF[3 * v + 1], m.posF[3 * v + 2]);
        const nf = forbid(bad.length ? bad : openPts(m)); if (nf) { rounds++; forbidden += nf; progress(`Retreating from a narrow concave feature (${forbidden} grid nodes excluded)`, 0.5 + 0.45 * (iter - 0.5) / (maxIter + 2 * rounds)); refine(); continue; }
      }
      if (iter >= maxIter + 2 * rounds) break;
    }
    if (iter < maxIter + 2 * rounds) { Tv = [Tv[0] + R[0], Tv[1] + R[1]]; refine(); if (cancelled()) chk(); }
  }
  if (forbidden) notes.push(`${forbidden} grid nodes next to narrow concave boundary features were excluded so the piece stays inside (${rounds} round${rounds > 1 ? 's' : ''})`);
  const m = bestMesh, world = fromFrame(m.posF, fr), idx = Uint32Array.from(m.idx);
  // checks: one piece, closed / manifold, containment, hub contact
  const par = new Int32Array(world.length / 3).map((_, i) => i), root = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let t = 0; t < idx.length; t += 3) { const a = root(idx[t]); par[root(idx[t + 1])] = a; par[root(idx[t + 2])] = a; }
  const comps = new Set(); for (let i = 0; i < par.length; i++) comps.add(root(i));
  const closed = meshCheck(world, idx, m.vol), ctol = Math.max(1e-6 * IB.diag, 1e-6);
  // M11: verification with THE Check-containment function (contain.js checkBody, edge-crossing test included) in
  // world coordinates at the Check tolerance; maxOut is measured. Hub overlap: strict (touching is not overlap).
  progress('Checking containment', 0.96);
  const Bw = buildIndex(boundary.pos, boundary.idx), Hw = buildIndex(hub.pos, hub.idx), cTol = checkTol > 0 ? checkTol : containTol(Bw.diag, []);
  const ver = checkBody(Bw, Hw, world, idx, cTol, { cancelled, maxEdgeTests: EDGE_TESTS });
  // L14: hub contact = vertices on the hub mesh surface within contactTol (the mesh deflection or a small fraction of
  // the cell); the measured minimum vertex–hub distance is reported too.
  const ctH = contactTol > 0 ? contactTol : Math.max(ctol, 1e-3 * h); let hubContact = 0, hubGap = 1 / 0;
  progress('Checking the result', 0.98);
  for (let i = 0; i < m.tags.length; i++) { if (m.tags[i] === 'free') continue; const x = [m.posF[3 * i], m.posF[3 * i + 1], m.posF[3 * i + 2]], d = nearSurface(IH, x, 2 * h); if (d <= ctH) hubContact++; if (d < hubGap) hubGap = d; }
  let dipH = 0; const seenE = new Set();
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = idx[t + k], b = idx[t + (k + 1) % 3]; if (m.tags[a] === 'free' && m.tags[b] === 'free') continue; const key = a < b ? a * 4294967296 + b : b * 4294967296 + a; if (seenE.has(key)) continue; seenE.add(key);
    const x = [0, 1, 2].map(c => (m.posF[3 * a + c] + m.posF[3 * b + c]) / 2);
    if (classify(IH, x) === 'in') { const d = nearSurface(IH, x, h); if (Number.isFinite(d)) dipH = Math.max(dipH, d); }
  }
  let bandOut = 0; for (let i = 2; i < m.posF.length; i += 3) if (m.posF[i] < w0 - 1e-9 || m.posF[i] > w1 + 1e-9) bandOut++;
  return { pos: world, idx, frame: { o: fr.o, R: fr.R }, cell: h, cellW: hw, grid: [NU, NV, NW], allowed: nAllowed, cells: m.cells, iterations: m.iter, residual: m.R, achieved: m.Q, target, tol: tolIn, stopTol: tol, unc: U0, goal,
    volume: m.vol, mass: m.vol * rho * KGM3, components: comps.size, open: closed.open, hubVertices: hubContact, hubGap: Number.isFinite(hubGap) ? hubGap : null, contactTol: ctH, dipBoundary: ver.maxOut, maxOut: ver.maxOut, dipHub: dipH, reverted: m.reverted, inset: m.inset, split: m.split, margin: mg, checkTol: cTol, contained: ver.inside && !ver.crossSkipped, outPts: ver.outPts,
    outsideBoundary: ver.nOut, crossBoundary: ver.crossSkipped ? null : ver.crossings, insideHub: ver.hubOverlap.nIn, outsideBand: bandOut, band: [w0, w1], capped, notes, ms: Date.now() - t0 };
}
