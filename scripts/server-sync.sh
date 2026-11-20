#!/bin/bash
# Applies merged hub changes on the server (PLAN.md Step 12). Unraid's User Scripts plugin runs it
# every few minutes. Watchtower only swaps images under existing containers, so this does the rest:
#
#   1. git pull the hub clone (games.json, the compose file, the Caddyfile)
#   2. docker compose up -d --remove-orphans, if the compose file changed: starts new games, re-creates
#      changed ones, removes deleted ones. It never pulls newer images (Watchtower does that), but it
#      does pull a new game's image, because it isn't on the server yet.
#   3. caddy reload, if anything under proxy/ changed
#
# It waits while games are open (or in their grace period), so a merge never restarts a game
# mid-party. It pauses while the clone has local edits, e.g. a rollback pin, until they're undone.
# If applying fails, it tries again on every run and sends an Unraid notification once per new error.
#
# Run it by hand to see what it does: bash scripts/server-sync.sh
# Settings (environment variables, all optional):
#   HUB_DIR           the hub clone                (default /mnt/user/appdata/slopbox/hub)
#   COMPOSE_OVERRIDE  Compose Manager's override   (default its slopboxhub project folder; used if it exists)
#   SYNC_FORCE=1      apply even while games are open

# Everything is inside main(), which bash reads in full before running it. The git pull below can
# replace this file while it runs; without the function, bash would go on reading the new file.
main() {
  set -uo pipefail
  local hub_dir=${HUB_DIR:-/mnt/user/appdata/slopbox/hub}
  local override=${COMPOSE_OVERRIDE:-/boot/config/plugins/compose.manager/projects/slopboxhub/docker-compose.override.yml}
  local project=slopboxhub

  cd "$hub_dir" || { echo "No hub clone at $hub_dir"; return 1; }
  local synced_file=.git/slopbox-synced   # last commit fully applied (inside .git, so git ignores it)
  local error_file=.git/slopbox-sync-error

  # One run at a time.
  if command -v flock >/dev/null; then
    exec 9>"/tmp/slopbox-sync.lock"
    flock -n 9 || return 0
  fi

  git fetch -q origin main || { log "Couldn't reach GitHub. Trying again next run."; return 0; }
  local head target synced
  head=$(git rev-parse HEAD)
  target=$(git rev-parse origin/main)
  synced=$(cat "$synced_file" 2>/dev/null || true)
  [ "$head" = "$target" ] && [ "$head" = "$synced" ] && return 0   # nothing new

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "Paused: the hub clone has local changes (git status). Undo them, e.g. git checkout docker-compose.yml, to resume."
    return 0
  fi

  local phase
  phase=$(docker exec "$project-hub-1" wget -qO- http://127.0.0.1:8080/status 2>/dev/null |
    sed -n 's/.*"phase":"\([a-z]*\)".*/\1/p')
  if [ "${SYNC_FORCE:-}" != 1 ] && { [ "$phase" = open ] || [ "$phase" = grace ]; }; then
    log "Games are ${phase}. Applying $(short "$target") after they close."
    return 0
  fi

  if [ "$head" != "$target" ]; then
    local merge_out
    if ! merge_out=$(git merge -q --ff-only origin/main 2>&1); then
      problem "git pull failed. Fix the clone by hand (git status, git log): it has commits that aren't on GitHub, or files in the way. $(tail -n 3 <<<"$merge_out")"
      return 1
    fi
    log "Pulled $(short "$head")..$(short "$target"): $(git log -1 --format=%s "$target")"
    head=$target
  fi

  # What changed since the last commit that was fully applied. On the first run, apply everything.
  local changed
  if [ -n "$synced" ] && git cat-file -e "$synced^{commit}" 2>/dev/null; then
    changed=$(git diff --name-only "$synced" "$head")
  else
    changed=$'docker-compose.yml\nproxy/'
  fi

  if grep -qx 'docker-compose.yml' <<<"$changed"; then
    local args=(-f docker-compose.yml)
    [ -f "$override" ] && args+=(-f "$override")
    log "Compose file changed: docker compose up -d --remove-orphans"
    local out
    if ! out=$(docker compose -p "$project" "${args[@]}" up -d --remove-orphans 2>&1); then
      problem "docker compose up failed. It tries again next run. $(tail -n 5 <<<"$out")"
      return 1
    fi
    printf '%s\n' "$out" | grep -E 'Created|Recreated|Started|Removed' | sed 's/^/  /' || true
  fi

  if grep -q '^proxy/' <<<"$changed"; then
    log "Caddyfile changed: reloading Caddy"
    if ! docker exec "$project-caddy-1" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      problem "caddy reload failed, so Caddy is still on the old routes. It tries again next run. Check: docker logs $project-caddy-1"
      return 1
    fi
  fi

  echo "$head" > "$synced_file"
  rm -f "$error_file"
  log "Server is on $(short "$head")."
}

log() { echo "$(date '+%F %T') $*"; }
short() { git rev-parse --short "$1"; }

# Log every failure, but only notify when it's a new one, so a retry every few minutes doesn't
# fill Unraid's notifications.
problem() {
  log "ERROR: $*"
  if [ "$(cat .git/slopbox-sync-error 2>/dev/null)" != "$*" ]; then
    printf '%s' "$*" > .git/slopbox-sync-error
    local notify=/usr/local/emhttp/webGui/scripts/notify
    [ -x "$notify" ] && "$notify" -e "Slop Box sync" -s "Slop Box: hub change not applied" -d "$*" -i alert
  fi
  return 0
}

main "$@"; exit $?
