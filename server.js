// Kage Kami multiplayer server: a small WebSocket relay for the game's room presence (the lobby, and one room per match),
// so online play works without claude.ai. The game's own lockstep netcode runs in the players' games; the server only
// keeps each room's member list and their presence objects and passes changes on. Optionally it also serves a game folder
// over HTTP (index.html, manifest.json and the files next to it), so launchers can use it as their update address.
//
//   node server.js [--port 7420] [--password secret] [--game path/to/game]       (standalone, needs the ws package)
//   require('./server').start({ port, password, game })                           (from the desktop app)
//
// Messages (JSON), client to server: {t:"hello", by, name, pw}  {t:"join", r}  {t:"p", r, p}  {t:"leave", r}
// server to client: {t:"welcome", peer}  {t:"snap", r, peers:[{peer,by,name,p,at}]}  {t:"p", r, peer, by, name, p, at}  {t:"bye", r, peer}  {t:"err", m}
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MAX_PRESENCE = 4096, MAX_ROOMS_PER_CLIENT = 4, MAX_MSGS_PER_SEC = 120, ROOM_RE = /^[a-z0-9-]{1,32}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

function start(o = {}) {
  const port = +o.port || 7420, password = o.password ? String(o.password) : '', game = o.game ? path.resolve(o.game) : null, log = o.log || (m => console.log(new Date().toISOString(), m));
  const rooms = new Map();   // name -> Map(peer -> client)
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (rel === 'status') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ kageKami: true, rooms: rooms.size, players: count(), game: !!game })); return; }
    if (!game) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Kage Kami multiplayer server is running.\n'); return; }
    if (!rel) rel = 'index.html';
    const f = path.join(game, ...rel.split('/'));
    if (rel.split('/').some(s => s === '..' || s === '') || !f.startsWith(game + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': rel === 'manifest.json' || rel === 'index.html' ? 'no-store' : 'max-age=3600', 'access-control-allow-origin': '*' });
    fs.createReadStream(f).pipe(res);
  });
  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  const count = () => { let n = 0; wss.clients.forEach(() => n++); return n; };
  const info = c => ({ peer: c.peer, by: c.by, name: c.name });
  const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  function leave(c, r) {
    const room = rooms.get(r); if (!room || !room.has(c.peer)) return;
    room.delete(c.peer); c.rooms.delete(r);
    for (const o of room.values()) send(o.ws, { t: 'bye', r, peer: c.peer });
    if (!room.size) rooms.delete(r);
  }
  wss.on('connection', (ws, req) => {
    const c = { ws, peer: crypto.randomBytes(6).toString('hex'), by: null, name: '', ok: !password, rooms: new Map(), n: 0, t0: Date.now() };
    ws.on('message', buf => {
      const now = Date.now(); if (now - c.t0 > 1000) { c.t0 = now; c.n = 0; } if (++c.n > MAX_MSGS_PER_SEC) return;   // flood guard
      let m; try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return; } if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') {
        if (password && m.pw !== password) { send(ws, { t: 'err', m: 'Wrong server password.' }); ws.close(); return; }
        c.ok = true; c.by = typeof m.by === 'string' && /^[a-zA-Z0-9_-]{2,40}$/.test(m.by) ? m.by : 'g' + c.peer; c.name = String(m.name || '').slice(0, 24);
        send(ws, { t: 'welcome', peer: c.peer, by: c.by }); return;
      }
      if (!c.ok) return;
      const r = typeof m.r === 'string' && ROOM_RE.test(m.r) ? m.r : null; if (!r) return;
      if (m.t === 'join') {
        if (c.rooms.has(r)) return; if (c.rooms.size >= MAX_ROOMS_PER_CLIENT) { send(ws, { t: 'err', m: 'Too many rooms.' }); return; }
        let room = rooms.get(r); if (!room) rooms.set(r, room = new Map());
        c.rooms.set(r, { p: {}, at: now }); room.set(c.peer, c);
        send(ws, { t: 'snap', r, peers: [...room.values()].filter(o => o !== c).map(o => ({ ...info(o), p: o.rooms.get(r).p, at: o.rooms.get(r).at })) });
        for (const o of room.values()) if (o !== c) send(o.ws, { t: 'p', r, ...info(c), p: {}, at: now });
      } else if (m.t === 'p') {
        const mine = c.rooms.get(r); if (!mine || !m.p || typeof m.p !== 'object' || Array.isArray(m.p)) return;
        if (Buffer.byteLength(JSON.stringify(m.p)) > MAX_PRESENCE) { send(ws, { t: 'err', m: 'Presence over 4 KiB.' }); return; }
        mine.p = m.p; mine.at = now;
        for (const o of rooms.get(r).values()) if (o !== c) send(o.ws, { t: 'p', r, ...info(c), p: m.p, at: now });
      } else if (m.t === 'leave') leave(c, r);
    });
    ws.on('close', () => { for (const r of [...c.rooms.keys()]) leave(c, r); });
    ws.on('error', () => {});
  });
  const hb = setInterval(() => wss.clients.forEach(ws => { if (ws._kkDead) return ws.terminate(); ws._kkDead = true; ws.ping(); }), 15000); // drop silent connections
  wss.on('connection', ws => ws.on('pong', () => { ws._kkDead = false; }));
  return new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(port, () => { log(`Kage Kami server on port ${port}${password ? ' (password set)' : ''}${game ? ', serving ' + game : ''}`); ok({ port, stop: () => new Promise(r => { clearInterval(hb); wss.clients.forEach(w => w.terminate()); wss.close(); server.close(() => r()); }), stats: () => ({ rooms: rooms.size, players: count() }) }); });
  });
}

module.exports = { start };
if (require.main === module) {
  const a = process.argv.slice(2), get = k => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  start({ port: get('port') || process.env.PORT, password: get('password') || process.env.KK_PASSWORD, game: get('game') }).catch(e => { console.error(e.message); process.exit(1); });
}
