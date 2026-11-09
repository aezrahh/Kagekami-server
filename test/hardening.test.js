// Server 2.6 security pass: real addresses behind the proxy, "__proto__" keys, connection and new-account limits,
// ranked rows held to the game's rules, and Village War limits.
const WS = require('ws');
const { start } = require('../server.js');
const Store = require('../store.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (cond, name) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
function client(url, headers) {
  const ws = new WS(url, { headers }), c = { ws, msgs: [], q: 0, closed: false };
  ws.on('message', d => c.msgs.push(JSON.parse(d))); ws.on('error', () => {}); ws.on('close', () => { c.closed = true; });
  c.ready = new Promise(okk => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', tok: 'tok' + Math.random().toString(36).slice(2).padEnd(20, 'x') })); okk(); }));
  c.ask = async m => { const q = ++c.q; ws.send(JSON.stringify({ ...m, q })); for (let i = 0; i < 100; i++) { const r = c.msgs.find(x => x.q === q && x.t === m.t); if (r) return r; await sleep(20); } return null; };
  return c;
}
const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', code = i => 'KK-HARD-ABCD-EFGH-JK' + AL[(i >> 5) % 32] + AL[i % 32];

(async () => {
  // 1. behind the proxy: Cloudflare's header decides the address, a made-up X-Forwarded-For does not
  let srv = await start({ port: 7571, log: () => {}, trustProxy: true, maxPerAddress: 2 });
  const U1 = 'ws://127.0.0.1:7571', cs = [];
  for (let i = 0; i < 3; i++) { const c = client(U1, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.' + i }); cs.push(c); await sleep(40); }
  await sleep(150);
  ok(cs[2].msgs.some(m => m.t === 'err' && /Too many connections/.test(m.m)), 'a changing X-Forwarded-For no longer dodges the per-address limit');
  const other = client(U1, { 'cf-connecting-ip': '203.0.113.8' }); await sleep(150);
  ok(other.msgs.some(m => m.t === 'welcome') && !other.msgs.some(m => m.t === 'err'), 'another real address still gets in');
  for (const c of [...cs, other]) c.ws.close(); await srv.stop();

  // 2. new connections a minute
  srv = await start({ port: 7572, log: () => {}, connsPerMinute: 5 });
  let refused = 0; for (let i = 0; i < 7; i++) { const c = client('ws://127.0.0.1:7572'); await sleep(60); if (c.msgs.some(m => m.t === 'err' && /Wait a minute/.test(m.m))) refused++; c.ws.close(); await sleep(20); }
  ok(refused === 2, 'at most 5 new connections a minute from one address (' + refused + ' refused)');
  await srv.stop();

  // 3. "__proto__" in presence never reaches anyone, and can't make a member the room's host
  srv = await start({ port: 7573, log: () => {} }); const U3 = 'ws://127.0.0.1:7573';
  const H = client(U3), X = client(U3), V = client(U3); await H.ready; await X.ready; await V.ready; await sleep(60);
  for (const c of [H, X, V]) c.ws.send(JSON.stringify({ t: 'join', r: 'kr-prt1' })); await sleep(80);
  H.ws.send(JSON.stringify({ t: 'p', r: 'kr-prt1', p: { host: 1, vis: 0, cid: 'hostcid' } })); await sleep(60);
  X.ws.send('{"t":"p","r":"kr-prt1","p":{"__proto__":{"host":1,"cid":"victim","st":"run"},"cid":"x1","n":{"__proto__":{"a":1}}}}'); await sleep(60);
  V.ws.send(JSON.stringify({ t: 'p', r: 'kr-prt1', p: { cid: 'victim' } })); await sleep(80);
  const raw = JSON.stringify(V.msgs);
  ok(!raw.includes('__proto__'), 'no "__proto__" key is passed on');
  const vEcho = H.msgs.filter(m => m.t === 'p' && m.p && m.p.cid === 'victim');
  ok(vEcho.length === 1, 'a hidden "__proto__" cid can\'t block another player\'s cid');
  const late = client(U3); await late.ready; await sleep(40); late.ws.send(JSON.stringify({ t: 'join', r: 'kr-prt1' })); await sleep(80);
  ok(late.msgs.some(m => m.t === 'snap'), 'a hidden "__proto__" st can\'t lock the room');
  for (const c of [H, X, V, late]) c.ws.close(); await srv.stop();

  // 4. new accounts a day from one address; known accounts always sign in
  const store = Store.open({ memory: true });
  srv = await start({ port: 7574, store, log: () => {}, freshPerDay: 3 }); const U4 = 'ws://127.0.0.1:7574';
  const A = client(U4); await A.ready; await sleep(40);
  const res = []; for (let i = 0; i < 4; i++) res.push(await A.ask({ t: 'acct', code: code(i) }));
  ok(res.slice(0, 3).every(r => r && r.ok) && res[3] && /new accounts/.test(res[3].err), 'at most 3 new accounts a day from one address');
  let r = await A.ask({ t: 'acct', code: code(0) }); ok(r && r.ok && r.fresh === false, 'a known account still signs in');
  A.ws.close(); await srv.stop();

  // 5. ranked rows held to the game's rules
  const now = 1e12, MIN = 60000;
  let x = Store.checkRank({ mode: 'duel', nm: 'a', tier: 5, seals: 900, mmr: 9000, g: 200, w: 200 }, null, now, now);
  ok(x.g === 1 && x.tier === -1 && x.seals === 0 && x.mmr <= 1264, 'a new account can\'t post Kage straight away');
  x = Store.checkRank({ mode: 'duel', nm: 'a', tier: 5, seals: 0, mmr: 1500, g: 12, w: 12 }, null, now - 60 * MIN, now);
  ok(x.g === 12 && x.tier * 100 + x.seals <= 280 + 30 * 7 && x.tier === 4, 'rank is held to what 12 games can earn (' + x.tier + '/' + x.seals + ')');
  const prev = { tier: 3, seals: 40, mmr: 1300, g: 30, w: 20, at: now - 3 * MIN };
  x = Store.checkRank({ mode: 'duel', nm: 'a', tier: 5, seals: 0, mmr: 1900, g: 40, w: 30 }, prev, now - 864e5, now);
  ok(x.g === 32 && x.w === 22 && x.mmr === 1428, 'games go up by one per 2 minutes since the last row (' + x.g + ')');
  x = Store.checkRank({ mode: 'duel', nm: 'b', tier: 4, seals: 10, mmr: 1400, g: 30, w: 20 }, prev, now - 864e5, now);
  ok(x.tier === 3 && x.seals === 40 && x.mmr === 1300 && x.nm === 'b', 'no new game, no new rank (name still changes)');
  x = Store.checkRank({ mode: 'duel', nm: 'a', tier: 3, seals: 70, mmr: 1320, g: 31, w: 21 }, prev, now - 864e5, now);
  ok(x.tier === 3 && x.seals === 70 && x.g === 31 && x.mmr === 1320, 'an ordinary win goes through unchanged');
  x = Store.checkRank({ mode: 'duel', nm: 'a', tier: -1, seals: 0, mmr: 1150, g: 2, w: 1 }, prev, now - 864e5, now);
  ok(x.g === 2 && x.tier === -1, 'a new season (fewer games) starts again');

  // over the socket: held rows say so
  srv = await start({ port: 7575, store, log: () => {} }); const B = client('ws://127.0.0.1:7575'); await B.ready; await sleep(40);
  await B.ask({ t: 'acct', code: code(1) });
  r = await B.ask({ t: 'rank', row: { mode: 'ffa', nm: 'Cheat', tier: 5, seals: 999, mmr: 3000, g: 300, w: 300 } });
  ok(r && r.ok && r.held === true, 'a held row is answered with held');
  const top = await B.ask({ t: 'kage', mode: 'ffa' }); ok(top && top.rows && !top.rows.some(y => y.nm === 'Cheat'), 'the forged row is not in the Top Kage');

  // 6. Village War: brand-new accounts don't count yet; one address adds at most vwPerHour results
  r = await B.ask({ t: 'vw', v: 'leaf', win: true }); ok(r && r.ok && r.counted === false && r.skip === 'new', 'a brand-new account\'s result does not count yet');
  B.ws.close(); await srv.stop();
  srv = await start({ port: 7576, store: Store.open({ memory: true }), log: () => {}, vwMinAge: 0, vwPerHour: 2, freshPerDay: 10 }); const U6 = 'ws://127.0.0.1:7576';
  const counted = [];
  for (let i = 0; i < 3; i++) { const c = client(U6); await c.ready; await sleep(30); await c.ask({ t: 'acct', code: code(10 + i) }); const y = await c.ask({ t: 'vw', v: 'sand', win: true }); counted.push(y && y.counted ? 1 : y && y.skip); c.ws.close(); }
  ok(counted.join() === '1,1,address', 'at most 2 counted results an hour from one address (' + counted.join() + ')');
  await srv.stop();

  console.log(fails ? fails + ' failed' : 'all passed'); process.exit(fails ? 1 : 0);
})();
