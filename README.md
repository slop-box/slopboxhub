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
| [hub/](hub/) | The landing page. It will also run the party gate and the deploy hook. |
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
3. In **Compose Manager**, add a stack named `slopbox`, and under the advanced options set its folder to the cloned repo. The compose file uses paths relative to the repo (`./proxy/Caddyfile`), so a copied compose file won't find them. Then **Compose Up**.
4. In the Cloudflare Zero Trust dashboard, point the tunnel's `<domain>` and `*.<domain>` hostnames at `http://<unraid-ip>:<SLOPBOX_HTTP_PORT>` (default 8480). Caddy's is the only port the stack publishes.

After a hub pull request is merged: `git pull` in the hub folder on the server, then **Compose Up**.
