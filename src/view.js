import { Scene, PerspectiveCamera, OrthographicCamera, WebGLRenderer, HemisphereLight, DirectionalLight, Group, Mesh, MeshStandardMaterial, BufferGeometry, BufferAttribute, SphereGeometry,
  CylinderGeometry, ConeGeometry, MeshBasicMaterial, Line, LineBasicMaterial, ArrowHelper, Vector2, Vector3, Box3, Shape, Path, ExtrudeGeometry, Color, Raycaster,
  Sprite, SpriteMaterial, CanvasTexture, OrbitControls } from '../vendor/three/three.lite.min.js';
import { loops } from './tools.js';
// Thin Three.js layer: bodies (pickable, multi-select), correction tools, CoM marker, assembly-CG marker
// and model-space origin (constant screen size). Origin, CG and the origin-to-CG line live in an overlay
// scene rendered after a depth clear so they draw through the (transparent) bodies. Spin axis, imbalance
// arrows, and a world-axes triad in a lower-left inset (scissor pass).
const TRIAD = 110, CLICK_PX = 5; // inset size (CSS px); pointer travel that still counts as a click, not an orbit
export function createView(el) {
  const scene = new Scene(); scene.background = new Color(0xeef0f3);
  const cam = new PerspectiveCamera(40, 1, 0.1, 1e6); cam.up.set(0, 0, 1); cam.position.set(200, -260, 180);
  const ren = new WebGLRenderer({ antialias: true }); el.appendChild(ren.domElement);
  const ctl = new OrbitControls(cam, ren.domElement);
  scene.add(new HemisphereLight(0xffffff, 0x8899aa, 2.2)); const sun = new DirectionalLight(0xffffff, 1.6); sun.position.set(1, -1, 2); scene.add(sun);
  const bodies = new Group(), tools = new Group(), marks = new Group(), picks = new Group(), cgGrp = new Group(), originGrp = new Group(), cgLine = new Group();
  const pinGrp = new Group(), outGrp = new Group(), bandGrp = new Group();
  const overlay = new Scene(); scene.add(bodies, tools, marks, picks, pinGrp, outGrp, bandGrp); overlay.add(cgGrp, originGrp, cgLine);
  const triad = makeTriad(), tcam = new OrthographicCamera(-1.45, 1.45, 1.45, -1.45, 0.1, 10);
  let mq;
  const resize = () => { // also on devicePixelRatio changes (browser zoom, moving to another screen) so both passes stay crisp
    ren.setPixelRatio(Math.min(devicePixelRatio, 2)); const w = el.clientWidth, h = el.clientHeight; ren.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix();
    mq?.removeEventListener('change', resize); mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); mq.addEventListener('change', resize);
  };
  new ResizeObserver(resize).observe(el); resize();
  const cgLabel = document.createElement('div'); cgLabel.id = 'cgmark'; cgLabel.hidden = true; el.appendChild(cgLabel);
  const originLabel = document.createElement('div'); originLabel.id = 'originmark'; originLabel.textContent = 'Origin 0,0,0'; el.appendChild(originLabel);
  const originRoot = makeOriginAxes(); originGrp.add(originRoot);
  let cgRoot = null;
  const pxScale = pos => { const d = cam.position.distanceTo(pos), h = el.clientHeight || 1; return d * Math.tan(cam.fov * Math.PI / 360) * 2 / h; };
  const placeLabel = (label, pos, hide = false) => {
    const v = pos.clone().project(cam), r = el.getBoundingClientRect(), on = v.z >= -1 && v.z <= 1 && Math.abs(v.x) <= 1.2 && Math.abs(v.y) <= 1.2;
    label.style.left = (v.x + 1) / 2 * r.width + 'px'; label.style.top = (1 - v.y) / 2 * r.height + 'px';
    label.hidden = hide || !on;
  };
  const syncMarks = () => {
    originRoot.scale.setScalar(pxScale(originRoot.position));
    placeLabel(originLabel, originRoot.position);
    if (!cgRoot) { cgLabel.hidden = true; return; }
    cgRoot.scale.setScalar(pxScale(cgRoot.position));
    placeLabel(cgLabel, cgRoot.position);
  };
  const frame = () => {
    ctl.update(); syncMarks(); const w = el.clientWidth, h = el.clientHeight;
    ren.setViewport(0, 0, w, h); ren.render(scene, cam);
    // M3: overlay pass after a depth clear so CG / origin / dashed line are not painted over by transparent bodies
    ren.autoClear = false; ren.clearDepth(); ren.render(overlay, cam);
    tcam.position.copy(cam.position).sub(ctl.target).setLength(4); tcam.up.copy(cam.up); tcam.lookAt(0, 0, 0);
    ren.clearDepth(); ren.setScissorTest(true); ren.setScissor(0, 0, TRIAD, TRIAD); ren.setViewport(0, 0, TRIAD, TRIAD);
    ren.render(triad, tcam); ren.setScissorTest(false); ren.autoClear = true;
  };
  ren.setAnimationLoop(frame);
  const clear = g => { for (const c of [...g.children]) { g.remove(c); c.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); } };
  // click (not drag) on the canvas → onClick(hit | null, event)
  const ray = new Raycaster(); let down = null, onClick = () => { }, sel = new Set();
  const pick = (x, y) => {
    const r = ren.domElement.getBoundingClientRect(); ray.setFromCamera(new Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1), cam);
    // 0.2.0: the see-through Boundary ghost does not block picks on the bodies inside it
    const hits = ray.intersectObjects(bodies.children.filter(m => m.visible), false), h = hits.find(x => roles[bodies.children.indexOf(x.object)] !== 'boundary') || hits[0];
    return h ? { body: bodies.children.indexOf(h.object), tri: h.faceIndex, point: h.point.toArray() } : null;
  };
  ren.domElement.addEventListener('pointerdown', e => { down = e.button === 0 ? [e.clientX, e.clientY] : null; });
  ren.domElement.addEventListener('pointerup', e => {
    if (!down || e.button !== 0) return; const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
    if (moved <= CLICK_PX) onClick(pick(e.clientX, e.clientY), e);
  });
  // 0.2.0 roles: hub tinted blue-green, boundary a see-through ghost, existing counterweight orange, ignore faded
  let roles = [];
  const ROLE_LOOK = { hub: { color: 0x3a8f8a, opacity: 0.9 }, boundary: { color: 0x7fa7d9, opacity: 0.16 }, cw: { color: 0xe8902a, opacity: 0.95 }, ignore: { color: 0xb8bec8, opacity: 0.35 }, gen: { color: 0xd6309a, opacity: 0.97 } }; // gen: the generated counterweight (magenta)
  const paint = () => bodies.children.forEach((m, i) => {
    const on = sel.has(i), look = ROLE_LOOK[roles[i]];
    m.material.color.setHex(look ? look.color : m.userData.color); m.material.depthWrite = roles[i] !== 'boundary';
    m.material.emissive.setHex(on ? 0x1f5fd6 : 0); m.material.emissiveIntensity = on ? 0.55 : 1;
    m.material.opacity = look ? (on ? Math.max(look.opacity, 0.35) : look.opacity) : on ? 1 : 0.85;
  });
  const meshOf = b => {
    const g = new BufferGeometry(); g.setAttribute('position', new BufferAttribute(b.pos32 || (b.pos instanceof Float32Array ? b.pos : new Float32Array(b.pos)), 3));
    if (b.nrm) g.setAttribute('normal', new BufferAttribute(b.nrm instanceof Float32Array ? b.nrm : new Float32Array(b.nrm), 3)); else g.computeVertexNormals();
    g.setIndex(new BufferAttribute(b.idx instanceof Uint32Array ? b.idx : new Uint32Array(b.idx), 1));
    const m = new Mesh(g, new MeshStandardMaterial({ color: b.color || 0x9aa4b2, metalness: 0.3, roughness: 0.6, transparent: true, opacity: 0.85 }));
    m.userData.color = b.color || 0x9aa4b2; m.visible = b.on; return m;
  };
  let size = 100;
  return {
    setBodies(list) {
      clear(bodies);
      for (const b of list) bodies.add(meshOf(b));
      sel = new Set(); paint();
    },
    // 0.2.0-alpha.4 (L15): add / replace / remove one body (the generated piece) without rebuilding the others
    setBody(i, b) { const old = bodies.children[i]; if (old) { bodies.remove(old); old.geometry.dispose(); old.material.dispose(); } const m = meshOf(b); bodies.add(m); if (i < bodies.children.length - 1) { bodies.children.splice(bodies.children.indexOf(m), 1); bodies.children.splice(i, 0, m); } paint(); },
    removeBody(i) { const old = bodies.children[i]; if (!old) return; bodies.remove(old); old.geometry.dispose(); old.material.dispose(); sel = new Set([...sel].filter(j => j !== i).map(j => j > i ? j - 1 : j)); paint(); },
    fit() {
      const bb = new Box3().setFromObject(bodies.children.length ? bodies : tools); if (bb.isEmpty()) return;
      const c = bb.getCenter(new Vector3()); size = bb.getSize(new Vector3()).length() || 100;
      ctl.target.copy(c); cam.position.copy(c).add(new Vector3(0.8, -1, 0.7).multiplyScalar(size)); cam.near = size / 1000; cam.far = size * 100; cam.updateProjectionMatrix();
    },
    setTools(list) {
      clear(tools);
      for (const t of list) {
        const ls = loops(t), sh = new Shape(); trace(sh, ls[0]);
        for (const h of ls.slice(1)) { const p = new Path(); trace(p, h); sh.holes.push(p); }
        const m = new Mesh(new ExtrudeGeometry(sh, { depth: t.h, bevelEnabled: false, curveSegments: 64 }),
          new MeshStandardMaterial({ color: t.sign < 0 ? 0xd0343c : t.role === 'swinglink' ? 0x2b9a66 : 0xe8902a, transparent: t.sign < 0, opacity: t.sign < 0 ? 0.55 : 1 }));
        m.rotation.order = 'ZYX'; m.rotation.set(t.rx * Math.PI / 180, t.ry * Math.PI / 180, t.rz * Math.PI / 180); m.position.set(t.x, t.y, t.z); tools.add(m);
      }
    },
    // r: imbalance result, fr: axis frame (origin = axis point), com: world CoM, span: body extent along w.
    setMarks(r, fr, com, span) {
      clear(marks);
      const s = size, Rt = v => new Vector3(fr.R[0] * v[0] + fr.R[3] * v[1] + fr.R[6] * v[2], fr.R[1] * v[0] + fr.R[4] * v[1] + fr.R[7] * v[2], fr.R[2] * v[0] + fr.R[5] * v[1] + fr.R[8] * v[2]);
      const at = z => Rt([0, 0, z]).add(new Vector3(...fr.o));
      const z0 = Math.min(span[0], 0) - s * 0.15, z1 = Math.max(span[1], 0) + s * 0.15;
      // spin axis through its point (0.2.0: drawn through the whole model): line + thin cylinder over the span
      // (+15 % of the model size each side), arrow head along +w, ringed marker at the axis point
      marks.add(new Line(new BufferGeometry().setFromPoints([at(z0), at(z1)]), new LineBasicMaterial({ color: 0x1d2330 })));
      const rod = new Mesh(new CylinderGeometry(s * 0.0025, s * 0.0025, z1 - z0, 10), new MeshBasicMaterial({ color: 0x1d6fd6, transparent: true, opacity: 0.9, depthTest: false }));
      rod.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), Rt([0, 0, 1]).normalize()); rod.position.copy(at((z0 + z1) / 2)); rod.renderOrder = 8; rod.name = 'axis-rod'; marks.add(rod);
      const head = new ArrowHelper(Rt([0, 0, 1]), at(z1 - s * 0.06), s * 0.08, 0x1d6fd6, s * 0.06, s * 0.03); head.traverse(o => { if (o.material) o.material.depthTest = false; o.renderOrder = 9; }); head.name = 'axis-arrow'; marks.add(head);
      const dot = new Mesh(new SphereGeometry(s * 0.01, 14, 10), new MeshBasicMaterial({ color: 0x1d6fd6, depthTest: false })); dot.position.copy(at(0)); dot.renderOrder = 9; dot.name = 'axis-point'; marks.add(dot);
      const ring = new Mesh(new SphereGeometry(s * 0.016, 14, 10), new MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.6 })); ring.position.copy(at(0)); ring.renderOrder = 8; marks.add(ring);
      if (!r || !r.m) return;
      const ball = new Mesh(new SphereGeometry(s * 0.012, 16, 12), new MeshBasicMaterial({ color: 0xd0343c, depthTest: false })); ball.position.set(...com); ball.renderOrder = 9; marks.add(ball);
      const arrow = (v, z, col, mag, ref) => { if (!(mag > ref)) return; const d = Rt([v[0], v[1], 0]).normalize(), a = new ArrowHelper(d, at(z), s * (0.12 + 0.18 * Math.min(1, Math.log10(1 + mag / ref) / 4)), col, s * 0.03, s * 0.015); a.traverse(o => { if (o.material) o.material.depthTest = false; o.renderOrder = 10; }); marks.add(a); };
      const tiny = 1e-6 * r.m * s, [a0, a1] = span;
      arrow(r.U, r.zc, 0xd0343c, r.Umag, tiny);
      const half = (a1 - a0) / 2 || s / 4; arrow(r.C, r.zc + half, 0x2a62c9, r.Cmag, tiny * half); arrow(r.C.map(v => -v), r.zc - half, 0x2a62c9, r.Cmag, tiny * half);
    },
    setRoles(list) { roles = list.slice(); paint(); },
    roles: () => roles.slice(),
    // drive pin: a line along the pin axis between world points a and b, plus a marker at a
    setPin(a, b) {
      clear(pinGrp); if (!a) return;
      const A = new Vector3(...a), B = new Vector3(...b), L = A.distanceTo(B) || 1;
      const ln = new Line(new BufferGeometry().setFromPoints([A, B]), new LineBasicMaterial({ color: 0x7a2bd6, depthTest: false })); ln.renderOrder = 12; pinGrp.add(ln);
      const rod = new Mesh(new CylinderGeometry(size * 0.002, size * 0.002, L, 8), new MeshBasicMaterial({ color: 0x7a2bd6, depthTest: false, transparent: true, opacity: 0.9 }));
      rod.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), B.clone().sub(A).normalize()); rod.position.copy(A).add(B).multiplyScalar(0.5); rod.renderOrder = 12; pinGrp.add(rod);
      const m = new Mesh(new SphereGeometry(size * 0.009, 12, 8), new MeshBasicMaterial({ color: 0x7a2bd6, depthTest: false })); m.position.set(...a); m.renderOrder = 12; pinGrp.add(m);
    },
    hasPin: () => pinGrp.children.length > 0,
    // generator axial band: two translucent discs (radius r, mm) square to the axis at w0 and w1, plus a faint slab between
    setBand(fr, w0, w1, r) {
      clear(bandGrp); if (fr == null || !(w1 > w0) || !(r > 0)) return;
      const ax = new Vector3(fr.R[6], fr.R[7], fr.R[8]), at = w => new Vector3(...fr.o).add(ax.clone().multiplyScalar(w)), q = new Vector3(0, 1, 0);
      const disc = (w, name) => { const m = new Mesh(new CylinderGeometry(r, r, Math.max((w1 - w0) * 0.004, size * 1e-4), 64, 1, true), new MeshBasicMaterial({ color: 0xd6309a, transparent: true, opacity: 0.18, depthWrite: false, side: 2 })); m.quaternion.setFromUnitVectors(q, ax); m.position.copy(at(w)); m.name = name; bandGrp.add(m);
        const cap = new Mesh(new CylinderGeometry(r, r, 1e-6, 64), new MeshBasicMaterial({ color: 0xd6309a, transparent: true, opacity: 0.12, depthWrite: false, side: 2 })); cap.quaternion.copy(m.quaternion); cap.position.copy(at(w)); bandGrp.add(cap); };
      disc(w0, 'band-0'); disc(w1, 'band-1');
      const slab = new Mesh(new CylinderGeometry(r, r, w1 - w0, 64, 1, true), new MeshBasicMaterial({ color: 0xd6309a, transparent: true, opacity: 0.07, depthWrite: false, side: 2 }));
      slab.quaternion.setFromUnitVectors(q, ax); slab.position.copy(at((w0 + w1) / 2)); slab.name = 'band-slab'; bandGrp.add(slab);
    },
    bandDrawn: () => ['band-0', 'band-1'].every(n => bandGrp.getObjectByName(n)),
    // check mode: small red markers at vertices found outside the boundary (flat xyz list, capped)
    setOutside(flat) {
      clear(outGrp); if (!flat || !flat.length) return;
      const n = Math.min(flat.length / 3, 20000), h = size * 0.003, P = new Float32Array(n * 18), I = new Uint32Array(n * 24);
      const off = [[h, 0, 0], [-h, 0, 0], [0, h, 0], [0, -h, 0], [0, 0, h], [0, 0, -h]], F = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
      for (let i = 0; i < n; i++) { for (let k = 0; k < 6; k++) for (let c = 0; c < 3; c++) P[18 * i + 3 * k + c] = flat[3 * i + c] + off[k][c]; for (let k = 0; k < 24; k++) I[24 * i + k] = 6 * i + F[k]; }
      const g = new BufferGeometry(); g.setAttribute('position', new BufferAttribute(P, 3)); g.setIndex(new BufferAttribute(I, 1));
      const m = new Mesh(g, new MeshBasicMaterial({ color: 0xff1030, depthTest: false })); m.renderOrder = 13; outGrp.add(m);
    },
    outsideCount: () => outGrp.children.length ? outGrp.children[0].geometry.attributes.position.count / 6 : 0,
    axisDrawn: () => ['axis-rod', 'axis-arrow', 'axis-point'].every(n => marks.getObjectByName(n)),
    setPicks(points) { clear(picks); for (const p of points) { const m = new Mesh(new SphereGeometry(size * 0.007, 12, 8), new MeshBasicMaterial({ color: 0x7a2bd6, depthTest: false })); m.position.set(...p); m.renderOrder = 11; picks.add(m); } },
    showBody(i, on) { if (bodies.children[i]) bodies.children[i].visible = on; },
    select(idx) { sel = new Set(Array.isArray(idx) ? idx : idx >= 0 ? [idx] : []); paint(); },
    setAssemblyCG(c, stale = false) {
      clear(cgGrp); clear(cgLine); cgRoot = null; cgLabel.hidden = true;
      if (!c) return;
      const g = new Group(), mat = (col) => new MeshBasicMaterial({ color: col, depthTest: false, depthWrite: false, transparent: true });
      const halo = new Mesh(new SphereGeometry(11, 20, 16), mat(0x1d2330)), ball = new Mesh(new SphereGeometry(8, 20, 16), mat(stale ? 0xb89a00 : 0xffcc00));
      halo.renderOrder = 20; ball.renderOrder = 21; g.add(halo, ball);
      const up = new Vector3(0, 1, 0);
      for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const m = new Mesh(new CylinderGeometry(1.6, 1.6, 28, 8), mat(stale ? 0xb89a00 : 0xffe066));
        m.quaternion.setFromUnitVectors(up, new Vector3(...d)); m.renderOrder = 22; g.add(m);
      }
      g.position.set(...c); cgGrp.add(g); cgRoot = g;
      cgLabel.textContent = stale ? 'CG (stale)' : 'CG'; cgLabel.classList.toggle('stale', !!stale);
      if (Math.hypot(...c) > 1e-9) cgLine.add(dashLine([0, 0, 0], c, stale ? 0xb89a00 : 0xc4a000));
      syncMarks();
    },
    hasAssemblyCG: () => !!cgRoot,
    hasOrigin: () => true,
    hasOriginToCG: () => cgLine.children.length > 0,
    // for tests: confirm the overlay pass and that marker materials will not be hidden by transparent bodies
    markerOverlay() {
      const mats = [];
      overlay.traverse(o => { const m = o.material; if (m) mats.push({ depthTest: !!m.depthTest, depthWrite: !!m.depthWrite, transparent: !!m.transparent, renderOrder: o.renderOrder }); });
      return { pass: 'overlay', count: mats.length, mats };
    },
    onClick(f) { onClick = f; },
    // for tests (L15): stop / restart the render loop so a Long Tasks measurement sees the app's own main-thread work
    // and not software-GL frames (headless Chromium draws one frame in ~50 ms on SwiftShader)
    renderLoop(on) { ren.setAnimationLoop(on ? frame : null); },
    project(p) { const v = new Vector3(...p).project(cam), r = ren.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; },
    pick, cursor(c) { ren.domElement.style.cursor = c; },
    // for tests: triad axis directions on screen (x right, y up)
    triadScreen() { return [0, 1, 2].map(k => { const v = new Vector3(+(k === 0), +(k === 1), +(k === 2)).applyMatrix4(tcam.matrixWorldInverse); return [+v.x.toFixed(3), +v.y.toFixed(3)]; }); },
    triadPx: TRIAD, highlighted: () => bodies.children.map((m, i) => sel.has(i)),
  };
}
// X/Y/Z arrows (red/green/blue) with canvas-texture sprite labels, unit length, in their own scene.
function makeTriad() {
  const s = new Scene(), up = new Vector3(0, 1, 0);
  s.add(new HemisphereLight(0xffffff, 0x667788, 3));
  [[0xd0343c, 'X'], [0x2b9a46, 'Y'], [0x2a62c9, 'Z']].forEach(([col, name], k) => {
    const d = new Vector3(+(k === 0), +(k === 1), +(k === 2)), mat = new MeshBasicMaterial({ color: col });
    const shaft = new Mesh(new CylinderGeometry(0.045, 0.045, 0.8, 10), mat), cone = new Mesh(new ConeGeometry(0.12, 0.3, 14), mat);
    for (const [m, at] of [[shaft, 0.4], [cone, 0.95]]) { m.quaternion.setFromUnitVectors(up, d); m.position.copy(d).multiplyScalar(at); s.add(m); }
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.font = 'bold 92px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 14; g.strokeStyle = 'rgba(255,255,255,.9)'; g.strokeText(name, 64, 70); g.fillStyle = '#' + col.toString(16).padStart(6, '0'); g.fillText(name, 64, 70);
    const tex = new CanvasTexture(c); tex.colorSpace = 'srgb'; tex.anisotropy = 4;
    const sp = new Sprite(new SpriteMaterial({ map: tex, depthTest: false })); sp.scale.setScalar(0.42); sp.position.copy(d).multiplyScalar(1.2); sp.renderOrder = 2; s.add(sp);
  });
  return s;
}
// Model-space origin at 0,0,0: small RGB arrows (same colours as the inset triad), sized in CSS pixels.
function makeOriginAxes() {
  const g = new Group(), up = new Vector3(0, 1, 0);
  const hub = new Mesh(new SphereGeometry(3, 12, 8), new MeshBasicMaterial({ color: 0x1d2330, depthTest: false, depthWrite: false, transparent: true }));
  hub.renderOrder = 15; g.add(hub);
  [[0xd0343c, [1, 0, 0]], [0x2b9a46, [0, 1, 0]], [0x2a62c9, [0, 0, 1]]].forEach(([col, dir]) => {
    const mat = new MeshBasicMaterial({ color: col, depthTest: false, depthWrite: false, transparent: true }), d = new Vector3(...dir);
    const shaft = new Mesh(new CylinderGeometry(1.2, 1.2, 20, 8), mat), cone = new Mesh(new ConeGeometry(3.2, 8, 10), mat);
    shaft.quaternion.setFromUnitVectors(up, d); shaft.position.copy(d).multiplyScalar(10);
    cone.quaternion.setFromUnitVectors(up, d); cone.position.copy(d).multiplyScalar(24);
    shaft.renderOrder = 16; cone.renderOrder = 16; g.add(shaft, cone);
  });
  return g;
}
// World-space dashed segment list (LineDashedMaterial is not in the tree-shaken bundle).
function dashLine(a, b, col) {
  const g = new Group(), len = Math.hypot(...b.map((v, i) => v - a[i]));
  if (!(len > 1e-9)) return g;
  const n = Math.max(8, Math.min(36, Math.round(len / 6))), dash = len / (n * 2), dir = b.map((v, i) => (v - a[i]) / len);
  const mat = new LineBasicMaterial({ color: col, depthTest: false, depthWrite: false, transparent: true });
  for (let i = 0; i < n; i++) {
    const t0 = i * 2 * dash, t1 = t0 + dash;
    const ln = new Line(new BufferGeometry().setFromPoints([new Vector3(...a.map((v, k) => v + dir[k] * t0)), new Vector3(...a.map((v, k) => v + dir[k] * t1))]), mat);
    ln.renderOrder = 14; g.add(ln);
  }
  return g;
}
function trace(p, segs) {
  p.moveTo(...segs[0].p);
  for (const s of segs) s.t === 'L' ? p.lineTo(...s.q) : p.absarc(0, 0, s.r, s.a0, s.a1, s.a1 < s.a0);
}
