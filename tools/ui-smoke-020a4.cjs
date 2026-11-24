// 0.2.0-alpha.4 fix-build UI smoke (Tester gate aa48991): M10 residual ± U and CAN'T RESOLVE (generator + check mode),
// M11 generator containment = the Check containment (agreeing readouts), L12 invalid assembly CG / atomic restore,
// L13 a tampered restored piece is re-measured (not trusted), L14 hub-contact line, L15 long tasks (< 100 ms, Long Tasks observer).
// Fixture: test/fixtures/scroll-hub.stp.
//   python3 -m http.server 8765 &   node tools/ui-smoke-020a4.cjs [url]      Env: BROWSERS=chromium  HEADED=1  PLAYWRIGHT=/path/to/playwright
const pw = require(process.env.PLAYWRIGHT || 'playwright'), path = require('path'), fs = require('fs'), os = require('os');
const url = process.argv[2] || 'http://localhost:8765/', FIX = path.join(__dirname, '../test/fixtures/scroll-hub.stp');
const LONG_MAX = +(process.env.LONG_MAX || 100);
(async () => {
  let fail = 0;
  for (const name of (process.env.BROWSERS || 'chromium').split(',')) {
    const b = await pw[name].launch({ headless: !process.env.HEADED }), ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    await ctx.addInitScript(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) { window.__lt = null; } });
    const p = await ctx.newPage(), errs = [], res = [];
    p.on('pageerror', e => errs.push(e.message));
    const check = (label, ok, info = '') => { res.push(`${ok ? 'ok ' : 'FAIL'} ${label}${info ? ' — ' + info : ''}`); if (!ok) fail++; };
    const idx = n => p.evaluate(n => rab.st.bodies.findIndex(b => b.name === n), n);
    const role = async (n, r) => p.selectOption(`select[data-role="${await idx(n)}"]`, r);
    const commit = async (sel, v) => { await p.fill(sel, String(v)); await p.press(sel, 'Enter'); await p.locator(sel).blur(); };
    const load = async files => { await p.evaluate(() => document.querySelector('#status').textContent = ''); await p.setInputFiles('#file', files); await p.waitForFunction(() => /bodies ·|Session loaded|failed|nothing changed/.test(document.querySelector('#status').textContent), null, { timeout: 60000 }); };
    const verdict = () => p.waitForFunction(() => { const v = document.querySelector('#genverdict'); return v && v.dataset.v !== 'pending'; }, null, { timeout: 60000 });
    // long tasks that started after the last mark (entries are delivered asynchronously, so earlier ones are filtered by start time)
    const lt = async () => p.evaluate(() => { const t0 = window.__ltMark ?? 0, a = window.__lt && window.__lt.filter(([s]) => s >= t0).map(([, d]) => d); window.__lt = []; window.__ltMark = performance.now(); return a ? { max: Math.max(0, ...a), n: a.length, sum: a.reduce((s, x) => s + x, 0) } : null; });
    const txt = s => p.evaluate(s => document.querySelector(s)?.textContent ?? null, s);
    try {
      await p.goto(url); await load(FIX);
      check('version 0.2.0-alpha.4 in the header', (await p.textContent('#ver')).trim() === '0.2.0-alpha.4');
      await role('hub', 'hub'); await role('boundary', 'boundary'); await role('scroll', 'ignore'); await role('pin', 'ignore');
      await commit('#pine', 6); await commit('#pinang', 90); await p.selectOption('#load', 'b' + await idx('scroll'));
      await p.evaluate(() => rab.view.renderLoop(false)); await lt();
      await p.click('#gen'); await p.waitForFunction(() => document.querySelector('#genverdict') || /generator:/.test(document.querySelector('#genmsg').textContent), null, { timeout: 60000 }); await verdict();
      await p.waitForTimeout(300); const L = await lt(); await p.evaluate(() => rab.view.renderLoop(true));
      check(`L15: long tasks during generate + render + verify < ${LONG_MAX} ms (Long Tasks observer, app work: render loop paused — SwiftShader frames are ~50 ms here)`, L && L.max < LONG_MAX, JSON.stringify(L));
      const meta = await p.evaluate(() => JSON.parse(JSON.stringify(rab.st.gen.meta)));
      // ---- M10 ----
      const u = await txt('#genleftu'), left = +(await txt('#genleft')), v = await txt('#genverdict');
      check('M10: leftover shown with ± U', /^± \d/.test(u || ''), `${left} ${u} → ${v}`);
      check('M10: generator verdict PASS (|R| + U ≤ tol)', v === 'PASS' && left + +u.slice(2) <= meta.tol, `tol ${meta.tol}`);
      const ru = await txt('#residu'); check('M10: check-mode residual shown with ± U', /^± \d/.test(ru || ''), `${await txt('#resid0')} ${ru}`);
      const R = +(await txt('#resid0')), U = +ru.slice(2);
      await p.selectOption('#tolk', 'gmm'); await commit('#tolv', R);
      const cv = await p.evaluate(() => { const v = document.querySelector('#verdict'); return { t: v?.textContent, cls: v?.className, all: document.querySelector('#checkout').textContent }; });
      check("M10: check mode, tol = |R| (within ± U) → CAN'T RESOLVE with residual ± U and a finer-mesh / looser-tolerance hint", U > 0 && /CAN.T RESOLVE/.test(cv.t) && /unres/.test(cv.cls) && /exceeds tolerance resolution/.test(cv.all) && /finer|looser/.test(cv.all), `R ${R} U ${U}: ${cv.t}`);
      await commit('#tolv', Math.max(1e-6, R - 3 * U - 1e-3)); check('M10: tol below |R| − U → FAIL', /FAIL/.test(await txt('#verdict')), await txt('#verdict'));
      await commit('#tolv', R + 3 * U + 1); check('M10: tol above |R| + U → PASS', /PASS/.test(await txt('#verdict')), await txt('#verdict'));
      // ---- M11 / L14 ----
      check('M11: generator readout: inside the Boundary by the Check-containment test, measured protrusion ≤ check tol', (await txt('#gencontain')) === 'inside' && meta.contained === true && meta.maxOut <= meta.checkTol, `maxOut ${meta.maxOut} tol ${meta.checkTol} inset ${meta.inset} split ${meta.split}`);
      await p.click('#contain'); await p.waitForFunction(() => /checked in|failed/.test(document.querySelector('#containmsg').textContent), null, { timeout: 60000 });
      check('M11: Check containment agrees (Generated CW inside)', /inside<\/span> <b>Generated CW/.test(await p.innerHTML('#containres')), await txt('#containres'));
      const gout = await txt('#genout');
      check('L14: hub contact judged within a small tolerance, closest distance reported', /touches the hub/.test(gout) && meta.contactTol < 0.5 && meta.hubGap <= meta.contactTol, `contactTol ${meta.contactTol} gap ${meta.hubGap}`);
      // ---- session ----
      const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-exp="json"]')]);
      const sess = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')), tmp = n => path.join(os.tmpdir(), `rab-020a4-${n}.json`);
      // L13: shift the stored mesh 40 mm sideways, leave the stored summary claiming "contained" / PASS
      const bad = JSON.parse(JSON.stringify(sess)), pb = Buffer.from(bad.generated.mesh.pos, 'base64'), mp = new Float64Array(pb.buffer, pb.byteOffset, pb.length / 8);
      for (let i = 0; i < mp.length; i += 3) mp[i] += 40; bad.generated.mesh.pos = Buffer.from(mp.buffer, mp.byteOffset, mp.byteLength).toString('base64');
      Object.assign(bad.generated.meta || {}, { contained: true, outsideBoundary: 0, maxOut: 0 });
      fs.writeFileSync(tmp('moved'), JSON.stringify(bad));
      await p.reload(); await load(FIX); await p.evaluate(() => rab.view.renderLoop(false)); await lt(); await load(tmp('moved')); await verdict(); await p.waitForTimeout(300); const L2 = await lt(); await p.evaluate(() => rab.view.renderLoop(true));
      const m2 = await p.evaluate(() => ({ c: document.querySelector('#gencontain')?.textContent, v: document.querySelector('#genverdict')?.textContent, out: document.querySelector('#genout').textContent, red: rab.view.outsideCount(), cv: document.querySelector('#verdict')?.textContent }));
      check('L13: tampered restored piece re-measured → outside, FAIL, count + max protrusion shown, vertices marked red', m2.c === 'outside' && m2.v === 'FAIL' && /vertices outside/.test(m2.out) && /max protrusion/.test(m2.out) && m2.red > 0, JSON.stringify({ c: m2.c, v: m2.v, red: m2.red }));
      check('M11: containment failure blocks a check-mode PASS', !/PASS/.test(m2.cv || ''), m2.cv);
      check(`L15: long tasks during session restore + re-verify < ${LONG_MAX} ms`, L2 && L2.max < LONG_MAX, JSON.stringify(L2));
      // L12: the good session again, then one with an invalid assembly CG → note, nothing half-applied
      fs.writeFileSync(tmp('good'), JSON.stringify(sess)); await load(tmp('good')); await verdict();
      check('good session restores: inside, PASS', (await txt('#gencontain')) === 'inside' && (await txt('#genverdict')) === 'PASS');
      const before = await p.evaluate(() => JSON.stringify({ r: rab.st.bodies.map(b => b.role || ''), n: rab.st.bodies.length }));
      const cg = JSON.parse(JSON.stringify(sess)); cg.assemblyCG = { c: ['x', null, {}], mass: -5, bodies: 'all' }; fs.writeFileSync(tmp('cg'), JSON.stringify(cg));
      await load(tmp('cg')); await verdict();
      const after = await p.evaluate(() => JSON.stringify({ r: rab.st.bodies.map(b => b.role || ''), n: rab.st.bodies.length }));
      check('L12: invalid assembly CG rejected with a note, the rest restored consistently', /invalid assembly CG ignored/.test(await txt('#cards')) && after === before && /Session loaded/.test(await txt('#status')), after);
      await load(path.join(__dirname, '../test/fixtures/malicious-session.json'));
      check('L12: malicious fixture never leaves a half-applied state (loads cleanly or changes nothing)', /Session loaded|nothing changed|previous state restored/.test(await txt('#status')), await txt('#status'));
    } catch (e) { check('run', false, e.stack); }
    check('no page errors', !errs.length, errs.join(' | '));
    console.log(`--- ${name}\n` + res.join('\n'));
    await b.close();
  }
  console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
})();
