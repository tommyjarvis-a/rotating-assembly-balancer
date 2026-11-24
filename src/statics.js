import { frame, imbalance, twoPlane } from './imbalance.js';
import { KGM3, add, scale, zero } from './mass.js';
// Static balance about a spin axis given as a point p and a direction d (0.2.0).
// Angular frame: the axis frame of imbalance.js — u, v ⊥ w = d̂ (right-handed, u × v = w); for the world +Z axis
// u = +X and v = +Y. Angles are in degrees, 0° along +u, 90° along +v, i.e. right-handed about w
// (counter-clockwise when looking at the model from the +w end). An imbalance angle is the heavy spot's
// direction; a counterweight that cancels it sits at that angle + 180°.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Normalize a typed direction once (on commit). Returns { d } or { error }.
export function normalizeDir(d) {
  if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite)) return { error: 'direction must be three numbers' };
  const n = Math.hypot(...d); if (!(n > 1e-12)) return { error: 'direction must be non-zero' };
  return { d: d.map(v => v / n || 0) };
}
// Perpendicular distance from point c to the line through p along d (d need not be unit).
export function lineDistance(c, p, d) {
  const n = Math.hypot(...d), w = d.map(v => v / n), r = sub(c, p), t = dot(r, w);
  return Math.hypot(r[0] - t * w[0], r[1] - t * w[1], r[2] - t * w[2]);
}
export const angleDeg = (x, y) => { if (!(Math.hypot(x, y) > 0)) return 0; const a = Math.atan2(y, x) * 180 / Math.PI; return a < 0 ? a + 360 : a; };
export const wrap180 = a => { let x = ((a + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };
export const polar = (mag, deg) => [mag * Math.cos(deg * Math.PI / 180), mag * Math.sin(deg * Math.PI / 180)];
export const vec = U => ({ U, mag: Math.hypot(...U), ang: angleDeg(U[0], U[1]) });
export function basis(axis) {
  const fr = frame(axis.p, axis.d); return { fr, u: fr.R.slice(0, 3), v: fr.R.slice(3, 6), w: fr.R.slice(6, 9) };
}
// Static imbalance of mass moments (g, g·mm, g·mm²) about the axis: U (g·mm, u/v components), angle,
// CG offset = perpendicular distance from the CG to the axis line (mm). |U| = m · offset.
export function staticOf(mom, axis) {
  const fr = frame(axis.p, axis.d), r = imbalance(mom, fr), c = mom.m ? mom.M1.map(v => v / mom.m) : null;
  return { m: mom.m, c, U: r.U, mag: r.Umag, ang: angleDeg(r.U[0], r.U[1]), offset: c ? lineDistance(c, axis.p, axis.d) : 0, zc: r.zc, C: r.C, fr };
}
export const bodyMoments = b => scale(b.vol, b.sign * b.rho * KGM3);
export const sumMoments = list => list.reduce((a, m) => add(a, m), zero());

// ---------- eccentric drive pin ----------
export const PIN_PARALLEL_DEG = 0.5;
// Pin from a fitted cylinder axis { p, d } (world). A pin more than PIN_PARALLEL_DEG off parallel is warned
// about and projected parallel (its direction replaced by the spin direction through the fitted point).
// e = perpendicular distance between the (parallel) pin axis and the spin axis; ang in the axis frame.
export function pinFromAxis(pin, axis, tolDeg = PIN_PARALLEL_DEG) {
  const n = Math.hypot(...pin.d), m = Math.hypot(...axis.d);
  const c = Math.min(1, Math.abs(dot(pin.d, axis.d)) / (n * m)), tilt = Math.acos(c) * 180 / Math.PI;
  const { fr } = basis(axis), r = sub(pin.p, axis.p), R = fr.R;
  const x = R[0] * r[0] + R[1] * r[1] + R[2] * r[2], y = R[3] * r[0] + R[4] * r[1] + R[5] * r[2], z = R[6] * r[0] + R[7] * r[1] + R[8] * r[2];
  const e = Math.hypot(x, y), out = { e, ang: angleDeg(x, y), z, tiltDeg: tilt, projected: tilt > tolDeg, src: 'pick', p: pin.p.slice(), r: pin.r };
  if (out.projected) out.warn = `pin axis is ${tilt.toFixed(2)}° off parallel to the spin axis (limit ${tolDeg}°); projected parallel through the fitted point`;
  return out;
}
export function pinTyped(e, ang) {
  if (!(Number.isFinite(e) && e >= 0) || !Number.isFinite(ang)) return { error: 'pin e must be ≥ 0 mm and the angle a number' };
  return { e, ang: ((ang % 360) + 360) % 360, src: 'typed', tiltDeg: 0, projected: false };
}
// M8: move a picked pin (geometry { p, d, r }) to orbit radius e and angle ang (deg) about the spin axis, keeping its
// axial position; its direction is turned with it about the axis, so the tilt is kept. Returns a picked pin again.
export function movePin(pin, axis, e, ang) {
  const cur = pinFromAxis(pin, axis), { w } = basis(axis), t = (ang - cur.ang) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const rot = v => { const k = dot(w, v), x = cross(w, v); return [0, 1, 2].map(i => v[i] * c + x[i] * s + w[i] * k * (1 - c)); };
  return { src: 'pick', p: pinPoint({ e, ang }, axis, cur.z), d: rot(pin.d), r: pin.r ?? null };
}
// World point of the pin axis at axial position z (for drawing).
export function pinPoint(pin, axis, z = pin.z ?? 0) {
  const { u, v, w } = basis(axis), [x, y] = polar(pin.e, pin.ang);
  return [0, 1, 2].map(k => axis.p[k] + x * u[k] + y * v[k] + z * w[k]);
}
// Orbiting load: a point mass (g) on the pin axis at radius e → m·e vector (g·mm) in the axis frame.
export const orbitU = (mass, pin) => !pin || !(mass > 0) ? [0, 0] : polar(mass * pin.e, pin.ang);

// ---------- ISO 1940-1 / ISO 21940-11 balance grades ----------
export const GRADES = [0.4, 1, 2.5, 6.3, 16, 40, 100, 250, 630, 1600, 4000];
export const omega = rpm => 2 * Math.PI * rpm / 60;
// G = e·ω in mm/s with e in mm (specific unbalance e = |U| / rotor mass).
export const isoG = (eMm, rpm) => eMm * omega(rpm);
export function nearestGrade(G) {
  if (!(G > 0)) return GRADES[0];
  return GRADES.reduce((b, g) => Math.abs(Math.log(g / G)) < Math.abs(Math.log(b / G)) ? g : b, GRADES[0]);
}
// Finest standard grade the rotor meets (smallest grade ≥ G), or null above G 4000.
export const meetsGrade = G => GRADES.find(g => G <= g * (1 + 1e-9)) ?? null;
// Permissible residual imbalance for grade G (g·mm) for rotor mass M (g) at rpm.
export const permissibleU = (G, M, rpm) => G * M / omega(rpm);
export function isoReadout(Umag, M, rpm) {
  if (!(rpm > 0) || !(M > 0)) return null;
  const e = Umag / M, G = isoG(e, rpm);
  return { rpm, e, G, nearest: nearestGrade(G), meets: meetsGrade(G) };
}

// ---------- check mode (existing counterweight) ----------
export const CHECK = { matched: 0.02, angleDeg: 5 }; // |ratio − 1| below this reads "matched"; perpendicular error flag
// base: hub + orbiting load U (g·mm); cw: existing counterweight U; tol: { kind: 'gmm' | 'G', value }, M rotor mass (g).
export function checkBalance({ base, cw, M, rpm, tol, pinAng = null }) {
  const B = vec(base), C = vec(cw || [0, 0]), R = vec([base[0] + (cw?.[0] || 0), base[1] + (cw?.[1] || 0)]);
  const pct = B.mag > 0 ? 1 - R.mag / B.mag : null;
  const bh = B.mag > 0 ? base.map(x => x / B.mag) : null;
  const ratio = bh ? -(C.U[0] * bh[0] + C.U[1] * bh[1]) / B.mag : null; // projection onto −base, / |base|
  const perp = bh ? (C.U[0] * bh[1] - C.U[1] * bh[0]) / B.mag : null;   // signed, / |base|
  const angErr = bh && C.mag > 0 ? wrap180(C.ang - (B.ang + 180)) : null;
  const iso = isoReadout(R.mag, M, rpm);
  let limit = null;
  if (tol?.kind === 'gmm' && tol.value >= 0) limit = tol.value;
  else if (tol?.kind === 'G' && tol.value > 0 && rpm > 0 && M > 0) limit = permissibleU(tol.value, M, rpm);
  const pass = limit == null ? null : R.mag <= limit * (1 + 1e-12);
  const state = ratio == null ? null : Math.abs(ratio - 1) <= CHECK.matched ? 'matched' : ratio > 1 ? 'over' : 'under';
  return { base: B, cw: C, resid: R, pct, ratio, perp, angErr, angFlag: angErr != null && Math.abs(angErr) > CHECK.angleDeg, state, iso, limit, pass,
    cwRelPin: pinAng != null && C.mag > 0 ? wrap180(C.ang - pinAng) : null };
}

// ---------- solver API (slice 2 generator) ----------
// Correction target: the imbalance the added material must cancel. `parts` are mass moments (hub, existing
// counterweights, …) and `points` are extra U vectors (g·mm, e.g. the orbiting load). `planes` is a list of
// correction planes: one plane → static only (U_corr = −U); two planes { z } (axial positions along w from
// the axis point) → two-plane static + couple (later). `constraints.axialBand` = [start, end] mm along w limits
// where material may be placed (the slab constraint, slice 2). Returns per-plane required correction vectors.
export function correctionTarget({ parts = [], points = [], axis, planes = [{}], constraints = {} }) {
  if (!Array.isArray(planes) || planes.length < 1 || planes.length > 2) throw new Error('planes: one (static) or two (two-plane)');
  const band = constraints.axialBand ?? null;
  if (band && !(Array.isArray(band) && band.length === 2 && band.every(Number.isFinite) && band[0] < band[1])) throw new Error('axialBand must be [start, end] with start < end');
  const s = staticOf(sumMoments(parts), axis), U = points.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], s.U.slice());
  if (planes.length === 1) return { kind: 'static', total: vec(U), planes: [{ ...planes[0], ...vec([-U[0], -U[1]]) }], constraints: { axialBand: band } };
  const z = planes.map(p => p.z); if (!z.every(Number.isFinite) || z[0] === z[1]) throw new Error('two-plane correction needs two distinct plane positions z');
  const t = twoPlane({ U, C: s.C, zc: s.zc }, z[0], z[1]);
  return { kind: 'two-plane', total: vec(U), planes: [{ ...planes[0], ...vec(t.U1.map(v => -v)) }, { ...planes[1], ...vec(t.U2.map(v => -v)) }], constraints: { axialBand: band } };
}
export const inBand = (zAxial, band) => !band || (zAxial >= band[0] && zAxial <= band[1]);
