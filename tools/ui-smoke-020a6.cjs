// 0.2.0-alpha.6 UI smoke: fine hub mesh as the default. Setting the Hub role re-meshes the hub in a worker (progress,
// Cancel, retry), Fast (coarse) uses the import mesh, the choice is saved in the session (schema-checked), Generate
// waits for a running re-mesh, and a file that declares a CAD modelling tolerance shows the ± breakdown (mesh vs the
// CAD-tolerance floor). Fixture: test/fixtures/scroll-hub.stp (+ a temp copy declaring 0.1 mm).
// Local only, any STEP:  STP=/path/file.stp HUB=<body #> node tools/ui-smoke-020a6.cjs   (1-based body row; prints
// import and re-mesh times; writes nothing into the repo).
//   python3 -m http.server 8765 &   node tools/ui-smoke-020a6.cjs [url]      Env: BROWSERS=chromium  HEADED=1  PLAYWRIGHT=/path/to/playwright
const pw = require(process.env.PLAYWRIGHT || 'playwright'), path = require('path'), fs = require('fs'), os = require('os');
const url = process.argv[2] || 'http://localhost:8765/', FX = path.join(__dirname, '../test/fixtures/scroll-hub.stp'), CUSTOM = !!process.env.STP;
(async () => {
  let fail = 0; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rab026-'));
  for (const name of (process.env.BROWSERS || 'chromium').split(',')) {
    const b = await pw[name].launch({ headless: !process.env.HEADED }), ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    const p = await ctx.newPage(), errs = [], res = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
    const check = (label, ok, info = '') => { res.push(`${ok ? 'ok ' : 'FAIL'} ${label}${info ? ' — ' + info : ''}`); if (!ok) fail++; };
    const idx = n => p.evaluate(n => rab.st.bodies.findIndex(b => b.name === n), n);
    const role = async (i, r) => p.selectOption(`select[data-role="${typeof i === 'number' ? i : await idx(i)}"]`, r);
    const commit = async (sel, v) => { await p.fill(sel, String(v)); await p.press(sel, 'Enter'); await p.locator(sel).blur(); };
    const load = async (files, re = /bodies ·|failed/) => { await p.evaluate(() => document.querySelector('#status').textContent = ''); await p.setInputFiles('#file', files); await p.waitForFunction(re => new RegExp(re).test(document.querySelector('#status').textContent), re.source, { timeout: 600000 }); };
    const hub = () => p.evaluate(() => { const b = rab.st.bodies.find(b => b.role === 'hub'); return b && { name: b.name, fine: !!b.fine, isFine: b.vol === b.fine?.vol, isImport: b.vol === b.importVol, V: b.vol.m, Vi: b.importVol?.m, mesh: b.mesh, state: b.fineState || '', ms: b.fine?.ms }; });
    const waitFine = (t = 600000) => p.waitForFunction(() => { const b = rab.st.bodies.find(b => b.role === 'hub'); return b && (b.vol === b.fine?.vol || b.fineState); }, null, { timeout: t });
    const hjobShown = () => p.evaluate(() => !document.querySelector('#hjob').hidden);
    try {
      await p.goto(url);
      check('version 0.2.0-alpha.6 in the header', (await p.textContent('#ver')).trim() === '0.2.0-alpha.6');
      check('Hub mesh select: Fine (default) and Fast (coarse)', await p.inputValue('#hubmesh') === 'fine' && (await p.locator('#hubmesh option').allTextContents()).join('|') === 'Fine (default, slower)|Fast (coarse)');
      let t0 = Date.now(); await load(CUSTOM ? process.env.STP : FX); const tImp = (Date.now() - t0) / 1000;
      if (CUSTOM) {
        t0 = Date.now(); await role(+process.env.HUB - 1, 'hub'); await p.waitForTimeout(300);
        check('re-mesh job shown with progress', await hjobShown() && /Hub fine mesh|fine re-mesh/.test(await p.textContent('#hjobmsg')), await p.textContent('#hjobmsg'));
        await waitFine(); const h = await hub(), tRe = (Date.now() - t0) / 1000;
        check('hub re-meshed finely', h.isFine && !h.state, JSON.stringify(h.mesh) + ' ' + h.state);
        res.push(`   import ${tImp.toFixed(1)} s, fine hub re-mesh ${tRe.toFixed(1)} s (worker ${(h.ms / 1000).toFixed(1)} s), ${h.mesh.tris} triangles, deflection ${h.mesh.deflection} mm · ${await p.textContent('#hubmeshmsg')}`);
      } else {
        // ---- Cancel, retry, Fine ⇄ Fast ----
        await p.evaluate(async () => { const s = document.querySelector(`select[data-role="${rab.st.bodies.findIndex(b => b.name === 'hub')}"]`); s.value = 'hub'; s.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 30)); });
        const shown = await p.evaluate(() => { const r = [!document.querySelector('#hjob').hidden, document.querySelector('#hjobmsg').textContent]; document.querySelector('#hcancel').click(); return r; });
        check('setting the Hub role starts the fine re-mesh in a worker (progress card)', shown[0] && /hub:/.test(shown[1]), shown[1]);
        let h = await hub();
        check('Cancel stops it: import mesh used, message + "Re-mesh hub finely" shown', !await hjobShown() && h.isImport && !h.fine && /cancelled/.test(await p.textContent('#hubmeshmsg')) && await p.isVisible('#hubremesh'), await p.textContent('#hubmeshmsg'));
        await p.click('#hubremesh'); await waitFine(); h = await hub();
        check('retry: hub mass properties from the fine mesh (2 passes + Richardson), never coarser than the import mesh', h.isFine && h.mesh.fine && h.mesh.passes === 2 && /fine mesh: .*2 passes \+ Richardson/.test(await p.textContent('#hubmeshmsg')), JSON.stringify(h.mesh));
        check('body table source says "fine hub mesh"', /fine hub mesh/.test(await p.textContent('#bodies')));
        await p.selectOption('#hubmesh', 'fast'); h = await hub();
        check('Fast (coarse): hub back on the import mass properties, no job', h.isImport && !await hjobShown() && /Fast: the hub uses its import mesh/.test(await p.textContent('#hubmeshmsg')));
        await p.selectOption('#hubmesh', 'fine'); h = await hub();
        check('Fine again: cached fine result, instant (no job)', h.isFine && !await hjobShown());
        // ---- session ----
        await p.selectOption('#hubmesh', 'fast');
        const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-exp="json"]')]);
        const sess = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
        check('session saves hubMesh', sess.balance.hubMesh === 'fast' && sess.version === '0.2.0-alpha.6', sess.balance.hubMesh);
        await p.selectOption('#hubmesh', 'fine'); const f1 = path.join(tmp, 's1.json'); fs.writeFileSync(f1, JSON.stringify(sess));
        await p.setInputFiles('#file', f1); await p.waitForTimeout(500);
        check('session restore applies Fast', await p.inputValue('#hubmesh') === 'fast' && (await hub()).isImport);
        const f2 = path.join(tmp, 's2.json'); fs.writeFileSync(f2, JSON.stringify({ ...sess, balance: { ...sess.balance, hubMesh: '<img src=x onerror=window.__xss=1>' } }));
        await p.setInputFiles('#file', f2); await p.waitForTimeout(500);
        check('invalid hubMesh rejected (schema): Fine used, warning shown as text', await p.inputValue('#hubmesh') === 'fine' && /invalid hub mesh setting ignored/.test(await p.textContent('#cards')) && !(await p.evaluate(() => window.__xss)) && (await hub()).isFine);
        // ---- Generate waits for a running re-mesh ----
        await role('hub', ''); await role('boundary', 'boundary'); await role('scroll', 'ignore'); await role('pin', 'ignore');
        await commit('#pine', 6); await commit('#pinang', 90); await p.selectOption('#load', 'b' + await idx('scroll'));
        await p.evaluate(() => { const b = rab.st.bodies.find(b => b.name === 'hub'); b.fine = null; b.fineState = ''; });
        await p.evaluate(async () => { const s = document.querySelector(`select[data-role="${rab.st.bodies.findIndex(b => b.name === 'hub')}"]`); s.value = 'hub'; s.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 30)); document.querySelector('#gen').click(); });
        check('Generate during a re-mesh is queued (message), then runs on the fine hub', /waiting for the fine hub mesh/.test(await p.textContent('#genmsg')), await p.textContent('#genmsg'));
        await p.waitForFunction(() => { const v = document.querySelector('#genverdict'); return (v && v.dataset.v !== 'pending') || /generator:/.test(document.querySelector('#genmsg').textContent); }, null, { timeout: 180000 });
        check('… generated with the fine hub: PASS', (await hub()).isFine && (await p.textContent('#genverdict')) === 'PASS', await p.textContent('#genverdict'));
        // ---- L16 hub label agrees with the measured gap; L19 hub + piece STEP: both closed solids ----
        const gm = await p.evaluate(() => rab.st.gen.meta), hl = await p.textContent('#genhub');
        check('L16: hub label follows the measured gap ("touches" only at ≤ 0.001 cell, else "seated … within the contact tolerance")', gm.hubGap <= 1e-3 * gm.cell ? /touches the hub/.test(hl) : /seated on the hub/.test(hl), `${hl} · gap ${gm.hubGap}`);
        await p.selectOption('#expfmt', 'step'); await p.setChecked('#exphub', true);
        const [dx] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.click('#genexport')]); const sx = fs.readFileSync(await dx.path(), 'latin1'), em = await p.textContent('#expmsg');
        check('L19: hub + piece STEP: two closed FACETED_BREPs, no reference shell, message says so', (sx.match(/CLOSED_SHELL/g) || []).length === 2 && !/OPEN_SHELL/.test(sx) && /as closed solids/.test(em), em);
                // ---- CAD floor breakdown (temp copy declaring a 0.1 mm modelling tolerance) ----
        const cad = path.join(tmp, 'scroll-hub-cad.stp'); fs.writeFileSync(cad, fs.readFileSync(FX, 'latin1').replace('LENGTH_MEASURE(1.E-07)', 'LENGTH_MEASURE(0.1)'), 'latin1');
        await p.goto(url); await load(cad); await role('hub', 'hub'); await role('boundary', 'boundary'); await role('scroll', 'ignore'); await role('pin', 'ignore'); await waitFine();
        await commit('#gentol', 0.01); await p.click('#gen');
        await p.waitForFunction(() => { const v = document.querySelector('#genverdict'); return (v && v.dataset.v !== 'pending') || /generator:/.test(document.querySelector('#genmsg').textContent); }, null, { timeout: 180000 });
        const S = await p.evaluate(() => rab.balanceState().unc), gt = await p.textContent('#genout');
        check('CAD tolerance: hub ± set by the floor, breakdown shows the much smaller mesh ±', S.hubFloor > 0 && S.hubMesh < S.hubFloor / 10 && /set by the CAD-tolerance floor/.test(gt), `hub ± ${S.hub.toFixed(4)} (mesh ${S.hubMesh.toExponential(2)}, floor ${S.hubFloor.toFixed(4)}) g·mm`);
        check('CAN\'T RESOLVE says the floor (not the mesh) limits it', /CAN.T RESOLVE/.test(await p.textContent('#genverdict')) && /a finer mesh cannot lower it/.test(gt), (await p.textContent('#genverdict')));
      }
      check('no CSP violations (hub worker)', (await p.evaluate(() => window.__csp)).length === 0, JSON.stringify(await p.evaluate(() => window.__csp)));
      check('no page errors', errs.length === 0, errs.join(' | '));
    } catch (e) { check('run', false, e.stack); }
    console.log(`\n${name}:`); res.forEach(r => console.log('  ' + r)); await b.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
})();
