'use strict';
// Checks that games.json, docker-compose.yml and proxy/Caddyfile agree, and that every game
// follows the hub-side rules in GAME_CONTRACT.md. Runs on every hub pull request (check.yml).
// Run locally from the repo root: node scripts/check-config.js   (needs Docker for `docker compose`)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Services that aren't games. Game ids can't use these names either, or the compose service would clash.
const INFRA = ['caddy', 'cloudflared', 'hub'];
const RESERVED = new Set([...INFRA, 'www']);

// The update-lock hook (PLAN.md Step 11). Watchtower runs it inside the game before updating it.
const HOOK_LABEL = 'com.centurylinklabs.watchtower.lifecycle.pre-update';
const hookFor = (id) =>
  `node -e "fetch('http://hub:8080/update-allowed?id=${id}').then(r=>process.exit(r.ok?0:75),()=>process.exit(75))"`;

const errors = [];
const warnings = [];
const inActions = !!process.env.GITHUB_ACTIONS;
const fail = (file, msg) => errors.push({ file, msg });
const warn = (file, msg) => warnings.push({ file, msg });

// ---------- games.json ----------

let games = [];
try {
  games = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
  if (!Array.isArray(games)) { fail('games.json', 'must be a JSON array'); games = []; }
} catch (e) {
  fail('games.json', `isn't valid JSON: ${e.message}`);
}

const ids = [];
games.forEach((g, i) => {
  const where = `entry ${i + 1}${g && g.id ? ` (${g.id})` : ''}`;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return fail('games.json', `${where} must be an object`);
  if (typeof g.id !== 'string' || !ID_RE.test(g.id)) return fail('games.json', `${where}: "id" must be lowercase letters, digits and single hyphens`);
  if (RESERVED.has(g.id)) fail('games.json', `${where}: "${g.id}" is taken (${[...RESERVED].join(', ')} are reserved)`);
  if (ids.includes(g.id)) fail('games.json', `${where}: id "${g.id}" is listed twice`);
  ids.push(g.id);
  if (typeof g.name !== 'string' || !g.name.trim()) fail('games.json', `${where}: "name" is required`);
  if (typeof g.needsTv !== 'boolean') fail('games.json', `${where}: "needsTv" must be true or false`);
  if (typeof g.blurb !== 'string' || !g.blurb.trim()) fail('games.json', `${where}: "blurb" is required`);
  if (g.players != null && (typeof g.players !== 'string' || g.players !== g.players.toLowerCase())) {
    fail('games.json', `${where}: "players" must be a lowercase string, e.g. "4+" (it shows as a tag)`);
  }
  if (g.extraDevices != null && (!Array.isArray(g.extraDevices) ||
      !g.extraDevices.every((d) => typeof d === 'string' && d && d === d.toLowerCase()))) {
    fail('games.json', `${where}: "extraDevices" must be a list of lowercase strings, e.g. ["tablet"]`);
  }
  if (g.repo != null && (typeof g.repo !== 'string' || !g.repo.startsWith('https://github.com/slop-box/'))) {
    warn('games.json', `${where}: "repo" usually points at https://github.com/slop-box/<repo>`);
  }
});

// ---------- docker-compose.yml ----------

let services = {};
try {
  // compose resolves variables and long-form syntax for us, so no YAML parser is needed.
  const out = execFileSync('docker', ['compose', '--env-file', '.env.example', 'config', '--format', 'json'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  services = JSON.parse(out).services || {};
} catch (e) {
  fail('docker-compose.yml', `\`docker compose config\` failed: ${(e.stderr || e.message).trim()}`);
}

for (const [name, s] of Object.entries(services)) {
  if (name !== 'caddy' && s.ports && s.ports.length) {
    fail('docker-compose.yml', `${name}: remove \`ports:\`. Only Caddy publishes a port; anything else can be reached without the party gate.`);
  }
  if (!INFRA.includes(name) && !ids.includes(name)) {
    fail('docker-compose.yml', `${name}: not in games.json. Every game service needs a games.json entry with the same id.`);
  }
}

for (const id of ids) {
  const s = services[id];
  if (!s) { fail('docker-compose.yml', `${id}: no service named "${id}" (the service name must be the game id)`); continue; }
  const imageRe = new RegExp(`^ghcr\\.io/slop-box/${id}(:[\\w.-]+|@sha256:[0-9a-f]{64})?$`);
  if (!imageRe.test(s.image || '')) fail('docker-compose.yml', `${id}: image must be ghcr.io/slop-box/${id} (got ${s.image || 'none'})`);
  const nets = Object.keys(s.networks || {});
  if (nets.length !== 1 || nets[0] !== 'slopbox') fail('docker-compose.yml', `${id}: must be on the slopbox network only (got ${nets.join(', ') || 'none'})`);
  if ((s.labels || {})['com.centurylinklabs.watchtower.enable'] !== 'true') {
    fail('docker-compose.yml', `${id}: needs the label com.centurylinklabs.watchtower.enable: "true"`);
  }
  if ((s.labels || {})[HOOK_LABEL] !== hookFor(id)) {
    fail('docker-compose.yml', `${id}: needs the update-lock label (copy it from the template's README), ` +
      `so Watchtower doesn't restart the game mid-party. Under labels, add \`${HOOK_LABEL}: >-\` ` +
      `and on the next line, indented: ${hookFor(id)}`);
  }
  if (!s.mem_limit || !s.cpus) fail('docker-compose.yml', `${id}: set mem_limit and cpus, so one game can't slow the server`);

  // Anything that gives a game more of the server than its own container and data folder.
  if (s.privileged) fail('docker-compose.yml', `${id}: privileged isn't allowed`);
  if (s.network_mode) fail('docker-compose.yml', `${id}: network_mode isn't allowed`);
  for (const key of ['pid', 'ipc', 'userns_mode']) if (s[key] === 'host') fail('docker-compose.yml', `${id}: ${key}: host isn't allowed`);
  for (const key of ['cap_add', 'devices', 'security_opt']) if (s[key] && s[key].length) fail('docker-compose.yml', `${id}: ${key} isn't allowed`);
  if (s.user && /^(root|0)(:|$)/.test(String(s.user))) fail('docker-compose.yml', `${id}: games run as non-root`);
  const dataDir = `/mnt/user/appdata/slopbox/${id}`;
  for (const v of s.volumes || []) {
    if (v.type === 'bind' && v.source !== dataDir && !v.source.startsWith(dataDir + '/')) {
      fail('docker-compose.yml', `${id}: bind mounts must come from ${dataDir} (got ${v.source})`);
    }
  }
}

// ---------- proxy/Caddyfile ----------

let caddyfile = '';
try { caddyfile = fs.readFileSync(path.join(ROOT, 'proxy', 'Caddyfile'), 'utf8'); } catch (e) { fail('proxy/Caddyfile', e.message); }

// Top-level site blocks: an address at the start of a line, then everything up to a "}" at the start of a line.
const sites = new Map();
for (const m of caddyfile.matchAll(/^(\S+)\s*\{[^\n]*\n([\s\S]*?)^\}/gm)) {
  if (m[1].startsWith('(')) continue; // a snippet, like (gate)
  sites.set(m[1], m[2]);
}

const SUB_RE = /^http:\/\/([a-z0-9-]+)\.\{\$SLOPBOX_DOMAIN\}$/;
for (const address of sites.keys()) {
  if (address === 'http://{$SLOPBOX_DOMAIN}' || address === 'http://') continue;
  const sub = SUB_RE.exec(address);
  if (!sub) fail('proxy/Caddyfile', `unexpected site "${address}". Games use http://<id>.{$SLOPBOX_DOMAIN}.`);
  else if (!ids.includes(sub[1])) fail('proxy/Caddyfile', `${address}: "${sub[1]}" isn't in games.json`);
}

for (const id of ids) {
  const address = `http://${id}.{$SLOPBOX_DOMAIN}`;
  if (!sites.has(address)) { fail('proxy/Caddyfile', `${id}: no block for ${address}`); continue; }
  const lines = sites.get(address).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const gateAt = lines.indexOf('import gate');
  const proxyAt = lines.findIndex((l) => l.startsWith('reverse_proxy'));
  if (gateAt === -1) fail('proxy/Caddyfile', `${id}: the block must start with \`import gate\`, or the game is open to everyone`);
  else if (gateAt !== 0) fail('proxy/Caddyfile', `${id}: put \`import gate\` first in the block`);
  if (proxyAt === -1) fail('proxy/Caddyfile', `${id}: no reverse_proxy line`);
  else if (!new RegExp(`^reverse_proxy\\s+${id}:\\d+$`).test(lines[proxyAt])) {
    fail('proxy/Caddyfile', `${id}: expected \`reverse_proxy ${id}:<port>\` (got \`${lines[proxyAt]}\`)`);
  }
}

// ---------- report ----------

for (const { file, msg } of warnings) console.log(inActions ? `::warning file=${file}::${msg}` : `warning  ${file}: ${msg}`);
for (const { file, msg } of errors) console.log(inActions ? `::error file=${file}::${msg}` : `error    ${file}: ${msg}`);
if (errors.length) {
  console.log(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} found.`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${ids.length} game${ids.length === 1 ? '' : 's'} (${ids.join(', ')}) agree across games.json, docker-compose.yml and proxy/Caddyfile.`);
}
