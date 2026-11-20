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
| [hub/](hub/) | The landing page, the party gate and the update lock (`ghcr.io/slop-box/hub`). Run it locally with `node hub/server.js` and open `http://localhost:8080`. Test it with `node hub/test.js`. |
| [scripts/check-config.js](scripts/check-config.js) | Checks that `games.json`, the compose file and the Caddyfile agree and follow the game contract. It runs on every pull request ([check.yml](.github/workflows/check.yml)). Run it locally with `node scripts/check-config.js` (needs Docker). |
| [.env.example](.env.example) | The settings and secrets the server's `.env` needs |
| [PLAN.md](PLAN.md) | The build-out plan, step by step |

## How it runs

```
phone / TV ──HTTPS──▶ Cloudflare Tunnel ──▶ Caddy ──▶ <id> container
                                              └──────▶ hub (landing page)
```

- The **Cloudflare Tunnel** sends `<domain>` and `*.<domain>` to Caddy. Cloudflare handles HTTPS, and no router ports are open.
- **Caddy** routes each subdomain to the game with the same id. Games publish no ports of their own.
- **Watchtower** (the server's existing one) pulls new game images on its normal schedule, but not while games are open (see [Updates](#updates)).

## Opening the games for a party

The games are closed until the host opens them. Go to `https://<domain>/admin` and log in with `SLOPBOX_ADMIN_PASSWORD`. That opens every game for 4 hours. The admin page has **Extend 1 hour** and **Close now**.

- **Guests** never log in. Scanning a game's QR code just works while games are open.
- **When the 4 hours end**, devices that joined during them keep working for another hour, so a round in progress can finish. New devices see a "closed" page. That page lets them in on its own as soon as the host opens the games again.
- **Close now** shuts everyone out right away, including devices still in that extra hour.
- **`/healthz` on every game skips the gate**, so devs can check that their game is up, and which commit it's running, while games are closed. It only answers health and version.

## Updates

Pushing to a game's `main` publishes its image, and Watchtower picks it up on its normal schedule. The **update lock** sits on top of that: while games are open, and for the hour after, Watchtower skips Slop Box containers, so nothing restarts mid-party. It catches up on a later run.

Each container in the compose file has a pre-update hook label that asks the hub `/update-allowed?id=<id>`. The hook exits `75` ("skip this time") unless the hub says yes. If the hub doesn't answer, games are skipped too.

The admin page's **Updates** panel shows each game's last update and the scheduled updates skipped while games were open.

**Setting up the lock** (once): add `WATCHTOWER_LIFECYCLE_HOOKS=true` to your existing Watchtower's settings. Its schedule stays as it is, and containers without a hook label update as before.

### Manual deploys (not turned on)

The hub can also let a dev restart their own game right away with **Actions → Publish → Run workflow → Deploy now**, even while games are open. It's built but switched off: with no tokens in `.env`, the hub refuses deploys, and **Deploy now** just publishes the image and prints a warning.

How it works once it's on:
- The workflow calls `https://<domain>/deploy` with `SLOPBOX_DEPLOY_TOKEN`.
- The hub asks Watchtower to update only that image and waits for it. The run fails if the deploy fails.
- The admin page shows the latest deploy for each game. For a big party, its **Block manual deploys** switch makes every **Deploy now** fail until you allow them again.

To turn it on:

1. Generate `SLOPBOX_DEPLOY_TOKEN` and `WATCHTOWER_API_TOKEN` (`openssl rand -hex 32` each) and put them in `.env`.
2. In GitHub, add two **org** Actions secrets: `SLOPBOX_DEPLOY_TOKEN` (same value) and `SLOPBOX_DEPLOY_URL` (`https://<domain>/deploy`). On the free plan, a private game repo may need them as repo secrets instead.
3. Add these to Watchtower's settings, next to `WATCHTOWER_LIFECYCLE_HOOKS`:

   | Variable | Value | Why |
   |---|---|---|
   | `WATCHTOWER_HTTP_API_UPDATE` | `true` | Lets the hub trigger manual deploys. |
   | `WATCHTOWER_HTTP_API_TOKEN` | the `WATCHTOWER_API_TOKEN` value | Only the hub can call Watchtower. |
   | `WATCHTOWER_HTTP_API_PERIODIC_POLLS` | `true` | **Required.** Without it, turning on the HTTP API stops the normal schedule. |

4. Connect Watchtower to the stack's network: `docker network connect slopbox watchtower`. Don't publish its port 8080. Unraid drops this network when it re-creates the container (after a template edit or a Watchtower update), so run the command again then. If the container has another name, set `WATCHTOWER_URL=http://<name>:8080` in `.env`.
5. **Compose Up**, so the hub gets the new settings.
6. Update the "not turned on" notes in [CONTRIBUTING.md](CONTRIBUTING.md) and [GAME_CONTRACT.md](GAME_CONTRACT.md), and in the game template's README.

### Rollback and repairs

**Forcing an update while games are open:** the lock only stops Watchtower, so the server owner can still update a game by hand. Restarting a game ends any round in progress, so check nobody's playing it first.

- **One game:** run this on the server, from the hub folder. It pulls the new image and re-creates only that game.
  ```bash
  cd /mnt/user/appdata/slopbox/hub
  docker compose pull quickpic && docker compose up -d quickpic
  ```
- **Everything that's waiting:** press **Close now** on the admin page. The lock opens straight away, with no grace hour, and Watchtower's next run updates every game with a new image. Then open the games again. This shuts out every player, so it's a last resort.

**Rolling back a game:** in the server's copy of `docker-compose.yml`, change the game's image to a known-good build, e.g. `ghcr.io/slop-box/quickpic:sha-<commit>` (each build is also published as `:sha-<full commit>`), then **Compose Up**. Watchtower leaves a pinned build alone, because nothing new is ever published under that tag. Once the game is fixed, `git checkout docker-compose.yml` and **Compose Up** again.

**If the hub itself is broken**, the lock can't work, and neither can manual deploys. Update the hub from Compose Manager instead: **Compose Pull**, then **Compose Up**. Watchtower may also replace it on its own: unlike a game's hook, the hub's hook allows the update when the hub doesn't answer.

## Game data

A game that saves anything gets a Docker named volume, `<id>-data`, mounted at `/app/data`. On the server it's called `slopboxhub_<id>-data`. The hub's own state (games open or closed, update history) is in `slopboxhub_hub-data`.
- **No setup needed.** When Docker creates the volume, it copies the image's `/app/data` into it, owner included, so the non-root game can write straight away. The **Hub checks** keep games to their own volume, with no bind mounts.
- **What keeps the data:** restarts, Watchtower updates, and **Compose Down**/**Compose Up**.
- **What erases it:** `docker compose down -v`, or deleting Unraid's Docker image or directory.
- **Not backed up.** Volumes live inside Docker's own storage, not in `appdata`, so appdata backups miss them.

Run these on the server, from the hub folder (`/mnt/user/appdata/slopbox/hub`). Replace `<id>` with the game's id.

| Task | Command |
|---|---|
| List the volumes | `docker volume ls \| grep slopboxhub_` |
| Back up a game's data | `docker run --rm -v slopboxhub_<id>-data:/d -v /mnt/user/appdata/slopbox/backups:/b alpine tar czf /b/<id>.tgz -C /d .` |
| Restore a backup (game stopped) | `docker compose stop <id> && docker run --rm -v slopboxhub_<id>-data:/d -v /mnt/user/appdata/slopbox/backups:/b alpine tar xzf /b/<id>.tgz -C /d && docker compose start <id>` |
| Wipe a game's data | `docker compose rm -sf <id> && docker volume rm slopboxhub_<id>-data && docker compose up -d <id>` |
| Fix the owner, after a game changes the user it runs as | `docker run --rm -v slopboxhub_<id>-data:/d alpine chown -R <uid>:<gid> /d` |

- **Wiping** has to remove the container first, because Docker won't delete a volume that any container uses, even a stopped one. Bringing the game back up creates a fresh volume from the image.
- **Fixing the owner** is needed because Docker copies the owner only when it creates a volume. The `node` user in `node:` images is `1000:1000`.
- **Removing a game** from the compose file leaves its volume behind. Delete it with `docker volume rm slopboxhub_<id>-data` once you're sure.

## Running it on the server

1. Clone this repo onto the server, e.g. `/mnt/user/appdata/slopbox/hub`.
2. Copy `.env.example` to `.env` and fill it in.
3. In **Compose Manager**, click **Add New Stack**, name it `slopboxhub`, and set **External folder** (called **Stack Directory** in some versions) to the cloned repo. The compose file uses paths relative to the repo (`./proxy/Caddyfile`), so a copied compose file won't find them. Afterwards, **Edit Stack → Compose File** should show the hub's file. If your version has neither option, point the stack at the repo from the terminal:
   ```bash
   P=/boot/config/plugins/compose.manager/projects/slopboxhub
   printf '%s' /mnt/user/appdata/slopbox/hub > "$P/indirect"
   rm "$P/docker-compose.yml"
   ```
   Then **Compose Up**. Don't edit the compose file from Compose Manager's editor, because it now edits the repo. Change it through a pull request instead.
4. In the Cloudflare Zero Trust dashboard, Slop Box's tunnel routes `<domain>` and `*.<domain>` to `http://caddy:80`. Its connector runs in this stack as `cloudflared`, using `CLOUDFLARE_TUNNEL_TOKEN` from `.env`.
5. Turn on automatic sync (below), so merged pull requests go live without you.

### Automatic sync: merged changes go live by themselves

Watchtower only swaps a new image in under a container that already exists, re-creating it from that container's old settings. It never reads the compose file or pulls the repo. So on its own, Watchtower can't:
- start a new game
- apply changed settings, labels, volumes or limits
- remove a game
- load a new Caddyfile or `games.json`

[scripts/server-sync.sh](scripts/server-sync.sh) does that part. Every few minutes it pulls this repo. If anything changed, it applies it:

| Changed | It does |
|---|---|
| `games.json` | Nothing more. The hub reads it on the next page load. |
| `docker-compose.yml` | `docker compose up -d --remove-orphans`. This starts new games, re-creates changed ones and removes deleted ones. Running containers keep their images, which are Watchtower's job, so Caddy and cloudflared still only update by hand. |
| `proxy/` | Reloads Caddy. |
| `hub/` | Nothing. The workflow publishes a new hub image, and Watchtower picks it up. |

The script never changes anything while games are open or in their grace period. It applies the change after they close. Merging a pull request now puts it on the server, so review changes to the compose file with that in mind.

**Setting it up:**
1. Install the **User Scripts** plugin (Apps tab).
2. Run it once by hand, with games closed, and read what it prints:
   ```bash
   bash /mnt/user/appdata/slopbox/hub/scripts/server-sync.sh
   ```
   The first run applies everything, so it runs Compose Up and reloads Caddy. With nothing new to apply, Compose should only re-create containers whose settings changed. If it re-creates everything, the script isn't passing Compose the same files as Compose Manager. The script adds Compose Manager's override file from `/boot/config/plugins/compose.manager/projects/slopboxhub/` when one exists. If yours lives elsewhere, set `COMPOSE_OVERRIDE` in the script's command.
3. **Settings → User Scripts → Add New Script**, name it `slopbox-sync`, and make its script:
   ```bash
   #!/bin/bash
   bash /mnt/user/appdata/slopbox/hub/scripts/server-sync.sh
   ```
4. Set its schedule to **Custom**, `*/5 * * * *` (every 5 minutes), then **Apply**.

**Living with it:**
- **Its output** is under **Show Log** in User Scripts. If applying a change fails, you get an Unraid notification, once per new error. It tries again every run.
- **Local edits pause it.** While the clone has changes of its own, e.g. a rollback pin, it changes nothing and says so in its log. `git checkout docker-compose.yml` undoes the pin and resumes it.
- **To apply during a party anyway:** `SYNC_FORCE=1 bash /mnt/user/appdata/slopbox/hub/scripts/server-sync.sh`.
- **A game you stopped by hand** starts again the next time the compose file changes.

**Without the script**, do the same by hand: `git pull` in the hub folder, then **Compose Up** if the compose file changed, then `docker exec slopboxhub-caddy-1 caddy reload --config /etc/caddy/Caddyfile` if the Caddyfile changed.
