// Module worker for the counterweight generator (src/generator.js). Terminated by the Cancel button.
import { generate } from './generator.js';
self.onmessage = ({ data }) => {
  const post = (type, x = {}) => self.postMessage({ type, ...x });
  try {
    const r = generate({ ...data, progress: (stage, frac) => post('progress', { stage, frac }) });
    self.postMessage({ type: 'done', result: r }, [r.pos.buffer, r.idx.buffer]);
  } catch (e) { post('error', { message: e.message || String(e) }); }
};
