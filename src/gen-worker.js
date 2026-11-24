// Module worker for the counterweight generator (src/generator.js). Terminated by the Cancel button.
// 0.2.0-alpha.4 (L15): also builds the view buffers (Float32 positions, vertex normals) and the mass properties, so
// the main thread only attaches transferred buffers; { verify } re-measures a restored piece (L13) with the same
// containment function as Check containment (contain.js checkBody) and the hub-contact rule.
import { generate } from './generator.js';
import { viewBuffers, verifyPiece } from './gen-verify.js';
import { meshMoments } from './mass.js';
self.onmessage = ({ data }) => {
  const post = (type, x = {}) => self.postMessage({ type, ...x });
  try {
    if (data.verify) { post('progress', { stage: 'Verifying containment', frac: 0.5 }); const v = verifyPiece(data.verify); return self.postMessage({ type: 'verified', verify: v }, [v.outPts.buffer]); }
    const r = generate({ ...data, progress: (stage, frac) => post('progress', { stage, frac }) });
    const vb = viewBuffers(r.pos, r.idx); r.vol = meshMoments(r.pos, r.idx);
    self.postMessage({ type: 'done', result: r, view: vb }, [r.pos.buffer, r.idx.buffer, r.outPts.buffer, vb.pos32.buffer, vb.nrm.buffer]);
  } catch (e) { post('error', { message: e.message || String(e) }); }
};
