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
  for (const c of [A, B, A2]) c.ws.close(); await srv.stop();
}
(async () => {
  await run('memory', Store.open({ memory: true }), 7541);
  const off = await start({ port: 7542, log: () => {} }); const C = client('ws://127.0.0.1:7542'); await C.ready; await sleep(50);
  const r = await C.ask({ t: 'acct', code: 'KK-AB2C-DE3F-GH4J-KM5N' }); ok(r && r.off === true, 'no database: accounts off'); C.ws.close(); await off.stop();
  if (process.env.KK_TEST_PG) { const pg = Store.open({ databaseUrl: process.env.KK_TEST_PG }); await pg.ready(); await run('postgres', pg, 7543); await pg.close(); }
  console.log(fails ? fails + ' failed' : 'all passed'); process.exit(fails ? 1 : 0);
})();
