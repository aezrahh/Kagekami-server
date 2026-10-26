# Kage Kami multiplayer server

The online lobby and matches for Kage Kami, without claude.ai.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

After deploying, everyone enters `wss://<your-service>.onrender.com` as the Server address in the launcher's Online card.
On Render's free plan the server sleeps after about 15 minutes with nobody connected; the first player to connect after
that waits up to a minute while it wakes (the game keeps retrying by itself).

## Security and privacy (server 2.0)

- **Player IDs come from the server.** Each game sends a private token; other players only see a keyed hash of it, so
  nobody can claim someone else's ID or seat. The desktop app replaces its token after 6 hours without play, so players
  can't be recognised from one day to the next.
- **Rooms are guarded.** A player's `cid` can't be reused by another connection, only the room's host can publish host
  state (seats, the match, turns) and another player can take over only when the host is hidden or gone, and while a
  match is being set up or running only its players can join.
- **Limits.** 16 connections per address, 300 in total, 30 members per room, 20 room joins a minute, 120 messages and
  96 KiB a second per connection, and 10 minutes locked out after 5 wrong passwords.
- **Nothing about players is logged or stored.** Rooms, names and presence live in memory and vanish when a room empties.
  Addresses are held in memory only for the limits above.
- **Encryption.** Render serves `wss://` for you. On your own server, use `install-linux.sh --domain` (Caddy and a free
  certificate). The desktop app refuses unencrypted `ws://` addresses outside your local network.

## Stability (server 2.1)

- **Restarts and deploys don't end matches.** Before stopping, the server tells every game it is restarting and closes
  with the "service restart" code; the games reconnect to the new server within about a second and carry on, because
  the matches themselves run in the players' games. Players keep their IDs (and seats) as long as the secret stays the
  same: Render generates `KK_SECRET` for new deploys, and an existing Render service without it uses one derived from
  the service's own id.
- **One bad message can't take the server down.** Each message, and each HTTP request, is handled behind an error
  guard; any other unexpected error is logged and the server keeps running.
- **Slow clients are dropped** when more than 1 MiB is waiting to be sent to them, instead of filling the server's memory.

## Accounts and the ranked leaderboard (server 2.2)

Optional, and on only when the server has a database. Players get an **anonymous account**: the launcher makes a random
account code (like `KK-7F3Q-92XM-AB4C-DE5F`) and keeps it; there is no email and no password. The server stores only a
SHA-256 of the code, plus the account's cloud save (64 KiB at most) and its ranked standing per mode. Writing the code
down lets a player sign in on another computer. The leaderboard shows nicknames and short public ids, never the code.

1. Make a Postgres database. Neon's free plan (neon.tech) doesn't expire; Render's own free Postgres is deleted after
   30 days, its paid plan doesn't.
2. Copy its connection address (`postgresql://…`) into the Render service's Environment as `DATABASE_URL` and save.
   The server creates its tables (`kk_acct`, `kk_save`, `kk_rank`) by itself; `/status` then shows `"accounts":"postgres"`.

Without `DATABASE_URL` everything works as before and each game keeps its saves and ranks on the player's computer.
Ranked results are reported by the players' games, so a modified game could post a fake rank.

Settings (environment variables): `DATABASE_URL` (accounts, above), `KK_PASSWORD`, `PORT`, `KK_HOST` (address to listen on, for example `127.0.0.1` behind
Caddy), `KK_TRUST_PROXY=1` (on by itself on Render; set it behind another proxy that sets `X-Forwarded-For`), `KK_SECRET` (keeps player IDs
the same across restarts, so matches survive them), `KK_MAX_CONNECTIONS`, `KK_MAX_PER_ADDRESS`.

Tests: `npm test`.
