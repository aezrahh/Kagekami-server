// Accounts: sign-in with a code, cloud save, ranked rows and the leaderboard. Runs on the memory store, and also on
// Postgres when KK_TEST_PG is set to a database URL.
const WS = require('ws');
const { start } = require('../server.js');
const Store = require('../store.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (cond, name) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
function client(url) {
  const ws = new WS(url), c = { ws, msgs: [], q: 0 };
  ws.on('message', d => c.msgs.push(JSON.parse(d))); ws.on('error', () => {});
  c.ready = new Promise(okk => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', tok: 'tok' + Math.random().toString(36).slice(2).padEnd(20, 'x') })); okk(); }));
  c.ask = async m => { const q = ++c.q; ws.send(JSON.stringify({ ...m, q })); for (let i = 0; i < 100; i++) { const r = c.msgs.find(x => x.q === q && x.t === m.t); if (r) return r; await sleep(20); } return null; };
  return c;
}
async function run(label, store, port) {
  const srv = await start({ port, store, log: () => {} }); const U = 'ws://127.0.0.1:' + port;
  const A = client(U), B = client(U); await A.ready; await B.ready; await sleep(80);
  const codeA = 'KK-AB2C-DE3F-GH4J-KM5N', codeB = 'KK-PQ6R-ST7U-VW8X-YZ9A';
  let r = await A.ask({ t: 'save' }); ok(r && /Not signed in/.test(r.err), label + ': save needs sign-in');
  r = await A.ask({ t: 'acct', code: 'hello' }); ok(r && r.err, label + ': bad code refused');
  r = await A.ask({ t: 'acct', code: codeA }); ok(r && r.ok && r.fresh === true && /^a[0-9a-f]{12}$/.test(r.me), label + ': new account');
  const meA = r.me;
  r = await A.ask({ t: 'save' }); ok(r && r.d === null, label + ': empty save');
  r = await A.ask({ t: 'save', d: { t: 5, data: { 'kr-ryo': '{"r":10}' } } }); ok(r && r.ok, label + ': save written');
  r = await A.ask({ t: 'save', d: { t: 6, data: { x: 'y'.repeat(70000) } } }); ok(r && r.err, label + ': oversize save refused');
  r = await A.ask({ t: 'rank', row: { mode: 'ffa', nm: 'Alice<b>', tier: 3, seals: 40, mmr: 1200, g: 12, w: 8 } }); ok(r && r.ok, label + ': rank written');
  r = await B.ask({ t: 'acct', code: codeB }); ok(r && r.ok && r.me !== meA, label + ': second account');
  await B.ask({ t: 'rank', row: { mode: 'ffa', nm: 'Bob', tier: 5, seals: 10, mmr: 1500, g: 30, w: 20 } });
  await B.ask({ t: 'rank', row: { mode: 'hack', nm: 'x' } }).then(x => ok(x && x.err, label + ': unknown mode refused'));
  r = await B.ask({ t: 'save' }); ok(r && r.d === null, label + ': saves are private');
  r = await A.ask({ t: 'top', mode: 'ffa' });
  ok(r && r.rows.length === 2 && r.rows[0].nm === 'Bob' && r.rows[1].nm === 'Aliceb' && r.rows[1].id === meA, label + ': leaderboard order, cleaned names, public ids');
  ok(r && !JSON.stringify(r).includes(codeA) && !JSON.stringify(r).includes(Store.hashCode(codeA)), label + ': no codes or hashes leak');
  // sign back in from another connection: same save
  const A2 = client(U); await A2.ready; await sleep(50);
  r = await A2.ask({ t: 'acct', code: codeA.toLowerCase() }); ok(r && r.ok && r.fresh === false && r.me === meA, label + ': sign back in (any case)');
  r = await A2.ask({ t: 'save' }); ok(r && r.d && r.d.t === 5 && r.d.data['kr-ryo'] === '{"r":10}', label + ': save follows the account');
  // reconnecting with the same code never runs into the sign-in limit; 30 different accounts from one address do
  let same = true; for (let i = 0; i < 40; i++) { const x = await A2.ask({ t: 'acct', code: codeA }); if (!x || !x.ok) { same = false; break; } }
  ok(same, label + ': the same account can sign in again and again');
  let blocked = null; for (let i = 0; i < 31 && !blocked; i++) { const x = await A2.ask({ t: 'acct', code: 'KK-' + ('AAAA-BBBB-CCCC-' + 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[i] + 'DDD').slice(0) }); if (x && x.err) blocked = i; }
  ok(blocked === 28, label + ': 30 different accounts an hour per address');   // codeA and codeB came from this address too
  r = await A2.ask({ t: 'acct', code: codeA }); ok(r && r.ok, label + ': a known account still signs in after the limit');
  for (const c of [A, B, A2]) c.ws.close(); await srv.stop();
}
// the Top 500 Kage: only Kage-rank rows, by seals then rating, capped at 500, over WebSocket and HTTP
async function kage(label, store, port, many) {
  const srv = await start({ port, store, log: () => {} }); const U = 'ws://127.0.0.1:' + port;
  const rows = [['KK-KAGA-AAAA-BBBB-CCCC', 5, 50, 1600], ['KK-KAGB-AAAA-BBBB-CCCC', 5, 50, 1700], ['KK-KAGC-AAAA-BBBB-CCCC', 5, 120, 1550], ['KK-KAGD-AAAA-BBBB-CCCC', 4, 99, 1500], ['KK-KAGE-AAAA-BBBB-CCCC', 30, 200, 1400]];
  const me = [];
  for (const [code, tier, seals, mmr] of rows) { const c = client(U); await c.ready; await sleep(30); const a = await c.ask({ t: 'acct', code }); me.push(a && a.me);
    await c.ask({ t: 'rank', row: { mode: 'duel', nm: 'K' + me.length, tier, seals, mmr, g: 200, w: 150 } }); c.ws.close(); }
  if (many) for (let i = 0; i < 510; i++) await store.setRank('fake' + i, { mode: 'duel', nm: 'F' + i, tier: 5, seals: i % 50, mmr: 1550, g: 100, w: 60, at: Date.now() });
  const C = client(U); await C.ready; await sleep(30);
  let r = await C.ask({ t: 'kage', mode: 'duel' });
  const ours = r && r.rows ? r.rows.filter(x => me.includes(x.id)).map(x => x.nm) : [];
  ok(r && r.rows && ours.join() === 'K5,K3,K2,K1' && r.rows.every(x => x.tier === 5), label + ': Top Kage has only Kage rows, by seals then rating (' + ours.join() + ')');
  ok(r && r.rows && r.rows.find(x => x.nm === 'K5').tier === 5, label + ': an impossible rank is held to Kage');
  ok(r && r.rows && !JSON.stringify(r).includes('KK-KAG') && r.rows.every(x => /^a[0-9a-f]{12}$/.test(x.id)), label + ': Top Kage shows public ids only');
  if (many) ok(r.rows.length === 500 && r.total === 514, label + ': capped at 500 of ' + r.total);
  r = await C.ask({ t: 'kage', mode: 'chess' }); ok(r && r.err, label + ': Top Kage refuses an unknown mode');
  const h = await fetch('http://127.0.0.1:' + port + '/kage?mode=duel').then(x => x.json()).catch(() => null);
  ok(h && h.rows && h.rows.filter(x => me.includes(x.id)).map(x => x.nm).join() === 'K5,K3,K2,K1', label + ': GET /kage gives the same list');
  const bad = await fetch('http://127.0.0.1:' + port + '/kage?mode=x').then(x => x.status); ok(bad === 400, label + ': GET /kage refuses an unknown mode');
  C.ws.close(); await srv.stop();
}
// Village War: signed-in accounts add online results by village; capped per account; public totals over WS and HTTP
async function vwar(label, store, port) {
  const srv = await start({ port, store, log: () => {} }); const U = 'ws://127.0.0.1:' + port;
  const A = client(U), B = client(U); await A.ready; await B.ready; await sleep(60);
  let r = await A.ask({ t: 'vw', v: 'leaf', win: true }); ok(r && /Not signed in/.test(r.err), label + ': Village War needs sign-in');
  await A.ask({ t: 'acct', code: 'KK-VWAA-AAAA-BBBB-CCCC' }); await B.ask({ t: 'acct', code: 'KK-VWBB-AAAA-BBBB-CCCC' });
  r = await A.ask({ t: 'vw', v: 'leaf', win: true }); ok(r && r.ok && r.counted === true, label + ': a result counts');
  r = await A.ask({ t: 'vw', v: 'leaf', win: true }); ok(r && r.ok && r.counted === false, label + ': a second result within 10 minutes does not');
  r = await B.ask({ t: 'vw', v: 'sand', win: false }); ok(r && r.counted === true, label + ': another account counts');
  r = await B.ask({ t: 'vw', v: 'konoha', win: true }); ok(r && r.err, label + ': unknown village refused');
  r = await B.ask({ t: 'vw', v: 'mist', win: 'yes' }); ok(r && r.err, label + ': win must be true or false');
  r = await A.ask({ t: 'vwar' }); const g = v => r && r.rows && r.rows.find(x => x.v === v);
  ok(r && r.wk === Store.weekOf() && r.rows.length === 5 && g('leaf').w === 1 && g('leaf').g === 1 && g('sand').w === 0 && g('sand').g === 1 && r.prev.length === 5, label + ': weekly totals');
  // the weekly cap: 40 results, ten minutes apart
  await store.touch('cap'); let n = 0; for (let i = 0; i < 45; i++) if (await store.addVW('cap', '2026-W10', 'mist', true, 1e12 + i * Store.VW_GAP)) n++;
  ok(n === Store.VW_MAX, label + ': at most ' + Store.VW_MAX + ' results an account a week (' + n + ')');
  const t1 = 1e12 + 45 * Store.VW_GAP;
  ok(await store.addVW('cap', '2026-W11', 'mist', false, t1), label + ': a new week starts the count again');
  ok(!(await store.addVW('cap', '2026-W12', 'mist', false, t1 + 1000)), label + ': the 10-minute gap holds across a week change');
  const w11 = (await store.getVW('2026-W11')).find(x => x.v === 'mist'), w10 = (await store.getVW('2026-W10')).find(x => x.v === 'mist');
  ok(w11.g === 1 && w11.w === 0 && w10.g === Store.VW_MAX && w10.w === Store.VW_MAX, label + ': village totals match the counted results');
  const h = await fetch('http://127.0.0.1:' + port + '/vwar').then(x => x.json()).catch(() => null);
  ok(h && h.rows && h.rows.length === 5 && !JSON.stringify(h).includes('VWAA'), label + ': GET /vwar gives village totals only');
  A.ws.close(); B.ws.close(); await srv.stop();
}
(async () => {
  await run('memory', Store.open({ memory: true }), 7541);
  await kage('memory', Store.open({ memory: true }), 7544, true);
  await vwar('memory', Store.open({ memory: true }), 7546);
  const off = await start({ port: 7542, log: () => {} }); const C = client('ws://127.0.0.1:7542'); await C.ready; await sleep(50);
  const r = await C.ask({ t: 'acct', code: 'KK-AB2C-DE3F-GH4J-KM5N' }); ok(r && r.off === true, 'no database: accounts off');
  const k = await C.ask({ t: 'kage', mode: 'duel' }); ok(k && k.off === true, 'no database: Top Kage off');
  const vw = await C.ask({ t: 'vwar' }); ok(vw && vw.off === true, 'no database: Village War off'); C.ws.close(); await off.stop();
  if (process.env.KK_TEST_PG) { const pg = Store.open({ databaseUrl: process.env.KK_TEST_PG }); await pg.ready(); await run('postgres', pg, 7543); await kage('postgres', pg, 7545, false); await vwar('postgres', pg, 7547); await pg.close(); }
  console.log(fails ? fails + ' failed' : 'all passed'); process.exit(fails ? 1 : 0);
})();
