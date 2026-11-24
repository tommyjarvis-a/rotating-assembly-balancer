// Module worker for the check-mode containment test (src/contain.js): keeps the main thread free and can be
// terminated by the Cancel button. In: { boundary: {pos, idx}, hub?: {pos, idx}, bodies: [{ i, name, pos, idx }], tol }.
import { buildIndex, checkBody } from './contain.js';
self.onmessage = ({ data: { boundary, hub, bodies, tol } }) => {
  const post = (type, x = {}) => self.postMessage({ type, ...x });
  try {
    post('progress', { stage: 'Indexing boundary' });
    const B = buildIndex(boundary.pos, boundary.idx), H = hub ? buildIndex(hub.pos, hub.idx) : null, out = [];
    bodies.forEach((b, k) => {
      post('progress', { stage: `Checking ${b.name} (${k + 1} of ${bodies.length})` });
      const r = checkBody(B, H, b.pos, b.idx, tol ?? 1e-6 * B.diag), hubOverlap = r.hubOverlap;
      out.push({ i: b.i, name: b.name, n: r.n, nOut: r.nOut, frac: r.frac, crossings: r.crossings, crossSkipped: r.crossSkipped, inside: r.inside, maxOut: r.maxOut, outPts: r.outPts, outside: Uint32Array.from(r.outside), hubOverlap });
    });
    post('done', { results: out });
  } catch (e) { post('error', { message: e.message || String(e) }); }
};
