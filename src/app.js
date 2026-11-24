import { KGM3, add, scale, derive, eig3, zero, assemblyCG } from './mass.js';
import { uniqueNames, bodyRef, restoreSession, exportAssemblyCG, cgKey as sessionKey, holdStale } from './bodies.js';
import { frame, imbalance, twoPlane, axisNames } from './imbalance.js';
import { makeTool, toolMoments, valid, eulerZYX, PARAMS, COMMON_PARAMS } from './tools.js';
import { fitCylinder, fitLoop, faceOf, makeAxis, canon } from './fit.js';
import { optimize } from './optimize.js';
import { toStep } from './step-export.js';
import { createView } from './view.js';
import { ROLES, roleOf, setRole, roleIndex, inResiduals, normalizeRoles } from './roles.js';
import { MATERIALS, CUSTOM, materialId, materialName, applyMaterial, addedMaterial, gcc, validRho } from './materials.js';
import { momentUnc, verdictU, movePin, staticOf, pinFromAxis, pinTyped, pinPoint, orbitU, isoReadout, checkBalance, vec, basis, bodyMoments, sumMoments, correctionTarget } from './statics.js';
import { faceTris, fitCylinderTris, fitPlane } from './fit.js';
import { BALANCE_DEFAULT, exportBalance, restoreBalance } from './balance-session.js';
import { cleanTool } from './session-schema.js';
import { autoBand, faceBand, typedBand } from './band.js';
import { defaultCell } from './generator.js';
import { containTol } from './contain.js';
import { meshMoments } from './mass.js';
import { GEN_SESSION_MAX, packGenerated, unpackGenerated, genDefaultTol } from './gen-session.js';

const VERSION = '0.2.0-alpha.4', $ = s => document.querySelector(s);
// Without WebGL (blocked, no GPU and no software fallback) everything but the 3-D view still works.
let view; try { view = createView($('#view')); } catch (e) {
  view = new Proxy({}, { get: () => () => null }); queueMicrotask(() => card('err', `<b>3-D view unavailable</b>: WebGL could not start (${esc(e.message)}). Mass properties, balancing and export still work; enable hardware acceleration in the browser settings for the view.`));
}
const st = { bodies: [], tools: [], last: null, undo: null, sel: -1, sels: [], axis: { p: [0, 0, 0], d: [0, 0, 1], src: 'Z' }, pick: null, cg: null, bal: BALANCE_DEFAULT(), check: null, gen: null };
const fmt = (v, d = 3) => Math.abs(v) >= 1e5 || (v && Math.abs(v) < 1e-3) ? v.toExponential(d - 1) : (+v.toFixed(d)).toString();
const status = s => $('#status').textContent = s;

// ---------- STEP import: one module worker per file (occt-import-js WASM, meshing, mass properties) ----------
const WASM_URL = new URL('../vendor/occt-import-js/occt-import-js.wasm', import.meta.url), TIMEOUT_S = +new URLSearchParams(location.search).get('timeout') || 180; // ?timeout=s for testing
let wasmP, job = null;
const compileWasm = () => wasmP ??= (WebAssembly.compileStreaming ? WebAssembly.compileStreaming(fetch(WASM_URL)) : fetch(WASM_URL).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b)))
  .catch(e => { wasmP = null; throw e; });
function card(kind, html) { const el = $('#cards'), d = document.createElement('div'); d.className = 'card ' + kind; d.innerHTML = html + ' <button class="x" title="Dismiss">✕</button>'; d.querySelector('.x').onclick = () => d.remove(); el.append(d); }
function runImport(f, buf) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./import-worker.js', import.meta.url), { type: 'module' }), t0 = performance.now();
    let stage = 'Starting', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearInterval(tick); w.terminate(); job = null; $('#job').hidden = true; fn(v); };
    const tick = setInterval(() => {
      const s = (performance.now() - t0) / 1000;
      $('#jobmsg').textContent = `${f.name}: ${stage}… ${s.toFixed(0)} s`;
      if (s > TIMEOUT_S) finish(reject, new Error(`timed out after ${TIMEOUT_S} s (${stage}). Try "fast" mass props, or export fewer/simpler bodies.`));
    }, 250);
    job = { cancel: () => finish(reject, Object.assign(new Error('cancelled'), { cancelled: true })) };
    $('#job').hidden = false; $('#jobmsg').textContent = `${f.name}: starting…`;
    w.onmessage = ({ data: d }) => {
      if (d.type === 'progress') stage = d.stage;
      else if (d.type === 'done') finish(resolve, d);
      else if (d.type === 'error') finish(reject, new Error(d.message));
    };
    w.onerror = e => { e.preventDefault?.(); finish(reject, new Error(e.message || 'import worker failed (out of memory?)')); };
    compileWasm().then(wasm => w.postMessage({ buf, name: f.name, mode: $('#quality').value, defRho: +$('#defrho').value, wasm }, [buf]),
      e => finish(reject, new Error('could not load OpenCascade WASM: ' + e.message)));
  });
}

let busy = false;
async function loadFiles(files) {
  if (busy) return status('An import is already running — cancel it first');
  busy = true;
  let loadedSession = false;
  try {
    for (const f of files) {
      if (/\.json$/i.test(f.name)) { loadSession(JSON.parse(await f.text())); loadedSession = true; continue; }
      let r;
      try { r = await runImport(f, await f.arrayBuffer()); }
      catch (e) { if (e.cancelled) { status(`${f.name}: import cancelled`); break; } card('err', `<b>Could not import ${esc(f.name)}</b>: ${esc(e.message)}`); status(`${f.name}: import failed`); continue; }
      for (const b of r.bodies) { b.role = ''; b.mat = materialId(b.rho); }
      const g = st.bodies.findIndex(b => b.generated), gb = g >= 0 ? st.bodies.splice(g, 1)[0] : null; // the generated piece stays last
      uniqueNames(r.bodies, st.bodies); st.bodies.push(...r.bodies); if (gb) st.bodies.push(gb);
      for (const w of r.warn) card('warn', `${esc(f.name)}: ${esc(w)}`);
      for (const w of r.info) card('info quiet', `${esc(f.name)}: ${esc(w)}`);
      const nrem = r.bodies.filter(b => b.sign < 0).length, s = r.stats;
      status(`${f.name}: ${r.bodies.length} bodies · ${s.mode} · ${(s.tris / 1e3).toFixed(0)}k triangles · ${(s.ms / 1000).toFixed(1)} s` + (nrem ? ` (${nrem} REMOVE_ solid${nrem > 1 ? 's' : ''} counted as material removal, negative mass)` : ''));
    }
  } finally { busy = false; }
  // A session restore already set selection and CG; do not clear them (and do not re-fit, which would jump the camera).
  if (!loadedSession) { st.sel = -1; st.sels = []; }
  view.setBodies(st.bodies); view.setRoles(viewRoles()); if (!loadedSession) view.fit(); renderBodies(); renderAxis(); renderBalanceInputs(); update();
  if (loadedSession) { view.select(st.sels); renderCG(); }
}

// ---------- state → numbers ----------
const bodyMom = b => scale(b.vol, b.sign * b.rho * KGM3), bmass = b => b.sign * b.vol.m * b.rho * KGM3;
const baseMom = () => st.bodies.filter(inResiduals).reduce((a, b) => add(a, bodyMom(b)), zero()); // 0.2.0: Boundary / Ignore bodies are not material
const toolsMom = () => st.tools.filter(valid).reduce((a, t) => add(a, toolMoments(t)), zero());
// Spin axis: one object { p: point, d: unit direction, src } set by the presets (X/Y/Z through the point,
// a body's principal axis through its CoM), typed point + direction, or 3-D picking. The u/v/w basis is
// derived from it deterministically (imbalance.js frame); axial positions are measured along w from p.
const PRESET = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
function principal(i) {
  const d = derive(bodyMom(st.bodies[i])), e = eig3(d.I), g = e.val;
  const k = [0, 1, 2].reduce((best, i) => { const s = Math.min(...[0, 1, 2].filter(j => j !== i).map(j => Math.abs(g[i] - g[j]))); return s > best[1] ? [i, s] : best; }, [0, -1])[0];
  return { p: d.c, d: canon(e.vec[k]) };
}
const axisFrame = () => frame(st.axis.p, st.axis.d);
const num = v => +(+v).toPrecision(10);
function setAxis(a, src, msg = '', fill = true) {
  st.axis = { p: a.p.map(num), d: a.d.map(num), src }; st.pick = null; view.setPicks([]); pickUI();
  // presets, picks and session restore fill the boxes; typed input must not (M2: rewriting the
  // direction on every field change normalises a partially-entered vector and the next component is applied to that).
  if (fill) { ['#ox', '#oy', '#oz'].forEach((s, k) => $(s).value = st.axis.p[k]); ['#dx', '#dy', '#dz'].forEach((s, k) => $(s).value = st.axis.d[k]); }
  $('#axis').value = [...$('#axis').options].some(o => o.value === src) ? src : 'C';
  axmsg(msg); update();
}
const axmsg = (m, bad) => { $('#axmsg').textContent = m; $('#axmsg').className = 'hint' + (bad ? ' bad' : ''); };
const readComp = el => { if (el.validity.badInput || !String(el.value).trim()) return NaN; const v = Number(el.value); return Number.isFinite(v) ? v : NaN; };
function typedAxis() {
  const a = makeAxis(['#ox', '#oy', '#oz'].map(s => readComp($(s))), ['#dx', '#dy', '#dz'].map(s => readComp($(s))));
  if (a.error) return axmsg(a.error, true); // keep the last valid axis; do not rewrite the boxes
  const src = Object.keys(PRESET).find(k => PRESET[k].every((v, i) => v === a.d[i])) || 'C';
  setAxis(a, src, src === 'C' ? 'custom axis' : '', false);
}
function span(fr) {
  let lo = 1 / 0, hi = -1 / 0;
  for (const b of st.bodies) if (b.on) for (let i = 0; i < b.pos.length; i += 3) {
    const z = fr.R[6] * (b.pos[i] - fr.o[0]) + fr.R[7] * (b.pos[i + 1] - fr.o[1]) + fr.R[8] * (b.pos[i + 2] - fr.o[2]); if (z < lo) lo = z; if (z > hi) hi = z;
  }
  return lo <= hi ? [lo, hi] : [0, 50];
}

function update() {
  if (st.axis.src[0] === 'P' && st.bodies[+st.axis.src.slice(1)]) { const a = principal(+st.axis.src.slice(1)); st.axis.p = a.p; st.axis.d = a.d; }
  const fr = axisFrame(), base = baseMom(), tot = add(base, toolsMom()), r0 = imbalance(base, fr), r1 = imbalance(tot, fr), sp = span(fr);
  const an = axisNames(fr), vec = a => `(${a.map(v => fmt(v, 3)).join(', ')})`;
  const tp = r1.m ? twoPlane(r1, sp[0], sp[1]) : null, good = v => Math.abs(v) < 0.5 ? 'ok' : '';
  const row = (l, a, b, u, cls = '') => `<span>${l}</span><b class="${cls}">${a}</b><b class="${cls}">${b}</b><span>${u}</span>`;
  $('#resid').innerHTML = `<span></span><b>parts</b><b>+ tools</b><span></span>` +
    row(`Static U<sub>${an.n[0]}</sub>`, fmt(r0.U[0]), `<i class="${good(r1.U[0])}">${fmt(r1.U[0])}</i>`, 'g·mm', 'big') + row(`Static U<sub>${an.n[1]}</sub>`, fmt(r0.U[1]), `<i class="${good(r1.U[1])}">${fmt(r1.U[1])}</i>`, 'g·mm', 'big') +
    row('|U|', fmt(r0.Umag), fmt(r1.Umag), 'g·mm') + row('e = |U|/m', fmt(r0.e * 1000), fmt(r1.e * 1000), 'µm') +
    row(`Couple C<sub>${an.n[0]}</sub>`, fmt(r0.C[0]), fmt(r1.C[0]), 'g·mm²') + row(`Couple C<sub>${an.n[1]}</sub>`, fmt(r0.C[1]), fmt(r1.C[1]), 'g·mm²') + row('|C|', fmt(r0.Cmag), fmt(r1.Cmag), 'g·mm²') +
    row('Mass', fmt(r0.m), fmt(r1.m), 'g') +
    (tp ? row(`Plane A ${an.n[0] === 'u' ? 'w' : 'z'}=${fmt(sp[0], 1)}`, '', fmt(Math.hypot(...tp.U1)), 'g·mm') + row(`Plane B ${an.n[0] === 'u' ? 'w' : 'z'}=${fmt(sp[1], 1)}`, '', fmt(Math.hypot(...tp.U2)), 'g·mm') : '');
  if (an.n[0] === 'u') $('#resid').innerHTML += `<span class="note">u/v/w in world: u ${vec(an.u)} · v ${vec(an.v)} · w (axis) ${vec(an.w)}</span>`;
  view.setTools(st.tools.filter(valid));
  const com = tot.m ? tot.M1.map(v => v / tot.m) : [0, 0, 0];
  view.setMarks(r1, fr, com, sp);
  $('#dhat').textContent = `û (${st.axis.d.map(v => fmt(v, 5)).join(', ')})`;
  touchCG(); renderBalance(fr, sp);
  return { fr, base, r0, r1, sp };
}

// ---------- UI ----------
const srcText = b => `${b.sign < 0 ? 'removal (−m) · ' : ''}${esc(b.src)}${b.material ? ' · ' + esc(b.material) : ''} · V ${fmt(b.vol.m)} mm³${b.unc ? ` · ${b.unc.low ? '≥' : b.unc.rough ? '~' : ''}±${fmt(b.unc.dc * 1000, 2)} µm CoM` : ''}${b.mesh?.coarsened ? ' · coarsened mesh' : ''}`;
const viewRoles = () => st.bodies.map(b => b.generated && roleOf(b) === 'cw' ? 'gen' : roleOf(b));
const roleBadge = b => { const r = ROLES.find(x => x.id === roleOf(b)); return r?.short ? ` <span class="rb ${r.id}" title="${r.title}">${r.short}</span>` : ''; };
const roleSel = (b, i) => `<select data-role="${i}" title="Balance role">${ROLES.map(r => `<option value="${r.id}" ${roleOf(b) === r.id ? 'selected' : ''} title="${r.title}">${r.label}</option>`).join('')}</select>`;
const matSel = (b, i) => { const id = b.mat ?? materialId(b.rho); return `<select data-mat="${i}" title="Material preset (sets the density)">${MATERIALS.map(m => `<option value="${m.id}" ${id === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}<option value="${CUSTOM}" ${id === CUSTOM ? 'selected' : ''}>Custom${id === CUSTOM ? ' ' + +gcc(b.rho).toPrecision(5) : ''}</option></select>`; };
function renderBodies() {
  $('#bodies tbody').innerHTML = st.bodies.map((b, i) => `<tr data-row="${i}" class="${st.sels.includes(i) ? 'sel' : ''}${roleOf(b) ? ' role-' + roleOf(b) : ''}"><td><input type="checkbox" data-on="${i}" ${b.on ? 'checked' : ''}></td>
    <td>${esc(b.name)}${b.unreliable ? ` <span class="bad" title="${b.open} open/non-manifold edges (${pct(b.frac)} of edges), volume closure error ${fmt(b.eps, 2)}: mesh not closed, mass properties unreliable">⚠</span>` : b.open ? ` <span class="note" title="${b.open} open/non-manifold edges (${pct(b.frac)} of edges) but the mesh closes (volume closure error ${fmt(b.eps, 2)} ≤ 1e-4): mass properties OK">ⓘ</span>` : ''}${roleBadge(b)}<div class="src" data-src="${i}">${srcText(b)}</div></td>
    <td class="rm">${roleSel(b, i)}${matSel(b, i)}</td><td><input type="number" step="any" data-rho="${i}" value="${esc(b.rho)}"></td><td data-mass="${i}">${roleOf(b) === 'boundary' ? '<span class="hint" title="Boundary: a region, not material">region</span>' : fmt(bmass(b))}</td></tr>`).join('');
  view.setRoles(viewRoles()); renderNX();
}
function renderAxis() {
  $('#axis').innerHTML = ['X', 'Y', 'Z'].map(a => `<option>${a}</option>`).join('') + st.bodies.map((b, i) => `<option value="P${i}">${esc(b.name)} principal axis</option>`).join('') + '<option value="C">custom (point + direction)</option>';
  $('#axis').value = [...$('#axis').options].some(o => o.value === st.axis.src) ? st.axis.src : 'C';
}
// ---------- selection (list ⇄ 3-D view) and axis picking ----------
function select(i, from, ev) {
  if (i < 0) { st.sel = -1; st.sels = []; }
  else if (ev && ev.shiftKey && st.sel >= 0) {
    const a = Math.min(st.sel, i), b = Math.max(st.sel, i); st.sels = []; for (let k = a; k <= b; k++) st.sels.push(k); st.sel = i;
  } else if (ev && (ev.ctrlKey || ev.metaKey)) {
    const ix = st.sels.indexOf(i); if (ix >= 0) st.sels.splice(ix, 1); else st.sels.push(i);
    st.sel = st.sels.includes(i) ? i : (st.sels.at(-1) ?? -1);
  } else { st.sel = i; st.sels = [i]; }
  view.select(st.sels);
  document.querySelectorAll('#bodies tr[data-row]').forEach(r => r.classList.toggle('sel', st.sels.includes(+r.dataset.row)));
  if (i >= 0 && from === 'view') { document.querySelector(`#bodies tr[data-row="${i}"]`)?.scrollIntoView({ block: 'nearest' }); status(`Selected ${st.bodies[i].name}`); }
  touchCG();
}
const PICK = { band: 'click a planar face square to the axis for the band start', cyl: 'click a cylindrical face', loop: 'click a face next to a circular edge (hole, boss, end face)', pts: 'click the first point', pt: 'click a spot on the model for the axis point', nrm: 'click a planar face for the axis direction', pin: 'click the drive pin\'s cylindrical face' };
function pickUI() { document.querySelectorAll('[data-pick]').forEach(b => b.classList.toggle('on', b.dataset.pick === st.pick?.mode)); view.cursor(st.pick ? 'crosshair' : ''); }
function startPick(mode) { st.pick = st.pick?.mode === mode ? null : { mode, pts: [] }; view.setPicks([]); pickUI(); axmsg(st.pick ? `Pick: ${PICK[mode]} (Esc cancels)` : ''); }
function onPick(hit) {
  const pk = st.pick; if (!hit) return axmsg(`Pick: nothing under the pointer — ${PICK[pk.mode]}`, true);
  const b = st.bodies[hit.body];
  if (pk.mode === 'pts') {
    pk.pts.push(hit.point); view.setPicks(pk.pts);
    if (pk.pts.length < 2) return axmsg('Pick: click the second point');
    const a = makeAxis(pk.pts[0], pk.pts[1].map((v, k) => v - pk.pts[0][k]));
    if (a.error) { pk.pts = []; view.setPicks([]); return axmsg(a.error + ' — click the first point again', true); }
    a.d = canon(a.d); return setAxis(a, 'C', 'axis through 2 picked points');
  }
  if (pk.mode === 'pt') return setAxis({ p: hit.point, d: st.axis.d }, 'C', `axis point picked on ${b.name}; direction kept`);
  if (pk.mode === 'band') {
    const ft = faceTris(b, hit.tri), r = fitPlane(b.pos, b.idx, ft.tris); st.pick = null; pickUI();
    if (r.error) return bandmsg(r.error, true);
    st.bal.band.face = { p: r.p, d: r.d }; st.bal.band.mode = 'face'; axmsg(''); bandmsg(`band face: planar face of ${b.name} (${ft.how})`); return update();
  }
  if (pk.mode === 'nrm' || pk.mode === 'pin' || pk.mode === 'cyl') {
    const ft = faceTris(b, hit.tri);
    if (pk.mode === 'nrm') { const r = fitPlane(b.pos, b.idx, ft.tris); if (r.error) return axmsg(r.error, true); return setAxis({ p: st.axis.p, d: canon(r.d) }, 'C', `normal of a planar face of ${b.name} (${ft.how}); point kept`); }
    const r = fitCylinderTris(b.pos, b.idx, ft.tris);
    if (pk.mode === 'pin') { st.pick = null; pickUI(); if (r.error) return pinmsg(r.error + ` (${ft.how})`, true); setPin({ src: 'pick', p: r.p, d: r.d, r: r.r }, `pin cylinder of ${b.name} (${ft.how}): r = ${fmt(r.r, 4)} mm, fit RMS ${fmt(100 * r.rms, 2)} % of r`); return; }
    if (r.error) return axmsg(r.error + (ft.how === 'mesh region' ? ' (no B-rep face ids; fitted a mesh region)' : ''), true);
    const t = hit.point.reduce((a, v, k) => a + (v - r.p[k]) * r.d[k], 0), p = r.p.map((v, k) => v + t * r.d[k]);
    return setAxis({ p, d: r.d }, 'C', `cylinder of ${b.name}: r = ${fmt(r.r, 4)} mm, fit RMS ${fmt(100 * r.rms, 2)} % of r${ft.how === 'mesh region' ? ' (mesh-region fit: no B-rep face ids)' : ''}`);
  }
  const f = faceOf(b.faces || [], hit.tri); if (!f) return axmsg('no B-rep face data for this body', true);
  const r = (pk.mode === 'cyl' ? fitCylinder : fitLoop)(b.pos, b.idx, f[0], f[1], hit.point);
  if (r.error) return axmsg(r.error, true);
  // cylinder: the axis point is the foot of the picked point on the fitted axis
  const t = pk.mode === 'cyl' ? hit.point.reduce((a, v, k) => a + (v - r.p[k]) * r.d[k], 0) : 0, p = r.p.map((v, k) => v + t * r.d[k]);
  setAxis({ p, d: r.d }, 'C', `${pk.mode === 'cyl' ? 'cylinder' : 'circular edge'} of ${b.name}: r = ${fmt(r.r, 4)} mm, fit RMS ${fmt(100 * r.rms, 2)} % of r`);
}
view.onClick((hit, e) => st.pick ? onPick(hit) : select(hit ? hit.body : -1, 'view', e));
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (st.pick) { st.pick = null; view.setPicks([]); pickUI(); axmsg('Pick cancelled'); } else select(-1); });
const LABEL = { h: 'h', x: 'x', y: 'y', z: 'z', rx: 'rx°', ry: 'ry°', rz: 'rz°', rho: 'ρ', r: 'r', ri: 'ri', ro: 'ro', a0: 'a0°', sweep: 'sw°', sc: 'scale' };
function renderTools() {
  $('#tools').innerHTML = st.tools.map((t, i) => `<div class="tool" data-i="${i}">
    <div class="row"><input data-k="name" value="${esc(t.name)}" size="10"> <b>${esc(t.kind)}</b>
      <select data-k="role"><option ${t.role === 'counterweight' ? 'selected' : ''}>counterweight</option><option ${t.role === 'swinglink' ? 'selected' : ''}>swinglink</option></select>
      <select data-k="sign"><option value="1" ${t.sign > 0 ? 'selected' : ''}>add</option><option value="-1" ${t.sign < 0 ? 'selected' : ''}>remove</option></select>
      <button data-del="${i}" title="Remove tool">✕</button>${valid(t) ? '' : ' <span class="bad">invalid</span>'}</div>
    <div class="grid">${[...PARAMS[t.kind], ...COMMON_PARAMS].map(k => `<label class="${t.free?.[k] ? 'f' : ''}"><span>${LABEL[k]}</span><input type="number" step="any" data-k="${k}" value="${+(+t[k]).toPrecision(8)}">
      <input type="checkbox" title="free for optimiser" data-free="${k}" ${t.free?.[k] ? 'checked' : ''}>${t.free?.[k] ? `<span class="free"><input type="number" step="any" data-lo="${k}" value="${esc(t.free[k][0])}"><input type="number" step="any" data-hi="${k}" value="${esc(t.free[k][1])}"></span>` : ''}</label>`).join('')}</div>
    ${t.kind === 'prism' ? `<textarea data-k="pts" title="x,y; x,y; … (mm, local)">${esc(t.pts.map(p => p.join(',')).join('; '))}</textarea>` : ''}
    <div class="src">mass ${valid(t) ? fmt(toolMoments(t).m) : '—'} g</div></div>`).join('');
}
const pct = f => (100 * f).toPrecision(2) + ' %';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const defBounds = (k, v) => /^(a0|rx|ry|rz)$/.test(k) ? [-180, 180] : k === 'sweep' ? [5, 360] : [Math.max(/^(x|y|z)$/.test(k) ? -1e9 : 0, +(v - Math.max(Math.abs(v), 10)).toFixed(3)), +(v + Math.max(Math.abs(v), 10)).toFixed(3)];

$('#panel').addEventListener('input', e => {
  const el = e.target, card = el.closest('.tool');
  if (el.dataset.rho) { const b = st.bodies[+el.dataset.rho]; b.rho = +el.value; b.src = 'user'; b.mat = materialId(b.rho); const ms = $(`[data-mat="${el.dataset.rho}"]`); if (ms) ms.outerHTML = matSel(b, +el.dataset.rho); $(`[data-mass="${el.dataset.rho}"]`).textContent = fmt(bmass(b)); $(`[data-src="${el.dataset.rho}"]`).innerHTML = srcText(b); if (roleOf(b) === 'hub') renderBalanceInputs(); renderNX(); return update(); }
  if (!card) return;
  const t = st.tools[+card.dataset.i], k = el.dataset.k;
  if (k === 'pts') { const p = el.value.split(';').map(s => s.split(',').map(Number)).filter(p => p.length === 2 && p.every(isFinite)); if (p.length >= 3) t.pts = p; }
  else if (k === 'name' || k === 'role') t[k] = el.value; else if (k) t[k] = +el.value;
  if (el.dataset.lo) t.free[el.dataset.lo][0] = +el.value; if (el.dataset.hi) t.free[el.dataset.hi][1] = +el.value;
  card.querySelector('.src').textContent = `mass ${valid(t) ? fmt(toolMoments(t).m) : '—'} g`; update();
});
$('#panel').addEventListener('change', e => {
  const el = e.target, card = el.closest('.tool');
  if (el.dataset.on) { const i = +el.dataset.on; st.bodies[i].on = el.checked; view.showBody(i, el.checked); return update(); }
  if (el.id === 'axis') { const v = el.value; if (PRESET[v]) setAxis({ p: st.axis.p, d: PRESET[v] }, v); else if (v[0] === 'P') setAxis(principal(+v.slice(1)), v); else axmsg('custom axis: type the point and direction, or pick it in the 3-D view'); return; }
  if (/^[od][xyz]$/.test(el.id)) return typedAxis();
  if (el.id === 'defrho') { st.bodies.forEach(b => { if (b.src === 'default') { b.rho = +el.value; b.mat = materialId(b.rho); } }); renderBodies(); return update(); }
  if (el.dataset.role != null) { const i = +el.dataset.role, cleared = setRole(st.bodies, i, el.value); if (cleared.length) status(`${ROLES.find(r => r.id === el.value).label} moved to ${st.bodies[i].name} (cleared from ${cleared.map(j => st.bodies[j].name).join(', ')})`); st.check = null; view.setOutside(null); renderBodies(); renderBalanceInputs(); return update(); }
  if (el.dataset.mat != null) { const i = +el.dataset.mat, b = st.bodies[i]; if (el.value === CUSTOM) { b.mat = CUSTOM; b.src = 'user'; status(`${b.name}: custom density — type it in ρ (kg/m³)`); } else applyMaterial(b, el.value); renderBodies(); renderBalanceInputs(); return update(); }
  if (el.id === 'added') { st.bal.added = el.value === CUSTOM ? { mode: CUSTOM, rho: validRho(+$('#addedrho').value) ? +$('#addedrho').value : null } : { mode: el.value, rho: null }; renderBalanceInputs(); return update(); }
  if (el.id === 'addedrho') { st.bal.added = { mode: CUSTOM, rho: validRho(+el.value) ? +el.value : null }; return update(); }
  if (el.id === 'pine' || el.id === 'pinang') {
    const cur = pinNow(); const e = $('#pine').value.trim() === '' ? cur?.e ?? NaN : +$('#pine').value, a = $('#pinang').value.trim() === '' ? cur?.ang ?? 0 : +$('#pinang').value; const t = pinTyped(e, a); if (t.error) return pinmsg(t.error, true);
    // M8: a picked pin stays geometry — moved to the typed e / angle about the spin axis (unchanged values keep the current e / angle)
    if (st.bal.pin?.src === 'pick') { const ue = Math.abs(e - cur.e) < 1e-9 * Math.max(1, cur.e) ? cur.e : e, ua = Math.abs(a - cur.ang) < 1e-9 ? cur.ang : a; setPin(movePin(st.bal.pin, st.axis, ue, ua), 'picked pin moved about the spin axis'); return; }
    setPin(t, 'typed pin e / angle'); return;
  }
  if (el.id === 'load') { const v = el.value; st.bal.load = v === 'none' ? { kind: 'none', body: -1, mass: null } : v === 'mass' ? { kind: 'mass', body: -1, mass: +$('#loadmass').value > 0 ? +$('#loadmass').value : null } : { kind: 'body', body: +v.slice(1), mass: null }; renderBalanceInputs(); return update(); }
  if (el.id === 'loadmass') { st.bal.load = { kind: 'mass', body: -1, mass: +el.value > 0 ? +el.value : null }; return update(); }
  if (el.id === 'rpm') { st.bal.rpm = +el.value > 0 ? +el.value : null; return update(); }
  if (el.id === 'bandmode') { st.bal.band.mode = el.value; return update(); }
  if (el.id === 'bandt') { st.bal.band.thick = el.value.trim() === '' ? null : +el.value; return update(); }
  if (el.id === 'band0' || el.id === 'band1') { st.bal.band[el.id === 'band0' ? 'start' : 'end'] = el.value.trim() === '' ? null : +el.value; return update(); }
  if (el.id === 'gencell' || el.id === 'gentol') { st.bal.gen[el.id === 'gencell' ? 'cell' : 'tol'] = +el.value > 0 ? +el.value : null; return update(); }
  if (el.id === 'tolv' || el.id === 'tolk') { st.bal.tol = { kind: $('#tolk').value, value: $('#tolv').value.trim() === '' ? null : +$('#tolv').value }; return update(); }
  if (card && el.dataset.free) { const t = st.tools[+card.dataset.i], k = el.dataset.free; t.free ??= {}; if (el.checked) t.free[k] = defBounds(k, t[k]); else delete t.free[k]; renderTools(); }
  if (card && (el.dataset.k === 'sign' || el.dataset.k === 'role')) { renderTools(); update(); }
});
$('#panel').addEventListener('focusout', e => { if (/^[od][xyz]$/.test(e.target.id)) typedAxis(); });
$('#panel').addEventListener('keydown', e => { if (e.key === 'Enter' && /^[od][xyz]$/.test(e.target.id)) typedAxis(); });
$('#panel').addEventListener('click', e => {
  const el = e.target, row = el.closest('#bodies tr[data-row]');
  if (row && !el.closest('input')) {
    const i = +row.dataset.row, mod = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!mod && i === st.sel && st.sels.length === 1) select(-1, 'list', e); else select(i, 'list', e);
  }
  if (el.dataset.pick) startPick(el.dataset.pick);
  if (el.dataset.add) {
    // new tools sit on the spin axis (local z = w) at an end of the span; a cylinder 30 mm off-axis along u
    const { fr, sp } = update(), z = st.tools.length % 2 ? sp[0] - 5 : sp[1], k = el.dataset.add === 'cylinder' ? 30 : 0, R = fr.R;
    const pos = [0, 1, 2].map(i => num(fr.o[i] + k * R[i] + z * R[6 + i])), ang = eulerZYX([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
    const t = makeTool(el.dataset.add, { x: pos[0], y: pos[1], z: pos[2], ...Object.fromEntries(Object.entries(ang).map(([a, v]) => [a, num(v)])) }), c = (v, w) => [num(v - w), num(v + w)];
    t.free = el.dataset.add === 'sector' ? { a0: [-180, 180], sweep: [5, 180], h: [0.2, 20] } : el.dataset.add === 'cylinder' ? { x: c(t.x, 60), y: c(t.y, 60) } : { rz: [-180, 180], h: [0.2, 20] };
    if (el.dataset.add === 'cylinder') t.r = 5;
    st.tools.push(t); renderTools(); update(); if (!st.bodies.length) view.fit();
  }
  if (el.dataset.del) { st.tools.splice(+el.dataset.del, 1); renderTools(); update(); }
  if (el.dataset.exp) exportAs(el.dataset.exp);
  if (el.id === 'undo' && st.undo) { st.tools = st.undo; st.undo = null; el.disabled = true; renderTools(); update(); $('#optout').textContent = 'Reverted.'; }
  if (el.id === 'run') runOpt();
  if (el.id === 'calcg') calcCG();
  if (el.id === 'cancel') job?.cancel();
  if (el.id === 'ccancel') cjob?.cancel();
  if (el.id === 'contain') runContain();
  if (el.id === 'gen') runGen();
  if (el.id === 'gcancel') gjob?.cancel();
  if (el.id === 'genremove') removeGenerated();
  if (el.id === 'copytable') copyNX();
  if (el.id === 'pinclear') { st.bal.pin = null; st.pinNote = ''; pinmsg(''); renderBalanceInputs(); update(); }
  if (el.id === 'ptcg') { const r = assemblyCG(st.bodies, st.sels); if (r.error) axmsg(r.error === 'none' ? 'select one or more bodies first, then snap the point to their CG' : 'net mass of the selection is not positive', true); else setAxis({ p: r.c, d: st.axis.d }, 'C', `axis point = CG of ${r.n} selected bod${r.n === 1 ? 'y' : 'ies'}; direction kept`); }
});

function runOpt() {
  const { fr, base, sp } = update();
  const free = st.tools.flatMap(t => Object.entries(t.free || {}).map(([key, [lo, hi]]) => ({ id: t.id, key, lo, hi, name: t.name, from: t[key] })));
  if (!free.length) return $('#optout').innerHTML = '<p class="bad">Free at least one tool value (tick its ☐).</p>';
  if (free.some(p => !(p.hi > p.lo))) return $('#optout').innerHTML = '<p class="bad">Each free value needs hi &gt; lo.</p>';
  const L = +$('#lref').value || Math.max(sp[1] - sp[0], 1), t0 = performance.now();
  const res = optimize(base, st.tools, free, fr, { L, w: +$('#wc').value, lam: +$('#lam').value });
  if (!res.after.r) return $('#optout').innerHTML = '<p class="bad">No valid solution inside the bounds.</p>';
  st.undo = st.tools; st.tools = res.tools; $('#undo').disabled = false;
  const dm = res.after.dm, b = res.before.r, a = res.after.r;
  st.last = { L, w: +$('#wc').value, lam: +$('#lam').value, evals: res.evals, ms: performance.now() - t0, params: res.params.map(({ name, key, lo, hi, from, value }) => ({ tool: name, param: key, lo, hi, from, value })),
    before: b && { U: b.U, C: b.C }, after: { U: a.U, C: a.C }, addedMass: dm };
  $('#optout').innerHTML = `<table><tr><th>Tool.param</th><th>from</th><th>→ suggested</th></tr>${st.last.params.map(p => `<tr><td>${esc(p.tool)}.${p.param}</td><td>${fmt(p.from)}</td><td><b>${fmt(p.value, 4)}</b></td></tr>`).join('')}</table>
    <p>|U| ${b ? fmt(b.Umag) : '—'} → <b>${fmt(a.Umag)}</b> g·mm · |C| ${b ? fmt(b.Cmag) : '—'} → <b>${fmt(a.Cmag)}</b> g·mm² · tools mass ${fmt(dm)} g · ${res.evals} evals, ${fmt(st.last.ms, 0)} ms</p>`;
  renderTools(); update();
}


// ---------- assembly CG (mass-weighted CoM of the current list/view selection) ----------
// Stale handling: the result and marker stay visible after a calculation; if the selection, a density,
// or the body set then changes, the readout and marker are marked stale until Calculate CG is clicked again.
// Loading a session never clears stale (H2); only a successful Calculate CG does. A restored CG is
// current only if the saved CG was not stale and every saved body matches exactly with the same body
// count (H3; a missing stale flag is treated as stale). Otherwise the numbers are kept but marked
// stale, or dropped, and a notice is shown.
const cgKey = () => sessionKey(st.sels, st.bodies);
function touchCG() {
  if (!st.cg || st.cg.error) return;
  const next = holdStale(st.cg, cgKey());
  if (next.stale !== !!st.cg.stale) { st.cg = next; renderCG(); }
}
function calcCG() {
  const r = assemblyCG(st.bodies, st.sels);
  st.cg = r.error ? r : { ...r, key: cgKey(), stale: false, dropped: false, notice: '' };
  renderCG();
}
function renderCG() {
  const el = $('#cgout'), r = st.cg;
  if (r?.dropped) {
    el.className = 'hint stale'; el.innerHTML = `<span class="tag">stale</span> Saved assembly CG was not restored${r.notice ? ' (' + esc(r.notice) + ')' : ''}. Click Calculate CG to compute it for the current selection.`;
    view.setAssemblyCG(null); return;
  }
  if (!r || r.error === 'none') {
    el.className = 'hint'; el.textContent = r?.error === 'none' ? 'No bodies selected — select one or more in the list or the 3-D view, then Calculate CG.' : 'Select one or more bodies (Ctrl-click or Shift-click to add), then Calculate CG.';
    view.setAssemblyCG(null); return;
  }
  if (r.error) {
    el.className = 'hint bad'; el.textContent = r.error === 'negative' ? 'Net mass is negative — cannot compute a centre of gravity.' : 'Net mass is zero — cannot compute a centre of gravity.';
    view.setAssemblyCG(null); return;
  }
  el.className = 'cgout' + (r.stale ? ' stale' : '');
  el.innerHTML = `${r.stale ? '<span class="tag">stale</span> ' : ''}<b>Assembly CG</b> · <span id="cgn">${r.n}</span> bod${r.n === 1 ? 'y' : 'ies'} · <span id="cgm">${fmt(r.m)}</span> g
    <div class="xyz"><span>X</span><b id="cgx">${fmt(r.c[0])}</b><span>mm</span><span>Y</span><b id="cgy">${fmt(r.c[1])}</b><span>mm</span><span>Z</span><b id="cgz">${fmt(r.c[2])}</b><span>mm</span></div>
    <div class="src">from WCS origin (0, 0, 0)${r.stale ? ' — selection, density or bodies changed; click Calculate CG to refresh' : ''}${r.notice ? ' — ' + esc(r.notice) : ''}</div>`;
  view.setAssemblyCG(r.c, r.stale);
}


// ---------- 0.2.0: hub static balance, drive pin, orbiting load, check mode ----------
const pinmsg = (m, bad) => { $('#pinmsg').textContent = m; $('#pinmsg').className = 'hint' + (bad ? ' bad' : ''); };
// The pin in the current axis frame: a picked pin keeps its world axis, so e / angle follow axis edits.
const pinNow = () => { const p = st.bal.pin; if (!p) return null; return p.src === 'pick' ? { ...pinFromAxis({ p: p.p, d: p.d, r: p.r }, st.axis), d: p.d } : p; };
function setPin(pin, msg) { st.pinNote = msg; st.bal.pin = pin; renderBalanceInputs(); update(); }
// M8: pin boxes and message are refreshed on every update, so a picked pin's e / angle follow axis changes
function renderPin() {
  const pin = pinNow(), act = document.activeElement?.id;
  if (act !== 'pine') $('#pine').value = pin ? +pin.e.toPrecision(8) : ''; if (act !== 'pinang') $('#pinang').value = pin ? +pin.ang.toPrecision(8) : '';
  if (!pin) { if ($('#pinmsg').className === 'hint') $('#pinmsg').textContent = ''; return; }
  pinmsg(`${st.pinNote || (pin.src === 'pick' ? 'picked pin' : 'typed pin')} → e ${fmt(pin.e, 4)} mm, ∠ ${fmt(pin.ang, 2)}°${pin.src === 'pick' ? ' (picked geometry; follows the spin axis)' : ''}${pin.warn ? ' — ⚠ ' + pin.warn : ''}`, !!pin.warn);
}
// M7: an orbiting-load body that became Hub or Boundary (or is gone) is cleared, so the maths matches the selector
const loadOK = L => L.kind !== 'body' || (st.bodies[L.body] && roleOf(st.bodies[L.body]) !== 'hub' && roleOf(st.bodies[L.body]) !== 'boundary');
function checkLoad() { if (loadOK(st.bal.load)) return false; const b = st.bodies[st.bal.load.body]; st.bal.load = { kind: 'none', body: -1, mass: null }; status(`Orbiting load cleared${b ? ` (${b.name} is now ${ROLES.find(r => r.id === roleOf(b)).label})` : ''}`); return true; }
function renderBalanceInputs() {
  checkLoad();
  const hi = roleIndex(st.bodies), hub = st.bodies[hi.hub], a = st.bal.added;
  $('#added').innerHTML = `<option value="hub">Same as hub${hub ? ' (' + esc(materialName(hub.mat ?? materialId(hub.rho), hub.rho)) + ')' : ''}</option>` + MATERIALS.map(m => `<option value="${m.id}">${m.name}</option>`).join('') + `<option value="${CUSTOM}">Custom…</option>`;
  $('#added').value = a.mode; $('#addedrho').hidden = a.mode !== CUSTOM; if (a.mode === CUSTOM && a.rho) $('#addedrho').value = a.rho;
  const am = addedMaterial(a, hub); $('#addedinfo').textContent = am ? `${fmt(gcc(am.rho), 4)} g/cc · added by the generator` : a.mode === 'hub' ? 'set a Hub first' : 'type a density';
  const L = st.bal.load;
  $('#load').innerHTML = '<option value="none">none</option><option value="mass">typed mass (g)</option>' + st.bodies.map((b, i) => roleOf(b) === 'hub' || roleOf(b) === 'boundary' || b.generated ? '' : `<option value="b${i}">${esc(b.name)}${roleOf(b) ? ' [' + ROLES.find(r => r.id === roleOf(b)).label + ']' : ''}</option>`).join('');
  $('#load').value = L.kind === 'body' ? 'b' + L.body : L.kind; if (!$('#load').value) { $('#load').value = 'none'; }
  $('#loadmass').hidden = L.kind !== 'mass'; if (L.kind === 'mass' && L.mass) $('#loadmass').value = L.mass;
  if (st.bal.rpm) $('#rpm').value = st.bal.rpm; $('#tolk').value = st.bal.tol?.kind || 'gmm'; if (st.bal.tol?.value != null) $('#tolv').value = st.bal.tol.value;
}
const ang = a => { if (a == null) return '—'; const x = +(+a).toFixed(2); return (x >= 360 ? 0 : x).toFixed(2) + '°'; };
const isoTxt = iso => iso ? `G ${fmt(iso.G, 3)} mm/s (e ${fmt(iso.e * 1000, 3)} µm) · nearest G${iso.nearest} · meets ${iso.meets ? 'G' + iso.meets : '— (above G4000)'}` : '<span class="hint">enter RPM for the ISO 1940 grade</span>';
function balanceState() {
  const hi = roleIndex(st.bodies), hub = st.bodies[hi.hub];
  if (!hub) return { hi };
  const ax = st.axis, hubMom = bodyMoments(hub), H = staticOf(hubMom, ax), pin = pinNow(), L = st.bal.load;
  const lb = L.kind === 'body' && loadOK(L) ? st.bodies[L.body] : null, lm = L.kind === 'mass' ? L.mass : lb ? bmass(lb) : null;
  const loadU = pin && lm > 0 ? orbitU(lm, pin) : [0, 0], base = [H.U[0] + loadU[0], H.U[1] + loadU[1]];
  const cws = hi.cw.filter(i => st.bodies[i].on), cwMom = sumMoments(cws.map(i => bodyMoments(st.bodies[i]))), cwS = cws.length ? staticOf(cwMom, ax) : null;
  const M = hubMom.m + (cws.length ? cwMom.m : 0);
  const band = bandNow(hub, pin), target = correctionTarget({ parts: [hubMom], points: [loadU], axis: ax, planes: [{}], constraints: { axialBand: band.w || null } });
  // M10: input uncertainty (g·mm) of hub + load and of the counterweights, from each body's mass-property ±
  const uB = b => momentUnc(bmass(b), staticOf(bodyMoments(b), ax).mag, b.unc);
  const uHub = uB(hub), uLoad = lb && pin ? Math.abs(lm) * pin.e * (lb.unc?.dV || 0) : 0, uCw = cws.reduce((a, i) => a + uB(st.bodies[i]), 0);
  const unc = { hub: uHub, load: uLoad, base: uHub + uLoad, cw: uCw, total: uHub + uLoad + uCw };
  const check = cws.length ? checkBalance({ base, cw: cwS.U, M, rpm: st.bal.rpm, tol: st.bal.tol, pinAng: pin ? pin.ang : null, unc: unc.total }) : null;
  return { hi, hub, H, pin, lm, lb, loadU, base: vec(base), target, band, cws, cwS, check, M, unc, isoBase: isoReadout(Math.hypot(...base), hubMom.m, st.bal.rpm) };
}
function renderBalance(fr, sp) {
  renderPin();
  const out = $('#statout'), chk = $('#checkout'), S = balanceState(), b = basis(st.axis);
  const pin = S.pin, sp2 = sp || [0, 50], z0 = Math.min(sp2[0], pin?.z ?? 0), z1 = Math.max(sp2[1], pin?.z ?? 0); view.setPin(pin ? pinPoint(pin, st.axis, z0) : null, pin ? pinPoint(pin, st.axis, z1) : null);
  renderGen(S, sp);
  if (!S.hub) { out.innerHTML = '<p class="hint">Set one body\'s role to <b>Hub</b> for the static readout (and one to Boundary for the generator).</p>'; chk.innerHTML = ''; return; }
  const row = (l, U, a, d = '') => `<tr><td>${l}</td><td><b>${U}</b></td><td>${a}</td><td class="hint">${d}</td></tr>`;
  const ref = `Angles: 0° = +u (world ${b.u.map(v => fmt(v, 4)).join(', ')}), 90° = +v (${b.v.map(v => fmt(v, 4)).join(', ')}), right-handed about the axis direction w (counter-clockwise seen from the +w end). An imbalance angle is the heavy spot; the counterweight goes at +180°.`;
  out.innerHTML = `<table><tr><th></th><th>|U| g·mm</th><th>∠</th><th></th></tr>
    ${row(`Hub <i>${esc(S.hub.name)}</i>`, fmt(S.H.mag, 5), ang(S.H.ang), `m ${fmt(S.H.m, 5)} g · CG offset <b id="cgoff">${fmt(S.H.offset, 5)}</b> mm`)}
    ${row('Orbiting load', S.lm > 0 && S.pin ? fmt(Math.hypot(...S.loadU), 5) : '—', S.lm > 0 && S.pin ? ang(S.pin.ang) : '—', S.lm > 0 ? `${fmt(S.lm, 5)} g${S.lb ? ' (' + esc(S.lb.name) + ')' : ''} at e ${S.pin ? fmt(S.pin.e, 4) + ' mm' : '? (set the pin)'}` : 'none')}
    ${row('Hub + load', fmt(S.base.mag, 5), ang(S.base.ang), 'imbalance to cancel')}
    ${row('<b>Needed counterweight</b>', fmt(S.target.planes[0].mag, 5), ang(S.target.planes[0].ang), 'm·r of the added material')}
    </table><div class="iso">ISO 1940 (hub + load, rotor mass ${fmt(S.H.m, 5)} g): ${isoTxt(S.isoBase)}</div>
    <div class="ref" id="angref">${ref}</div>${S.pin?.warn ? `<div class="flag">⚠ ${esc(S.pin.warn)}</div>` : ''}`;
  if (!S.check) { chk.innerHTML = S.hi.cw.length ? '' : '<p class="hint">Check mode: set existing counterweight bodies to <b>Counterweight (existing)</b>.</p>'; return; }
  const c = S.check, pct = c.pct == null ? '—' : (100 * c.pct).toFixed(2) + ' %';
  const ou = c.state ? `<span class="ou ${c.state}" id="ouflag">${c.state === 'over' ? 'OVER-balanced' : c.state === 'under' ? 'UNDER-balanced' : 'matched'} ×${fmt(c.ratio, 4)}</span>` : '—';
  const cOut = containFail(S.cws);
  const verdict = c.verdict == null ? (st.bal.tol?.kind === 'G' && st.bal.tol.value > 0 && !(st.bal.rpm > 0) ? '<span class="hint" id="needrpm">enter an RPM to grade against G' + esc(st.bal.tol.value) + '</span>' : '<span class="hint">set a tolerance (g·mm or G grade)</span>')
    : verdictHtml(cOut ? 'fail' : c.verdict, c.resid.mag, c.unc, c.limit, 'verdict', cOut) + (st.bal.tol.kind === 'G' ? ` <span class="hint">(G${esc(st.bal.tol.value)} at ${esc(st.bal.rpm)} rpm, M ${fmt(S.M, 5)} g)</span>` : '');
  chk.innerHTML = `<h3 class="hint">Check mode — ${S.cws.length} existing counterweight bod${S.cws.length === 1 ? 'y' : 'ies'}</h3><table>
    ${row('Hub + load', fmt(c.base.mag, 5), ang(c.base.ang))}
    ${row('Counterweight', fmt(c.cw.mag, 5), ang(c.cw.ang), `m ${fmt(S.cwS.m, 5)} g${c.cwRelPin != null ? ` · ${fmt(c.cwRelPin, 2)}° from the pin` : ''}`)}
    ${row('<b>Residual</b>', `<span id="resid0">${fmt(c.resid.mag, 5)}</span> <span id="residu">± ${fmt(c.unc, 3)}</span>`, ang(c.resid.ang), `corrected <b id="pctcorr">${pct}</b> · ± = input uncertainty (hub ${fmt(S.unc.hub, 3)}, load ${fmt(S.unc.load, 3)}, counterweights ${fmt(S.unc.cw, 3)} g·mm)`)}
    </table>
    <div>Balance: ${ou} <span class="hint">(projection of the counterweight on −(hub+load) ÷ |hub+load|; &gt;1 over, &lt;1 under)</span></div>
    <div>Angle error ${c.angErr == null ? '—' : `<span class="${c.angFlag ? 'flag' : ''}" id="angerr">${fmt(c.angErr, 3)}°</span>`} · perpendicular ${c.perp == null ? '—' : fmt(100 * c.perp, 3) + ' % of |hub+load|'}${c.angFlag ? ' <span class="flag">⚠ large angle (perpendicular) error</span>' : ''}</div>
    <div>ISO 1940 residual (rotor = hub + counterweight, ${fmt(S.M, 5)} g): ${isoTxt(c.iso)}</div>
    <div>${verdict}</div><div id="containres">${renderContain()}</div>`;
}
// M10: one verdict rendering for check mode and the generator. v: 'pass' | 'fail' | 'unresolved'.
function verdictHtml(v, R, U, limit, id, contain = '') {
  const ru = `residual ${fmt(R, 5)} ± ${fmt(U, 3)} g·mm`;
  if (v === 'unresolved') return `<span class="verdict unres" id="${id}">CAN'T RESOLVE</span> Can't resolve: ${ru} exceeds tolerance resolution (tol ${fmt(limit, 4)} g·mm). Use a finer mesh (accurate mass props, a CAD file with a tighter modelling tolerance) or a looser tolerance (≥ ${fmt(R + U, 4)} g·mm).`;
  const why = contain ? ` — <span class="flag">${esc(contain)}</span>` : v === 'pass' ? ` (|R| + U ≤ ${fmt(limit, 4)})` : ` (|R| − U > ${fmt(limit, 4)})`;
  return `<span class="verdict ${v === 'pass' ? 'pass' : 'fail'}" id="${id}">${v === 'pass' ? 'PASS' : 'FAIL'}</span> ${ru}${why}`;
}
// M11: a current containment result with a body outside blocks PASS (check mode and the generated piece).
function containFail(idxs) {
  const c = st.check; if (!c || c.key !== checkKey()) return genContainFail(idxs);
  const bad = c.results.filter(r => idxs.includes(r.i) && !r.inside); return bad.length ? `containment: ${bad.map(r => r.name).join(', ')} outside the Boundary` : genContainFail(idxs);
}
// the generated piece's own (measured) containment also blocks a check-mode PASS
function genContainFail(idxs) {
  const gi = st.bodies.findIndex(b => b.generated); if (gi < 0 || !idxs.includes(gi) || !st.gen) return '';
  const v = st.gen.verify, c = v ? (v.pending ? null : v.contained) : st.gen.meta?.contained;
  return c === false ? `containment: ${st.bodies[gi].name} outside the Boundary` : '';
}
// containment (worker, Cancel)
let cjob = null;
const checkKey = () => { const hi = roleIndex(st.bodies); return [hi.boundary, ...hi.cw].map(i => i < 0 ? '-' : `${i}:${st.bodies[i].name}:${st.bodies[i].pos.length}`).join(','); };
function renderContain() {
  const c = st.check; if (!c) return '';
  if (c.key !== checkKey()) return '<span class="hint">containment result is stale (roles changed) — run Check containment again</span>';
  return c.results.map(r => `<div>${r.inside ? '<span class="verdict pass">inside</span>' : '<span class="verdict fail">outside</span>'} <b>${esc(r.name)}</b>: ${r.nOut} of ${r.n} vertices outside (${(100 * r.frac).toFixed(2)} %)${r.crossings ? ` · ${r.crossings} edges cross the boundary surface` : ''}${r.crossSkipped ? ' · edge-crossing check skipped (too large)' : ''}${r.hubOverlap?.nIn ? ` · <span class="flag">${r.hubOverlap.nIn} vertices inside the hub</span>` : ''}</div>`).join('') + `<div class="hint">tolerance ${fmt(c.tol, 3)} mm (touching counts as inside); outside vertices are marked red in the view</div>`;
}
function runContain() {
  const hi = roleIndex(st.bodies), msg = (m, bad) => { $('#containmsg').textContent = m; $('#containmsg').className = 'hint' + (bad ? ' bad' : ''); };
  if (hi.boundary < 0) return msg('set one body as Boundary first', true);
  if (!hi.cw.length) return msg('set one or more bodies as Counterweight (existing) first', true);
  if (cjob) return msg('a check is already running', true);
  const B = st.bodies[hi.boundary], H = st.bodies[hi.hub], defl = [B, ...hi.cw.map(i => st.bodies[i])].map(b => b.mesh?.deflection || 0);
  const diag = Math.hypot(...[0, 1, 2].map(k => { let lo = 1 / 0, hi2 = -1 / 0; for (let i = k; i < B.pos.length; i += 3) { lo = Math.min(lo, B.pos[i]); hi2 = Math.max(hi2, B.pos[i]); } return hi2 - lo; }));
  const tol = containTol(diag, defl), key = checkKey();
  const w = new Worker(new URL('./check-worker.js', import.meta.url), { type: 'module' }), t0 = performance.now(); let stage = 'Starting', done = false;
  const finish = () => { if (done) return; done = true; clearInterval(tick); w.terminate(); cjob = null; $('#cjob').hidden = true; };
  const tick = setInterval(() => { $('#cjobmsg').textContent = `Containment: ${stage}… ${((performance.now() - t0) / 1000).toFixed(0)} s`; }, 250);
  cjob = { cancel: () => { finish(); msg('containment check cancelled'); } }; $('#cjob').hidden = false; msg('');
  w.onmessage = ({ data: d }) => {
    if (d.type === 'progress') stage = d.stage;
    else if (d.type === 'error') { finish(); msg('containment check failed: ' + d.message, true); }
    else if (d.type === 'done') {
      finish(); st.check = { key, tol, results: d.results, ms: performance.now() - t0 };
      const flat = []; for (const r of d.results) for (const x of r.outPts) flat.push(x);
      view.setOutside(flat); msg(`checked in ${((performance.now() - t0) / 1000).toFixed(1)} s`); update();
    }
  };
  w.onerror = e => { e.preventDefault?.(); finish(); msg('containment worker failed: ' + (e.message || 'out of memory?'), true); };
  const copy = b => ({ pos: Float64Array.from(b.pos), idx: Uint32Array.from(b.idx) });
  w.postMessage({ boundary: copy(B), hub: H ? copy(H) : null, bodies: hi.cw.map(i => ({ i, name: st.bodies[i].name, ...copy(st.bodies[i]) })), tol });
}
// ---------- 0.2.0-alpha.3: axial band + counterweight generator (worker, Cancel) ----------
const bandmsg = (m, bad) => { $('#bandmsg').textContent = m; $('#bandmsg').className = 'hint' + (bad ? ' bad' : ''); };
function bandNow(hub, pin) {
  const B = st.bal.band;
  if (B.mode === 'face') return faceBand(B.face, st.axis, B.thick);
  if (B.mode === 'typed') return typedBand(B.start, B.end);
  return hub ? autoBand(hub.pos, st.axis, axisFrame(), pin ? pin.ang : null) : { error: 'set a Hub first' };
}
const bbDiag = b => { const lo = [1 / 0, 1 / 0, 1 / 0], hi = [-1 / 0, -1 / 0, -1 / 0]; for (let i = 0; i < b.pos.length; i++) { const k = i % 3; if (b.pos[i] < lo[k]) lo[k] = b.pos[i]; if (b.pos[i] > hi[k]) hi[k] = b.pos[i]; } return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]); };
const radialMax = b => { const fr = axisFrame(), R = fr.R, o = fr.o; let r = 0; for (let i = 0; i < b.pos.length; i += 3) { const x = b.pos[i] - o[0], y = b.pos[i + 1] - o[1], z = b.pos[i + 2] - o[2]; r = Math.max(r, Math.hypot(R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z)); } return r; };
const genBody = () => st.bodies.find(b => b.generated) || null;
const r6 = v => +(+v).toPrecision(9);
// Everything the generated piece depends on; a different key marks the piece stale (regenerate).
function genKey(S = balanceState()) {
  const hi = S.hi, H = st.bodies[hi.hub], Bd = st.bodies[hi.boundary], am = addedMaterial(st.bal.added, H);
  if (!H || !Bd) return '';
  return JSON.stringify([H.name, H.pos.length, H.rho, Bd.name, Bd.pos.length, st.axis.p.map(r6), st.axis.d.map(r6), S.band?.w?.map(r6), S.target?.planes[0].U.map(r6), am?.rho, st.bal.gen.cell, genTol(S).tol]);
}
function genTol(S) { return st.bal.gen.tol > 0 ? { tol: st.bal.gen.tol, how: 'typed' } : genDefaultTol(st.bal.tol, st.bal.rpm, S.H?.m, S.target?.planes[0].mag || 0); }
function renderGen(S, sp) {
  const hi = S.hi, Bd = st.bodies[hi.boundary], B = st.bal.band;
  $('#bandmode').value = B.mode; $('#bandface').hidden = B.mode !== 'face'; $('#bandtyped').hidden = B.mode !== 'typed';
  if (document.activeElement?.id !== 'bandt') $('#bandt').value = B.thick ?? ''; if (document.activeElement?.id !== 'band0') $('#band0').value = B.start ?? ''; if (document.activeElement?.id !== 'band1') $('#band1').value = B.end ?? '';
  if (document.activeElement?.id !== 'gencell') $('#gencell').value = st.bal.gen.cell ?? ''; if (document.activeElement?.id !== 'gentol') $('#gentol').value = st.bal.gen.tol ?? '';
  const band = S.band || bandNow(null, null);
  if (band.error) { bandmsg(band.error, B.mode !== 'auto' || !!S.hub); view.setBand(null); }
  else {
    bandmsg(`band w ${fmt(band.w[0], 5)} … ${fmt(band.w[1], 5)} mm (${fmt(band.w[1] - band.w[0], 5)} mm thick) · ${band.how}${band.warn ? ' — ⚠ ' + band.warn : ''}`, !!band.warn);
    const ref = Bd || S.hub; view.setBand(ref ? axisFrame() : null, band.w[0], band.w[1], ref ? radialMax(ref) * 1.03 : 0);
  }
  const T = S.target?.planes[0];
  $('#gendef').textContent = S.hub && Bd ? `default cell ${fmt(defaultCell(bbDiag(Bd)), 3)} mm · leftover tolerance ${fmt(genTol(S).tol, 4)} g·mm (${genTol(S).how})${T ? ` · needed ${fmt(T.mag, 5)} g·mm at ${ang(T.ang)}` : ''}${S.unc && genTol(S).tol < S.unc.base ? ` · ⚠ the tolerance is below the input uncertainty ± ${fmt(S.unc.base, 3)} g·mm (hub + load): the verdict will be "can't resolve" — loosen it or use a finer mesh` : ''}` : 'set one Hub and one Boundary to generate';
  const g = genBody(); $('#genremove').hidden = !g;
  const el = $('#genout'); if (!g && !st.gen?.needsRegenerate) { el.innerHTML = ''; return; }
  if (!g) { el.innerHTML = `<p class="flag">⚠ ${esc(st.gen.note || 'regenerate the counterweight')}</p>`; return; }
  const r = st.gen?.meta || {}, v = st.gen?.verify || null, mom = bodyMoments(g), Sg = staticOf(mom, st.axis), pin = S.pin, d = derive(g.vol);
  // M10 / L13: leftover ± input uncertainty and the tolerance from the CURRENT inputs (never the stored summary)
  const left = S.target ? vec([S.base.U[0] + Sg.U[0], S.base.U[1] + Sg.U[1]]) : null, tol = genTol(S).tol, U = S.unc ? S.unc.base + momentUnc(mom.m, Sg.mag, g.unc) : 0;
  const rel = pin ? ((Sg.ang - pin.ang) % 360 + 360) % 360 : null, stale = st.gen?.key && st.gen.key !== genKey(S);
  // M11 / L14: containment and hub contact are part of the verdict; on a restored piece they are re-measured (verify)
  const ctn = v ? (v.pending ? null : v.contained) : r.contained ?? null, nOut = v && !v.pending ? v.nOut : r.outsideBoundary, nCross = v && !v.pending ? v.crossings : r.crossBoundary;
  const maxOut = v && !v.pending ? v.maxOut : r.maxOut, cTol = v && !v.pending ? v.tol : r.checkTol, hubN = v && !v.pending ? v.hubVertices : r.hubVertices, hubMin = v && !v.pending ? v.hubMin : r.hubGap;
  const touch = hubN > 0, why = ctn === false ? `outside the Boundary (${nOut} vertices outside, ${nCross ?? '?'} edges cross; max protrusion ${fmt(maxOut || 0, 3)} mm)` : !touch && ctn != null ? 'does not touch the hub' : '';
  const vd = left ? verdictU(left.mag, U, tol) : null, verdictTxt = !left ? '' : ctn == null ? '<span class="hint" id="genverdict" data-v="pending">verifying containment…</span>' : verdictHtml(why ? 'fail' : vd, left.mag, U, tol, 'genverdict', why);
  const cline = ctn == null ? '<span class="hint">containment: verifying…</span>' : ctn ? `<span class="verdict pass" id="gencontain">inside</span> the Boundary (Check-containment test, tol ${fmt(cTol, 3)} mm: ${esc(nOut)} vertices outside, ${esc(nCross ?? 0)} edges cross; measured max protrusion ${fmt(maxOut || 0, 3)} mm)`
    : `<span class="verdict fail" id="gencontain">outside</span> <span class="flag">the Boundary: ${esc(nOut)} vertices outside, ${esc(nCross ?? '?')} edges cross, measured max protrusion ${fmt(maxOut || 0, 3)} mm (tol ${fmt(cTol, 3)} mm) — marked red in the view</span>`;
  const hline = hubN == null ? '' : touch ? `touches the hub (${esc(hubN)} vertices within ${fmt((v && !v.pending ? v.contactTol : r.contactTol) || 0, 3)} mm of the hub mesh; closest ${fmt(hubMin || 0, 3)} mm)` : `<span class="flag">does not touch the hub: closest ${hubMin == null ? '> 2 cells' : fmt(hubMin, 3) + ' mm'}</span>`;
  el.innerHTML = `${stale ? '<p class="flag" id="genstale">⚠ inputs changed since generation (hub, boundary, axis, band, load, material, cell or tolerance) — regenerate</p>' : ''}
    <table><tr><td>Piece <i>${esc(g.name)}</i></td><td>mass <b id="genmass">${fmt(mom.m, 5)}</b> g</td><td>volume ${fmt(d.m, 6)} mm³</td></tr>
    <tr><td>CG (world)</td><td colspan="2">${d.c.map(v => fmt(v, 5)).join(', ')} mm · offset ${fmt(Sg.offset, 5)} mm</td></tr>
    <tr><td>m·r</td><td>${fmt(Sg.mag, 5)} g·mm at ${ang(Sg.ang)}</td><td>${rel != null ? `<b id="genrel">${fmt(rel, 2)}°</b> from the pin` : 'no pin'}</td></tr>
    <tr><td>Leftover (hub + load + piece)</td><td><span id="genleft">${left ? fmt(left.mag, 5) : '—'}</span> <span id="genleftu">± ${fmt(U, 3)}</span> g·mm${left ? ' at ' + ang(left.ang) : ''}</td><td>tol ${fmt(tol, 4)} g·mm</td></tr></table>
    <div>${verdictTxt}</div>
    <div>${cline}</div>
    <div class="hint">± = input uncertainty: hub ${fmt(S.unc?.hub || 0, 3)} + load ${fmt(S.unc?.load || 0, 3)} g·mm from the bodies' mass-property ± (the piece's own mesh is exact).</div>
    <div class="hint">${r.cells ? `${esc(r.cells)} cells of ${fmt(r.cell, 3)} × ${fmt(r.cell, 3)} × ${fmt(r.cellW, 3)} mm · ${esc(r.iterations)} mesh iteration${r.iterations === 1 ? '' : 's'} · ${esc(r.tris)} triangles · ${esc(r.components)} piece${r.components === 1 ? '' : 's'}${r.open ? `, ${esc(r.open)} open edges` : ', closed'} · ` : 'restored from the session (containment and hub contact re-measured) · '}${hline}${r.cells ? ` · inside hub ${esc(r.insideHub)}, outside band ${esc(r.outsideBand)} · ${esc(r.inset || 0)} vertices inset by ${fmt(r.margin || 0, 3)} mm, ${esc(r.split || 0)} edges split · ${fmt(r.ms / 1000, 3)} s` : ''}${r.notes?.length ? ' · ' + esc(r.notes.join('; ')) : ''}</div>
    <div class="hint">The piece is a Counterweight in check mode above and a row in the body table. No export yet.</div>`;
}
let gjob = null;
// L14 contact, M11 margin and the Check-containment tolerance (same as runContain). Hub contact is judged within the
// hub mesh deflection plus 1.5 × the margin (where the hub meets the Boundary the contact vertices are inset by the
// margin), capped at a tenth of the cell — not the old fixed 0.5 mm.
const genTols = (H, Bd, cell) => { const margin = Math.max(Bd.mesh?.deflection || 0, 1e-3 * cell); return {
  contactTol: Math.max(1e-6 * bbDiag(Bd), 1e-3 * cell, Math.min((H.mesh?.deflection || 0) + 1.5 * margin, 0.1 * cell)),
  margin, checkTol: containTol(bbDiag(Bd), [Bd.mesh?.deflection || 0]) }; };
const xfer = b => ({ pos: b.pos.slice(), idx: b.idx.slice() }); // copies whose buffers are transferred (no structured clone)
function runGen() {
  const S = balanceState(), msg = (m, bad) => { $('#genmsg').textContent = m; $('#genmsg').className = 'hint' + (bad ? ' bad' : ''); };
  if (!S.hub) return msg('set one body as Hub first', true);
  if (S.hi.boundary < 0) return msg('set one body as Boundary first', true);
  if (S.band.error) return msg('axial band: ' + S.band.error, true);
  const am = addedMaterial(st.bal.added, S.hub); if (!am) return msg('choose the added material (or type its density)', true);
  const T = S.target.planes[0]; if (!(T.mag > 0)) return msg('nothing to balance: hub + load imbalance is zero', true);
  if (gjob) return msg('the generator is already running', true);
  const H = S.hub, Bd = st.bodies[S.hi.boundary], tol = genTol(S).tol, key = genKey(S), cell = st.bal.gen.cell || defaultCell(bbDiag(Bd));
  const w = new Worker(new URL('./gen-worker.js', import.meta.url), { type: 'module' }), t0 = performance.now(); let stage = 'Starting', frac = 0, done = false;
  const finish = () => { if (done) return; done = true; clearInterval(tick); w.terminate(); gjob = null; $('#gjob').hidden = true; $('#gen').disabled = false; };
  const tick = setInterval(() => { $('#gjobmsg').textContent = `Generator: ${stage}… ${((performance.now() - t0) / 1000).toFixed(0)} s`; $('#gprog').value = frac; }, 200);
  gjob = { cancel: () => { finish(); msg('generation cancelled'); } }; $('#gjob').hidden = false; $('#gen').disabled = true; msg('');
  w.onmessage = ({ data: d }) => {
    if (d.type === 'progress') { stage = d.stage; frac = d.frac; }
    else if (d.type === 'error') { finish(); msg('generator: ' + d.message, true); }
    else if (d.type === 'done') {
      finish(); const r = d.result, { pos, idx, vol, outPts, ...meta } = r; meta.tris = idx.length / 3; delete meta.frame;
      const g = st.bodies.findIndex(x => x.generated); if (g >= 0) { st.bodies.splice(g, 1); st.sels = st.sels.filter(j => j !== g); }
      const b = { name: uniqueGenName(), stepName: '(generated)', product: '', pos, idx, pos32: d.view.pos32, nrm: d.view.nrm, vol, rho: am.rho, sign: 1, on: true, src: 'generated', mat: materialId(am.rho), role: 'cw', generated: true, faces: [] };
      st.bodies.push(b); st.gen = { key, meta, needsRegenerate: false }; st.check = null;
      view.setOutside(meta.contained ? null : Array.from(outPts)); if (g >= 0) view.removeBody(g); view.setBody(st.bodies.length - 1, b); view.setRoles(viewRoles()); view.select(st.sels);
      // L15: the DOM refresh is yielded to the next frame so the worker's result attaches without a long task
      requestAnimationFrame(() => { renderBodies(); renderBalanceInputs(); update(); });
      msg(`generated in ${((performance.now() - t0) / 1000).toFixed(1)} s${r.capped ? ' — ⚠ the allowed region is too small for a full correction' : ''}${meta.contained ? '' : ' — ⚠ the piece is not inside the Boundary'}`, r.capped || !meta.contained);
    }
  };
  w.onerror = e => { e.preventDefault?.(); finish(); msg('generator worker failed: ' + (e.message || 'out of memory?'), true); };
  const bd = xfer(Bd), hb = xfer(H);
  w.postMessage({ boundary: bd, hub: hb, axis: { p: st.axis.p, d: st.axis.d }, band: S.band.w, target: T.U, rho: am.rho, cell, tol, ...genTols(H, Bd, cell) }, [bd.pos.buffer, bd.idx.buffer, hb.pos.buffer, hb.idx.buffer]);
}
// L13: a restored piece's containment and hub contact are re-measured in the worker (same functions), never trusted
function verifyGen() {
  const S = balanceState(), g = genBody(), Bd = st.bodies[S.hi?.boundary];
  if (!g || !S.hub || !Bd) { if (st.gen) st.gen.verify = { pending: false, contained: null }; return; }
  const cell = st.gen?.meta?.cell > 0 ? st.gen.meta.cell : defaultCell(bbDiag(Bd)), t = genTols(S.hub, Bd, cell), w = new Worker(new URL('./gen-worker.js', import.meta.url), { type: 'module' });
  st.gen.verify = { pending: true }; const me = st.gen;
  w.onmessage = ({ data: d }) => {
    if (d.type === 'progress') return; w.terminate(); if (st.gen !== me) return;
    if (d.type === 'verified') { me.verify = { pending: false, ...d.verify }; view.setOutside(d.verify.contained ? null : Array.from(d.verify.outPts)); }
    else me.verify = { pending: false, contained: null, error: d.message };
    update();
  };
  w.onerror = e => { e.preventDefault?.(); w.terminate(); if (st.gen === me) { me.verify = { pending: false, contained: null, error: 'worker failed' }; update(); } };
  const bd = xfer(Bd), hb = xfer(S.hub), pc = xfer(g);
  w.postMessage({ verify: { boundary: bd, hub: hb, pos: pc.pos, idx: pc.idx, tol: t.checkTol, contactTol: t.contactTol } }, [bd.pos.buffer, bd.idx.buffer, hb.pos.buffer, hb.idx.buffer, pc.pos.buffer, pc.idx.buffer]);
}
const uniqueGenName = () => { let n = 'Generated CW', k = 2; while (st.bodies.some(b => b.name === n)) n = `Generated CW ${k++}`; return n; };
function dropGenerated() { const i = st.bodies.findIndex(b => b.generated); if (i < 0) return false; st.bodies.splice(i, 1); st.sels = st.sels.filter(j => j !== i).map(j => j > i ? j - 1 : j); st.sel = st.sels.at(-1) ?? -1; st.gen = null; return true; }
function removeGenerated() { const i = st.bodies.findIndex(b => b.generated); if (i < 0) return; dropGenerated(); st.check = null; view.setOutside(null); view.removeBody(i); view.setRoles(viewRoles()); view.select(st.sels); renderBodies(); renderBalanceInputs(); update(); $('#genmsg').textContent = 'generated piece removed'; }
function genSession() { const g = genBody(); if (!g) return st.gen?.needsRegenerate ? { needsRegenerate: true, meta: st.gen.meta, note: st.gen.note } : null; return packGenerated(g, { ...(st.gen?.meta || {}), key: st.gen?.key || null }); }
// L12 / L13: staged (no state change); the piece's verdict, tolerance, containment and hub contact are recomputed
function stageGenerated(j) {
  const g = unpackGenerated(j), cards = []; if (!g) return { gen: null, body: null, cards };
  if (g.bad) cards.push(['warn', `Session: ${g.bad} invalid generated-piece field${g.bad > 1 ? 's' : ''} ignored.`]);
  if (g.needsRegenerate) { cards.push(['warn', `Session: ${esc(g.note)}.`]); return { gen: { needsRegenerate: true, meta: g.meta, note: g.note }, body: null, cards }; }
  const meta = { ...g.meta }; for (const k of ['tol', 'contained', 'outsideBoundary', 'crossBoundary', 'insideHub', 'hubVertices', 'hubGap', 'contactTol', 'maxOut', 'dipBoundary', 'checkTol']) delete meta[k];
  const body = { name: g.name, stepName: '(generated)', product: '', pos: g.pos, idx: g.idx, vol: meshMoments(g.pos, g.idx), rho: g.rho, sign: 1, on: g.on, src: 'generated', mat: g.mat ?? materialId(g.rho), role: 'cw', generated: true, faces: [] };
  return { gen: { key: g.meta?.key || null, meta, needsRegenerate: false, verify: { pending: true } }, body, cards };
}
// ---------- per-body table for comparison with NX Measure Bodies ----------
// Volume to 0.001 mm³ (and ≥ 7 significant figures), mass g, density g/cc, CG from the model origin to 0.0001 mm.
const NXH = ['Body', 'STEP name', 'Role', 'Volume mm3', 'Mass g', 'Density g/cc', 'CG X mm', 'CG Y mm', 'CG Z mm', 'Volume ± mm3', 'CG ± mm', 'Mesh'];
const sig = (v, dec, p = 7) => { const a = v.toFixed(dec), b = v.toPrecision(p); return (b.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length > a.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length && !/e/.test(b)) ? b : a; };
const f4 = v => { const t = v.toFixed(4); return /^-0\.0+$/.test(t) ? t.slice(1) : t; }; // L10: no '-0.0000'
function nxRows() {
  return st.bodies.map(b => {
    const d = derive(b.vol), m = bmass(b), u = b.unc, low = u?.low ? '≥' : '';
    return [b.name, b.stepName ?? '', ROLES.find(r => r.id === roleOf(b)).label, sig(d.m, 3), sig(m, 4), (b.rho / 1000).toFixed(5), ...d.c.map(f4),
      u ? low + (u.dV * d.m).toPrecision(2) : '', u ? low + u.dc.toPrecision(2) : '', b.mesh ? `${b.mesh.tris} tris, defl ${b.mesh.deflection.toPrecision(2)} mm${b.mesh.coarsened ? ', coarsened' : ''}` : ''];
  });
}
function renderNX() {
  const t = $('#nxtable'); if (!t) return;
  t.innerHTML = `<tr>${NXH.map(h => `<th>${h}</th>`).join('')}</tr>` + nxRows().map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
}
export const nxTSV = () => [NXH, ...nxRows()].map(r => r.map(c => String(c).replace(/[\t\n\r]/g, ' ')).join('\t')).join('\n') + '\n';
async function copyNX() {
  const text = nxTSV(), msg = m => $('#copymsg').textContent = m;
  try { await navigator.clipboard.writeText(text); msg(`copied ${st.bodies.length} rows`); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); msg(ok ? `copied ${st.bodies.length} rows` : 'copy blocked by the browser — select the table and copy'); }
}

// ---------- export / session ----------
function save(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1e4); }
const resRows = (r, an) => [[`residual`, `U${an.n[0]} g.mm`, r.U[0]], ['residual', `U${an.n[1]} g.mm`, r.U[1]], ['residual', `C${an.n[0]} g.mm2`, r.C[0]], ['residual', `C${an.n[1]} g.mm2`, r.C[1]],
  ['axis', 'point (world mm)', st.axis.p.join(' ')], ['axis', 'direction (world)', st.axis.d.join(' ')], ['axis', 'source', st.axis.src], ...['u', 'v', 'w'].map(k => ['basis', `${k} (world)`, an[k].join(' ')])];
const axisJson = an => ({ point: st.axis.p, direction: st.axis.d, source: st.axis.src, basis: { u: an.u, v: an.v, w: an.w }, note: 'spin axis through point along direction (= w); u, v ⊥ w, right-handed; axial positions are measured along w from point' });
const resJson = (r, an) => ({ components: an.n, basis: { u: an.u, v: an.v, w: an.w }, U: r.U, C: r.C, mass: r.m,
  note: an.n[0] === 'u' ? 'U and C are components along u, v (world vectors in basis); w is the spin axis' : 'U and C are world x, y components (spin axis +Z)' });
function exportAs(kind) {
  const { fr, r1 } = update();
  if (kind === 'step') return st.tools.some(t => valid(t) && t.sign > 0) || st.tools.some(valid) ? save('counterweights.stp', toStep(st.tools), 'application/step') : status('No valid tools to export');
  const assemblyCGJson = exportAssemblyCG(st.cg, st.bodies, st.sels);
  const cgRows = assemblyCGJson ? [['assembly CG', 'X mm', assemblyCGJson.c[0]], ['assembly CG', 'Y mm', assemblyCGJson.c[1]], ['assembly CG', 'Z mm', assemblyCGJson.c[2]], ['assembly CG', 'mass g', assemblyCGJson.mass], ['assembly CG', 'bodies', (st.cg.names || []).join(';')], ['assembly CG', 'stale', !!assemblyCGJson.stale]] : [];
  if (kind === 'csv') return save('counterweights.csv', 'tool,kind,role,sign,removal,param,value\n' + st.tools.flatMap(t => [...PARAMS[t.kind], ...COMMON_PARAMS].map(k => [t.name, t.kind, t.role, t.sign, t.sign < 0, k, t[k]].join(','))).join('\n') +
    `\n\n${resRows(r1, axisNames(fr)).map(r => r.join(',')).join('\n')}${cgRows.length ? '\n' + cgRows.map(r => r.join(',')).join('\n') : ''}\n`, 'text/csv');
  save('balance-session.json', JSON.stringify({ app: 'rotating-assembly-balancer', version: VERSION, units: { length: 'mm', mass: 'g', density: 'kg/m3' },
    axis: axisJson(axisNames(fr)), bodies: st.bodies.filter(b => !b.generated).map((b, i) => ({ ...bodyRef(b, i), on: b.on, rho: b.rho, src: b.src, removal: b.sign < 0, mass: bmass(b), role: roleOf(b), mat: b.mat ?? materialId(b.rho) })),
    balance: exportBalance(st.bal, st.bodies), generated: genSession(),
    tools: st.tools.map(t => ({ ...t, removal: t.sign < 0 })), residual: resJson(r1, axisNames(fr)), assemblyCG: assemblyCGJson, optimisation: st.last }, null, 1), 'application/json');
}
function loadSession(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.tools)) return status('JSON has no tools[]');
  // L12: build the complete new state first (on copies of the bodies), then commit it; any error leaves the
  // current state untouched (and a failing commit is rolled back).
  let S;
  try { S = stageSession(j); } catch (e) { card('err', `<b>Session not loaded</b>: ${esc(e.message)} — nothing was changed.`); return status('Session load failed (nothing changed)'); }
  const prev = { tools: st.tools, bodies: st.bodies, bal: st.bal, gen: st.gen, check: st.check, axis: st.axis, sels: st.sels, sel: st.sel, cg: st.cg };
  try { commitSession(S); }
  catch (e) {
    Object.assign(st, prev); view.setOutside(null); renderBalanceInputs(); renderBodies(); renderTools(); renderAxis(); update();
    card('err', `<b>Session not loaded</b>: ${esc(e.message)} — the previous state was restored.`); status('Session load failed (previous state restored)');
  }
}
function stageSession(j) {
  // H4: tools are rebuilt from schema-checked fields only (src/session-schema.js)
  let badTools = 0; const tools = j.tools.slice(0, 200).flatMap(t => { const { o, bad } = cleanTool(t); badTools += bad; return o ? [makeTool(o.kind, o)] : []; });
  const bodies = st.bodies.filter(b => !b.generated).map(b => ({ ...b }));
  const out = restoreSession(j, bodies), rb = restoreBalance(j.balance, bodies);
  for (const b of bodies) b.mat ??= materialId(b.rho);
  const gen = stageGenerated(j.generated);
  const ax = j.axis && typeof j.axis === 'object' ? j.axis : {}, a = makeAxis(ax.point || ax.origin || [0, 0, 0], ax.direction || (Array.isArray(ax.R) ? ax.R.slice(6, 9) : null) || [0, 0, 1]); // 0.1.x sessions: origin + R
  const src = typeof (ax.source ?? ax.choice) === 'string' ? (ax.source ?? ax.choice) : '';
  return { tools, badTools, bodies, out, rb, gen, a, src, hasCG: !!out.cg, densStale: out.densMatch.stale && (Array.isArray(j.bodies) ? j.bodies.length : 0) };
}
function commitSession(S) {
  st.tools = S.tools; st.bodies = S.bodies; if (S.gen.body) st.bodies.push(S.gen.body); st.gen = S.gen.gen;
  st.bal = S.rb.bal; st.check = null; view.setOutside(null);
  if (S.badTools) card('warn', `Session: ${S.badTools} invalid tool field${S.badTools > 1 ? 's' : ''} ignored.`);
  const notes = [...(S.out.roleNotes || []), ...S.rb.notes]; if (notes.length) card('warn', `Session: ${esc(notes.join('; '))}.`);
  for (const [k, h] of S.gen.cards) card(k, h);
  renderBalanceInputs();
  if (S.densStale) card('warn', `Session: some body densities were not applied (${esc(S.out.densMatch.notice) || 'could not match them uniquely'}).`);
  renderBodies(); renderTools(); renderAxis();
  const src = S.src; if (!S.a.error) setAxis(S.a, PRESET[src] || (src[0] === 'P' && st.bodies[+src.slice(1)]) ? src : 'C'); else update();
  if (S.hasCG) {
    st.sels = S.out.sels; st.sel = st.sels.at(-1) ?? -1; view.select(st.sels);
    document.querySelectorAll('#bodies tr[data-row]').forEach(r => r.classList.toggle('sel', st.sels.includes(+r.dataset.row)));
    st.cg = S.out.cg;
    if (S.out.cg.dropped) card('warn', `Session: the saved assembly CG was not restored (${esc(S.out.cg.notice) || 'bodies changed or did not match uniquely'}). Click Calculate CG for the current selection.`);
    else if (S.out.cg.stale) card('warn', `Session: the saved assembly CG is stale${S.out.cg.notice ? ' (' + esc(S.out.cg.notice) + ')' : ''}. Click Calculate CG to refresh.`);
    renderCG();
  }
  status('Session loaded');
  if (st.gen && !st.gen.needsRegenerate && genBody()) verifyGen();
}

const drop = $('#drop');
['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', e => loadFiles([...e.dataTransfer.files]).catch(err => status('Error: ' + err.message)));
$('#file').addEventListener('change', e => loadFiles([...e.target.files]).catch(err => status('Error: ' + err.message)));
renderAxis(); setAxis(st.axis, 'Z');
renderBalanceInputs(); renderNX();
window.rab = { st, view, nxTSV, balanceState, genKey }; // test hook (tools/ui-smoke.cjs)
