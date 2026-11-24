// 0.2.0-alpha.2 UI smoke: body roles (single Hub / Boundary in the UI), materials, spin-axis point / vector tools,
// drive pin pick, orbiting load, static readout + ISO grade, check mode (PASS/FAIL, over/under, containment in a
// worker with Cancel), NX body table + Copy, session round trip and an older session. Fixture: test/fixtures/scroll-hub.stp.
//   python3 -m http.server 8765 &   node tools/ui-smoke-020.cjs [url]      Env: BROWSERS=chromium  HEADED=1  PLAYWRIGHT=/path/to/playwright
const pw = require(process.env.PLAYWRIGHT || 'playwright'), path = require('path'), fs = require('fs'), os = require('os');
const url = process.argv[2] || 'http://localhost:8765/', FIX = path.join(__dirname, '../test/fixtures/scroll-hub.stp');
(async () => {
  let fail = 0;
  for (const name of (process.env.BROWSERS || 'chromium').split(',')) {
    const b = await pw[name].launch({ headless: !process.env.HEADED }), ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    if (name === 'chromium') await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    const p = await ctx.newPage(), errs = [], res = [];
    p.on('pageerror', e => errs.push(e.message));
    const check = (label, ok, info = '') => { res.push(`${ok ? 'ok ' : 'FAIL'} ${label}${info ? ' — ' + info : ''}`); if (!ok) fail++; };
    const idx = n => p.evaluate(n => rab.st.bodies.findIndex(b => b.name === n), n);
    const role = async (n, r) => p.selectOption(`select[data-role="${await idx(n)}"]`, r);
    const commit = async (sel, v) => { await p.fill(sel, String(v)); await p.press(sel, 'Enter'); await p.locator(sel).blur(); };
    const S = () => p.evaluate(() => { const s = rab.balanceState(); return JSON.parse(JSON.stringify({ H: s.H && { mag: s.H.mag, ang: s.H.ang, offset: s.H.offset, m: s.H.m }, pin: s.pin, load: s.loadU, base: s.base, check: s.check, target: s.target, roles: rab.st.bodies.map(b => b.role), axis: rab.st.axis })); });
    // click the 3-D view at world point q if the expected body is hit there
    const clickAt = async (body, pts) => { for (const q of pts) { const r = await p.evaluate(([body, q]) => { const [x, y] = rab.view.project(q), h = rab.view.pick(x, y); return h && rab.st.bodies[h.body].name === body ? { x, y } : null; }, [body, q]); if (r) { await p.mouse.click(r.x, r.y); return true; } } return false; };
    const load = async files => { await p.setInputFiles('#file', files); await p.waitForFunction(() => /bodies ·|Session loaded|failed/.test(document.querySelector('#status').textContent), null, { timeout: 60000 }); };
    try {
      await p.goto(url); await load(FIX);
      check('version 0.2.0-alpha.2 in the header', (await p.textContent('#ver')).trim() === '0.2.0-alpha.2');
      // ---- roles ----
      await role('hub', 'hub'); await role('boundary', 'boundary'); await role('cw_out', 'boundary');
      let s = await S(); const ib = await idx('boundary'), io = await idx('cw_out');
      check('picking a new Boundary clears the old one (single selection)', s.roles[ib] === '' && s.roles[io] === 'boundary', JSON.stringify(s.roles));
      await role('boundary', 'boundary'); await role('hub', 'hub'); await role('cw', 'cw'); await role('scroll', 'ignore');
      s = await S(); check('roles: one hub, one boundary, cw, ignore', s.roles.join() === ['hub', '', 'ignore', 'boundary', 'cw', ''].join(), s.roles.join());
      const marks = await p.evaluate(() => ({ badges: [...document.querySelectorAll('#bodies .rb')].map(e => e.textContent), cls: [...document.querySelectorAll('#bodies tr[data-row]')].map(r => r.className), view: rab.view.roles() }));
      check('role markers in the list and in the 3-D view', marks.badges.join() === 'HUB,IGN,BND,CW' && marks.cls.some(c => /role-hub/.test(c)) && marks.view[0] === 'hub', JSON.stringify(marks));
      // ---- static readout ----
      s = await S(); check('hub static: CG offset 1.5 mm, angle 0°, |U| = m·offset', Math.abs(s.H.offset - 1.5) < 1e-4 && (s.H.ang < 0.01 || s.H.ang > 359.99) && Math.abs(s.H.mag - s.H.m * s.H.offset) < 1e-6, JSON.stringify(s.H));
      check('angle reference shown', /0° = \+u \(world 1, 0, 0\)/.test(await p.textContent('#angref')));
      // ---- materials ----
      await p.selectOption(`select[data-mat="${await idx('hub')}"]`, 'wha180');
      const hubRho = await p.evaluate(() => rab.st.bodies[0].rho), hubRhoBox = await p.inputValue('[data-rho="0"]');
      check('material preset sets the density (WHA 18.0 → 18000 kg/m³)', hubRho === 18000 && hubRhoBox === '18000', `${hubRho} ${hubRhoBox}`);
      check('added material follows the hub by default', /Same as hub \(Tungsten heavy alloy 18\.0\)/.test(await p.textContent('#added')) && /18 g\/cc/.test(await p.textContent('#addedinfo')), await p.textContent('#addedinfo'));
      await p.selectOption('#added', 'wha185'); check('added material can be changed', /18\.5 g\/cc/.test(await p.textContent('#addedinfo')));
      await p.selectOption('#added', 'custom'); await commit('#addedrho', 17300); check('custom added density', await p.evaluate(() => rab.st.bal.added.rho) === 17300);
      await p.selectOption(`select[data-mat="${await idx('hub')}"]`, 'steel');
      // ---- drive pin ----
      await p.click('[data-pick="pin"]');
      const picked = await clickAt('pin', [[2.5, 2.9, 27.5], [3, 4, 30], [2, 3, 25], [3.9, 6, 30]]);
      s = await S(); check('drive pin pick on the pin cylinder: e 6 mm, ∠ 90°, parallel', picked && s.pin && Math.abs(s.pin.e - 6) < 0.01 && Math.abs(s.pin.ang - 90) < 0.1 && !s.pin.projected, JSON.stringify(s.pin));
      check('pin drawn in the view', await p.evaluate(() => rab.view.hasPin()));
      await p.click('#pinclear'); await commit('#pine', 6.5); await commit('#pinang', 100); s = await S(); check('typed pin e / angle (fallback)', s.pin.src === 'typed' && s.pin.e === 6.5 && s.pin.ang === 100, JSON.stringify(s.pin));
      await commit('#pine', 6); await commit('#pinang', 90); s = await S(); check('typed pin back to e 6, ∠ 90', s.pin.src === 'typed' && s.pin.e === 6 && s.pin.ang === 90);
      // ---- orbiting load ----
      await p.selectOption('#load', 'b' + await idx('scroll')); s = await S();
      const scrollM = await p.evaluate(() => rab.st.bodies[2].vol.m * rab.st.bodies[2].rho * 1e-6);
      check('orbiting load from an Ignore body: m·e at the pin angle', Math.abs(Math.hypot(...s.load) - scrollM * 6) < 1e-6 && Math.abs(s.load[0]) < 1e-9, JSON.stringify(s.load));
      check('needed counterweight = −(hub + load)', Math.abs(s.target.planes[0].mag - s.base.mag) < 1e-9 && Math.abs(((s.target.planes[0].ang - s.base.ang + 360) % 360) - 180) < 1e-6);
      await p.selectOption('#load', 'mass'); await commit('#loadmass', 100); s = await S(); check('typed load mass', Math.abs(s.load[1] - 600) < 1e-9);
      await p.selectOption('#load', 'b' + await idx('scroll'));
      // ---- ISO + check mode ----
      await commit('#rpm', 6000); await p.selectOption('#tolk', 'G'); await commit('#tolv', 2.5);
      s = await S(); const t = await p.textContent('#checkout');
      check('check mode: residual, % corrected, ISO, FAIL at G2.5', s.check && s.check.pass === false && /FAIL/.test(t) && /corrected/.test(t) && /meets G/.test(t), t.slice(0, 200));
      check('under-balanced highlighted', await p.evaluate(() => document.querySelector('#ouflag')?.classList.contains('under')));
      await p.selectOption('#tolk', 'gmm'); await commit('#tolv', 60); check('PASS with a 60 g·mm tolerance', /PASS/.test(await p.textContent('#verdict')));
      // ---- containment ----
      await p.click('#contain'); const running = await p.evaluate(() => !document.querySelector('#cjob').hidden);
      await p.waitForFunction(() => /checked|failed|cancel/.test(document.querySelector('#containmsg').textContent), null, { timeout: 30000 });
      check('containment runs in a worker with a Cancel button; cw inside', running && /inside/.test(await p.textContent('#containres')) && await p.evaluate(() => rab.view.outsideCount()) === 0, await p.textContent('#containres'));
      await role('cw_out', 'cw'); await p.click('#contain');
      await p.waitForFunction(() => /checked|failed/.test(document.querySelector('#containmsg').textContent), null, { timeout: 30000 });
      const cr = await p.evaluate(() => ({ t: document.querySelector('#containres').textContent, n: rab.view.outsideCount(), r: rab.st.check.results.map(r => [r.name, r.frac]) }));
      check('cw_out reported outside with % of vertices and red markers', /outside/.test(cr.t) && cr.n > 0 && cr.r.find(r => r[0] === 'cw_out')[1] > 0.3, JSON.stringify(cr));
      await p.evaluate(() => { document.querySelector('#contain').click(); document.querySelector('#ccancel').click(); });
      check('Cancel stops the check', /cancelled/.test(await p.textContent('#containmsg')) && await p.evaluate(() => document.querySelector('#cjob').hidden), await p.textContent('#containmsg'));
      await role('cw_out', '');
      // ---- axis point / vector tools ----
      check('spin axis drawn (rod, arrow, point marker)', await p.evaluate(() => rab.view.axisDrawn()));
      await p.click('#bodies tr[data-row="0"] td:nth-child(2)'); await p.click('#ptcg'); s = await S();
      check('axis point snaps to the selected body CG, direction kept', Math.abs(s.axis.p[0] - 1.5) < 1e-3 && Math.abs(s.axis.p[2] - 10) < 1e-3 && s.axis.d[2] === 1, JSON.stringify(s.axis));
      s = await S(); check('CG offset is 0 when the axis passes through the hub CG', s.H.offset < 1e-6, String(s.H.offset));
      await p.click('[data-pick="pt"]'); const okPt = await clickAt('hub', [[10, -10, 20], [5, -20, 20], [0, -15, 20]]); s = await S();
      check('pick a point on the model (direction kept)', okPt && Math.abs(s.axis.p[2] - 20) < 1e-3 && s.axis.d[2] === 1, JSON.stringify(s.axis));
      await p.selectOption('#axis', 'X'); await p.click('[data-pick="nrm"]'); const okN = await clickAt('hub', [[10, -10, 20], [5, -20, 20]]); s = await S();
      check('plane-normal pick sets the direction from the hub top face', okN && Math.abs(Math.abs(s.axis.d[2]) - 1) < 1e-9, JSON.stringify(s.axis));
      await commit('#ox', 0); await commit('#oy', 0); await commit('#oz', 0); await commit('#dx', 0); await commit('#dy', 0); await commit('#dz', 2);
      s = await S(); check('typed axis: direction normalised on commit, boxes keep what was typed', s.axis.d.join() === '0,0,1' && await p.inputValue('#dz') === '2', JSON.stringify(s.axis));
      // ---- NX table ----
      const tsv = await p.evaluate(() => rab.nxTSV()), rows = tsv.trim().split('\n').map(r => r.split('\t'));
      check('NX table: header + one row per body, tab-separated', rows.length === 7 && rows[0][0] === 'Body' && rows[0].length === 12 && rows.every(r => r.length === 12), `${rows.length} rows`);
      const hubRow = rows.find(r => r[0] === 'hub');
      check('NX table digits: volume to 0.001 mm³, CG to 0.0001 mm, density g/cc', /^\d+\.\d{3}$/.test(hubRow[3]) && /^-?\d+\.\d{4}$/.test(hubRow[6]) && hubRow[5] === '7.85000' && Math.abs(+hubRow[6] - 1.5) < 1e-3, hubRow.join(' | '));
      if (name === 'chromium') { await p.click('#copytable'); await p.waitForTimeout(200); const clip = await p.evaluate(() => navigator.clipboard.readText()); check('Copy table puts the TSV on the clipboard', clip === tsv, clip.slice(0, 80)); }
      // ---- session round trip ----
      const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-exp="json"]')]);
      const sess = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
      check('session saves roles, materials and balance inputs', sess.version === '0.2.0-alpha.2' && sess.bodies.map(b => b.role).join() === 'hub,,ignore,boundary,cw,' && sess.balance.pin.src === 'typed' && sess.balance.load.kind === 'body' && sess.balance.rpm === 6000 && sess.balance.added.mode === 'custom', JSON.stringify(sess.balance));
      const before = await S(), f1 = path.join(os.tmpdir(), 'rab-020-session.json'), f2 = path.join(os.tmpdir(), 'rab-020-legacy.json');
      fs.writeFileSync(f1, JSON.stringify(sess));
      const legacy = { ...sess, version: '0.1.8-alpha', bodies: sess.bodies.map(({ role, mat, ...b }) => b) }; delete legacy.balance; fs.writeFileSync(f2, JSON.stringify(legacy));
      await p.reload(); await load(FIX); await load(f1); const after = await S();
      check('session restore: roles, pin, load, readout identical', after.roles.join() === before.roles.join() && after.pin.e === 6 && Math.abs(after.check.resid.mag - before.check.resid.mag) < 1e-9 && after.pin.src === 'typed', JSON.stringify({ r: after.roles, resid: after.check?.resid.mag }));
      await p.reload(); await load(FIX); await load(f2); const leg = await S();
      check('older (0.1.8) session still loads: no roles, defaults', leg.roles.every(r => r === '') && !leg.H && await p.evaluate(() => rab.st.bal.load.kind) === 'none', JSON.stringify(leg.roles));
    } catch (e) { check('run', false, e.stack); }
    check('no page errors', !errs.length, errs.join(' | '));
    console.log(`--- ${name}\n` + res.join('\n'));
    await b.close();
  }
  console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
})();
