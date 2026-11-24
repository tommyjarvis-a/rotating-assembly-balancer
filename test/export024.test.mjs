// 0.2.0-alpha.4: export of the generated piece (binary / ASCII STL, faceted STEP AP214) and STL import; round trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generate } from '../src/generator.js';
import { autoBand } from '../src/band.js';
import { correctionTarget, pinTyped, orbitU } from '../src/statics.js';
import { meshMoments, KGM3, scale, derive } from '../src/mass.js';
import { frame } from '../src/imbalance.js';
import { toStl, toFacetedStep, safeName } from '../src/mesh-export.js';
import { parseStl, STL_LIMITS } from '../src/stl.js';
import { importStep, planarFaceted } from '../src/import-core.js';
import { toStep } from '../src/step-export.js';
import { makeTool } from '../src/tools.js';
import { unlatin1 } from '../src/step-meta.js';
import { cleanBody } from '../src/session-schema.js';
const occtP = createRequire(import.meta.url)('../vendor/occt-import-js/occt-import-js.js')();

// closed cylinder (axis through c along unit d), n facets, k rings
function cylMesh(c, d, r, h, n = 64, k = 4) {
  const hh = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let u = cr(hh, d); const un = Math.hypot(...u); u = u.map(v => v / un); const v = cr(d, u), pos = [], idx = [];
  const P = (a, z) => [0, 1, 2].map(i => c[i] + r * Math.cos(a) * u[i] + r * Math.sin(a) * v[i] + z * d[i]);
  for (let j = 0; j <= k; j++) for (let i = 0; i < n; i++) pos.push(...P(2 * Math.PI * i / n, -h / 2 + h * j / k));
  for (let j = 0; j < k; j++) for (let i = 0; i < n; i++) { const a = j * n + i, b = j * n + (i + 1) % n; idx.push(a, b, b + n, a, b + n, a + n); }
  const cb = pos.length / 3; pos.push(...[0, 1, 2].map(i => c[i] - h / 2 * d[i])); const ct = cb + 1; pos.push(...[0, 1, 2].map(i => c[i] + h / 2 * d[i]));
  for (let i = 0; i < n; i++) { idx.push(cb, (i + 1) % n, i); idx.push(ct, k * n + i, k * n + (i + 1) % n); }
  return { pos, idx };
}
const STEEL = 7850, Z = { p: [0, 0, 0], d: [0, 0, 1] };
// synthetic rotor: steel hub r 30 × 20 mm offset 2 mm along +Y (heavy at 90°), drive pin at e 6 mm, 90°, 20 g
// orbiting load; Boundary ring r 45 × 40 mm on the axis
function scene(axis = Z) {
  const fr = frame(axis.p, axis.d), W = (u, v, w) => [0, 1, 2].map(k => axis.p[k] + fr.R[k] * u + fr.R[3 + k] * v + fr.R[6 + k] * w);
  const wd = fr.R.slice(6, 9), hub = cylMesh(W(0, 2, 0), wd, 30, 20), boundary = cylMesh(W(0, 0, 0), wd, 45, 40, 96);
  const hubMom = scale(meshMoments(hub.pos, hub.idx), STEEL * KGM3), pin = pinTyped(6, 90), loadU = orbitU(20, pin);
  const band = autoBand(hub.pos, axis, fr, pin.ang);
  const T = correctionTarget({ parts: [hubMom], points: [loadU], axis, planes: [{}], constraints: { axialBand: band.w } });
  return { fr, hub, boundary, hubMom, pin, loadU, band, T };
}

let piece = null;
function gen() { // the synthetic scene's generated counterweight (as the app keeps it: Float64 world mm)
  if (piece) return piece;
  const S = scene(), r = generate({ boundary: S.boundary, hub: S.hub, axis: Z, band: S.band.w, target: S.T.planes[0].U, rho: STEEL, cell: 1, tol: 0.5 });
  const v = meshMoments(r.pos, r.idx); piece = { name: 'Generated CW', pos: r.pos, idx: r.idx, rho: STEEL, v, d: derive(v), m: v.m * STEEL * KGM3, hub: S.hub };
  return piece;
}
const near = (a, b, rel, abs = 0) => Math.abs(a - b) <= Math.max(rel * Math.abs(b), abs);
function same(d, m, g, relV, cgTol) { // volume, mass, CG vs the in-app piece
  assert.ok(near(d.m, g.d.m, relV), `volume ${d.m} vs ${g.d.m}`); assert.ok(near(m, g.m, relV), `mass ${m} vs ${g.m}`);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(d.c[k] - g.d.c[k]) <= cgTol, `CG[${k}] ${d.c[k]} vs ${g.d.c[k]}`);
}

test('faceted STEP AP214 round trip: generated piece → FACETED_BREP / planar FACE_SURFACE → importStep: volume, mass (density), CG match', async () => {
  const g = gen(), { text, skipped } = toFacetedStep([g], { name: 'Generated CW' });
  assert.match(text, /FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN/); assert.match(text, /FACETED_BREP\('Generated_CW'/); assert.match(text, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  assert.ok(!/TESSELLATED|=FACE\(|ADVANCED_FACE/.test(text), 'only FACE_SURFACE faces'); assert.equal((text.match(/FACE_SURFACE\(/g) || []).length + skipped, g.idx.length / 3);
  const r = importStep(await occtP, unlatin1(text), { mode: 'accurate', name: 'Generated_CW.stp' });
  assert.equal(r.stats.plan, 'faceted', 'planar faceted file read in one exact pass'); assert.equal(r.stats.passes.length, 1);
  assert.equal(r.bodies.length, 1); const b = r.bodies[0]; assert.equal(b.unc.dV, 0); assert.equal(b.open, 0); assert.equal(b.name, 'Generated_CW'); assert.equal(b.rho, STEEL, 'density read back');
  same(derive(b.vol), b.vol.m * b.rho * KGM3, g, 1e-6, 1e-4);
});

test('faceted STEP with the hub: two separate bodies (hub, piece) in model coordinates, each matching', async () => {
  const g = gen(), hub = { name: "hub 'A'", pos: Float64Array.from(g.hub.pos), idx: Uint32Array.from(g.hub.idx), rho: 2700 };
  const { text } = toFacetedStep([hub, g], { name: 'hub_and_counterweight' });
  const r = importStep(await occtP, unlatin1(text), { mode: 'accurate' }); assert.equal(r.bodies.length, 2);
  const hv = meshMoments(hub.pos, hub.idx), [bh, bp] = r.bodies;
  assert.equal(bh.name, "hub_'A'"); assert.equal(bh.rho, 2700); assert.ok(near(bh.vol.m, hv.m, 1e-6));
  assert.equal(bp.name, 'Generated_CW'); same(derive(bp.vol), bp.vol.m * bp.rho * KGM3, g, 1e-6, 1e-4);
});

test('STL round trip (binary and ASCII): volume, mass, CG match; welded closed mesh; units', () => {
  const g = gen();
  for (const ascii of [false, true]) {
    const out = toStl(g, { ascii }), buf = typeof out === 'string' ? new TextEncoder().encode(out) : new Uint8Array(out), r = parseStl(buf);
    assert.equal(r.binary, !ascii); assert.equal(r.tris, g.idx.length / 3); assert.equal(r.open, 0); assert.equal(r.nonManifold, 0);
    const v = meshMoments(r.pos, r.idx); same(derive(v), v.m * STEEL * KGM3, g, ascii ? 1e-7 : 2e-5, ascii ? 1e-6 : 2e-4); // binary: float32 coordinates
    if (ascii) assert.match(out, /^solid Generated_CW\n facet normal /);
  }
  const cm = parseStl(new Uint8Array(toStl(g)), { unit: 'cm' }), v = meshMoments(cm.pos, cm.idx);
  assert.ok(near(v.m, g.d.m * 1000, 2e-5)); assert.throws(() => parseStl(new Uint8Array(toStl(g)), { unit: 'furlong' }), /unknown unit/);
});

test('STL import guards: size, triangle count, bad sizes, non-finite or huge coordinates, inside-out and open meshes', () => {
  const g = gen(), bin = new Uint8Array(toStl(g)), nt = g.idx.length / 3;
  assert.throws(() => parseStl(bin, { limits: { ...STL_LIMITS, maxBytes: 1000 } }), /STL limit/);
  assert.throws(() => parseStl(bin, { limits: { ...STL_LIMITS, maxTris: nt - 1 } }), /limit is/);
  assert.throws(() => parseStl(new TextEncoder().encode(toStl(g, { ascii: true })), { limits: { ...STL_LIMITS, maxTris: 10 } }), /more than 10 triangles/);
  assert.throws(() => parseStl(bin.slice(0, bin.length - 7)), /binary size does not match/);
  assert.throws(() => parseStl(new TextEncoder().encode('hello world, not an stl')), /not a valid STL/);
  assert.throws(() => parseStl(new Uint8Array(5)), /too short/);
  const nan = bin.slice(); new DataView(nan.buffer).setFloat32(84 + 12, NaN, true); assert.throws(() => parseStl(nan), /non-finite/);
  assert.throws(() => parseStl(new TextEncoder().encode('solid x\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1e9 0 0\n vertex 0 1 0\n endloop\n endfacet\nendsolid x\n')), /out-of-range/);
  const open = parseStl(new TextEncoder().encode('solid x\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n vertex 0 1 0\n endloop\n endfacet\nendsolid x\n')); assert.equal(open.open, 3);
  // header with 'solid' but binary size: still binary
  const sb = bin.slice(); 'solid trap'.split('').forEach((c, i) => sb[i] = c.charCodeAt(0)); assert.equal(parseStl(sb).binary, true);
  // name sanitised (printable ASCII only)
  const ra = parseStl(new TextEncoder().encode('solid <img src=x>\u00e9\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n vertex 0 1 0\n endloop\n endfacet\nendsolid\n')); assert.equal(ra.name, '<img src=x>');
  assert.equal(safeName('a\u00e9 b\n<c>'), 'a__b_<c>'); assert.equal(safeName(''), 'body');
});

test('session schema: an STL body density source (added material) is allowed, unknown sources still rejected', () => {
  assert.equal(cleanBody({ src: 'added material', rho: 7850 }).o.src, 'added material');
  assert.equal(cleanBody({ src: '<b>x</b>', rho: 7850 }).bad, 1);
});

test('planar-faceted detection: only FACETED_BREP files without curved surfaces take the one-pass exact path', () => {
  assert.equal(planarFaceted(toFacetedStep([gen()]).text), true);
  assert.equal(planarFaceted(toStep([makeTool('cylinder')])), false); assert.equal(planarFaceted(''), false);
});
