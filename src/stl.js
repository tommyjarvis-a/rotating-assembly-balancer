// 0.2.0-alpha.4: STL import (binary and ASCII), run in stl-worker.js (and Node tests). Vertices are welded by exact
// position so a closed STL becomes a closed indexed mesh; orientation is fixed by the sign of the volume.
export const STL_LIMITS = { maxBytes: 256 * 2 ** 20, maxTris: 5e6, maxAbs: 1e7 };
export const STL_UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export function parseStl(buf, { unit = 'mm', limits = STL_LIMITS } = {}) {
  const k = STL_UNITS[unit]; if (!k) throw new Error(`unknown unit ${unit}`);
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), N = u8.byteLength;
  if (N > limits.maxBytes) throw new Error(`file is ${(N / 2 ** 20).toFixed(0)} MB; the STL limit is ${limits.maxBytes / 2 ** 20} MB`);
  if (N < 15) throw new Error('not an STL file (too short)');
  const dv = new DataView(u8.buffer, u8.byteOffset, N), nb = N >= 84 ? dv.getUint32(80, true) : -1;
  const head = String.fromCharCode(...u8.subarray(0, Math.min(N, 512)));
  const asciiLike = /^\s*solid/i.test(head) && /facet\s+normal/i.test(head), binary = nb >= 0 && 84 + 50 * nb === N && !asciiLike;
  const raw = []; let name = '';
  const push = (x, y, z) => { if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || Math.abs(x * k) > limits.maxAbs || Math.abs(y * k) > limits.maxAbs || Math.abs(z * k) > limits.maxAbs) throw new Error('STL has a non-finite or out-of-range coordinate'); raw.push(x * k, y * k, z * k); };
  if (binary) {
    if (nb > limits.maxTris) throw new Error(`${nb} triangles; the limit is ${limits.maxTris}`);
    name = head.slice(0, 80).replace(/\0.*$/s, '').trim();
    for (let t = 0, o = 84; t < nb; t++, o += 50) for (let v = 0; v < 3; v++) push(dv.getFloat32(o + 12 + 12 * v, true), dv.getFloat32(o + 16 + 12 * v, true), dv.getFloat32(o + 20 + 12 * v, true));
  } else if (asciiLike) {
    const text = new TextDecoder('latin1').decode(u8), m0 = /^\s*solid[ \t]*([^\r\n]*)/i.exec(text); name = m0 ? m0[1].trim() : '';
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi; let m;
    while ((m = re.exec(text))) { push(+m[1], +m[2], +m[3]); if (raw.length > 9 * limits.maxTris) throw new Error(`more than ${limits.maxTris} triangles`); }
    if (raw.length % 9) throw new Error('ASCII STL: vertex count is not a multiple of 3');
  } else throw new Error(nb >= 0 && /^\s*solid/i.test(head) ? 'not a valid STL (ASCII header without facets, and the binary size does not match)' : 'not a valid STL (binary size does not match the triangle count)');
  const nt = raw.length / 9; if (!nt) throw new Error('STL has no triangles');
  const map = new Map(), pos = [], idx = new Uint32Array(3 * nt); let deg = 0;
  for (let i = 0; i < 3 * nt; i++) { const x = raw[3 * i], y = raw[3 * i + 1], z = raw[3 * i + 2], key = x + ',' + y + ',' + z; let id = map.get(key); if (id == null) { id = pos.length / 3; pos.push(x, y, z); map.set(key, id); } idx[i] = id; }
  for (let t = 0; t < idx.length; t += 3) if (idx[t] === idx[t + 1] || idx[t + 1] === idx[t + 2] || idx[t] === idx[t + 2]) deg++;
  // edge use: closed (every edge used twice, once each way) or not
  const ec = new Map(); let open = 0, bad = 0;
  for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) { const a = idx[t + e], b = idx[t + (e + 1) % 3]; if (a === b) continue; const key = a < b ? a * 4294967296 + b : b * 4294967296 + a, s = a < b ? 1 : -1, c = ec.get(key) || [0, 0]; c[0]++; c[1] += s; ec.set(key, c); }
  for (const [, c] of ec) { if (c[0] === 1) open++; else if (c[0] !== 2 || c[1] !== 0) bad++; }
  return { name: name.replace(/[^\x20-\x7e]/g, '').slice(0, 80), pos: Float64Array.from(pos), idx, tris: nt, binary, degenerate: deg, open, nonManifold: bad };
}
