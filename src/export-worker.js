// Module worker: mesh export (STL binary / ASCII, faceted STEP AP214) off the main thread.
import { toStl, toFacetedStep } from './mesh-export.js';
self.onmessage = ({ data: { kind, bodies, name, solidOnly = [] } }) => {
  try {
    if (kind === 'step') {
      const r = toFacetedStep(bodies, { name, progress: frac => self.postMessage({ type: 'progress', frac }), requireSolid: b => solidOnly.includes(b.name) });
      self.postMessage({ type: 'done', data: r.text, skipped: r.skipped, report: r.report });
    } else {
      const d = toStl(bodies[0], { ascii: kind === 'stla', name: bodies[0].name });
      self.postMessage({ type: 'done', data: d }, typeof d === 'string' ? [] : [d]);
    }
  } catch (e) { self.postMessage({ type: 'error', message: e?.message || String(e) }); }
};
