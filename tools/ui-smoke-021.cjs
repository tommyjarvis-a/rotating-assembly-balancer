// 0.2.0-alpha.3 UI smoke: axial band (auto / typed / slabs), counterweight generator in a worker (progress, Cancel),
// result readout (mass, angle, leftover PASS/FAIL), the piece in check mode + containment + body table, stale flag,
// session round trip with the generated mesh, Remove. Fixture: test/fixtures/scroll-hub.stp.
//   python3 -m http.server 8765 &   node tools/ui-smoke-021.cjs [url]      Env: BROWSERS=chromium  HEADED=1  PLAYWRIGHT=/path/to/playwright
const pw = require(process.env.PLAYWRIGHT || 'playwright'), path = require('path'), fs = require('fs'), os = require('os');
const url = process.argv[2] || 'http://localhost:8765/', FIX = path.join(__dirname, '../test/fixtures/scroll-hub.stp');
(async () => {
  let fail = 0;
  for (const name of (process.env.BROWSERS || 'chromium').split(',')) {
    const b = await pw[name].launch({ headless: !process.env.HEADED }), ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    const p = await ctx.newPage(), errs = [], res = [];
    p.on('pageerror', e => errs.push(e.message));
    const check = (label, ok, info = '') => { res.push(`${ok ? 'ok ' : 'FAIL'} ${label}${info ? ' — ' + info : ''}`); if (!ok) fail++; };
    const idx = n => p.evaluate(n => rab.st.bodies.findIndex(b => b.name === n), n);
    const role = async (n, r) => p.selectOption(`select[data-role="${await idx(n)}"]`, r);
    const commit = async (sel, v) => { await p.fill(sel, String(v)); await p.press(sel, 'Enter'); await p.locator(sel).blur(); };
    const load = async files => { await p.setInputFiles('#file', files); await p.waitForFunction(() => /bodies ·|Session loaded|failed/.test(document.querySelector('#status').textContent), null, { timeout: 60000 }); };
    const G = () => p.evaluate(() => { const g = rab.st.bodies.find(b => b.generated), s = rab.balanceState(); return JSON.parse(JSON.stringify({ has: !!g, name: g?.name, role: g?.role, n: rab.st.bodies.length, mass: g ? g.vol.m * g.rho * 1e-6 : null, band: s.band, target: s.target, check: s.check, meta: rab.st.gen?.meta, msg: document.querySelector('#genmsg').textContent })); });
    const clickAt = async (body, pts) => { for (const q of pts) { const r = await p.evaluate(([body, q]) => { const [x, y] = rab.view.project(q), h = rab.view.pick(x, y); return h && rab.st.bodies[h.body].name === body ? { x, y } : null; }, [body, q]); if (r) { await p.mouse.click(r.x, r.y); return true; } } return false; };
    try {
      await p.goto(url); await load(FIX);
      check('version 0.2.0-alpha.5 in the header', (await p.textContent('#ver')).trim() === '0.2.0-alpha.5');
      check('generator asks for a Hub and a Boundary first', /set one Hub and one Boundary/.test(await p.textContent('#gendef')));
      await role('hub', 'hub'); await role('boundary', 'boundary'); await role('scroll', 'ignore'); await role('pin', 'ignore');
      await commit('#pine', 6); await commit('#pinang', 90); await p.selectOption('#load', 'b' + await idx('scroll'));
      let g = await G();
      check('auto band = hub axial extent next to the pin (0 … 20 mm)', Math.abs(g.band.w[0]) < 1e-6 && Math.abs(g.band.w[1] - 20) < 1e-6 && /next to the drive pin|within ±30°/.test(await p.textContent('#bandmsg')), JSON.stringify(g.band));
      check('band drawn as slab planes', await p.evaluate(() => rab.view.bandDrawn()));
      check('band fed to correctionTarget (axialBand)', JSON.stringify(g.target.constraints.axialBand) === JSON.stringify(g.band.w));
      await p.selectOption('#bandmode', 'typed'); await commit('#band0', 18); await commit('#band1', 4); g = await G();
      check('typed band (sorted)', g.band.w[0] === 4 && g.band.w[1] === 18, JSON.stringify(g.band));
      await p.selectOption('#bandmode', 'face'); g = await G(); check('face band asks for a face', !!g.band.error && /pick a planar face/.test(await p.textContent('#bandmsg')));
      await p.click('[data-pick="band"]');
      const hit = await clickAt('hub', [[20, -20, 20], [25, -10, 20], [10, -25, 20], [-20, -20, 20], [0, -28, 20]]);
      await commit('#bandt', -8); g = await G();
      check('band from a picked planar face (hub top, z 20) + thickness −8 → 12 … 20', hit && g.band.w && Math.abs(g.band.w[0] - 12) < 1e-4 && Math.abs(g.band.w[1] - 20) < 1e-4, JSON.stringify(g.band));
      await p.selectOption('#bandmode', 'auto');
      // ---- Cancel ----
      await p.evaluate(() => { document.querySelector('#gen').click(); document.querySelector('#gcancel').click(); });
      g = await G(); check('Cancel stops the generator (no piece added)', !g.has && /cancelled/.test(g.msg) && await p.evaluate(() => document.querySelector('#gjob').hidden), g.msg);
      // ---- generate ----
      const t0 = Date.now(); await p.click('#gen');
      await p.waitForFunction(() => document.querySelector('#genverdict') || /generator:/.test(document.querySelector('#genmsg').textContent), null, { timeout: 60000 });
      const secs = (Date.now() - t0) / 1000; g = await G();
      check('generator produced a piece', g.has && g.role === 'cw' && g.name === 'Generated CW', g.msg);
      const left = await p.textContent('#genleft'), verdict = await p.textContent('#genverdict');
      check('leftover under tolerance: PASS', verdict === 'PASS' && +left <= g.meta.tol, `${left} g·mm, tol ${g.meta.tol}, ${g.meta.iterations} iterations`);
      check('one connected, closed piece touching the hub, inside boundary / band, not in the hub', g.meta.components === 1 && g.meta.open === 0 && g.meta.hubVertices > 0 && g.meta.outsideBoundary === 0 && g.meta.insideHub === 0 && g.meta.outsideBand === 0, JSON.stringify({ c: g.meta.components, o: g.meta.open, h: g.meta.hubVertices }));
      const gst = await p.evaluate(() => { const s = rab.balanceState(); return { cw: s.check?.cw, tgt: s.target.planes[0] }; });
      check('piece lands at the needed-correction angle', Math.abs(((gst.cw.ang - gst.tgt.ang) % 360 + 540) % 360 - 180) < 2, `${gst.cw.ang} vs ${gst.tgt.ang}`);
      check('angle relative to the pin shown', /from the pin/.test(await p.textContent('#genout')) && !!(await p.textContent('#genrel')));
      check('distinct colour in the view', await p.evaluate(() => rab.view.roles().at(-1) === 'gen'));
      check('fed into check mode as a counterweight', /Check mode — 1 existing/.test(await p.textContent('#checkout')) && g.check && g.check.pct > 0.99, JSON.stringify(g.check?.pct));
      const tsv = await p.evaluate(() => rab.nxTSV()); check('row in the NX body table', /\nGenerated CW\t\(generated\)\tCounterweight/.test(tsv));
      check(`generation time ${secs.toFixed(1)} s (< 20 s)`, secs < 20);
      await p.click('#contain'); await p.waitForFunction(() => /checked in|failed/.test(document.querySelector('#containmsg').textContent), null, { timeout: 60000 });
      check('containment check: generated piece inside the Boundary', /inside<\/span> <b>Generated CW/.test(await p.innerHTML('#containres')), await p.textContent('#containres'));
      // ---- session ----
      const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-exp="json"]')]);
      const sess = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
      check('session stores the generated mesh (not as a body)', sess.generated?.mesh?.pos && !sess.bodies.some(b => /Generated/.test(b.name)) && sess.balance.band.mode === 'auto');
      const f1 = path.join(os.tmpdir(), 'rab-021-session.json'); fs.writeFileSync(f1, JSON.stringify(sess));
      await p.reload(); await load(FIX); await load(f1); const g2 = await G();
      check('session restore brings the piece back (same mass, not stale)', g2.has && Math.abs(g2.mass - g.mass) < 1e-9 && !(await p.$('#genstale')), `${g2.mass} vs ${g.mass}`);
      // ---- stale + remove ----
      await p.selectOption('#load', 'none');
      check('changing an input marks the piece stale', !!(await p.$('#genstale')));
      await p.click('#genremove'); g = await G();
      check('Remove generated', !g.has && g.n === 6 && !/Generated/.test(await p.evaluate(() => rab.nxTSV())));
    } catch (e) { check('run', false, e.stack); }
    check('no page errors', !errs.length, errs.join(' | '));
    console.log(`--- ${name}\n` + res.join('\n'));
    await b.close();
  }
  console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
})();
