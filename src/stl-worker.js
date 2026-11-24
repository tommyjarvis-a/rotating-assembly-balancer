// Module worker: STL parse (binary / ASCII), weld, closure check and mass properties off the main thread.
import { parseStl } from './stl.js';
import { meshMoments } from './mass.js';
self.onmessage = ({ data: { buf, unit } }) => {
  try {
    self.postMessage({ type: 'progress', stage: 'Parsing STL' });
    const r = parseStl(buf, { unit }); let vol = meshMoments(r.pos, r.idx), flipped = false;
    if (vol.m < 0) { for (let t = 0; t < r.idx.length; t += 3) { const a = r.idx[t + 1]; r.idx[t + 1] = r.idx[t + 2]; r.idx[t + 2] = a; } vol = meshMoments(r.pos, r.idx); flipped = true; }
    self.postMessage({ type: 'done', ...r, vol, flipped }, [r.pos.buffer, r.idx.buffer]);
  } catch (e) { self.postMessage({ type: 'error', message: e?.message || String(e) }); }
};
