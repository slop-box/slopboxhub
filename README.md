# Slop Box

Party games made by a group of friends, played on everyone's phones. Some games also use a TV: it opens the game's `/tv` page in its web browser, and players join by scanning the QR code it shows.

Slop Box runs on an Unraid server behind a Cloudflare Tunnel. The hub lives at `https://<domain>`, and each game at `https://<id>.<domain>`.

| Game | Address | Repo |
|---|---|---|
| QuickPic | `quickpic.<domain>` | [slop-box/QuickPic](https://github.com/slop-box/QuickPic) |

## For game makers

- [CONTRIBUTING.md](CONTRIBUTING.md): how to get access, add a game, and deploy it
- [GAME_CONTRACT.md](GAME_CONTRACT.md): the rules a game follows to plug in

## What's in this repo

| Path | What it does |
|---|---|
| [games.json](games.json) | The list of games the landing page shows |
| [docker-compose.yml](docker-compose.yml) | Every container on the server: Caddy and each game |
| [proxy/Caddyfile](proxy/Caddyfile) | Routes `<id>.<domain>` to each game's container |
| [hub/](hub/) | The landing page (`ghcr.io/slop-box/hub`). It will also run the party gate and the deploy route. Run it locally with `node hub/server.js` and open `http://localhost:8080`. |
| [.env.example](.env.example) | The settings and secrets the server's `.env` needs |
| [PLAN.md](PLAN.md) | The build-out plan, step by step |

## How it runs

```
phone / TV ──HTTPS──▶ Cloudflare Tunnel ──▶ Caddy ──▶ <id> container
                                              └──────▶ hub (landing page)
```

- The **Cloudflare Tunnel** sends `<domain>` and `*.<domain>` to Caddy. Cloudflare handles HTTPS, and no router ports are open.
- **Caddy** routes each subdomain to the game with the same id. Games publish no ports of their own.
- **Watchtower** (the server's existing one) pulls new game images on its normal schedule.

## Running it on the server

1. Clone this repo onto the server, e.g. `/mnt/user/appdata/slopbox/hub`.
2. Copy `.env.example` to `.env` and fill it in.
3. In **Compose Manager**, click **Add New Stack**, name it `slopboxhub`, and set **External folder** (called **Stack Directory** in some versions) to the cloned repo. The compose file uses paths relative to the repo (`./proxy/Caddyfile`), so a copied compose file won't find them. Afterwards, **Edit Stack → Compose File** should show the hub's file. If your version has neither option, point the stack at the repo from the terminal:
   ```bash
   P=/boot/config/plugins/compose.manager/projects/slopboxhub
   printf '%s' /mnt/user/appdata/slopbox/hub > "$P/indirect"
   rm "$P/docker-compose.yml"
   ```
   Then **Compose Up**. Don't edit the compose file from Compose Manager's editor, because it now edits the repo. Change it through a pull request, then `git pull` on the server.
4. In the Cloudflare Zero Trust dashboard, Slop Box's tunnel routes `<domain>` and `*.<domain>` to `http://caddy:80`. Its connector runs in this stack as `cloudflared`, using `CLOUDFLARE_TUNNEL_TOKEN` from `.env`.

After a hub pull request is merged, update the server:

```bash
cd /mnt/user/appdata/slopbox/hub && git pull
```

Then, depending on what changed:

| Changed | Do this |
|---|---|
| `games.json` | Nothing. The hub reads it on the next page load. |
| `docker-compose.yml` | **Compose Up** in Compose Manager. |
| `proxy/Caddyfile` | `docker exec slopboxhub-caddy-1 caddy reload --config /etc/caddy/Caddyfile` |
| `hub/` | Nothing. The workflow publishes a new hub image, and Watchtower picks it up. |
