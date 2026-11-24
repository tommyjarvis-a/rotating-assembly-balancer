// Axial band for the counterweight generator (0.2.0-alpha.3): [w0, w1] in mm along the spin axis direction,
// measured from the axis point (the same w as the axis frame). Fed to correctionTarget({ constraints: { axialBand } }).
// Modes: 'auto' — the hub's axial extent next to the drive pin (hub vertices within ±AUTO_DEG of the pin angle;
//          the hub's full axial extent without a pin);
//        'face' — a picked planar face (its plane meets the axis at w_face) plus a thickness along the axis
//          (sign = side; the band is [w_face, w_face + t] sorted);
//        'typed' — start and end typed in mm.
export const AUTO_DEG = 30, FACE_TILT_WARN_DEG = 1;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = d => { const n = Math.hypot(...d); return d.map(x => x / n); };
export const wOf = (x, axis) => { const d = unit(axis.d); return dot([x[0] - axis.p[0], x[1] - axis.p[1], x[2] - axis.p[2]], d); };
export function autoBand(pos, axis, fr, pinAng = null, halfDeg = AUTO_DEG) {
  let lo = 1 / 0, hi = -1 / 0, alo = 1 / 0, ahi = -1 / 0, n = 0; const R = fr.R, o = fr.o;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] - o[0], y = pos[i + 1] - o[1], z = pos[i + 2] - o[2], u = R[0] * x + R[1] * y + R[2] * z, v = R[3] * x + R[4] * y + R[5] * z, w = R[6] * x + R[7] * y + R[8] * z;
    if (w < alo) alo = w; if (w > ahi) ahi = w;
    if (pinAng != null) { const a = Math.atan2(v, u) * 180 / Math.PI, d = Math.abs(((a - pinAng) % 360 + 540) % 360 - 180); if (d > halfDeg || Math.hypot(u, v) < 1e-9) continue; }
    if (w < lo) lo = w; if (w > hi) hi = w; n++;
  }
  if (!(ahi > alo)) return { error: 'the hub has no axial extent' };
  if (pinAng == null) return { w: [alo, ahi], how: 'hub full axial extent (no drive pin set)' };
  if (!n || !(hi > lo)) return { w: [alo, ahi], how: `hub full axial extent (no hub geometry within ±${halfDeg}° of the pin)` };
  return { w: [lo, hi], how: `hub axial extent within ±${halfDeg}° of the drive pin` };
}
export function faceBand(face, axis, thick) {
  if (!face || !Array.isArray(face.p) || !Array.isArray(face.d)) return { error: 'pick a planar face first' };
  if (!(Number.isFinite(thick) && thick !== 0)) return { error: 'enter a non-zero thickness (mm; the sign picks the side)' };
  const a = unit(axis.d), n = unit(face.d), c = Math.min(1, Math.abs(dot(a, n))), tilt = Math.acos(c) * 180 / Math.PI;
  if (c < 1e-6) return { error: 'the face is parallel to the spin axis; pick a face square to it' };
  const w = wOf(face.p, axis), b = [w, w + thick].sort((x, y) => x - y);
  return { w: b, how: `face plane at w = ${+w.toFixed(4)} mm, thickness ${thick} mm`, warn: tilt > FACE_TILT_WARN_DEG ? `face is ${tilt.toFixed(2)}° off square to the axis; its centre is used` : '' };
}
export function typedBand(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { error: 'type the band start and end (mm along the axis)' };
  if (a === b) return { error: 'the band start and end must differ' };
  return { w: [Math.min(a, b), Math.max(a, b)], how: 'typed band' };
}
import { cleanBand } from './session-schema.js';
export const BAND_DEFAULT = () => ({ mode: 'auto', face: null, thick: null, start: null, end: null });
export { cleanBand } from './session-schema.js';
export const normalizeBand = j => cleanBand(j).o;
