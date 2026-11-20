# Slop Box: Plan

Slop Box is a hub for party games that a group of friends build. Players reach it through one domain, and it runs on the Unraid server. Each game is its own container on its own subdomain. A small hub repo ties the games together.

## Where things stand

QuickPic and DebateBros are already built the same way:

| | QuickPic | DebateBros |
|---|---|---|
| Server | Plain Node `http`, no framework | Plain Node `http` + `ws` |
| Pages | `/` phones, `/tv` TV, `/draw` tablet | `/` phones, `/tv` TV |
| Realtime | Server-sent events (`/events`) + `POST /action` | WebSocket at `/ws` |
| Port | 3000 | 3001 |
| Deploy | Push to `main` → GitHub Actions → GHCR → Watchtower | Same pipeline, plus bot tests first (private image) |

Both games use root paths everywhere (`/style.css`, `/ws`, `/action`, `/qr`, `/assets/...`). That's why each game gets a **subdomain** (`quickpic.<domain>`) and not a sub-path (`<domain>/quickpic`). With subdomains, no game needs code changes.

## Target setup

```
                         <domain>             → hub: landing page, party gate, deploy hook
 phones / TV ──HTTPS──▶  quickpic.<domain>    → quickpic container
 (browser)    Cloudflare debatebros.<domain>  → debatebros container
              Tunnel     <game>.<domain>      → ...
                                │
                         Caddy on Unraid (routes by hostname, checks the party gate)
                                │
                         Your existing Watchtower: pulls ghcr.io/slop-box/<game>:latest
                         on its normal schedule (skipped while games are open),
                         or right away when a dev triggers a deploy
```

- **GitHub org `slop-box`**: one repo per game, owned by whoever made the game, plus the hub repo `slop-box/slopboxhub`.
- **Hub repo**: compose file, Caddy config, landing page and gate, `games.json`, the game contract, and the shared CI workflow.
- **Game contract**: the short list of rules a game must follow to plug in.
- **One name per game.** A game's **id** (lowercase letters, digits and hyphens, e.g. `quickpic`) is also its subdomain, image name, compose service name and data folder. Nothing needs a mapping table.

---

## Step 0: Make the open decisions

- [x] **Exposure.** Use the existing **Cloudflare Tunnel**. No router ports are opened, and Cloudflare handles TLS.
- [x] **Routing behind the tunnel.** One wildcard hostname `*.<domain>` → **Caddy** (plain HTTP, no certificates) → game containers. Routes live in the hub repo, so adding a game is a pull request. The party gate (Step 8) depends on this: tunnel hostnames that point straight at a container would bypass it.
- [x] **Hostnames.** Every game lives at `<id>.<domain>`, one level under the domain. Cloudflare's free certificate covers `*.<domain>` but not `*.games.<domain>`. The game template (Step 9) builds this in.
- [x] **Public or gated.** Guests never log in. Games are closed until an admin opens them, and one admin login opens every game for 4 hours, plus a 1-hour grace period for devices already playing (the party gate, Step 8).
- [x] **Image visibility.** Public. Unraid and Watchtower pull with no login. Game repos can still be private.
- [x] **Org name.** `slop-box`.
- [x] **How Unraid runs the stack.** The **Compose Manager** plugin, with the hub's `docker-compose.yml` as the source of truth.
- [x] **Updates.** Your existing Watchtower, on its current schedule. It skips Slop Box games while they're open (the gate's window plus its grace hour) and catches up on a later run. Manual deploys for testing are built but **off for now** (decided 2026-11-20), so no deploy tokens are needed. The server owner updates a game right away from the server instead (Step 11).
- [x] **Hub merge rights.** The hub repo is **public**. Friends have Write access and open pull requests, and only you approve merges into `main` (branch protection + `CODEOWNERS`). Game repos are different: each friend pushes to their own with no approval.

## Step 1: Create the GitHub org and move the existing games

> **Status (2026-11-19):** QuickPic is being transferred now. **Only QuickPic for now:** make no changes to the DebateBros repo, and leave it out of the hub's `games.json`, compose file and Caddyfile. DebateBros moves later. Until then it keeps publishing to `ghcr.io/hyrumrichardson/debatebros`, and its existing Unraid container stays as it is.

1. [ ] Create a free GitHub organization named `slop-box`.
2. [ ] Transfer `hyrumrichardson/QuickPic` and `hyrumrichardson/DebateBros` into it. GitHub redirects the old repo URLs, so existing clones keep working, but update the remotes anyway: `git remote set-url origin https://github.com/slop-box/<Repo>.git`.
3. [ ] In each repo, change the image name from `ghcr.io/hyrumrichardson/<game>` to `ghcr.io/slop-box/<game>`:
   - QuickPic: `.github/workflows/docker.yml`, `docker-compose.yml`, `README.md`, `DEPLOY.md`
   - DebateBros: `.github/workflows/publish.yml`, `unraid/my-debate-bros.xml`, `unraid/*.md`, `README.md`, `CLAUDE.md`
4. [ ] Under **Org settings → Packages**, allow members to publish and allow public packages. After each game's first publish, set its package to **Public** (package settings → Change visibility). DebateBros's image is private today.
5. [ ] Push to `main` in each repo and confirm the new images appear under the org's Packages tab. The old images stay under your personal account. Delete them once Unraid pulls from the org.

**Done when:** both images build and publish under `ghcr.io/slop-box/`.

## Step 2: Create the hub repo

Turn this folder (`SlopBox`) into the **public** repo `slop-box/slopboxhub`. It must never contain secrets, because those live in the server's `.env` and in org secrets. Being public lets it use branch protection on a free org and lets every game call its shared workflow.

```
SlopBox/
├── PLAN.md
├── README.md                # what Slop Box is, how to play, how to add a game
├── GAME_CONTRACT.md         # rules a game must follow (Step 3)
├── CONTRIBUTING.md          # how friends get access, make a game, get it listed, and deploy it
├── .github/CODEOWNERS       # "* @hyrumrichardson": every change needs your review
├── .gitignore               # includes .env
├── games.json               # the list of games, read by the landing page
├── docker-compose.yml       # Caddy + hub + every game (your existing Watchtower updates them)
├── proxy/Caddyfile          # one route per game, plus the gate
├── hub/                     # landing page + party gate (small Node server, no build step)
└── .github/workflows/
    └── publish-game.yml     # reusable workflow every game calls (Step 4)
```

Example `games.json` entry. The `id` is also the subdomain, so there's no separate field for it:

```json
{
  "id": "quickpic",
  "name": "QuickPic",
  "players": "4–12",
  "needsTv": true,
  "extraDevices": ["tablet"],
  "blurb": "Draw blind. Your team shouts guesses at the TV.",
  "repo": "https://github.com/slop-box/QuickPic"
}
```

**Done when:** the repo exists with these files, even if some are still stubs.

> **Status (2026-11-19):** Files written and staged locally:
> - The README, game contract, contributing guide, `games.json`, compose file, Caddyfile, `.env.example`, `CODEOWNERS` and a placeholder landing page in `hub/public/`.
> - The compose file and Caddyfile pass `docker compose config` and `caddy validate`.
> - `publish-game.yml` comes in Step 4.
> - Next: create the public `slop-box/slopboxhub` repo on GitHub, commit and push.

## Step 3: Write the game contract

`GAME_CONTRACT.md` sets the rules every game follows. Each rule below is already true of QuickPic or DebateBros, or both:

1. **One id.** Lowercase letters, digits and hyphens. It's the game's subdomain (`<id>.<domain>`), image (`ghcr.io/slop-box/<id>`), compose service name and data folder.
2. **One container**, built from a Dockerfile in the game's repo.
3. **Listens on `$PORT`.** The default port doesn't matter, because Caddy reaches containers by name on a shared Docker network, not through host ports.
4. **Routes:** players start at `/`. A TV is optional. Games that use one put its page at `/tv` and set `"needsTv": true` in `games.json`. Other device pages are allowed (QuickPic has `/draw`).
5. **`GET /healthz`** returns `200` when the game is ready. The Dockerfile `HEALTHCHECK` uses it.
6. **Works behind HTTPS and a proxy:**
   - Build URLs from `location.origin`, never a hard-coded host or port.
   - Use `wss://` when the page is on `https:` (`location.protocol === 'https:' ? 'wss://' : 'ws://'`).
   - Join QR codes use `PUBLIC_URL` if it's set, otherwise `location.origin`.
7. **Runs as non-root.** Saved data goes in `/app/data` and nowhere else.
8. **Watchtower label in the final Dockerfile stage:** `LABEL com.centurylinklabs.watchtower.enable="true"`.
   The image must also include `sh` and Node 18 or newer. The update-lock hook (Step 11) runs `node -e "fetch(...)"` inside the container. Any `node:` base image has both.
9. **Runs standalone with `npm start`**, so a contributor never needs the hub to work on their game.
10. **Admin and debug features stay behind an env var** (like QuickPic's `ADMIN_PASSWORD`), because the game is on the public internet.
11. **Original content only:** no names, characters, art, music or layouts copied from existing games.

## Step 4: Write the shared CI workflow

The QuickPic and DebateBros workflows are almost identical. Move the shared part into `slop-box/slopboxhub/.github/workflows/publish-game.yml` as a reusable workflow (`on: workflow_call`):

- **Inputs:**
  - `id`: the game id, e.g. `quickpic`
  - `test-command` (optional): e.g. `npm test`
  - `deploy` (boolean, default `false`): deploy right after publishing
- **Steps:**
  1. Checkout, then run the test command if one is given.
  2. Build with buildx and push `ghcr.io/slop-box/<id>:latest` and `:sha-<commit>`, using the GHA cache.
  3. If `deploy` is true, call the deploy hook (Step 11), which updates only this game.
- **Build arg:** `GIT_SHA`, so games can show their version (DebateBros already does).

Each game's workflow then shrinks to:

```yaml
name: Publish
on:
  push: { branches: [main] }          # publishes; the server picks it up on Watchtower's next run
  workflow_dispatch:                  # "Run workflow" button in the Actions tab
    inputs:
      deploy: { type: boolean, default: true, description: Deploy to the server now }
permissions: { contents: read, packages: write }
jobs:
  publish:
    uses: slop-box/slopboxhub/.github/workflows/publish-game.yml@main
    with:
      id: debatebros
      test-command: npm ci && npm test && node test/bots.js 6 && node test/bots.js 2
      deploy: ${{ inputs.deploy == true }}
    secrets: inherit
```

- [x] Write the reusable workflow (`.github/workflows/publish-game.yml`). It also publishes `:sha-<full commit>`, which QuickPic's rollback docs use, and checks that the id is valid.
- [x] Switch QuickPic over to it (`.github/workflows/publish.yml`, renamed from `docker.yml`).
- [ ] Switch DebateBros over to it when it moves to the org. Pass its bot tests as `test-command: npm ci && npm test && node test/bots.js 6 && node test/bots.js 2`.

> **Status (2026-11-19):** Both workflows pass actionlint. **Push the hub first:** QuickPic's workflow calls `slop-box/slopboxhub/...@main`, so it fails until the hub's `main` has `publish-game.yml`. Until the deploy secrets exist (Step 11), **Deploy now** only prints a warning and the image still publishes.

**Done when:** a push to either game publishes its image through the shared workflow.

## Step 5: Set up the domain, DNS and proxy on Unraid

1. [ ] Slop Box has **its own Cloudflare Tunnel**. Its connector runs in the hub stack as `cloudflared`, using `CLOUDFLARE_TUNNEL_TOKEN` from `.env`. It shares the `slopbox` network with Caddy and the games. Caddy also publishes `SLOPBOX_HTTP_PORT` (default 8480), but only for testing from the home network.
2. [ ] Add public hostnames to the tunnel: `<domain>` and `*.<domain>`, both → `http://caddy:80`. The dashboard creates a DNS record for each hostname, but check that the `*` CNAME exists. Your other services' DNS records still take priority, because a specific record always beats the wildcard.
3. [ ] Set up Caddy with one route per game, plus the hub at the bare domain. Cloudflare handles TLS, so Caddy serves plain HTTP:
   ```
   {
     auto_https off
   }
   http://<domain>             { reverse_proxy hub:8080 }
   http://quickpic.<domain>    { reverse_proxy quickpic:3000 }
   http://debatebros.<domain>  { reverse_proxy debatebros:3001 }
   ```
   Caddy passes WebSockets and SSE through with no extra settings. Step 8 adds the gate to this file.
4. [ ] Check that each game builds its own links and join QR codes as `https://`, because the browser is on HTTPS even though the containers only see HTTP. Both games build URLs from `location.origin`, so this should already work. Set `PUBLIC_URL` for any game whose server builds its own absolute URLs.
5. [ ] Turn off Cloudflare features that can break live updates: **Rocket Loader** and HTML minification, which rewrite game scripts. Confirm that QuickPic's SSE stream reaches the TV without a delay.
6. [ ] Clone the hub repo onto the server (e.g. `/mnt/user/appdata/slopbox/hub`) and add it as a **Compose Manager** stack that uses its `docker-compose.yml`. Secrets (`SLOPBOX_ADMIN_PASSWORD`, `SLOPBOX_GATE_SECRET`, `SLOPBOX_DEPLOY_TOKEN`, `WATCHTOWER_API_TOKEN`) go in a `.env` file next to it, which is never committed.

**Done when:** `https://<domain>` loads from a phone on mobile data, not only on the home Wi-Fi.

> **Status (2026-11-19):** Done for QuickPic. Slop Box has its own tunnel, and its connector runs in the `slopboxhub` stack.

## Step 6: Bring QuickPic and DebateBros onto the hub

Do this for each game:

1. [ ] Add a `/healthz` route. Point the Dockerfile `HEALTHCHECK` at it (DebateBros currently uses `/config.json`).
2. [ ] Add `LABEL com.centurylinklabs.watchtower.enable="true"` to the Dockerfile. Right now QuickPic only sets it in its compose file, and DebateBros only in its Unraid template.
3. [ ] Add the game to the hub's `docker-compose.yml`:
   - service name = game id, on the `slopbox` network
   - no host `ports:` (Caddy reaches it by name)
   - the Watchtower enable label and the update-lock hook label (Step 11)
   - `/app/data` mounted from `/mnt/user/appdata/slopbox/<id>`, with `PUID=99`/`PGID=100` where the game supports it
4. [ ] Add the game to `games.json` and to the Caddyfile.
5. [ ] Stop and remove the old standalone container that runs on port 3000/3001.
6. [ ] **Test a real game over HTTPS:** TV browser on `https://<id>.<domain>/tv` and phones joining by QR code. Confirm all of the following:
   - The QR code shows the `https://` subdomain, not a LAN IP.
   - Realtime updates work (WebSocket for DebateBros, SSE for QuickPic).
   - Reconnecting after a phone locks its screen still works.

**Done when:** a full game of each runs on the TV through the public URLs.

> **Status (2026-11-19), QuickPic:**
> - Items 1–2 are done: `/healthz` route, plus the Dockerfile `HEALTHCHECK` and Watchtower label.
> - Items 3–4 were already in the hub.
> - QuickPic needs no data volume, because it doesn't save anything.
> - Left: remove the old standalone container, and play a full game on the public URL.

## Step 7: Build the landing page

- [ ] Build a page at `<domain>` that reads `games.json` and shows a card per game (name, players, "needs a TV", blurb), each linking to `https://<id>.<domain>`.
- [ ] Make it readable on a phone and also on a TV browser driven by a remote (arrow keys plus OK).
- [ ] For games that use a TV, give the card a "TV" link that goes straight to `https://<id>.<domain>/tv`, so the TV only needs one bookmark (the hub). Games without a TV only get a "Play" link.
- [ ] Serve it from a small Node container (`hub`), built by the shared workflow like a game. The same container runs the party gate (Step 8).
- [ ] The landing page is always reachable. It shows whether games are open and how much time is left.

**Done when:** the TV can open `<domain>`, pick a game, and land on that game's TV page.

> **Status (2026-11-19):** Built and tested locally (routes, phone and TV layouts).
> - **`hub/`:** a plain Node server on port 8080 with `/healthz`, plus the page, styles and arrow-key navigation for TV remotes.
> - **`games.json`:** read from the cloned repo (`GAMES_FILE`), so `git pull` updates it without a new image.
> - **Publishing:** the hub's own `publish.yml` builds `ghcr.io/slop-box/hub` with the shared workflow, which now has a `dockerfile` input.
> - **Caddy:** now mounts the `proxy/` folder, so a pulled Caddyfile change can be reloaded.
> - **Not yet:** showing whether games are open. That waits for the gate (Step 8).

## Step 8: Add the party gate

Games are closed until an admin opens them. One admin login opens every game for everyone for 4 hours. Guests never see a login. The check happens in Caddy, so no game needs code for it.

**Gate routes (served by the `hub` container):**

| Route | Job |
|---|---|
| `<domain>/admin` | Password form. The password comes from `SLOPBOX_ADMIN_PASSWORD` in the server's `.env`. Logging in opens the window (`openUntil = now + 4h`). Once logged in, the admin can **Extend 1 hour** or **Close now**. `openUntil` is saved to `/app/data`, so restarting the container doesn't close the games. |
| `/check` | Caddy calls this for every request to a game subdomain. It returns `200` to let the request through, or a redirect to `/closed`. |
| `<domain>/pass` | Gives the device a pass cookie, then sends it back where it was going (see "Grace period" below). |
| `<domain>/closed` | Friendly page: "Slop Box is closed. Ask the host to open it." It links to `/admin`. |

**Caddy:** every game route imports one shared snippet:

```
(gate) {
  forward_auth hub:8080 {
    uri /check
  }
}

http://quickpic.<domain> {
  import gate
  reverse_proxy quickpic:3000
}
```

When `/check` doesn't return 2xx, Caddy sends its response (the redirect) to the browser and never reaches the game.

**Grace period, so a game isn't cut off mid-round:**

- While the window is open, `/check` sends any device without a pass cookie to `<domain>/pass?next=<url>`. That page sets a signed `slopbox_pass` cookie on `Domain=<domain>`, which covers every game subdomain, and redirects back. On a QR scan this is one redirect the guest won't notice.
- After the window ends, new devices get the closed page. Devices holding a pass from that window keep working for **1 more hour**, so a game in progress can finish.
- The cookie only identifies the window. The server checks it against the current `openUntil`, so **Extend** covers existing devices and **Close now** shuts everyone out right away.

**Update lock:** while games are open, including the grace hour, Watchtower's scheduled updates skip Slop Box games, so no game restarts mid-party (Step 11).

**Security:**

- [ ] Allow at most 5 login attempts per minute per IP (Caddy and the gate see the real IP in the `CF-Connecting-IP` header).
- [ ] Sign cookies with `SLOPBOX_GATE_SECRET`. The admin session cookie is separate from the pass cookie.
- [ ] Games publish no host ports, so the only way in is through the tunnel and Caddy. Keep it that way: a game with `ports:` in the compose file can be reached on the home network without passing the gate.

**Done when:**

- [ ] On mobile data with the window closed, every game subdomain shows the closed page.
- [ ] After the admin logs in, scanning a game's QR code joins the game with no extra prompts, and WebSocket (DebateBros) and SSE (QuickPic) both work through the gate.
- [ ] After the window ends, a phone that joined earlier keeps playing, and a new phone gets the closed page.
- [ ] **Close now** blocks both.

> **Status (2026-11-19):** Built in `hub/gate.js` and `hub/server.js`. `node hub/test.js` passes all 19 checks, and the hub's Publish workflow runs it before every build.
> - **Background requests** (live updates, actions, WebSockets) without a pass are let through while games are open, so a game never breaks mid-round. When games are closed they get a `403`.
> - **Page loads** without a pass are sent to `/pass` (games open) or `/closed` (games closed).
> - **The closed page** checks every 10 seconds and lets the guest in as soon as the host opens the games.
> - **The gate state** lives in a Docker named volume (`hub-data`), because an appdata folder would be owned by root.
> - **The landing page** shows a banner: open with time left, closing, or closed.
> - **Caddy:** the QuickPic route has `import gate`.
> - **Left:** the on-device checks above, after deploying.

## Step 9: Make a game template repo

Create `slop-box/game-template`, marked as a **template repository** in GitHub settings. It contains:

- [ ] A minimal Node server that already follows the contract: `$PORT`, `/`, an optional `/tv` (easy to delete for phone-only games), `/healthz`, WebSocket, room code, QR join and phone reconnect
- [ ] A Dockerfile with the non-root user, `/app/data`, the Watchtower label and the healthcheck
- [ ] The short workflow calling `publish-game.yml`, with the manual **Deploy now** option
- [ ] The game id as a single placeholder (`GAME_ID`) in the workflow, `package.json` and README. Setting it once gives the game its image name and its address, `https://<id>.<domain>`.
- [ ] A ready-to-paste snippet for the hub pull request: the `games.json` entry, the compose service (with the `slopbox` network, Watchtower labels including the update-lock hook, and data mount) and the Caddy route (with `import gate`), each filled in from the id
- [ ] A README checklist: choose the id, run `npm start`, open `/` (and `/tv` if the game uses a TV), push, then open the hub pull request

Wait for a third game before pulling shared code (QR, rooms, reconnect) into an npm package. Copying from the template is fine until then.

**Done when:** a friend can click "Use this template", set the id, push, and get an image published under the org.

> **Status (2026-11-19):** Built at `c:\git-repos\game-template` and staged.
> - **The demo game** is a buzzer: phones join and buzz, and the TV shows the QR code, the players and the winner. It has no dependencies and uses server-sent events plus `POST /action`, like QuickPic. It runs one game per server, with no room codes.
> - **Players** keep a secret key on their phone. Others only see a short id derived from it, so nobody can buzz as someone else.
> - **`npm run set-id -- <id>`** renames the placeholder `my-game` everywhere. It refuses invalid ids and `hub`, `www`, `caddy` and `cloudflared`.
> - **`npm test`** plays a short game against a real server, and the publish workflow runs it.
> - **The template's own workflow** skips publishing when it runs in `slop-box/game-template`.
> - **QR codes** use QuickPic's `qr.js`.
> - **Left:** create the `slop-box/game-template` repo, push it, and tick **Template repository** in its settings.

## Step 10: Onboard friends

- [ ] Invite friends to the org, and turn on **Org settings → Member privileges → Repository creation** so they can create their own game repos. Each friend is admin on their own game's repo and pushes to it with no approval from anyone.
- [ ] Give friends **Write** access to the hub repo, so they can push branches and open pull requests.
- [ ] Protect the hub's `main` branch with a ruleset in the **hub repo's** settings (**Settings → Rules → Rulesets**). Org-level rulesets need a paid plan; repo-level ones are free on public repos. Require a pull request, 1 approval and review from code owners, and block force pushes. Add yourself to the bypass list. GitHub doesn't let anyone approve their own pull request, and you're the only code owner, so without the bypass your own changes could never merge.
- [ ] Each game repo sets its own rules. Friends push to their own repos with no approval.
- [ ] Once **Hub checks** has run once, add it to the ruleset under **Require status checks to pass**. The check comes from `.github/workflows/check.yml`, which runs `scripts/check-config.js`, `caddy validate` and the hub tests on every pull request.
- [ ] Write `CONTRIBUTING.md` with the flow:
  1. Create a repo from `game-template` and set the game id.
  2. Build and test locally with `npm start`.
  3. Push to `main` to publish the image.
  4. Open a pull request on the hub with the snippet from the template (`games.json`, `docker-compose.yml`, Caddyfile).
  5. Once it's merged, the server owner runs `git pull` in the hub folder on the server and **Compose Up** in Compose Manager.
  6. From then on, the game updates on Watchtower's normal schedule (skipped while games are open), or right away with **Run workflow → Deploy now** (Step 11).

## Step 11: Set up updates

Slop Box uses **your existing Watchtower** with its **current schedule**. No second Watchtower is added. The hub adds two things on top:

- **Update lock:** while games are open (the gate's window plus its grace hour), Watchtower skips Slop Box containers.
- **Manual deploy:** any dev can update their own game right away, even while games are open. **Off for now** (decided 2026-11-20): it's built, but stays off until the two tokens are set, so nobody needs deploy secrets yet. Until then, the server owner updates a game right away with `docker compose pull <id> && docker compose up -d <id>` in the hub folder.

**How the lock works:**

Watchtower can run a command inside a container just before updating it (a *pre-update lifecycle hook*). If the command exits with code `75`, Watchtower skips that container for this run and tries again at its next scheduled check. Each Slop Box service in the hub's compose file gets this hook as a label. Nothing goes in the game's code or image:

```yaml
  quickpic:
    image: ghcr.io/slop-box/quickpic:latest
    labels:
      com.centurylinklabs.watchtower.enable: "true"
      com.centurylinklabs.watchtower.lifecycle.pre-update: >-
        node -e "fetch('http://hub:8080/update-allowed?id=quickpic').then(r=>process.exit(r.ok?0:75),()=>process.exit(75))"
```

The hub gets the same hook, with one difference: if the hub doesn't answer, its hook allows the update. A hub that doesn't answer is broken, so a new image can only help.

The hub's `/update-allowed?id=<id>` route answers:

- `200` when games are closed and the grace hour is over → Watchtower updates the game.
- `200` when a manual deploy for that id is in progress → the update goes through even while games are open.
- `423` otherwise → the hook exits `75` and Watchtower skips the game until its next run.

If the hub can't be reached, a game's hook also exits `75`, so a broken hub never lets an update through mid-party.

Every answer is recorded, so the admin page shows each game's last update (scheduled or manual) and the scheduled updates skipped while games were open.

**Changes to your existing Watchtower** (its schedule stays as it is):

- [ ] `WATCHTOWER_LIFECYCLE_HOOKS=true`. This turns on the lock. It only affects containers that have a lifecycle label, so your other containers update as before.

Only when turning manual deploys on:

- [ ] `WATCHTOWER_HTTP_API_UPDATE=true` and `WATCHTOWER_HTTP_API_TOKEN=<WATCHTOWER_API_TOKEN>`. This lets the hub trigger manual deploys.
- [ ] `WATCHTOWER_HTTP_API_PERIODIC_POLLS=true`. **Required:** without it, turning on the HTTP API stops Watchtower's normal schedule.
- [ ] Connect the Watchtower container to the `slopbox` network so the hub can reach it at `watchtower:8080`: `docker network connect slopbox watchtower`. Don't publish port 8080.
  - Unraid drops this extra network when it re-creates the container (after a template edit or a Watchtower update), so run the command again after either one. A broken connection shows on the admin page as "Couldn't reach Watchtower".
  - If the container isn't named `watchtower`, set `WATCHTOWER_URL=http://<its name>:8080` in `.env`.

**Manual deploy, for any dev, for testing (off for now):**

1. A dev opens their game's repo and goes to **Actions → Publish → Run workflow**, with **Deploy now** ticked. The workflow builds, tests and publishes the game.
2. The workflow calls the hub:
   ```
   curl -X POST -H "Authorization: Bearer $SLOPBOX_DEPLOY_TOKEN" "https://<domain>/deploy?id=<id>"
   ```
3. The hub checks the token and that `<id>` is a game in `games.json`, then marks the deploy as in progress for that id.
4. The hub calls Watchtower: `http://watchtower:8080/v1/update?image=ghcr.io/slop-box/<id>` with `WATCHTOWER_API_TOKEN`. The `image` filter limits the update to this one game. Without the filter, the call would update every container your Watchtower manages.
5. That game's hook sees the deploy in progress and allows the update. Watchtower restarts only that game. The hub clears the mark and reports the result to the workflow, so a failed deploy fails the run:
   - **updated:** the hook ran, so Watchtower pulled the new image and restarted the game.
   - **nothing to update:** Watchtower answered without running the hook, so the server already had that image.
   - **failed:** Watchtower answered with an error, couldn't be reached, or took more than 10 minutes.
6. Cloudflare drops a request after 100 seconds, so the hub answers `running` after one minute. The workflow then checks back with `GET /deploy?id=<id>` every 10 seconds, for up to 10 minutes. It also keeps trying while the hub doesn't answer at all, which happens when the hub deploys itself.

There are two tokens, so devs can never call Watchtower directly. The deploy URL is a secret too:

| Token | Lives in | Used for |
|---|---|---|
| `SLOPBOX_DEPLOY_TOKEN` | Org-level Actions secret, plus the server's `.env` | Devs' workflows → hub `/deploy` |
| `SLOPBOX_DEPLOY_URL` | Org-level Actions secret (`https://<domain>/deploy`) | Where the shared workflow sends deploys. It's a secret so the domain stays out of the public hub repo. |
| `WATCHTOWER_API_TOKEN` | The server's `.env`, plus your Watchtower's settings | Hub → Watchtower |

- [x] Add `/deploy` and `/update-allowed` to the `hub` container. `/deploy` is on the bare domain, so it's outside the party gate. Allow at most 10 deploy calls per minute per IP address. Status checks with the right token don't count.
- [x] `/update-allowed` is only reachable on the `slopbox` Docker network. Caddy returns `404` for it from outside.
- [x] Show on the admin page: the last update for each game, whether it was scheduled or manual, and any scheduled updates skipped because games were open.
- [x] Note for `CONTRIBUTING.md`: running the workflow from a branch other than `main` publishes that branch as `:latest`. That's handy for testing on the server, but the next push to `main` replaces it, and the server picks that up at Watchtower's next scheduled run.
- [x] Note for `CONTRIBUTING.md`: a manual deploy during a party restarts that game, which ends any round in progress. Check that the game isn't being played first.
- [ ] If Cloudflare's bot protection challenges the workflow's `curl` (the deploy fails with an HTML `403`), add a WAF rule that skips it for the path `/deploy`.

**Game night:**

- [x] Scheduled updates are locked automatically while games are open. For a big party, the admin page also has a **Block manual deploys** switch, which makes `/deploy` return `423` until it's turned off.
- [x] **Rollback:** pin a game to a known-good `:sha-<commit>` tag in the compose file, then unpin once it's fixed (README, "Updates").
- [x] **If the hub itself is broken**, manual deploys and the lock can't work. Update the hub from Compose Manager instead (pull, then up). Watchtower may also update it on its own, because the hub's hook allows updates when the hub doesn't answer.
- [x] Put basic resource limits (`mem_limit`, `cpus`) on each game container, so one buggy game can't slow the server. **Hub checks** fail a game without them.

**Check against your Watchtower version** (`nickfedor/watchtower`) before relying on it:

- [ ] Exit code `75` from a pre-update hook skips the update without stopping the container.
- [ ] `/v1/update?image=...` updates only that image.
- [ ] `WATCHTOWER_HTTP_API_PERIODIC_POLLS=true` keeps the normal schedule running.

**Done when:**

- [ ] A game pushed during the day updates at Watchtower's next scheduled run.
- [ ] With games open during a scheduled run, no Slop Box container restarts, your other containers still update, and the skipped game updates on a later run after games close.
- Once manual deploys are on:
  - [ ] **Run workflow → Deploy now** restarts only that game within a couple of minutes, whether or not games are open.
  - [ ] A deploy call without the token is rejected.

> **Status (2026-11-20):** The hub side is built. Manual deploys stay off for now, so the only server change is one Watchtower setting.
> - **`hub/updates.js`** decides each hook call, tracks manual deploys and keeps the history in `/app/data/updates.json`. `hub/server.js` serves `/update-allowed` and `/deploy`, and the admin page has an **Updates** panel with the **Block manual deploys** switch.
> - **Compose:** QuickPic and the hub have the hook label. The hub gets `SLOPBOX_DEPLOY_TOKEN`, `WATCHTOWER_API_TOKEN` and `WATCHTOWER_URL`.
> - **Hub checks:** `scripts/check-config.js` fails any game whose hook label is missing or names the wrong id.
> - **Caddy:** `/update-allowed` returns `404` on the bare domain.
> - **`publish-game.yml`** waits for the deploy result, and fails the run when the deploy fails.
> - **Tested:** `node hub/test.js` passes 30 checks, 11 of them for updates against a fake Watchtower. The hook labels were run with `sh -c` in `node:22-alpine` against a real hub. They exit `0` when games are closed and `75` when they're open. When the hub is down, a game's hook exits `75` and the hub's exits `0`. The workflow's deploy script was run against a hub and a fake Watchtower for each kind of result.
> - **Left:**
>   - After the hub's Publish run finishes: `git pull`, then **Compose Pull** and **Compose Up**. Pull the image first. If the hook labels go live on the old hub image, every hook gets a `404` and exits `75`, so nothing updates, not even the hub.
>   - Add `WATCHTOWER_LIFECYCLE_HOOKS=true` to Watchtower.
>   - Check that exit code `75` skips the update without stopping the container, then the first two "Done when" items.
>   - **Later, to turn manual deploys on:** follow "Manual deploys" in the README (tokens, org secrets, three more Watchtower settings, the network). Then do the two remaining Watchtower checks and the deploy items under "Done when".

## Later (not needed yet)

- **TV handoff:** the hub's TV page starts a game and passes the room on, so phones follow along without rescanning.
- **Shared library:** a `@slop-box/party-kit` package for rooms, QR, reconnect and TV scaling, once three or more games share real code.
- **Shared player identity** across games (names and avatars carried from game to game).
- **Uptime page** on the hub showing each game's `/healthz`.
