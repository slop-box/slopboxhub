# Game contract

Every Slop Box game follows these rules. They let the hub run, route, gate and update any game the same way, without knowing anything about how the game works inside. QuickPic and DebateBros already follow most of them.

## Identity

1. **One id.** Lowercase letters, digits and hyphens, e.g. `quickpic`. The id is used everywhere:

   | Where | Value |
   |---|---|
   | Address | `https://<id>.<domain>` |
   | Image | `ghcr.io/slop-box/<id>` |
   | Service name in the hub's `docker-compose.yml` | `<id>` |
   | Data folder on the server | `/mnt/user/appdata/slopbox/<id>` |
   | Entry in `games.json` | `"id": "<id>"` |

2. **Original content only.** No names, characters, art, music or screen layouts copied from existing games, even with a reference image. Match the mood, not the design.

## Container

3. **One container**, built from a `Dockerfile` in the game's repo and published by the shared workflow to `ghcr.io/slop-box/<id>`.
4. **Listens on `$PORT`.** Pick any default. Caddy reaches the game by name on the `slopbox` Docker network, so no host port is ever published.
5. **Runs as a non-root user.** Anything saved goes in `/app/data`, and nowhere else.
6. **Has `sh` and Node 18 or newer in the image.** The update lock runs `node -e "fetch(...)"` inside the container. Every `node:` base image has both.
7. **Has the Watchtower label** in the final Dockerfile stage:
   ```dockerfile
   LABEL com.centurylinklabs.watchtower.enable="true"
   ```
8. **`GET /healthz` returns `200`** once the game is ready, and the Dockerfile's `HEALTHCHECK` uses it.
9. **Secrets come from environment variables**, never from files in the image. Images are public.

## Pages

10. **Phones at `/`, TV at `/tv`.** Extra device pages are fine (QuickPic has `/draw` for its tablet).
11. **Works behind HTTPS and a proxy.** The browser is on `https://`, but the container only sees plain HTTP from Caddy.
    - Build every URL from `location.origin`. Never hard-code a host, port or `http://`.
    - Open WebSockets with `(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'`.
    - Join QR codes use `PUBLIC_URL` if it's set, otherwise `location.origin`.
12. **Root paths are fine** (`/style.css`, `/ws`). Each game has its own subdomain, so it owns every path.
13. **Admin and debug features stay behind an environment variable** (like QuickPic's `ADMIN_PASSWORD`), because the game is reachable from the internet while games are open.

## Development

14. **Runs on its own with `npm start`.** Nobody should need the hub, Docker or the server to work on a game.
15. **Pushing to `main` publishes the image.** The server picks it up on Watchtower's next scheduled run, unless games are open. To test on the server right away, use **Actions → Publish → Run workflow** with **Deploy now** ticked.
