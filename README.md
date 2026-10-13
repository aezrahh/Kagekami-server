# Kage Kami multiplayer server

The online lobby and matches for Kage Kami, without claude.ai.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

After deploying, everyone enters `wss://<your-service>.onrender.com` as the Server address in the launcher's Online card.
On Render's free plan the server sleeps after about 15 minutes with nobody connected; the first player to connect after
that waits up to a minute while it wakes (the game keeps retrying by itself).
