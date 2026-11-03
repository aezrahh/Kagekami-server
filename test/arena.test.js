// Chūnin Exam Arena online (server 2.5): an 8-player room in 4 cells of two, the match lock, a reconnect, a host hand-over,
// and ranked and Village War kept out of the arena. Runs on the memory store.
const WS = require('ws');
const { start } = require('../server.js');
const Store = require('../store.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (cond, name) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
function client(url, tok) {
  const ws = new WS(url), c = { ws, msgs: [], q: 0, by: null, feat: null };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'welcome') { c.by = m.by; c.feat = m.feat; } });
  ws.on('error', () => {});
  c.ready = new Promise(okk => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', tok })); okk(); })).then(() => sleep(60));
  c.send = m => ws.send(JSON.stringify(m));
  c.last = pred => [...c.msgs].reverse().find(pred);
  c.ask = async m => { const q = ++c.q; c.send({ ...m, q }); for (let i = 0; i < 100; i++) { const r = c.msgs.find(x => x.q === q && x.t === m.t); if (r) return r; await sleep(20); } return null; };
  return c;
}
const tok = i => ('arenaTok' + i).padEnd(24, 'x'), code = i => 'KK-ARN' + 'ABCDEFGH'[i] + '-AAAA-BBBB-CCCC', R = 'kr-arena-test';

(async () => {
  const srv = await start({ port: 7561, store: Store.open({ memory: true }), log: () => {} }); const U = 'ws://127.0.0.1:7561';
  const P = []; for (let i = 0; i < 8; i++) { P.push(client(U, tok(i))); await P[i].ready; }
  ok(P[0].feat && P[0].feat.includes('arena'), 'welcome lists the arena feature');
  const st = await fetch('http://127.0.0.1:7561/status').then(x => x.json()).catch(() => null);
  ok(st && st.version === '2.5.0' && st.feat.includes('arena'), '/status shows 2.5.0 and the arena feature');
  for (let i = 0; i < 8; i++) { const r = await P[i].ask({ t: 'acct', code: code(i) }); if (!r || !r.ok) ok(false, 'sign-in ' + i); }

  // the host opens the room, everyone joins, the host seats 8 players in 4 cells (slot >> 1)
  const H = P[0], seats = P.map((c, i) => ['c:' + i, i, c.by]), set = { mode: 'arena', stage: 'stadium', cells: 4, duo: 2 };
  H.send({ t: 'join', r: R }); await sleep(40);
  H.send({ t: 'p', r: R, p: { cid: 'c0', host: 1, he: 1, vis: 1, set, seats, st: 'lobby' } }); await sleep(40);
  for (let i = 1; i < 8; i++) { P[i].send({ t: 'join', r: R }); await sleep(30); P[i].send({ t: 'p', r: R, p: { cid: 'c' + i, vis: 1, hero: 'naruto' } }); }
  await sleep(150);
  const snap = P[7].last(m => m.t === 'snap' && m.r === R);
  ok(snap && snap.peers.length === 7 && snap.peers.some(x => x.p.set && x.p.set.mode === 'arena' && x.p.seats.length === 8), 'the 8th player sees the host, the arena set and 8 seats');
  const cells = [0, 1, 2, 3].map(k => seats.filter(s => s[1] >> 1 === k).length);
  ok(cells.every(n => n === 2), 'seats make 4 cells of two');

  // the bout starts: prep, then run. Lockstep turns from the host reach all 7 others.
  H.send({ t: 'p', r: R, p: { cid: 'c0', host: 1, he: 1, vis: 1, set, seats, st: 'prep' } }); await sleep(60);
  const T = { n: 1, i: seats.map(s => [s[1], 0, 0, 0]) };
  H.send({ t: 'p', r: R, p: { cid: 'c0', host: 1, he: 1, vis: 1, set, seats, st: 'run', T } }); await sleep(120);
  ok(P.slice(1).every(c => c.last(m => m.t === 'p' && m.by === H.by && m.p.st === 'run' && m.p.T && m.p.T.i.length === 8)), 'run state and 8-player turns reach everyone');
  ok(Buffer.byteLength(JSON.stringify({ cid: 'c0', host: 1, he: 1, vis: 1, set, seats, st: 'run', T })) < 4096, 'host presence for 8 players fits in 4 KiB');
  // a non-host can't publish host fields
  P[3].send({ t: 'p', r: R, p: { cid: 'c3', vis: 1, st: 'lobby', seats: [] } }); await sleep(80);
  const p3 = H.last(m => m.t === 'p' && m.by === P[3].by); ok(p3 && !p3.p.st && !p3.p.seats, 'a seated player cannot change the match state');

  // a 9th player is refused while the bout runs; a seated player who drops comes back in
  const X = client(U, tok(9)); await X.ready; X.send({ t: 'join', r: R }); await sleep(80);
  ok(X.last(m => m.t === 'err' && /progress/.test(m.m)) && !X.last(m => m.t === 'snap'), 'a stranger cannot join a running arena');
  P[5].ws.close(); await sleep(80);
  const P5 = client(U, tok(5)); await P5.ready; P5.send({ t: 'join', r: R }); await sleep(80);
  ok(P5.last(m => m.t === 'snap' && m.r === R), 'a seated player can rejoin mid-bout');
  P5.send({ t: 'p', r: R, p: { cid: 'c5', vis: 1 } }); await sleep(80);
  ok(H.last(m => m.t === 'p' && m.by === P[5].by && m.p.cid === 'c5'), 'the rejoined player takes its cid back');

  // the host tabs out (vis 0): the next player takes over hosting
  H.send({ t: 'p', r: R, p: { cid: 'c0', host: 1, he: 1, vis: 0, set, seats, st: 'run' } }); await sleep(60);
  P[2].send({ t: 'p', r: R, p: { cid: 'c2', host: 1, he: 2, vis: 1, set, seats, st: 'run' } }); await sleep(80);
  ok(P[1].last(m => m.t === 'p' && m.by === P[2].by && m.p.host === 1 && m.p.he === 2), 'hosting hands over when the host is hidden');

  // the end: ranked refuses the arena, Village War skips it, and a two-village result still counts
  let r = await P[1].ask({ t: 'rank', row: { mode: 'arena', nm: 'Cell One', tier: 2, seals: 10, mmr: 1200, g: 1, w: 1 } });
  ok(r && /Bad ranked/.test(r.err), 'ranked refuses an arena result');
  r = await P[1].ask({ t: 'top', mode: 'arena' }); ok(r && /Unknown mode/.test(r.err), 'there is no arena leaderboard');
  r = await P[1].ask({ t: 'vw', v: 'leaf', win: true, mode: 'arena' }); ok(r && r.ok && r.counted === false && r.skip === 'mode', 'Village War skips an arena result');
  r = await P[1].ask({ t: 'vw', v: 'leaf', win: true, mode: 'bogus' }); ok(r && r.err, 'Village War refuses an unknown mode');
  r = await P[1].ask({ t: 'vwar' }); ok(r && r.rows.every(x => x.g === 0), 'no village gained a game from the arena');
  r = await P[1].ask({ t: 'vw', v: 'leaf', win: true, mode: 'duel' }); ok(r && r.counted === true, 'a two-village result still counts (and the arena one used no slot)');
  r = await P[4].ask({ t: 'vw', v: 'sand', win: false }); ok(r && r.counted === true, 'older games without mode still count');

  for (const c of [...P, P5, X]) try { c.ws.close(); } catch (e) {}
  await srv.stop();
  console.log(fails ? fails + ' failed' : 'all passed'); process.exit(fails ? 1 : 0);
})();
