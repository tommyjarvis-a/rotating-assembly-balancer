// 0.2.0-alpha.5 UI smoke: export of the generated counterweight (binary / ASCII STL, faceted STEP AP214, hub + piece),
// blob-URL downloads under the CSP, re-import (STL in a worker with units, faceted STEP) as a Counterweight (existing)
// and check mode PASS on the re-imported piece; STL guards; About note. Fixture: test/fixtures/scroll-hub.stp.
// Local only, any STEP:  STP=/path/file.stp HUB=<body #> BND=<body #> node tools/ui-smoke-024.cjs   (1-based body rows;
// writes nothing into the repo — downloads go to a temp dir).
//   python3 -m http.server 8765 &   node tools/ui-smoke-024.cjs [url]      Env: BROWSERS=chromium  HEADED=1  PLAYWRIGHT=/path/to/playwright
const pw = require(process.env.PLAYWRIGHT || 'playwright'), path = require('path'), fs = require('fs'), os = require('os');
const url = process.argv[2] || 'http://localhost:8765/', FIX = process.env.STP || path.join(__dirname, '../test/fixtures/scroll-hub.stp'), CUSTOM = !!process.env.STP;
(async () => {
  let fail = 0; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rab024-'));
  for (const name of (process.env.BROWSERS || 'chromium').split(',')) {
    const b = await pw[name].launch({ headless: !process.env.HEADED }), ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    const p = await ctx.newPage(), errs = [], res = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
    const check = (label, ok, info = '') => { res.push(`${ok ? 'ok ' : 'FAIL'} ${label}${info ? ' — ' + info : ''}`); if (!ok) fail++; };
    const idx = n => p.evaluate(n => rab.st.bodies.findIndex(b => b.name === n), n);
    const role = async (i, r) => p.selectOption(`select[data-role="${typeof i === 'number' ? i : await idx(i)}"]`, r);
    const commit = async (sel, v) => { await p.fill(sel, String(v)); await p.press(sel, 'Enter'); await p.locator(sel).blur(); };
    const status = () => p.textContent('#status');
    const load = async (files, re = /bodies ·|STL ·|failed/) => { await p.evaluate(() => document.querySelector('#status').textContent = ''); await p.setInputFiles('#file', files); await p.waitForFunction(re => new RegExp(re).test(document.querySelector('#status').textContent), re.source, { timeout: 180000 }); };
    const piece = () => p.evaluate(() => { const g = rab.st.bodies.find(b => b.generated); if (!g) return null; let m = 0, c = [0, 0, 0]; const v = g.vol; return { name: g.name, V: v.m, mass: v.m * g.rho * 1e-6, c: v.M1.map(x => x / v.m), tris: g.idx.length / 3, rho: g.rho }; });
    const bodyOf = n => p.evaluate(n => { const b = rab.st.bodies.find(b => b.name === n); if (!b) return null; const v = b.vol; return { name: b.name, role: b.role, V: v.m, mass: v.m * b.rho * 1e-6, c: v.M1.map(x => x / v.m), rho: b.rho, src: b.src }; }, n);
    const exp = async (fmt, hub = false) => {
      await p.selectOption('#expfmt', fmt); if (fmt === 'step') await p.setChecked('#exphub', hub);
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.click('#genexport')]);
      const f = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(f); return { f, name: dl.suggestedFilename(), url: dl.url(), size: fs.statSync(f).size };
    };
    const close = (a, b2, rel, cg) => a && b2 && Math.abs(a.V - b2.V) <= rel * b2.V && Math.abs(a.mass - b2.mass) <= rel * b2.mass && a.c.every((v, k) => Math.abs(v - b2.c[k]) <= cg);
    const diff = (a, b2) => a && b2 ? `ΔV ${(a.V / b2.V - 1).toExponential(2)}, ΔCG ${Math.hypot(...a.c.map((v, k) => v - b2.c[k])).toExponential(2)} mm` : 'missing';
    try {
      await p.goto(url); const t0 = Date.now(); await load(FIX); const tImp = (Date.now() - t0) / 1000;
      check('version 0.2.0-alpha.6 in the header', (await p.textContent('#ver')).trim() === '0.2.0-alpha.6');
      check('About: STEP export is faceted (planar triangles, not B-spline), NX imports it as a faceted / sewn solid', /faceted/.test(await p.textContent('#aboutstep')) && /not B-spline/.test(await p.textContent('#aboutstep')) && /NX imports it as a faceted or sewn solid/.test(await p.textContent('#aboutstep')));
      check('file input accepts .stl; STL units default mm', /\.stl/.test(await p.getAttribute('#file', 'accept')) && await p.inputValue('#stlunit') === 'mm');
      if (CUSTOM) { await role(+process.env.HUB - 1, 'hub'); await role(+process.env.BND - 1, 'boundary'); }
      else { await role('hub', 'hub'); await role('boundary', 'boundary'); await role('scroll', 'ignore'); await role('pin', 'ignore'); await commit('#pine', 6); await commit('#pinang', 90); await p.selectOption('#load', 'b' + await idx('scroll')); }
      check('no export before a piece exists', await p.evaluate(() => document.querySelector('#genexp').hidden));
      const t1 = Date.now(); await p.click('#gen');
      await p.waitForFunction(() => { const v = document.querySelector('#genverdict'); return (v && v.dataset.v !== 'pending') || /generator:/.test(document.querySelector('#genmsg').textContent); }, null, { timeout: 180000 });
      const tGen = (Date.now() - t1) / 1000, g = await piece(), meta = await p.evaluate(() => rab.st.gen?.meta || {}); if (!g) throw new Error('no piece: ' + await p.textContent('#genmsg'));
      // alpha.4 M10: on a CAD file whose mass-property ± exceeds the generator tolerance the honest verdict is CAN'T RESOLVE
      // (leftover within the tolerance, uncertainty above it); the piece must be inside the Boundary either way
      const gv = await p.textContent('#genverdict'), gl = +(await p.textContent('#genleft')), gu = await p.textContent('#genleftu');
      check('generated piece: inside the Boundary and PASS (or CAN\'T RESOLVE with the leftover within tol on a CAD file with a larger ±)', g && (await p.textContent('#gencontain')) === 'inside' && (gv === 'PASS' || (CUSTOM && /CAN.T RESOLVE/.test(gv) && gl <= meta.tol)), `${gv}: leftover ${gl} ${gu} g·mm vs tol ${meta.tol}; ${g?.tris} tris, mass ${g?.mass?.toFixed(4)} g, max protrusion ${meta.maxOut} mm, ${meta.inset} inset / ${meta.split} split, ${tGen.toFixed(1)} s`);
      check('export row shown with the piece; "with hub" only for STEP', !await p.evaluate(() => document.querySelector('#genexp').hidden) && await p.evaluate(() => document.querySelector('#exphubl').hidden));
      // ---- exports ----
      const sb = await exp('stl'); const head = fs.readFileSync(sb.f).subarray(0, 84);
      check('binary STL: blob-URL download, 84 + 50·n bytes, n = piece triangles', sb.url.startsWith('blob:') && sb.name === 'Generated_CW.stl' && sb.size === 84 + 50 * g.tris && head.readUInt32LE(80) === g.tris, `${sb.name} ${sb.size} B ${sb.url.slice(0, 5)}`);
      const sa = await exp('stla'); const at = fs.readFileSync(sa.f, 'utf8');
      check('ASCII STL', sa.name === 'Generated_CW_ascii.stl' && /^solid Generated_CW\n/.test(at) && (at.match(/facet normal/g) || []).length === g.tris, `${sa.name} ${sa.size} B`);
      const ss = await exp('step'); const stx = fs.readFileSync(ss.f, 'latin1');
      check('STEP AP214, faceted (FACETED_BREP + planar FACE_SURFACE, no FACE / TESSELLATED), mm, one product', ss.name === 'Generated_CW.stp' && /AUTOMOTIVE_DESIGN/.test(stx) && /FACETED_BREP\('Generated_CW'/.test(stx) && /SI_UNIT\(\.MILLI\.,\.METRE\.\)/.test(stx) && !/=FACE\(|TESSELLATED|ADVANCED_FACE/.test(stx) && (stx.match(/=PRODUCT\(/g) || []).length === 1, `${ss.size} B, ${(stx.match(/FACE_SURFACE\(/g) || []).length} faces`);
      const sh = await exp('step', true); const shx = fs.readFileSync(sh.f, 'latin1');
      check('STEP hub + piece: two products, separate bodies', (shx.match(/=PRODUCT\(/g) || []).length === 2 && (shx.match(/FACETED_BREP\(/g) || []).length === 2 && /\+Generated_CW\.stp$/.test(sh.name), sh.name);
      // ---- re-import as Counterweight (existing) ----
      await p.click('#genremove'); check('generated piece removed', !await piece());
      await load(sb.f, /STL ·|failed/); let r = await bodyOf('Generated_CW');
      check('binary STL re-imported in a worker: Counterweight (existing), added-material density, volume / mass / CG match', r && r.role === 'cw' && r.rho === g.rho && close(r, g, 2e-5, 5e-4), `${await status()} · ${diff(r, g)}`);
      const chkTol = process.env.CHKTOL ? +process.env.CHKTOL : meta.tol; // CHKTOL: a check-mode tolerance above the file's ± (M10)
      await commit('#tolv', chkTol); await p.selectOption('#tolk', 'gmm');
      let c = await p.evaluate(() => rab.balanceState().check);
      check('check mode on the re-imported STL piece: PASS', c && c.pass === true && /PASS/.test(await p.textContent('#checkout')), `residual ${c?.resid?.mag?.toFixed(5)} ± ${c?.unc?.toFixed(3)} g·mm vs tol ${chkTol}`);
      await role('Generated_CW', 'ignore');
      await load(sa.f, /STL ·|failed/); r = await bodyOf('Generated_CW_ascii');
      check('ASCII STL re-import matches', r && r.role === 'cw' && close(r, g, 1e-7, 1e-5), diff(r, g)); await role('Generated_CW_ascii', 'ignore');
      const t2 = Date.now(); await load(ss.f); const tStep = (Date.now() - t2) / 1000; r = (await p.evaluate(() => rab.st.bodies.map(b => b.name))).filter(n => /^Generated_CW( #\d+)?$/.test(n) && n !== 'Generated_CW').at(-1);
      const rs = await bodyOf(r);
      check('faceted STEP re-import (one exact pass, density from the file) matches', rs && rs.rho === g.rho && close(rs, g, 1e-6, 1e-4) && /exact \(faceted\)/.test(await status()), `${await status()} · ${diff(rs, g)} · ${tStep.toFixed(1)} s`);
      await role(r, 'cw'); c = await p.evaluate(() => rab.balanceState().check);
      check('check mode on the re-imported STEP piece: PASS', c && c.pass === true, `residual ${c?.resid?.mag?.toFixed(5)} ± ${c?.unc?.toFixed(3)} g·mm vs tol ${chkTol}`);
      // ---- guards ----
      const bad = path.join(tmp, 'broken.stl'); fs.writeFileSync(bad, Buffer.concat([fs.readFileSync(sb.f).subarray(0, 84 + 50 * 3 + 7)]));
      await load(bad, /failed/); check('broken STL rejected with a message (escaped card)', /binary size does not match/.test(await p.textContent('#cards')));
      const xs = path.join(tmp, '<img src=x onerror=window.__xss=1>.stl'); fs.writeFileSync(xs, 'solid <img src=x onerror=window.__xss=1>\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n vertex 0 1 0\n endloop\n endfacet\nendsolid\n');
      await load(xs, /STL ·|failed/);
      check('hostile STL name / header shown as text; open STL warned', !(await p.evaluate(() => window.__xss)) && (await p.locator('#panel img').count()) === 0 && /not a closed solid/.test(await p.textContent('#cards')));
      check('no CSP violations (workers, blob downloads)', (await p.evaluate(() => window.__csp)).length === 0, JSON.stringify(await p.evaluate(() => window.__csp)));
      if (CUSTOM) res.push(`   import ${tImp.toFixed(1)} s, generate ${tGen.toFixed(1)} s, STEP re-import ${tStep.toFixed(1)} s`);
      check('no page errors', errs.length === 0, errs.join(' | '));
    } catch (e) { check('run', false, e.stack); }
    console.log(`\n${name}:`); res.forEach(r => console.log('  ' + r)); await b.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
})();
