// Module worker for the check-mode containment test (src/contain.js): keeps the main thread free and can be
// terminated by the Cancel button. In: { boundary: {pos, idx}, hub?: {pos, idx}, bodies: [{ i, name, pos, idx }], tol }.
import { buildIndex, containment } from './contain.js';
self.onmessage = ({ data: { boundary, hub, bodies, tol } }) => {
  const post = (type, x = {}) => self.postMessage({ type, ...x });
  try {
    post('progress', { stage: 'Indexing boundary' });
    const B = buildIndex(boundary.pos, boundary.idx), H = hub ? buildIndex(hub.pos, hub.idx) : null, out = [];
    bodies.forEach((b, k) => {
      post('progress', { stage: `Checking ${b.name} (${k + 1} of ${bodies.length})` });
      const r = containment(B, b.pos, b.idx, { tol: tol ?? 1e-6 * B.diag });
      let hubOverlap = null;
      if (H) { const h = containment(H, b.pos, b.idx, { tol: tol ?? 1e-6 * H.diag, maxEdgeTests: 0, strict: true }); hubOverlap = { nIn: h.n - h.nOut, frac: h.n ? (h.n - h.nOut) / h.n : 0 }; }
      out.push({ i: b.i, name: b.name, n: r.n, nOut: r.nOut, frac: r.frac, crossings: r.crossings, crossSkipped: r.crossSkipped, inside: r.inside, outside: Uint32Array.from(r.outside), hubOverlap });
    });
    post('done', { results: out });
  } catch (e) { post('error', { message: e.message || String(e) }); }
};
