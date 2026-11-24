// 0.2.0-alpha.2 UI smoke for the c8cc29d gate fixes: CSP (import, WASM and workers still run), malicious session
// (H4: no script, payloads rejected), M7 orbiting load cleared when its body becomes Boundary/Hub, M8 picked pin
// follows the axis and an angle edit keeps e, L8 RPM prompt, L10 no "-0.0000", L11 panel / body list widths.
//   python3 -m http.server 8765 &   node tools/ui-smoke-020a2.cjs [url]      Env: BROWSERS=chromium  HEADED=1  PLAYWRIGHT=/path/to/playwright
const pw = require(process.env.PLAYWRIGHT || 'playwright'), path = require('path');
const url = process.argv[2] || 'http://localhost:8765/', FIX = path.join(__dirname, '../test/fixtures/scroll-hub.stp'), BAD = path.join(__dirname, '../test/fixtures/malicious-session.json');
(async () => {
  let fail = 0;
  for (const name of (process.env.BROWSERS || 'chromium').split(',')) {
    const b = await pw[name].launch({ headless: !process.env.HEADED }), ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
    const p = await ctx.newPage(), errs = [], res = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
    const check = (label, ok, info = '') => { res.push(`${ok ? 'ok ' : 'FAIL'} ${label}${info ? ' — ' + info : ''}`); if (!ok) fail++; };
    const idx = n => p.evaluate(n => rab.st.bodies.findIndex(b => b.name === n), n);
    const role = async (n, r) => p.selectOption(`select[data-role="${await idx(n)}"]`, r);
    const commit = async (sel, v) => { await p.fill(sel, String(v)); await p.press(sel, 'Enter'); await p.locator(sel).blur(); };
    const load = async files => { await p.setInputFiles('#file', files); await p.waitForFunction(() => /bodies ·|Session loaded|failed|JSON/.test(document.querySelector('#status').textContent), null, { timeout: 60000 }); };
    const clickAt = async (body, pts) => { for (const q of pts) { const r = await p.evaluate(([body, q]) => { const [x, y] = rab.view.project(q), h = rab.view.pick(x, y); return h && rab.st.bodies[h.body].name === body ? { x, y } : null; }, [body, q]); if (r) { await p.mouse.click(r.x, r.y); return true; } } return false; };
    try {
      await p.goto(url);
      const csp = await p.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
      check('strict CSP meta (no unsafe-inline / unsafe-eval)', /script-src 'self' 'wasm-unsafe-eval'/.test(csp) && !/unsafe-inline|'unsafe-eval'/.test(csp), csp);
      await load(FIX);
      check('STEP import (WASM + worker) works under the CSP', /6 bodies/.test(await p.textContent('#status')), await p.textContent('#status'));
      // ---- H4 ----
      await load(BAD);
      await p.waitForTimeout(300);
      const x = await p.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('img[src="x"]').length, cards: [...document.querySelectorAll('.card')].map(c => c.textContent).join(' | '), tools: rab.st.tools.map(t => t.kind), rho: rab.st.bodies.map(b => b.rho), src: rab.st.bodies.map(b => b.src) }));
      check('malicious session: no script runs, no injected elements', x.xss === undefined && x.imgs === 0, JSON.stringify(x).slice(0, 300));
      check('malicious session: payload fields rejected and reported', /invalid body field/.test(x.cards) && /invalid tool field/.test(x.cards) && x.tools.join() === 'sector,prism' && x.rho.every(r => typeof r === 'number') && x.src.every(s => !/</.test(s)), x.cards.slice(0, 200));
      check('tool name payload shown as text', await p.evaluate(() => [...document.querySelectorAll('#tools input[data-k="name"]')].some(i => /onerror/.test(i.value))));
      // ---- containment worker under the CSP ----
      await p.reload(); await load(FIX);
      await role('hub', 'hub'); await role('boundary', 'boundary'); await role('cw', 'cw'); await role('scroll', 'ignore');
      await p.click('#contain'); await p.waitForFunction(() => /checked in|failed/.test(document.querySelector('#containmsg').textContent), null, { timeout: 60000 });
      check('containment worker runs under the CSP', /checked in/.test(await p.textContent('#containmsg')) && /inside/.test(await p.textContent('#containres')));
      // ---- M7 ----
      await commit('#pine', 6); await commit('#pinang', 90); await p.selectOption('#load', 'b' + await idx('scroll'));
      let s = await p.evaluate(() => JSON.parse(JSON.stringify(rab.balanceState().loadU)));
      check('load from a body counts', Math.hypot(...s) > 1);
      await role('scroll', 'boundary');
      let m7 = await p.evaluate(() => ({ kind: rab.st.bal.load.kind, sel: document.querySelector('#load').value, U: rab.balanceState().loadU }));
      check('M7: load body made Boundary → load cleared (maths matches the selector)', m7.kind === 'none' && m7.sel === 'none' && Math.hypot(...m7.U) === 0, JSON.stringify(m7));
      await role('boundary', 'boundary'); await role('scroll', 'ignore'); await p.selectOption('#load', 'b' + await idx('scroll')); await role('scroll', 'hub');
      m7 = await p.evaluate(() => ({ kind: rab.st.bal.load.kind, sel: document.querySelector('#load').value }));
      check('M7: load body made Hub → load cleared', m7.kind === 'none' && m7.sel === 'none', JSON.stringify(m7));
      await role('hub', 'hub'); await role('scroll', 'ignore');
      // ---- M8 ----
      await p.click('#pinclear'); await p.click('[data-pick="pin"]');
      const picked = await clickAt('pin', [[2.5, 2.9, 27.5], [3, 4, 30], [2, 3, 25], [3.9, 6, 30]]);
      let pin = await p.evaluate(() => rab.balanceState().pin);
      check('pin picked (e 6, ∠ 90)', picked && Math.abs(pin.e - 6) < 0.01 && Math.abs(pin.ang - 90) < 0.1, JSON.stringify(pin));
      await commit('#ox', 2);
      const boxes = { e: +(await p.inputValue('#pine')), a: +(await p.inputValue('#pinang')), msg: await p.textContent('#pinmsg') };
      const e2 = Math.hypot(2, 6), a2 = 180 - Math.atan2(6, 2) * 180 / Math.PI;
      check('M8: after the axis moves the e / ∠ boxes and message show the recomputed pin', Math.abs(boxes.e - e2) < 0.01 && Math.abs(boxes.a - a2) < 0.1 && boxes.msg.includes(e2.toFixed(3).slice(0, 4)), JSON.stringify(boxes));
      await commit('#pinang', 120); pin = await p.evaluate(() => ({ ...rab.balanceState().pin, raw: rab.st.bal.pin.src }));
      check('M8: editing only ∠ keeps the picked geometry and the current e', pin.raw === 'pick' && Math.abs(pin.e - e2) < 0.01 && Math.abs(pin.ang - 120) < 1e-6, JSON.stringify(pin));
      await commit('#ox', 0);
      // ---- L8 ----
      await p.selectOption('#tolk', 'G'); await commit('#tolv', 2.5);
      check('L8: G tolerance without RPM asks for an RPM', /enter an RPM to grade against G2\.5/.test(await p.textContent('#checkout')));
      // ---- L10 ----
      const tsv = await p.evaluate(() => rab.nxTSV()); check('L10: no "-0.0000" in the NX table', !/\t-0\.0000(\t|\n)/.test(tsv));
      // ---- L11 ----
      const w1500 = await p.evaluate(() => ({ panel: document.querySelector('#panel').clientWidth, table: document.querySelector('#bodies').scrollWidth, view: document.querySelector('#view').clientWidth }));
      check('L11: 1500 px window — wider panel, body list fits', w1500.panel >= 500 && w1500.table <= w1500.panel, JSON.stringify(w1500));
      await p.setViewportSize({ width: 800, height: 900 }); await p.waitForTimeout(600);
      const w800 = await p.evaluate(() => ({ panel: document.querySelector('#panel').offsetWidth, inner: document.querySelector('#panel').clientWidth, table: document.querySelector('#bodies').scrollWidth, view: Math.round(document.querySelector('#view').getBoundingClientRect().width) }));
      check('L11: 800 px window — panel ≥ 360, view ≥ 420, body list fits', w800.panel >= 360 && w800.view >= 420 && w800.table <= w800.inner, JSON.stringify(w800));
      check('no CSP violations', (await p.evaluate(() => window.__csp)).length === 0, JSON.stringify(await p.evaluate(() => window.__csp)));
    } catch (e) { check('run', false, e.stack); }
    check('no page errors', !errs.length, errs.join(' | '));
    console.log(`--- ${name}\n` + res.join('\n'));
    await b.close();
  }
  console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
})();
