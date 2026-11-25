// 0.2.0-alpha.6: module worker for the fine hub re-mesh (src/hub-mesh.js). Terminating it (Cancel) frees the WASM heap.
import { remeshBody } from './hub-mesh.js';
const OCCT = new URL('../vendor/occt-import-js/occt-import-js.js', import.meta.url);
self.onmessage = async ({ data: { buf, index, expect, wasm } }) => {
  const post = (type, x = {}) => self.postMessage({ type, ...x });
  try {
    post('progress', { stage: 'Hub fine mesh: loading OpenCascade' });
    const src = await (await fetch(OCCT)).text();
    const factory = (0, eval)(src + '\n;occtimportjs');
    const occt = await factory({
      locateFile: f => new URL('../vendor/occt-import-js/' + f, import.meta.url).href,
      ...(wasm && { instantiateWasm: (imports, ok) => { WebAssembly.instantiate(wasm, imports).then(i => ok(i)); return {}; } }),
    });
    const r = remeshBody(occt, new Uint8Array(buf), index, { expect, progress: stage => post('progress', { stage }) });
    post('done', r);
  } catch (e) { post('error', { message: e?.message || String(e) }); }
};
