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
  64 KiB a second per connection, and 10 minutes locked out after 5 wrong passwords.
- **Nothing about players is logged or stored.** Rooms, names and presence live in memory and vanish when a room empties.
  Addresses are held in memory only for the limits above.
- **Encryption.** Render serves `wss://` for you. On your own server, use `install-linux.sh --domain` (Caddy and a free
  certificate). The desktop app refuses unencrypted `ws://` addresses outside your local network.

Settings (environment variables): `KK_PASSWORD`, `PORT`, `KK_HOST` (address to listen on, for example `127.0.0.1` behind
Caddy), `KK_TRUST_PROXY=1` (on by itself on Render; set it behind another proxy that sets `X-Forwarded-For`), `KK_SECRET` (keeps player IDs
the same across restarts; leave it unset for the most privacy), `KK_MAX_CONNECTIONS`, `KK_MAX_PER_ADDRESS`.

Tests: `npm test`.
