// Kage Kami accounts store: anonymous accounts (no email, no password), their cloud save and their ranked standing.
// An account is a random code the player's own launcher makes (like KK-7F3Q-92XM-...); the server keeps only a SHA-256 of
// it, so a leaked database can't be used to sign in. Two backends: Postgres (DATABASE_URL, e.g. a free Neon database or
// Render Postgres) and memory (for tests and local play; forgotten on restart).
const crypto = require('crypto');
const MODES = ['ffa', 'duel'], MAX_SAVE = 64 * 1024;
// the game's ranks: 0 Academy Student ... 5 Kage (RK_TIERS); -1 is unranked (still in placements)
const KAGE = 5, KAGE_TOP = 500;
// Village War (server 2.4): a weekly server-wide score of online matches by village; each account adds at most VW_MAX
// results a week, and at most one every VW_GAP ms (an online match lasts longer than that)
const VILLAGES = ['leaf', 'sand', 'mist', 'cloud', 'stone'], VW_MAX = 40, VW_GAP = 10 * 60 * 1000;
// online match modes the server knows (2.5). Ranked is ffa and duel only (MODES); the Chūnin Exam Arena ("arena", 8 players
// in 4 cells of two) is played online but never counts for ranked or Village War.
const MATCH_MODES = ['ffa', 'duel', 'aram', 'kura', 'arena'], VW_SKIP = ['arena'];
// ISO week of a time, as "2026-W44" (weeks start on Monday, UTC)
function weekOf(t = Date.now()) {
  const d = new Date(t), day = (d.getUTCDay() + 6) % 7, th = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const y = th.getUTCFullYear(), w1 = new Date(Date.UTC(y, 0, 4)), wk = 1 + Math.round(((th - w1) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7);
  return y + '-W' + String(wk).padStart(2, '0');
}

function memory() {
  const acct = new Map(), save = new Map(), rank = new Map(), vw = new Map(), vwa = new Map();
  return {
    kind: 'memory',
    async ready() {},
    async touch(h) { const now = Date.now(); const a = acct.get(h); if (a) { a.seen = now; return false; } acct.set(h, { at: now, seen: now }); return true; },
    async getSave(h) { const s = save.get(h); return s ? JSON.parse(s) : null; },
    async setSave(h, d) { save.set(h, JSON.stringify(d)); },
    async setRank(h, row) { rank.set(h + ':' + row.mode, { h, ...row }); },
    async top(mode, n) { return [...rank.values()].filter(r => r.mode === mode).sort(order).slice(0, n); },
    async kage(mode, n) { const all = [...rank.values()].filter(r => r.mode === mode && r.tier === KAGE).sort(order); return { rows: all.slice(0, n), total: all.length }; },
    async counts() { return { accounts: acct.size, ranked: rank.size }; },
    // one row per account for the current week only (a new week starts the count again), so no history is kept
    async addVW(h, wk, v, win, now) { const a = vwa.get(h), n = a && a.wk === wk ? a.n : 0; if (n >= VW_MAX || (a && now - a.at < VW_GAP)) return false;
      vwa.set(h, { wk, n: n + 1, at: now }); const s = vw.get(wk + ':' + v) || { w: 0, g: 0 }; vw.set(wk + ':' + v, { w: s.w + (win ? 1 : 0), g: s.g + 1 }); return true; },
    async getVW(wk) { return VILLAGES.map(v => ({ v, ...(vw.get(wk + ':' + v) || { w: 0, g: 0 }) })); },
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
      await q(`CREATE TABLE IF NOT EXISTS kk_vw (wk text NOT NULL, v text NOT NULL, w int NOT NULL, g int NOT NULL, PRIMARY KEY (wk, v))`);
      await q(`CREATE TABLE IF NOT EXISTS kk_vwa (h text PRIMARY KEY REFERENCES kk_acct(h) ON DELETE CASCADE, wk text NOT NULL, n int NOT NULL, at bigint NOT NULL)`);
    },
    async touch(h) { const now = Date.now(); const r = await q(`INSERT INTO kk_acct (h, at, seen) VALUES ($1, $2, $2) ON CONFLICT (h) DO UPDATE SET seen = $2 RETURNING (xmax = 0) AS fresh`, [h, now]); return !!r.rows[0].fresh; },
    async getSave(h) { const r = await q(`SELECT d FROM kk_save WHERE h = $1`, [h]); return r.rows[0] ? r.rows[0].d : null; },
    async setSave(h, d) { await q(`INSERT INTO kk_save (h, d, at) VALUES ($1, $2, $3) ON CONFLICT (h) DO UPDATE SET d = $2, at = $3`, [h, JSON.stringify(d), Date.now()]); },
    async setRank(h, r) { await q(`INSERT INTO kk_rank (h, mode, nm, tier, seals, mmr, g, w, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (h, mode) DO UPDATE SET nm=$3, tier=$4, seals=$5, mmr=$6, g=$7, w=$8, at=$9`, [h, r.mode, r.nm, r.tier, r.seals, r.mmr, r.g, r.w, r.at]); },
    async top(mode, n) { const r = await q(`SELECT h, mode, nm, tier, seals, mmr, g, w, at FROM kk_rank WHERE mode = $1 ORDER BY (tier >= 0) DESC, tier DESC, seals DESC, mmr DESC LIMIT $2`, [mode, n]);
      return r.rows.map(x => ({ ...x, at: +x.at })); },
    async kage(mode, n) {
      const r = await q(`SELECT h, mode, nm, tier, seals, mmr, g, w, at FROM kk_rank WHERE mode = $1 AND tier = $2 ORDER BY seals DESC, mmr DESC LIMIT $3`, [mode, KAGE, n]);
      const c = await q(`SELECT count(*) n FROM kk_rank WHERE mode = $1 AND tier = $2`, [mode, KAGE]);
      return { rows: r.rows.map(x => ({ ...x, at: +x.at })), total: +c.rows[0].n }; },
    async counts() { const a = await q(`SELECT (SELECT count(*) FROM kk_acct) a, (SELECT count(*) FROM kk_rank) r`); return { accounts: +a.rows[0].a, ranked: +a.rows[0].r }; },
    // one statement does it all: claims the account's slot (cap, gap and week checked in the database; kk_vwa holds one
    // row per account, reset when the week changes, so no weekly history is kept) and adds to the village's count
    async addVW(h, wk, v, win, now) {
      const r = await q(`WITH c AS (INSERT INTO kk_vwa (h, wk, n, at) VALUES ($1, $2, 1, $3) ON CONFLICT (h) DO UPDATE
          SET n = CASE WHEN kk_vwa.wk = $2 THEN kk_vwa.n + 1 ELSE 1 END, wk = $2, at = $3
          WHERE $3 - kk_vwa.at >= $5 AND (kk_vwa.wk <> $2 OR kk_vwa.n < $4) RETURNING n)
        INSERT INTO kk_vw (wk, v, w, g) SELECT $2, $6, $7, 1 FROM c ON CONFLICT (wk, v) DO UPDATE SET w = kk_vw.w + EXCLUDED.w, g = kk_vw.g + 1
        RETURNING 1`, [h, wk, now, VW_MAX, VW_GAP, v, win ? 1 : 0]);
      return r.rows.length > 0; },
    async getVW(wk) { const r = await q(`SELECT v, w, g FROM kk_vw WHERE wk = $1`, [wk]); const m = new Map(r.rows.map(x => [x.v, x]));
      return VILLAGES.map(v => ({ v, w: m.has(v) ? +m.get(v).w : 0, g: m.has(v) ? +m.get(v).g : 0 })); },
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
  return { mode: m.mode, nm: cleanName(m.nm), tier: clampInt(m.tier, -1, KAGE), seals: clampInt(m.seals, 0, 100000), mmr: clampInt(m.mmr, 0, 10000), g, w, at: Date.now() };
}

function open(o = {}) {
  const log = o.log || (() => {});
  if (o.databaseUrl) return postgres(o.databaseUrl, log);
  if (o.memory) return memory();
  return null;
}
module.exports = { open, CODE_RE, hashCode, pubOf, cleanRank, cleanName, MODES, MAX_SAVE, KAGE, KAGE_TOP, VILLAGES, VW_MAX, VW_GAP, MATCH_MODES, VW_SKIP, weekOf };
