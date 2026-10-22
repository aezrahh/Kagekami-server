const WS = require('ws');
const { start } = require('../server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(url, hello) {
  const ws = new WS(url), c = { ws, msgs: [], by: null, closed: false };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'welcome') c.by = m.by; });
  ws.on('close', () => c.closed = true); ws.on('error', () => {});
  c.ready = new Promise(ok => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', ...hello })); ok(); }));
  c.send = m => ws.send(JSON.stringify(m));
  c.last = (pred) => [...c.msgs].reverse().find(pred);
  return c;
}
let fails = 0; const ok = (cond, name) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
(async () => {
  const srv = await start({ port: 7531, password: 'pw', log: () => {} });
  const U = 'ws://127.0.0.1:7531';
  const A = client(U, { tok: 'tokenAAAAAAAAAAAAAAAAAAAA', pw: 'pw', name: 'Alice' }); await A.ready; await sleep(100);
  ok(/^p[0-9a-f]{20}$/.test(A.by), 'server issues public id');
  const B = client(U, { tok: A.by, pw: 'pw', name: 'Bob' }); await B.ready; await sleep(100);
  ok(B.by && B.by !== A.by, 'public id as token does not impersonate');
  const L = client(U, { by: A.by, pw: 'pw' }); await L.ready; await sleep(100);
  ok(L.by !== A.by, 'legacy by=public id does not impersonate');
  const A2 = client(U, { tok: 'tokenAAAAAAAAAAAAAAAAAAAA', pw: 'pw' }); await A2.ready; await sleep(100);
  ok(A2.by === A.by, 'same token gives same id');
  A2.ws.close();
  // room
  A.send({ t: 'join', r: 'kr-abcd' }); await sleep(50);
  A.send({ t: 'p', r: 'kr-abcd', p: { cid: 'aaaa', host: 1, he: 1, vis: 1, seats: [['c:aaaa', 0, A.by]] } }); await sleep(50);
  B.send({ t: 'join', r: 'kr-abcd' }); await sleep(80);
  const snap = B.last(m => m.t === 'snap'); ok(snap && snap.peers[0].p.host === 1, 'joiner sees host');
  B.send({ t: 'p', r: 'kr-abcd', p: { cid: 'aaaa', vis: 1 } }); await sleep(80);
  let bp = A.last(m => m.t === 'p' && m.by === B.by); ok(bp && !('cid' in bp.p), 'stolen cid stripped');
  B.send({ t: 'p', r: 'kr-abcd', p: { cid: 'bbbb', host: 1, he: 99, vis: 1, T: { x: 1 } } }); await sleep(80);
  bp = A.last(m => m.t === 'p' && m.by === B.by); ok(bp && bp.p.cid === 'bbbb' && !bp.p.host && !bp.p.T && !bp.p.he, 'host claim stripped while host visible');
  A.send({ t: 'p', r: 'kr-abcd', p: { cid: 'aaaa', host: 1, he: 1, vis: 0, seats: [['c:aaaa', 0, A.by], ['c:bbbb', 1, B.by]], st: 'run' } }); await sleep(50);
  B.send({ t: 'p', r: 'kr-abcd', p: { cid: 'bbbb', host: 1, he: 2, vis: 1 } }); await sleep(80);
  bp = A.last(m => m.t === 'p' && m.by === B.by); ok(bp && bp.p.host === 1 && bp.p.he === 2, 'takeover allowed when host hidden');
  A.send({ t: 'p', r: 'kr-abcd', p: { cid: 'aaaa', host: 1, he: 1, vis: 1, st: 'run', seats: [] } }); await sleep(80);
  const ap = B.last(m => m.t === 'p' && m.by === A.by); ok(ap && !ap.p.host && !ap.p.seats, 'old host loses host fields');
  // B is host with st run and seats from previous? B's presence has no seats; set them
  B.send({ t: 'p', r: 'kr-abcd', p: { cid: 'bbbb', host: 1, he: 2, vis: 1, st: 'run', seats: [['c:aaaa', 0, A.by], ['c:bbbb', 1, B.by]] } }); await sleep(50);
  const C = client(U, { tok: 'tokenCCCCCCCCCCCCCCCCCCCC', pw: 'pw' }); await C.ready; await sleep(80);
  C.send({ t: 'join', r: 'kr-abcd' }); await sleep(80);
  ok(C.last(m => m.t === 'err' && /progress/.test(m.m)) && !C.last(m => m.t === 'snap'), 'stranger blocked during match');
  const A3 = client(U, { tok: 'tokenAAAAAAAAAAAAAAAAAAAA', pw: 'pw' }); await A3.ready; await sleep(80);
  A3.send({ t: 'join', r: 'kr-abcd' }); await sleep(80);
  ok(A3.last(m => m.t === 'snap'), 'seated player can rejoin during match');
  A3.send({ t: 'p', r: 'kr-abcd', p: { cid: 'aaaa', vis: 1 } }); await sleep(80);
  const a3p = B.last(m => m.t === 'p' && m.peer && m.by === A.by && m.p.cid === 'aaaa'); ok(!!a3p, 'reconnect takes its cid back');
  ok(B.msgs.some(m => m.t === 'bye'), 'old connection removed from room');
  // passwords
  const bad = []; for (let i = 0; i < 5; i++) { const x = client(U, { tok: 'tokenXXXXXXXXXXXXXXXXXXX', pw: 'nope' }); await x.ready; await sleep(40); bad.push(x); }
  const good = client(U, { tok: 'tokenXXXXXXXXXXXXXXXXXXX', pw: 'pw' }); await good.ready; await sleep(80);
  ok(good.last(m => m.t === 'err' && /Too many wrong/.test(m.m)) && !good.by, 'lockout after 5 wrong passwords');
  // stability: garbage doesn't break anything, and a restart with the same secret keeps player ids
  const s2 = await start({ port: 7533, secret: 'stable', log: () => {} });
  const G = client('ws://127.0.0.1:7533', { tok: 'tokenGGGGGGGGGGGGGGGGGGGG' }); await G.ready; await sleep(80); G.send({ t: 'join', r: 'kr-abcd' });
  for (const junk of ['[]', 'null', '{"t":"p","r":"kr-abcd","p":[1]}', '{"t":"join","r":{}}', '{"t":"p","r":"kr-abcd","p":{"cid":{"x":1},"host":"1"}}', '\u0000'.repeat(100)]) G.ws.send(junk);
  await sleep(100); ok(!G.closed, 'junk messages are ignored');
  const R1 = client('ws://127.0.0.1:7533', { tok: 'tokenRRRRRRRRRRRRRRRRRRRR' }); await R1.ready; await sleep(80);
  let code = 0; R1.ws.on('close', c => code = c); s2.drain(); await sleep(150);
  ok(code === 1012 && R1.msgs.some(m => m.t === 'err' && /restarting/.test(m.m)), 'restart notice and close code 1012');
  await s2.stop();
  const s3 = await start({ port: 7533, secret: 'stable', log: () => {} });
  const R2 = client('ws://127.0.0.1:7533', { tok: 'tokenRRRRRRRRRRRRRRRRRRRR' }); await R2.ready; await sleep(80);
  ok(R1.by && R2.by === R1.by, 'same secret keeps the player id across a restart');
  await s3.stop();
  console.log(fails ? fails + ' failed' : 'all passed');
  await srv.stop(); process.exit(fails ? 1 : 0);
})();
