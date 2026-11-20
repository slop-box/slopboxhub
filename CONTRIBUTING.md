# Contributing to Slop Box

Each game lives in its own repo in the [`slop-box`](https://github.com/slop-box) GitHub organization, and whoever makes a game owns its repo. You push to your game whenever you like, with no review from anyone. This repo (the hub) only lists the games and runs them, so changes here go through a pull request.

## Getting access

Ask the server owner for an invite to the `slop-box` organization. Members can create repos in the org and have Write access to this hub repo.

## Making a new game

1. **Create a repo** in the org from [`slop-box/game-template`](https://github.com/slop-box/game-template): **Use this template → Create a new repository**, owner `slop-box`. It's a small working game (a buzzer) that already follows the contract, with the Dockerfile, publish workflow and a test.
2. **Choose an id**: lowercase letters, digits and hyphens, e.g. `space-lawyers`. It becomes the game's address (`https://<id>.<domain>`) and image name. Check it isn't already in [games.json](games.json). `hub`, `www`, `caddy` and `cloudflared` are taken. Then run `npm run set-id -- space-lawyers` to put it everywhere in the repo.
3. **Build it** so it follows the [game contract](GAME_CONTRACT.md). Run it locally with `npm start`, then open `http://<your-computer's-ip>:<port>/` on your phone, plus `/tv` on a second screen if the game uses a TV.
4. **Push to `main`.** The workflow publishes `ghcr.io/slop-box/<id>`. After the first publish, open the package in the org's **Packages** tab and set **Package settings → Change visibility → Public**.
5. **Open a pull request on this repo** that adds your game in three places. The template's README has the snippets, already filled in with your id:
   - `games.json`: name, players, whether it needs a TV, and a one-line blurb. Write `players` and `extraDevices` in lowercase (e.g. `"4+"`, `["tablet"]`), because they show as tags on the landing page, and all tags are lowercase.
   - `docker-compose.yml`: a service named `<id>` on the `slopbox` network, with no `ports:`, the two Watchtower labels (the second is the update lock, which keeps your game from restarting mid-party), and a data volume if the game saves anything
   - `proxy/Caddyfile`: a block for `http://<id>.{$SLOPBOX_DOMAIN}` that starts with `import gate`, then proxies to `<id>:<port>`. The gate keeps the game closed until the host opens Slop Box for a party. Your game doesn't need any code for it.

   The **Hub checks** run on your pull request and must pass before it can merge. They catch a missing piece, an id that doesn't match across the three files, `ports:` on a game, a missing update-lock label, or a Caddy block without `import gate`. To run them before pushing, use `node scripts/check-config.js` (needs Docker).
6. **After it's merged**, the server owner pulls the hub on the server, runs **Compose Up** and reloads Caddy. Your game is then live at `https://<id>.<domain>`.

## Updating your game

- **Normal updates:** push to `main`. The server picks up the new image on Watchtower's next scheduled run. While games are open at a party, updates wait until the party is over.
- **Testing on the server:** just push. Watchtower checks every couple of minutes, so your game is usually live a few minutes after the publish finishes. The exception is a party: while games are open it waits until they close. The workflow's **Deploy now** box isn't turned on, so it only publishes the image and prints a warning. If deploys are turned on later:
  - Only your game restarts, even if games are open. The **deploy** job waits until the server has your new image, usually within a couple of minutes, and fails if the update failed. "Nothing to update" means the server already had that image.
  - A deploy during a party ends any round of your game in progress, so check nobody's playing it first.
  - At a big party the host may block manual deploys. The run then fails with "The host has blocked manual deploys". Your image is still published, and the server picks it up after the party.
- **Running the workflow from a branch other than `main`** publishes that branch as `:latest`, and the server picks it up like any other update. The next push to `main` replaces it.
- **Changing how the game runs on the server** (a new environment variable, a data folder, a different port): open a pull request on this repo.

## Changing the hub

Open a pull request. Every change needs the server owner's approval (see [.github/CODEOWNERS](.github/CODEOWNERS)), because the hub decides what runs on the server and who can reach it.
