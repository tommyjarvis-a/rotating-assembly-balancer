// 0.2.0-alpha.2 regression tests for the c8cc29d gate: H4 session schema, M8 picked pin geometry, M9 touching
// containment on a curved boundary, L9 CAD-tolerance floor. (M7, L8, L10, L11 and the CSP: tools/ui-smoke-020a2.cjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanBody, cleanTool } from '../src/session-schema.js';
import { restoreSession, applyCadFloor, CAD_FLOOR, bodyRef } from '../src/bodies.js';
import { restoreBalance } from '../src/balance-session.js';
import { makeTool, valid } from '../src/tools.js';
import { pinFromAxis, movePin } from '../src/statics.js';
import { buildIndex, containment } from '../src/contain.js';

const XSS = '<img src=x onerror="window.__xss=1">';
test('H4: session body fields are schema-checked (rho, src, on, role, mat)', () => {
  assert.deepEqual(cleanBody({ rho: 7850, src: 'user', on: false, role: 'hub', mat: 'steel' }).o, { rho: 7850, src: 'user', on: false, role: 'hub', mat: 'steel' });
  for (const bad of [{ rho: '7850"><img src=x>' }, { rho: -1 }, { rho: 1e9 }, { rho: NaN }, { src: XSS }, { on: 'yes' }, { mat: XSS }, { role: 'x'.repeat(40) }]) {
    const r = cleanBody(bad); assert.equal(r.bad, 1, JSON.stringify(bad)); for (const v of Object.values(r.o)) assert.ok(!/[<>"]/.test(String(v)));
  }
  // through restoreSession: the current body keeps its own rho / src, and the rejection is noted
  const cur = [{ name: 'hub', sign: 1, vol: { m: 100 }, rho: 7850, src: 'default', on: true, pos: [0, 0, 0, 1, 1, 1] }];
  const out = restoreSession({ bodies: [{ ...bodyRef(cur[0], 0), rho: '1"><img src=x onerror=alert(1)>', src: XSS, on: true }] }, cur);
  assert.equal(cur[0].rho, 7850); assert.equal(cur[0].src, 'default'); assert.ok(out.roleNotes.some(n => /2 invalid body fields ignored/.test(n)), out.roleNotes.join());
  assert.equal(restoreBalance({ pin: { src: 'pick', p: [1, 2, 3], d: [0, 0, 1], r: XSS } }, []).bal.pin.r, null);
});
test('H4: session tools are rebuilt from checked fields only (kind, name, role, numbers, free bounds, prism pts)', () => {
  assert.equal(cleanTool({ kind: XSS }).o, null); assert.equal(cleanTool({ kind: '__proto__' }).o, null); assert.equal(cleanTool(null).o, null);
  const f = cleanTool({ kind: 'sector', free: { h: ['1"><img src=x>', 2], a0: [-10, 10], bogus: [0, 1] } });
  assert.deepEqual(f.o.free, { a0: [-10, 10] }); assert.equal(f.bad, 2);
  const p = cleanTool({ kind: 'prism', pts: [['</textarea><img src=x onerror=alert(1)>', 1], [1, 1], [1, 0]] });
  assert.equal(p.o.pts, undefined); assert.equal(p.bad, 1); assert.ok(valid(makeTool('prism', p.o)), 'falls back to the default profile');
  const ok = cleanTool({ kind: 'prism', name: 'p'.repeat(500), role: 'swinglink', sign: -1, h: 4, x: 1, pts: [[0, 0], [5, 0], [5, 5]], sc: 2, rho: 'x' });
  assert.equal(ok.o.name.length, 80); assert.equal(ok.o.role, 'swinglink'); assert.equal(ok.o.sign, -1); assert.deepEqual(ok.o.pts, [[0, 0], [5, 0], [5, 5]]); assert.equal(ok.o.rho, undefined); assert.equal(ok.bad, 1);
  assert.equal(cleanTool({ kind: 'cylinder', role: '<b>' }).o.role, undefined);
  // the malicious fixture: every payload is rejected
  const j = JSON.parse(fs.readFileSync(new URL('./fixtures/malicious-session.json', import.meta.url)));
  const bodies = j.bodies.map(cleanBody), tools = j.tools.map(cleanTool);
  const flat = JSON.stringify([bodies.map(b => b.o), tools.map(t => t.o && { ...t.o, name: undefined })]); // names are free text, escaped where shown
  assert.ok(!/onerror|<img|<\/textarea/.test(flat), flat.slice(0, 300));
  assert.ok(bodies.reduce((a, b) => a + b.bad, 0) >= 3 && tools.reduce((a, t) => a + t.bad, 0) >= 3);
});
test('M8: a picked pin is geometry — e / angle follow the axis; editing the angle keeps e and turns the pin', () => {
  const pin = { src: 'pick', p: [12 * Math.cos(150 * Math.PI / 180), 12 * Math.sin(150 * Math.PI / 180), 5], d: [0, 0, 1], r: 3 };
  const a0 = pinFromAxis(pin, { p: [0, 0, 0], d: [0, 0, 1] }); assert.ok(Math.abs(a0.e - 12) < 1e-9 && Math.abs(a0.ang - 150) < 1e-9);
  const ax = { p: [2, 0, 0], d: [0, 0, 1] }, a1 = pinFromAxis(pin, ax);
  assert.ok(Math.abs(a1.e - 13.7684) < 1e-4 && Math.abs(a1.ang - 154.165) < 1e-3, `${a1.e} ${a1.ang}`);
  const m = movePin(pin, ax, a1.e, 200), a2 = pinFromAxis(m, ax);
  assert.equal(m.src, 'pick'); assert.ok(Math.abs(a2.e - a1.e) < 1e-9 && Math.abs(a2.ang - 200) < 1e-9 && Math.abs(a2.z - a1.z) < 1e-9);
  const tilted = { ...pin, d: [0, 0.02, 1] }, t1 = pinFromAxis(tilted, ax), t2 = pinFromAxis(movePin(tilted, ax, 9, 10), ax);
  assert.ok(Math.abs(t2.e - 9) < 1e-9 && Math.abs(t2.ang - 10) < 1e-9 && Math.abs(t2.tiltDeg - t1.tiltDeg) < 1e-9);
});
// closed cylinder, n facets
function cyl(r, h, n, z0 = 0) { const pos = [], idx = []; for (const z of [z0, z0 + h]) for (let i = 0; i < n; i++) pos.push(r * Math.cos(2 * Math.PI * i / n), r * Math.sin(2 * Math.PI * i / n), z); for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(i, j, j + n, i, j + n, i + n); } const b = pos.length / 3; pos.push(0, 0, z0, 0, 0, z0 + h); for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(b, j, i, b + 1, i + n, j + n); } return { pos, idx }; }
// arc band (annular sector) ri..ro over a0..a1 deg, m segments, z 5..15
function arc(ri, ro, a0, a1, m) { const pos = [], idx = [], A = k => (a0 + (a1 - a0) * k / m) * Math.PI / 180; for (let k = 0; k <= m; k++) for (const [r, z] of [[ri, 5], [ro, 5], [ro, 15], [ri, 15]]) pos.push(r * Math.cos(A(k)), r * Math.sin(A(k)), z); for (let k = 0; k < m; k++) for (let f = 0; f < 4; f++) { const a = 4 * k + f, b = 4 * k + (f + 1) % 4; idx.push(a, b, b + 4, a, b + 4, a + 4); } idx.push(0, 1, 2, 0, 2, 3); const e = 4 * m; idx.push(e, e + 2, e + 1, e, e + 3, e + 2); return { pos, idx }; }
test('M9: a counterweight touching a curved boundary (OD on the faceted bore, or proud by < tol) is inside; clearly proud is outside', () => {
  const n = 64, R = 40, B = cyl(R, 20, n), I = buildIndex(B.pos, B.idx), sag = R * (1 - Math.cos(Math.PI / n)), tol = 2 * sag;
  const on = arc(30, R, 10, 80, 90), r1 = containment(I, on.pos, on.idx, { tol });
  assert.ok(r1.inside && r1.crossings === 0, JSON.stringify({ out: r1.nOut, x: r1.crossings }));
  const proud = arc(30, R + 0.4 * tol, 10, 80, 90), r2 = containment(I, proud.pos, proud.idx, { tol });
  assert.ok(r2.inside, JSON.stringify({ out: r2.nOut, x: r2.crossings }));
  const out = arc(30, R + 0.5, 10, 80, 90), r3 = containment(I, out.pos, out.idx, { tol });
  assert.ok(!r3.inside && r3.nOut > 0);
  // a genuine crossing with both ends inside (concave boundary: U-shaped region) is still caught
  const U = { pos: [], idx: [] }; // two boxes joined: region x∈[0,30], y∈[0,10] minus notch x∈[10,20], y∈[5,10]
  const box = (x0, y0, x1, y1) => { const o = U.pos.length / 3; U.pos.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0, x0, y0, 5, x1, y0, 5, x1, y1, 5, x0, y1, 5); [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7].forEach(v => U.idx.push(o + v)); };
  box(0, 0, 10, 10); box(20, 0, 30, 10); // two separate pillars: a bar from one to the other leaves the region in between
  const bar = { pos: [5, 7, 2, 25, 7, 2, 25, 8, 2, 5, 8, 2, 5, 7, 3, 25, 7, 3, 25, 8, 3, 5, 8, 3], idx: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] };
  const r4 = containment(buildIndex(U.pos, U.idx), bar.pos, bar.idx, { tol: 1e-3 }); assert.ok(r4.nOut === 0 && r4.crossings > 0 && !r4.inside, JSON.stringify(r4.crossings));
});
test('L9: a loose declared modelling uncertainty floors every per-body ± and marks it "≥"', () => {
  const b = [{ unc: { dV: 1e-5, dc: 1e-4 } }, { unc: { dV: 5e-3, dc: 0.05 } }, {}];
  applyCadFloor(b, 0.1);
  assert.ok(Math.abs(b[0].unc.dV - CAD_FLOOR.rel * 0.1) < 1e-15 && Math.abs(b[0].unc.dc - 0.02) < 1e-15 && b[0].unc.low && b[0].unc.cad === 0.1);
  assert.equal(b[1].unc.dV, 5e-3); assert.equal(b[1].unc.dc, 0.05); assert.ok(b[2].unc.low);
  // covers the NX diagnosis case: small body 9.0e-4 relative volume, 15.8 µm CG vs OCP at δ = 0.1 mm
  assert.ok(b[0].unc.dV >= 9.0e-4 && b[0].unc.dc >= 0.0158);
  const c = [{ unc: { dV: 1e-6, dc: 1e-6 } }]; applyCadFloor(c, 0.001); assert.equal(c[0].unc.dV, 1e-6); assert.ok(!c[0].unc.low);
});
