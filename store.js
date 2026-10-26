// Kage Kami accounts store: anonymous accounts (no email, no password), their cloud save and their ranked standing.
// An account is a random code the player's own launcher makes (like KK-7F3Q-92XM-...); the server keeps only a SHA-256 of
// it, so a leaked database can't be used to sign in. Two backends: Postgres (DATABASE_URL, e.g. a free Neon database or
// Render Postgres) and memory (for tests and local play; forgotten on restart).
const crypto = require('crypto');
const MODES = ['ffa', 'duel'], MAX_SAVE = 64 * 1024;

function memory() {
  const acct = new Map(), save = new Map(), rank = new Map();
  return {
    kind: 'memory',
    async ready() {},
    async touch(h) { const now = Date.now(); const a = acct.get(h); if (a) { a.seen = now; return false; } acct.set(h, { at: now, seen: now }); return true; },
    async getSave(h) { const s = save.get(h); return s ? JSON.parse(s) : null; },
    async setSave(h, d) { save.set(h, JSON.stringify(d)); },
    async setRank(h, row) { rank.set(h + ':' + row.mode, { h, ...row }); },
    async top(mode, n) { return [...rank.values()].filter(r => r.mode === mode).sort(order).slice(0, n); },
    async counts() { return { accounts: acct.size, ranked: rank.size }; },
    async close() {},
  };
}
// placed players first, then by rank, seals and rating (the same order the game draws)
const order = (a, b) => ((b.tier >= 0) - (a.tier >= 0)) || (b.tier - a.tier) || (b.seals - a.seals) || (b.mmr - a.mmr);

function postgres(url, log) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /host=\/|sslmode=disable/.test(url);
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30000, ssl: local ? false : { rejectUnauthorized: false } });
  pool.on('error', e => log('Database connection error: ' + e.message));
  const q = (s, v) => pool.query(s, v);
  return {
    kind: 'postgres',
    async ready() {
      await q(`CREATE TABLE IF NOT EXISTS kk_acct (h text PRIMARY KEY, at bigint NOT NULL, seen bigint NOT NULL)`);
      await q(`CREATE TABLE IF NOT EXISTS kk_save (h text PRIMARY KEY REFERENCES kk_acct(h) ON DELETE CASCADE, d jsonb NOT NULL, at bigint NOT NULL)`);
      await q(`CREATE TABLE IF NOT EXISTS kk_rank (h text NOT NULL REFERENCES kk_acct(h) ON DELETE CASCADE, mode text NOT NULL, nm text NOT NULL, tier int NOT NULL, seals int NOT NULL,
        mmr int NOT NULL, g int NOT NULL, w int NOT NULL, at bigint NOT NULL, PRIMARY KEY (h, mode))`);
      await q(`CREATE INDEX IF NOT EXISTS kk_rank_order ON kk_rank (mode, (tier >= 0) DESC, tier DESC, seals DESC, mmr DESC)`);
    },
    async touch(h) { const now = Date.now(); const r = await q(`INSERT INTO kk_acct (h, at, seen) VALUES ($1, $2, $2) ON CONFLICT (h) DO UPDATE SET seen = $2 RETURNING (xmax = 0) AS fresh`, [h, now]); return !!r.rows[0].fresh; },
    async getSave(h) { const r = await q(`SELECT d FROM kk_save WHERE h = $1`, [h]); return r.rows[0] ? r.rows[0].d : null; },
    async setSave(h, d) { await q(`INSERT INTO kk_save (h, d, at) VALUES ($1, $2, $3) ON CONFLICT (h) DO UPDATE SET d = $2, at = $3`, [h, JSON.stringify(d), Date.now()]); },
    async setRank(h, r) { await q(`INSERT INTO kk_rank (h, mode, nm, tier, seals, mmr, g, w, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (h, mode) DO UPDATE SET nm=$3, tier=$4, seals=$5, mmr=$6, g=$7, w=$8, at=$9`, [h, r.mode, r.nm, r.tier, r.seals, r.mmr, r.g, r.w, r.at]); },
    async top(mode, n) { const r = await q(`SELECT h, mode, nm, tier, seals, mmr, g, w, at FROM kk_rank WHERE mode = $1 ORDER BY (tier >= 0) DESC, tier DESC, seals DESC, mmr DESC LIMIT $2`, [mode, n]);
      return r.rows.map(x => ({ ...x, at: +x.at })); },
    async counts() { const a = await q(`SELECT (SELECT count(*) FROM kk_acct) a, (SELECT count(*) FROM kk_rank) r`); return { accounts: +a.rows[0].a, ranked: +a.rows[0].r }; },
    async close() { await pool.end(); },
  };
}

// codes: KK- and four groups of four from an alphabet without 0/O/1/I (80 bits); the client makes them
const CODE_RE = /^KK(-[A-HJ-NP-Z2-9]{4}){4}$/;
const hashCode = code => crypto.createHash('sha256').update('kagekami-acct:' + code).digest('hex');
// what other players see on the leaderboard instead of anything about the account: a short hash of the hash
const pubOf = h => 'a' + crypto.createHash('sha256').update('pub:' + h).digest('hex').slice(0, 12);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
function cleanRank(m) {
  if (!m || typeof m !== 'object' || !MODES.includes(m.mode)) return null;
  const g = clampInt(m.g, 0, 100000), w = clampInt(m.w, 0, g);
  return { mode: m.mode, nm: cleanName(m.nm), tier: clampInt(m.tier, -1, 30), seals: clampInt(m.seals, 0, 100000), mmr: clampInt(m.mmr, 0, 10000), g, w, at: Date.now() };
}

function open(o = {}) {
  const log = o.log || (() => {});
  if (o.databaseUrl) return postgres(o.databaseUrl, log);
  if (o.memory) return memory();
  return null;
}
module.exports = { open, CODE_RE, hashCode, pubOf, cleanRank, cleanName, MODES, MAX_SAVE };
