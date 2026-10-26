// Kage Kami multiplayer server: a small WebSocket relay for the game's room presence (the lobby, and one room per match),
// so online play works without claude.ai. The game's own lockstep netcode runs in the players' games; the server keeps
// each room's member list and their presence objects and passes changes on. Optionally it also serves a game folder
// over HTTP (index.html, manifest.json and the files next to it), so launchers can use it as their update address.
//
//   node server.js [--port 7420] [--host 0.0.0.0] [--password secret] [--game path/to/game]   (standalone, needs ws)
//   require('./server').start({ port, host, password, game })                                  (from the desktop app)
//
// Messages (JSON), client to server: {t:"hello", tok, name, pw}  {t:"join", r}  {t:"p", r, p}  {t:"leave", r}
// server to client: {t:"welcome", peer, by}  {t:"snap", r, peers:[{peer,by,name,p,at}]}  {t:"p", r, peer, by, name, p, at}
//                   {t:"bye", r, peer}  {t:"err", m, r?}
// Accounts (server 2.2, only with a database; see store.js). A request carries q, an id the reply echoes:
//   {t:"acct", q, code} -> {t:"acct", q, ok, me}       sign in with the account code the player's launcher made
//   {t:"save", q} -> {t:"save", q, d}                   read the account's cloud save; with d: write it (64 KiB at most)
//   {t:"rank", q, row} -> {t:"rank", q, ok}             this account's ranked standing in one mode (ffa or duel)
//   {t:"top", q, mode} -> {t:"top", q, mode, rows}      the leaderboard: the top 100 of a mode, with short public ids
//   With no database every reply is {t, q, off:true}, and the game keeps everything on the player's computer.
//
// Security and privacy (server 2.0):
// - Player IDs are issued by the server. A client sends a private token; everyone else only ever sees `by`, a keyed hash
//   of it, so nobody can claim another player's ID or seat. (Older clients send their old id as `by`; it is used as the
//   token the same way, so they never see each other's raw ids either.)
// - In a room, a presence `cid` belongs to the first connection that used it (or the same player reconnecting).
// - Only the room's current host may publish host fields (host, set, seats, the match and its turns). Another member may
//   take over only when the host is hidden or gone, which is when the game itself hands hosting over.
// - While a match is being set up or running, only players who hold a seat in it can join the room.
// - Limits: connections per address and in total, wrong passwords per address, joins per minute, members per room,
//   messages and bytes per second.
// - Nothing about players is logged or written to disk. Addresses are kept in memory only, for the limits above.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const VERSION = '2.2.0';
const Store = require('./store');
const MAX_PRESENCE = 4096, MAX_ROOMS_PER_CLIENT = 4, MAX_MSGS_PER_SEC = 120, MAX_BYTES_PER_SEC = 96 * 1024, ROOM_RE = /^[a-z0-9-]{1,32}$/;
const MAX_ROOM_MEMBERS = 30, MAX_JOINS_PER_MIN = 20, LOBBY = 'lobby';
const TOK_RE = /^[A-Za-z0-9_-]{16,128}$/, CID_RE = /^[A-Za-z0-9_-]{1,40}$/, PUB_RE = /^p[0-9a-f]{20}$/;
// fields only the room's host may publish (the game's lockstep host state)
const HOST_KEYS = ['host', 'he', 'set', 'seats', 'mt', 'st', 'T', 'K', 'po', 'drop', 'ds', 'props'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

function start(o = {}) {
  const port = +o.port || 7420, host = o.host || undefined, password = o.password ? String(o.password) : '', game = o.game ? path.resolve(o.game) : null;
  const log = o.log || (m => console.log(new Date().toISOString(), m));
  const store = o.store || null;
  const acctTries = new Map();   // address -> sign-in times in the last hour
  const maxConns = +o.maxConnections || 300, maxPerIp = +o.maxPerAddress || 16, trustProxy = !!o.trustProxy;
  // the key that turns private tokens into public ids; new on every start unless KK_SECRET is set
  // Set it (KK_SECRET; on Render it is derived from the service) so players keep their IDs, and with them their seats,
  // across a restart or deploy.
  const secret = o.secret ? String(o.secret) : crypto.randomBytes(32).toString('hex');
  const pubId = tok => 'p' + crypto.createHmac('sha256', secret).update(tok).digest('hex').slice(0, 20);
  const pwHash = crypto.createHash('sha256').update(password).digest();
  const pwOk = pw => crypto.timingSafeEqual(crypto.createHash('sha256').update(typeof pw === 'string' ? pw : '').digest(), pwHash);

  const rooms = new Map();   // name -> { members: Map(peer -> client), host: peer | null }
  const perIp = new Map();   // address -> open connections
  const fails = new Map();   // address -> { n, until }: wrong passwords
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (f.until < now && now - f.at > 600000) fails.delete(k); }, 60000);

  const server = http.createServer((req, res) => { try { serveHttp(req, res); } catch (e) { log('HTTP error: ' + (e && e.message)); try { res.writeHead(500); res.end(); } catch (x) {} } });
  function serveHttp(req, res) {
    const hdr = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    let u, rel; try { u = new URL(req.url, 'http://x'); rel = decodeURIComponent(u.pathname).replace(/^\/+/, ''); } catch (e) { res.writeHead(400, hdr); res.end(); return; }
    if (rel === 'status') { res.writeHead(200, { ...hdr, 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ kageKami: true, version: VERSION, rooms: rooms.size, players: count(), game: !!game, accounts: store ? store.kind : 'off' })); return; }
    if (!game) { res.writeHead(200, { ...hdr, 'content-type': 'text/plain' }); res.end('Kage Kami multiplayer server is running.\n'); return; }
    if (!rel) rel = 'index.html';
    const f = path.join(game, ...rel.split('/'));
    if (rel.split('/').some(s => s === '..' || s === '' || s.startsWith('.')) || !f.startsWith(game + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, hdr); res.end('not found'); return; }
    res.writeHead(200, { ...hdr, 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': rel === 'manifest.json' || rel === 'index.html' ? 'no-store' : 'max-age=3600', 'access-control-allow-origin': '*' });
    fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
  }
  const wss = new WebSocketServer({ server, maxPayload: 72 * 1024, perMessageDeflate: false });
  const count = () => wss.clients.size;
  const info = c => ({ peer: c.peer, by: c.by, name: c.name });
  // a client that stops reading (over 1 MiB waiting) is dropped instead of filling the server's memory
  const send = (ws, m) => { if (ws.readyState !== 1) return; if (ws.bufferedAmount > 1 << 20) { ws.terminate(); return; } ws.send(JSON.stringify(m)); };
  const addrOf = req => {
    const fwd = trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req.socket.remoteAddress || '?';
  };
  const isHostP = p => p && p.host === 1;

  function leave(c, r) {
    const room = rooms.get(r); if (!room || !room.members.has(c.peer)) return;
    room.members.delete(c.peer); c.rooms.delete(r);
    if (room.host === c.peer) room.host = null;
    for (const o of room.members.values()) send(o.ws, { t: 'bye', r, peer: c.peer });
    if (!room.members.size) rooms.delete(r);
  }
  // the seat list the room's host publishes: [[pid, slot, by?], ...]
  function roomSeats(room) {
    const h = room.host && room.members.get(room.host); const p = h && h.rooms.get(room.name).p;
    return p && Array.isArray(p.seats) ? p.seats : [];
  }
  function matchLocked(room) {
    const h = room.host && room.members.get(room.host); const p = h && h.rooms.get(room.name).p;
    return !!(p && (p.st === 'prep' || p.st === 'run'));
  }
  // decide what of a member's presence the others get to see
  function filterPresence(c, room, r, p) {
    const out = {};
    for (const k in p) out[k] = p[k];
    // a cid names one player in the room; nobody else may use it
    if ('cid' in out) {
      if (typeof out.cid !== 'string' || !CID_RE.test(out.cid)) delete out.cid;
      else for (const o of room.members.values()) {
        if (o === c) continue; const op = o.rooms.get(r).p;
        if (op && op.cid === out.cid) {
          if (o.by === c.by) { leave(o, r); break; }            // the same player reconnected: the old connection gives way
          delete out.cid; break;
        }
      }
    }
    // host fields: only from the current host, or from a member taking over when the host is hidden or gone
    const claims = isHostP(out);
    if (room.host !== c.peer) {
      const h = room.host && room.members.get(room.host), hp = h && h.rooms.get(r).p;
      const canTake = !h || !isHostP(hp) || hp.vis === 0;
      if (claims && canTake) room.host = c.peer;
      else for (const k of HOST_KEYS) if (k in out && out[k] !== null) delete out[k];
    } else if (out.host === null || ('host' in out && out.host !== 1)) room.host = null;
    return out;
  }

  wss.on('connection', (ws, req) => {
    const addr = addrOf(req);
    const f = fails.get(addr);
    if (f && f.until > Date.now()) { send(ws, { t: 'err', m: 'Too many wrong passwords. Try again in a few minutes.' }); ws.close(); return; }
    if (count() > maxConns) { send(ws, { t: 'err', m: 'The server is full.' }); ws.close(); return; }
    if ((perIp.get(addr) || 0) >= maxPerIp) { send(ws, { t: 'err', m: 'Too many connections from your address.' }); ws.close(); return; }
    perIp.set(addr, (perIp.get(addr) || 0) + 1);
    const c = { ws, peer: crypto.randomBytes(8).toString('hex'), by: null, name: '', ok: false, rooms: new Map(), n: 0, bytes: 0, t0: Date.now(), joins: [] };
    ws._kkAlive = true; ws.on('pong', () => { ws._kkAlive = true; });
    // one bad message drops only itself, never the server and everyone's matches
    ws.on('message', buf => { try { handle(buf); } catch (e) { log('Dropped a message that caused an error: ' + (e && e.message)); } });
    const handle = buf => {
      const now = Date.now(); if (now - c.t0 > 1000) { c.t0 = now; c.n = 0; c.bytes = 0; }
      c.bytes += buf.length; if (++c.n > MAX_MSGS_PER_SEC || c.bytes > MAX_BYTES_PER_SEC) return;   // flood guard
      let m; try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return; } if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      if (m.t === 'hello') {
        if (c.ok) return;
        if (password && !pwOk(m.pw)) {
          const x = fails.get(addr) || { n: 0, until: 0, at: now }; if (now - x.at > 600000) { x.n = 0; x.at = now; }
          if (++x.n >= 5) { x.until = now + 600000; x.n = 0; x.at = now; } fails.set(addr, x);
          send(ws, { t: 'err', m: 'Wrong server password.' }); ws.close(); return;
        }
        // a public id (what an older client sends back after a reconnect) is never accepted as a token
        const okTok = t => typeof t === 'string' && TOK_RE.test(t) && !PUB_RE.test(t);
        const tok = okTok(m.tok) ? m.tok : okTok(m.by) ? m.by : crypto.randomBytes(16).toString('hex');
        c.ok = true; c.by = pubId(tok); c.name = String(m.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
        send(ws, { t: 'welcome', peer: c.peer, by: c.by, v: VERSION }); return;
      }
      if (!c.ok) return;
      if (m.t === 'acct' || m.t === 'save' || m.t === 'rank' || m.t === 'top') { account(c, m, now); return; }
      const r = typeof m.r === 'string' && ROOM_RE.test(m.r) ? m.r : null; if (!r) return;
      if (m.t === 'join') {
        if (c.rooms.has(r)) return; if (c.rooms.size >= MAX_ROOMS_PER_CLIENT) { send(ws, { t: 'err', r, m: 'Too many rooms.' }); return; }
        c.joins = c.joins.filter(t => now - t < 60000); if (c.joins.length >= MAX_JOINS_PER_MIN) { send(ws, { t: 'err', r, m: 'Too many rooms joined. Wait a minute.' }); return; }
        c.joins.push(now);
        let room = rooms.get(r);
        if (room && r !== LOBBY) {
          if (room.members.size >= MAX_ROOM_MEMBERS) { send(ws, { t: 'err', r, m: 'That room is full.' }); return; }
          // during a match only its players may come (back) in
          if (matchLocked(room) && !roomSeats(room).some(s => Array.isArray(s) && s[2] === c.by)) { send(ws, { t: 'err', r, m: 'A match is in progress in that room.' }); return; }
        }
        if (!room) rooms.set(r, room = { name: r, members: new Map(), host: null });
        c.rooms.set(r, { p: {}, at: now }); room.members.set(c.peer, c);
        send(ws, { t: 'snap', r, peers: [...room.members.values()].filter(o => o !== c).map(o => ({ ...info(o), p: o.rooms.get(r).p, at: o.rooms.get(r).at })) });
        for (const o of room.members.values()) if (o !== c) send(o.ws, { t: 'p', r, ...info(c), p: {}, at: now });
      } else if (m.t === 'p') {
        const mine = c.rooms.get(r), room = rooms.get(r); if (!mine || !room || !m.p || typeof m.p !== 'object' || Array.isArray(m.p)) return;
        if (Buffer.byteLength(JSON.stringify(m.p)) > MAX_PRESENCE) { send(ws, { t: 'err', r, m: 'Presence over 4 KiB.' }); return; }
        const p = r === LOBBY ? m.p : filterPresence(c, room, r, m.p);
        mine.p = p; mine.at = now;
        for (const o of room.members.values()) if (o !== c) send(o.ws, { t: 'p', r, ...info(c), p, at: now });
      } else if (m.t === 'leave') leave(c, r);
    };
    // accounts: each request answered on its own; the database never holds up the room messages
    function account(c, m, now) {
      const q = typeof m.q === 'number' || typeof m.q === 'string' ? m.q : 0, reply = o => send(ws, { t: m.t, q, ...o });
      if (!store) { reply({ off: true }); return; }
      const fail = e => { log('Accounts: ' + (e && e.message)); reply({ err: 'The account service had a problem. Try again.' }); };
      if (m.t === 'acct') {
        const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
        if (!Store.CODE_RE.test(code)) { reply({ err: 'That account code is not valid.' }); return; }
        const tries = (acctTries.get(addr) || []).filter(t => now - t < 3600000); if (tries.length >= 30) { reply({ err: 'Too many sign-ins from your address. Try later.' }); return; }
        tries.push(now); acctTries.set(addr, tries);
        const h = Store.hashCode(code);
        store.touch(h).then(fresh => { c.acct = h; reply({ ok: true, me: Store.pubOf(h), fresh }); }, fail); return;
      }
      if (m.t === 'top') {
        if (now - (c.topT || 0) < 2000) { reply({ err: 'busy' }); return; } c.topT = now;
        if (!Store.MODES.includes(m.mode)) { reply({ err: 'Unknown mode.' }); return; }
        store.top(m.mode, 100).then(rows => reply({ mode: m.mode, rows: rows.map(r => ({ id: Store.pubOf(r.h), nm: r.nm, mode: r.mode, tier: r.tier, seals: r.seals, mmr: r.mmr, g: r.g, w: r.w, at: r.at })) }), fail); return;
      }
      if (!c.acct) { reply({ err: 'Not signed in.' }); return; }
      if (m.t === 'save') {
        if (m.d === undefined) { store.getSave(c.acct).then(d => reply({ d }), fail); return; }
        if (now - (c.saveT || 0) < 1500) { reply({ err: 'busy' }); return; } c.saveT = now;
        if (!m.d || typeof m.d !== 'object' || Array.isArray(m.d) || Buffer.byteLength(JSON.stringify(m.d)) > Store.MAX_SAVE) { reply({ err: 'That save is too big.' }); return; }
        store.setSave(c.acct, m.d).then(() => reply({ ok: true }), fail); return;
      }
      if (m.t === 'rank') {
        const row = Store.cleanRank(m.row); if (!row) { reply({ err: 'Bad ranked standing.' }); return; }
        c.rankT = c.rankT || {}; if (now - (c.rankT[row.mode] || 0) < 1500) { reply({ err: 'busy' }); return; } c.rankT[row.mode] = now;
        store.setRank(c.acct, row).then(() => reply({ ok: true }), fail); return;
      }
    }
    ws.on('close', () => { for (const r of [...c.rooms.keys()]) leave(c, r); const n = (perIp.get(addr) || 1) - 1; if (n > 0) perIp.set(addr, n); else perIp.delete(addr); });
    ws.on('error', () => {});
  });
  const hb = setInterval(() => wss.clients.forEach(ws => { if (!ws._kkAlive) return ws.terminate(); ws._kkAlive = false; ws.ping(); }), 15000); // drop silent connections
  return new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(port, host, () => {
      log(`Kage Kami server ${VERSION} on ${host || 'all addresses'}, port ${port}${password ? ' (password set)' : ''}${game ? ', serving ' + game : ''}`);
      // before a restart: tell everyone, and close with "service restart" so the games reconnect to the new server
      // straight away and carry on (the matches themselves live in the players' games)
      const drain = msg => { wss.clients.forEach(w => { send(w, { t: 'err', m: msg || 'The server is restarting. Reconnecting…' }); try { w.close(1012, 'restart'); } catch (e) {} }); };
      ok({ port, drain, stop: () => new Promise(res => { clearInterval(hb); clearInterval(sweep); wss.clients.forEach(w => w.terminate()); wss.close(); server.close(() => res()); }), stats: () => ({ rooms: rooms.size, players: count() }) });
    });
  });
}

module.exports = { start, VERSION };
if (require.main === module) {
  const a = process.argv.slice(2), get = k => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; }, env = process.env;
  // on Render without KK_SECRET, a stable secret from the service's own id (the same on every deploy of this service)
  const secret = env.KK_SECRET || (env.RENDER_SERVICE_ID ? crypto.createHash('sha256').update('kagekami:' + env.RENDER_SERVICE_ID + ':' + (env.KK_PASSWORD || '')).digest('hex') : undefined);
  const log = m => console.log(new Date().toISOString(), m);
  // accounts need a database: DATABASE_URL (Postgres, e.g. Neon's free plan or Render Postgres); KK_ACCOUNTS=memory for testing
  const store = Store.open({ databaseUrl: env.DATABASE_URL, memory: env.KK_ACCOUNTS === 'memory', log });
  const storeReady = store ? store.ready().then(() => { log('Accounts: ' + store.kind + ' store ready'); return store; }, e => { log('Accounts are off: the database did not answer (' + e.message + ')'); return null; }) : Promise.resolve(null);
  process.on('uncaughtException', e => log('Error (kept running): ' + (e && e.stack || e)));
  process.on('unhandledRejection', e => log('Error (kept running): ' + (e && e.stack || e)));
  storeReady.then(store => start({ store, port: get('port') || env.PORT, host: get('host') || env.KK_HOST, password: get('password') || env.KK_PASSWORD, game: get('game'), secret, log,
    trustProxy: env.KK_TRUST_PROXY === '1' || env.RENDER === 'true', maxConnections: env.KK_MAX_CONNECTIONS, maxPerAddress: env.KK_MAX_PER_ADDRESS }))
    .then(srv => {
      let down = false;
      const bye = () => { if (down) return; down = true; log('Shutting down: asking players to reconnect'); srv.drain(); setTimeout(() => srv.stop().then(() => process.exit(0)), 1500).unref(); setTimeout(() => process.exit(0), 5000).unref(); };
      process.on('SIGTERM', bye); process.on('SIGINT', bye);
    })
    .catch(e => { console.error(e.message); process.exit(1); });
}
