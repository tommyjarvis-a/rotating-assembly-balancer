// 0.2.0-alpha.4: view buffers and re-verification of a generated piece (used by gen-worker.js and Node tests).
import { buildIndex, checkBody, nearSurface } from './contain.js';
export function viewBuffers(pos, idx) {
  const pos32 = Float32Array.from(pos), nrm = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2], ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; for (const o of [a, b, c]) for (let k = 0; k < 3; k++) nrm[o + k] += n[k];
  }
  for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1; nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
  return { pos32, nrm };
}
export function verifyPiece({ boundary, hub, pos, idx, tol, contactTol }) {
  const B = buildIndex(boundary.pos, boundary.idx), H = buildIndex(hub.pos, hub.idx), r = checkBody(B, H, pos, idx, tol);
  let hubVertices = 0, hubMin = 1 / 0; const far = 0.05 * H.diag;
  for (let i = 0; i < pos.length; i += 3) { const d = nearSurface(H, [pos[i], pos[i + 1], pos[i + 2]], far); if (d <= contactTol) hubVertices++; if (d < hubMin) hubMin = d; }
  return { contained: r.inside && !r.crossSkipped, nOut: r.nOut, crossings: r.crossings, maxOut: r.maxOut, outPts: r.outPts, insideHub: r.hubOverlap.nIn, tol, contactTol, hubVertices, hubMin: Number.isFinite(hubMin) ? hubMin : null };
}
