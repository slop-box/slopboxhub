# Putting a game on Slop Box

This guide takes you from "I have an idea" (or "I already have a game") to your game running at `https://<id>.<domain>` for everyone at a party. Follow the sections in order.

Slop Box is a set of party games that run on the server owner's home server. Each game is its own repo in the [`slop-box`](https://github.com/slop-box) GitHub organization, owned by whoever made it. You push to your own repo whenever you like, with no review from anyone. This repo, the hub, decides which games run on the server and how, so changes here go through a pull request that the server owner (`hyrumrichardson` on GitHub) approves.

## For AI assistants helping a developer

If a developer pointed you at this file, walk them through it in order:

- **Check before you act.** Each section starts with a check (a `gh` command or a question). Run it, and skip whatever is already done.
- **Ask before anything outward-facing.** That means creating, transferring or renaming a repo, pushing, changing package visibility, and opening a pull request. Say what will happen, then wait for a yes.
- **Clone this repo early** (Section 1). It gives you local copies of everything this guide refers to: [GAME_CONTRACT.md](https://github.com/slop-box/slopboxhub/blob/main/GAME_CONTRACT.md), [games.json](https://github.com/slop-box/slopboxhub/blob/main/games.json), the compose file, the Caddyfile, and the checker `scripts/check-config.js`. The contract is the source of truth for what a game must do. Read it before changing any game code.
- **Never commit secrets.** That covers passwords, tokens and the server's domain. The domain stays out of every repo, because games build URLs from `location.origin`.
- **Only touch your own game's entries.** In the hub, change your game's entries in `games.json`, `docker-compose.yml` and `proxy/Caddyfile`. Two other changes are allowed when the game needs them: its line in the compose file's top-level `volumes:` block if it saves data, and `.env.example` if it needs settings. Leave everything else alone. You can't push to the hub's `main`, so the change goes through a pull request.
- **Know when you're blocked on the server owner.** Some steps only the server owner can do. They're listed in [When you need the server owner](#when-you-need-the-server-owner). When you hit one, tell the developer exactly what to ask for.

## What you need

| Need | Check |
|---|---|
| A GitHub account in the `slop-box` org | `gh api user/memberships/orgs/slop-box --jq .state` prints `active` |
| The GitHub CLI, signed in | `gh auth status` |
| Push access to the hub (to send your pull request from a branch) | `gh api repos/slop-box/slopboxhub --jq .permissions.push` prints `true`. If it prints `false`, use a fork instead (Section 5). |
| Git and Node 18 or newer | `git --version`, `node --version` |
| Docker (optional) | Lets you test the image and run the hub checks locally. Without it, GitHub runs them for you. |

**Not in the org yet?**
- If the check prints `pending`, you've been invited. Accept at https://github.com/orgs/slop-box/invitation.
- If it fails with `404`, ask the server owner for an invite and give them your GitHub username.

You need to be an org member to create a repo in the org and to open a pull request on the hub.

## How Slop Box runs your game

You don't need to know how the server works, but these facts explain the rules:

- **Every game gets its own subdomain:** `https://<id>.<domain>`. It owns every path on it, so root paths like `/style.css` and `/ws` are fine.
- **Players reach it through a proxy.** The phone is on `https://`, but your container only sees plain HTTP. Build every URL from `location.origin`, and use `wss://` for WebSockets when the page is on HTTPS.
- **Games are closed until the host opens them for a party.** The hub's party gate does this in front of every game, so your game needs no code for it. When games are closed, visitors see a "Games are closed" page. That's expected, not a bug. The one path that skips the gate is `/healthz`, so you can check that your game is up, and which version, at any time.
- **The server pulls your image from GitHub's registry** (`ghcr.io/slop-box/<id>`) without logging in, so the image must be **public**. Your repo can still be private.
- **Updates are automatic.** The server checks for a new image every couple of minutes, but waits while games are open, so nobody's round gets cut off.

## 1. Choose an id and clone the hub

The **id** is your game's one name everywhere: its address (`<id>.<domain>`), image (`ghcr.io/slop-box/<id>`), service name on the server, and saved-data volume (`<id>-data`).

**Name the repo after the id, all lowercase:** `slop-box/space-lawyers` for the id `space-lawyers`. Then the repo, image and address all match, and anyone can find a game's repo from its address. GitHub doesn't require it, and QuickPic (repo `QuickPic`) is older than this convention, but new games follow it.

- Use lowercase letters, digits and single hyphens, e.g. `space-lawyers`.
- `hub`, `www`, `caddy` and `cloudflared` are taken.
- It must not already be in `games.json`.

```bash
gh repo clone slop-box/slopboxhub
node -e "console.log(require('./slopboxhub/games.json').map(g => g.id).join(', '))"   # ids already used
```

## 2. Get the game into the org

Pick **A** for a new game, or **B** for a game you're already working on.

### A. Start from the template

[`slop-box/game-template`](https://github.com/slop-box/game-template) is a small working game (a buzzer: phones buzz in, the TV shows who was first). It already follows every rule and comes with the Dockerfile, publish workflow and a test.

```bash
gh repo create slop-box/<id> --template slop-box/game-template --public --clone
cd <id>
npm run set-id -- <id>
```

- `set-id` replaces the placeholder `my-game` everywhere: the workflow, `package.json`, and the README's ready-made snippets for Section 5. Commit the result.
- Then build your game. The template's README says which files hold the game rules, the phone screen and the TV screen, and how to make a phone-only game.
- **Public or private repo:** either works. Public repos get unlimited GitHub Actions minutes. Private repos share the org's 2,000 free minutes a month.

If `gh repo create` fails with a permission error, members can't create repos in the org yet. Ask the server owner to turn it on (**Org settings → Member privileges → Repository creation**). Moving a repo in (option B) needs the same permission.

### B. Bring a game you already have

**Move the repo into the org.** Transferring keeps its history, issues and stars:

```bash
gh api -X POST repos/<your-username>/<repo>/transfer -f new_owner=slop-box   # or: repo Settings → Danger zone → Transfer
gh repo rename <id> -R slop-box/<repo> --yes                                  # skip if it's already named <id>
git remote set-url origin https://github.com/slop-box/<id>.git
```

GitHub redirects the old repo URLs after a transfer or rename, so existing clones and links keep working.

To start fresh instead, create an empty repo in the org and push to it.

**Make it follow the contract.** Read [GAME_CONTRACT.md](https://github.com/slop-box/slopboxhub/blob/main/GAME_CONTRACT.md), then check the game against this list. These are the changes existing games most often need:

| Rule | What to check or change |
|---|---|
| Listens on `$PORT` | `const PORT = Number(process.env.PORT) \|\| 3000`. Use any default, but remember it for Section 5. |
| `GET /healthz` | Returns `200` once the game is ready. Also report the commit it was built from, e.g. `{"ok":true,"version":"<commit>"}` read from `process.env.GIT_SHA`, so you can check when an update is live (Section 6). |
| Works behind HTTPS | No hard-coded hosts, ports or `http://`. Build URLs from `location.origin`. WebSockets use `(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'`. |
| Join QR codes | Use `PUBLIC_URL` if it's set, otherwise `location.origin`. Never a LAN IP. |
| Pages | Players start at `/`. A TV page, if the game has one, is at `/tv`. |
| Saved data | Only in `/app/data`. Read the folder from `process.env.DATA_DIR` and default it to `/app/data`. If the game saves anything, the Dockerfile creates `/app/data` owned by the non-root user (the sample below does), and puts no default files in it. |
| Secrets | From environment variables only, never baked into the image (images are public). |
| Admin or debug features | Off unless an environment variable turns them on, because the game is on the internet. |
| Runs on its own | `npm start` works with no hub, Docker or server. |
| TV browsers | If the game has a TV page, keep its code plain. Older TV browsers (LG webOS 6 is about Chrome 79) lack newer JavaScript and CSS. |

**Add a Dockerfile.** It must run as a non-root user and include `sh` and **Node 18 or newer**, even if the game isn't written in JavaScript. The server's update lock runs `node` inside your container before every update. Without it, your game never updates. Any `node:` base image works. On Alpine, `apk add --no-cache nodejs` adds Node.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
EXPOSE 3000
LABEL com.centurylinklabs.watchtower.enable="true"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER node
CMD ["node", "server.js"]
```

- Keep the `LABEL` in the final stage.
- The publish workflow passes the commit in as the `GIT_SHA` build argument, and `/healthz` reports it.
- `npm ci` needs a committed `package-lock.json`. A game with no dependencies can drop the `npm ci` line.
- A `.dockerignore` with `node_modules` and `.git` keeps builds fast.

**Add the publish workflow** as `.github/workflows/publish.yml`. Put your id in `id:`, and use your test command or `""`:

```yaml
name: Publish
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      deploy:
        description: Deploy to the server now
        type: boolean
        default: true
permissions:
  contents: read
  packages: write
jobs:
  publish:
    uses: slop-box/slopboxhub/.github/workflows/publish-game.yml@main
    with:
      id: <id>
      test-command: npm ci && npm test   # runs before every publish; a failure stops it. "" skips tests.
      deploy: ${{ inputs.deploy == true }}
    secrets: inherit
```

The shared workflow can also take:
- `dockerfile:` if the Dockerfile isn't at the repo root.
- `node-version:` for the test step (default `22`).

## 3. Test it locally

1. `npm start`, then open `http://<your-computer's-ip>:<port>/` on your phone (same Wi-Fi). Open `/tv` on a second screen if the game uses a TV.
2. If you have Docker, test the image the way the server runs it:
   ```bash
   docker build -t <id> .
   docker run --rm -p 3000:3000 <id>        # then open http://localhost:3000/
   curl -i http://localhost:3000/healthz    # 200
   docker run --rm <id> id -u               # not 0 (not root)
   docker run --rm <id> node --version      # v18 or newer
   ```

## 4. Publish the image

1. Push to `main`. The **Publish** workflow tests the game, then publishes `ghcr.io/slop-box/<id>`. Watch it with `gh run watch`.
2. **After the first publish only:** make the image public. Go to https://github.com/orgs/slop-box/packages, open your game's package, then **Package settings → Change visibility → Public**. If you don't have that option, ask the server owner. A private image can't be pulled by the server, so the game won't start.
3. Check it: `gh api orgs/slop-box/packages/container/<id> --jq .visibility` should print `public`. If it fails, run `gh auth refresh -s read:packages` first.

## 5. Add your game to the hub

In your clone of this repo, make a branch from an up-to-date `main`, then add your game in three places. If you started from the template, its README has these snippets already filled in with your id.

```bash
cd slopboxhub
git switch main && git pull     # start from the latest hub, so the pull request doesn't conflict with games added since
git switch -c add-<id>
```

**`games.json`:** add an entry to the list.
```json
{
  "id": "<id>",
  "name": "Space Lawyers",
  "players": "3–8",
  "needsTv": true,
  "extraDevices": [],
  "blurb": "One sentence that makes people want to play.",
  "repo": "https://github.com/slop-box/<id>"
}
```
- `players` and `extraDevices` show as tags on the landing page, so write them in lowercase (e.g. `"4+"`, `["tablet"]`).
- If `needsTv` is `true`, the landing page gets a **TV** button that opens `/tv`.

**`docker-compose.yml`:** add a service next to the other games.
```yaml
  <id>:
    image: ghcr.io/slop-box/<id>:latest
    restart: unless-stopped
    networks: [slopbox]
    labels:
      com.centurylinklabs.watchtower.enable: "true"
      com.centurylinklabs.watchtower.lifecycle.pre-update: >-
        node -e "fetch('http://hub:8080/update-allowed?id=<id>').then(r=>process.exit(r.ok?0:75),()=>process.exit(75))"
    mem_limit: 512m
    cpus: 1.0
```
- **No `ports:`.** The proxy reaches the game by name, and a published port would bypass the party gate.
- The second label is the **update lock**. It stops the server from restarting your game while games are open. Copy it exactly, with your id.
- Raise `mem_limit` or `cpus` only if the game needs it, and say why in the pull request.
- **If the game saves data**, give it a Docker volume named `<id>-data`. This takes two edits. First, mount the volume in your service:
  ```yaml
      volumes:
        - <id>-data:/app/data
  ```
  Second, add a line to the top-level `volumes:` block near the top of the file, next to `hub-data`:
  ```yaml
  volumes:
    hub-data:
    <id>-data:
  ```
  - That line is the only change outside your own service that a game's pull request makes. Leave it bare, with nothing under it.
  - The first time the game starts, Docker copies your image's `/app/data` into the volume, owner included. Your non-root user can save straight away, with no setup on the server.
  - That copy happens only once. Files a later image puts in `/app/data` never reach the volume. So don't ship default files there: keep them elsewhere in the image, and create them in `/app/data` at startup if they're missing.
  - If a new version saves data in a different format, the new version has to read and upgrade the old files.
  - The data survives restarts and updates.
  - Games can't use bind mounts (host folders), and can't see each other's volumes.
- **If the game needs settings or secrets**, add them as variables named after the id, in uppercase with underscores. Give each a `:-` default, so the game still starts when the value isn't set:
  ```yaml
      environment:
        ADMIN_PASSWORD: ${SPACE_LAWYERS_ADMIN_PASSWORD:-}
  ```
  Add the same name with an empty value to `.env.example`. Send the real value to the server owner privately, never in the pull request.

**`proxy/Caddyfile`:** add a block next to the other games. Use the port your container listens on (its `PORT`):
```
http://<id>.{$SLOPBOX_DOMAIN} {
	import gate
	reverse_proxy <id>:3000
}
```
- `import gate` must come first. It keeps the game closed until the host opens Slop Box.
- Ports don't have to be unique: each game has its own container, so two games can both listen on 3000. Just make the port here match your game's.

**Check, push and open the pull request:**
```bash
node scripts/check-config.js    # needs Docker; skip it without Docker, the pull request runs it anyway
git add games.json docker-compose.yml proxy/Caddyfile .env.example
git commit -m "Add <name>"
git push -u origin add-<id>
gh pr create --fill
```

**No push access to the hub** (the check in [What you need](#what-you-need) printed `false`)? Send the pull request from a fork instead. Run these in your clone, after the commit:
```bash
gh repo fork --remote                      # makes your fork "origin", and the hub "upstream"
git push -u origin add-<id>
gh pr create --repo slop-box/slopboxhub --head <your-username>:add-<id> --fill
```

The **Hub checks** run on the pull request and must pass before it can merge. They catch:
- an id that doesn't match across the three files
- `ports:` on a game
- a missing or wrong update-lock label
- missing resource limits
- a bind mount, or a volume other than `<id>-data` at `/app/data`
- a Caddy block without `import gate`
- a broken Caddyfile

The server owner is asked to review automatically.

## 6. After the merge

The server applies the merge by itself within about 5 minutes: it starts your game and adds its route. While games are open at a party, it waits until they close. If your game needs secrets or settings, the server owner adds them on the server. Until then, the game starts with them empty.

Then test on the real address, `https://<id>.<domain>`. Ask the server owner for the domain, because it isn't written in any repo.
- **First check that it's up**, which works even while games are closed: `curl -s https://<id>.<domain>/healthz` should print your game's `/healthz` answer. If it prints nothing, the address still redirects to the Slop Box page, so the merge isn't applied yet. Try again in a few minutes.
- **"Games are closed"** means the party gate is shut. Ask the server owner to open the games while you test.
- With a TV, open `/tv` on it and join by scanning its QR code with your phone. The QR code should show the `https://<id>.<domain>` address.
- Check that live updates arrive and that a phone reconnects after its screen locks.

The landing page at `https://<domain>` now lists your game.

## Updating your game

- **Push to `main`.** The workflow tests and publishes the new image, and the server picks it up within a few minutes.
- **To see when it's live**, wait until `/healthz` reports the commit you pushed. It answers even while games are closed:
  ```bash
  want=$(git rev-parse HEAD)
  until curl -s https://<id>.<domain>/healthz | grep -q "$want"; do sleep 20; done; echo "live: $want"
  ```
  This needs `/healthz` to report the version (the template's does). If games are open, it waits until they close.
- **While games are open at a party**, the server waits and updates your game after they close, so nobody's round gets cut off. You don't need to do anything.
- **Need it live sooner** (e.g. a bug at a party)? Ask the server owner. They can update one game by hand, even while games are open. Restarting the game ends any round in progress.
- **Running the workflow from another branch** (**Actions → Publish → Run workflow**, pick the branch) publishes that branch as `:latest`, so the server picks it up like any update. The next push to `main` replaces it.
- **Deploy now** (the box in **Run workflow**) is turned off. It only publishes the image and prints a warning. The server's normal check every couple of minutes is fast enough.
- **Rolling back:** push a fix or a revert to `main`. In a hurry, ask the server owner to pin the last good build (each build is also published as `:sha-<commit>`).

## Changing or removing your game on the server

Anything about how the game runs on the server needs a pull request on this repo. That covers:
- a new setting or secret
- saved data (a volume)
- a different port
- more memory
- renaming or removing the game

Game code changes never need one: just push to your repo.

Saved data stays on the server whatever happens to the game:
- **Removing a game** doesn't delete its volume. If the data should go too, the server owner runs `docker volume rm slopboxhub_<id>-data`.
- **Renaming a game** gives it a new, empty volume, `<new-id>-data`. Ask the server owner to copy the old data across if you need it.
- **Changing the user your image runs as**, after the volume exists, leaves the volume owned by the old user, so the game can't save. Docker only copies the owner when it creates the volume. Ask the server owner to fix the owner once, or to delete the volume.

## When you need the server owner

| You need | Why only they can do it |
|---|---|
| An invite to the `slop-box` org | Org owners send invites. |
| Permission to create repos in the org, if it's off | It's an org setting. |
| Your package made public, if you can't change it | It may need org-owner rights. |
| Your hub pull request approved | Only they can merge to the hub. Once it's merged, the server applies it by itself. |
| Restoring, copying or wiping your game's saved data | The volume is only reachable on the server. |
| Secrets or settings set on the server | They live in the server's `.env`, never in a repo. |
| The domain, and games opened for a test | The domain is kept out of the repos, and only the host can open the games. |
| Your game updated right away, or rolled back | Updates otherwise wait for the server's check, or for the party to end. |
| Your game's server logs | You don't have access to the server. |

## Changing the hub itself

Open a pull request. Every change needs the server owner's approval (see [.github/CODEOWNERS](.github/CODEOWNERS)), because the hub decides what runs on the server and who can reach it.
