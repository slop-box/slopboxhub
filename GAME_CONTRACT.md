# Game contract

Every Slop Box game follows these rules. They let the hub run, route, gate and update any game the same way, without knowing anything about how the game works inside. QuickPic and DebateBros already follow most of them.

## Identity

1. **One id.** Lowercase letters, digits and hyphens, e.g. `quickpic`. `hub`, `www`, `caddy` and `cloudflared` are taken. The id is used everywhere:

   | Where | Value |
   |---|---|
   | Address | `https://<id>.<domain>` |
   | Image | `ghcr.io/slop-box/<id>` |
   | Service name in the hub's `docker-compose.yml` | `<id>` |
   | Saved data on the server | Docker volume `<id>-data`, mounted at `/app/data` |
   | Entry in `games.json` | `"id": "<id>"` |

## Container

2. **One container**, built from a `Dockerfile` in the game's repo and published by the shared workflow to `ghcr.io/slop-box/<id>`.
3. **Listens on `$PORT`.** Pick any default. Caddy reaches the game by name on the `slopbox` Docker network, so no host port is ever published.
4. **Runs as a non-root user.** Anything saved goes in `/app/data`, and nowhere else. A game that saves data also needs these two things:
   - **The Dockerfile creates `/app/data` owned by that user**, e.g. `RUN mkdir -p /app/data && chown node:node /app/data` before `USER node`. On the server, the game's data volume starts as a copy of that folder, owner included. Without it, the volume belongs to root, and the game can't save.
   - **No default files ship in `/app/data`.** Docker copies the folder into the volume only once, when the volume is created, so files a later image adds there never appear. Keep defaults elsewhere in the image, and create them in `/app/data` at startup if they're missing.
5. **Has `sh` and Node 18 or newer in the image.** The update lock runs `node -e "fetch(...)"` inside the container. Every `node:` base image has both.
6. **Has the Watchtower label** in the final Dockerfile stage:
   ```dockerfile
   LABEL com.centurylinklabs.watchtower.enable="true"
   ```
7. **`GET /healthz` returns `200`** once the game is ready, and the Dockerfile's `HEALTHCHECK` uses it.
8. **Secrets come from environment variables**, never from files in the image. Images are public.

## Pages

9. **Players start at `/`.** A TV is optional. If the game uses one, its page is at `/tv`, and `games.json` sets `"needsTv": true`. Extra device pages are fine (QuickPic has `/draw` for its tablet).
10. **Works behind HTTPS and a proxy.** The browser is on `https://`, but the container only sees plain HTTP from Caddy.
    - Build every URL from `location.origin`. Never hard-code a host, port or `http://`.
    - Open WebSockets with `(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'`.
    - Join QR codes use `PUBLIC_URL` if it's set, otherwise `location.origin`.
11. **Root paths are fine** (`/style.css`, `/ws`). Each game has its own subdomain, so it owns every path.
12. **Admin and debug features stay behind an environment variable** (like QuickPic's `ADMIN_PASSWORD`), because the game is reachable from the internet while games are open.

## Development

13. **Runs on its own with `npm start`.** Nobody should need the hub, Docker or the server to work on a game.
14. **Pushing to `main` publishes the image.** The server picks it up on Watchtower's next scheduled run, unless games are open. (**Deploy now**, for testing on the server right away, isn't turned on yet.)
