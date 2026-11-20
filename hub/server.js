'use strict';
// Slop Box hub: the landing page at <domain>, the party gate (PLAN.md Step 8), and the update lock
// and manual deploys (Step 11). Plain Node, no dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createGate } = require('./gate');
const { createUpdates } = require('./updates');

const PORT = Number(process.env.PORT) || 8080;
const DOMAIN = (process.env.SLOPBOX_DOMAIN || '').trim().toLowerCase();
// Where browsers reach the hub. Cloudflare serves HTTPS, but the hub only ever sees HTTP from Caddy.
const ORIGIN = process.env.HUB_ORIGIN || (DOMAIN ? `https://${DOMAIN}` : `http://localhost:${PORT}`);
const SECURE = ORIGIN.startsWith('https:');
const PUBLIC_DIR = path.join(__dirname, 'public');
// In the image games.json sits next to server.js; in the repo it's one folder up. On the server, compose
// points GAMES_FILE at the cloned repo, so a `git pull` updates the list without rebuilding the image.
const GAMES_FILE = process.env.GAMES_FILE ||
  (fs.existsSync(path.join(__dirname, 'games.json')) ? path.join(__dirname, 'games.json') : path.join(__dirname, '..', 'games.json'));

const HOUR = 3600e3;
const gate = createGate({
  password: process.env.SLOPBOX_ADMIN_PASSWORD || '',
  secret: process.env.SLOPBOX_GATE_SECRET || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  openMs: (Number(process.env.GATE_OPEN_HOURS) || 4) * HOUR,
  graceMs: (Number(process.env.GATE_GRACE_MINUTES) || 60) * 60e3,
});
const OPEN_MS = (Number(process.env.GATE_OPEN_HOURS) || 4) * HOUR;

// Updates. Devs' workflows call /deploy with SLOPBOX_DEPLOY_TOKEN; only the hub knows Watchtower's token.
const DEPLOY_TOKEN = process.env.SLOPBOX_DEPLOY_TOKEN || '';
const WATCHTOWER_TOKEN = process.env.WATCHTOWER_API_TOKEN || '';
const WATCHTOWER_URL = (process.env.WATCHTOWER_URL || 'http://watchtower:8080').replace(/\/+$/, '');
// Cloudflare gives up on a request after 100 s, so /deploy answers "running" after this and the
// workflow checks back.
const DEPLOY_WAIT_MS = (Number(process.env.DEPLOY_WAIT_SECONDS) || 60) * 1000;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const updates = createUpdates({
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  gatePhase: () => gate.phase(),
  watchtowerUrl: WATCHTOWER_URL,
  watchtowerToken: WATCHTOWER_TOKEN,
});
if (!DEPLOY_TOKEN || !WATCHTOWER_TOKEN) {
  console.warn('SLOPBOX_DEPLOY_TOKEN or WATCHTOWER_API_TOKEN is not set: manual deploys are off. The update lock still works.');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- helpers ----------

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  }, extra));
  res.end(body);
}
const redirect = (res, to, extra = {}) => send(res, 302, 'text/plain', '', Object.assign({ Location: to, 'Cache-Control': 'no-store' }, extra));

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore a malformed cookie */ }
  }
  return out;
}

function cookie(name, value, { maxAge, domain } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (SECURE) c += '; Secure';
  if (domain) c += `; Domain=${domain}`;
  if (maxAge != null) c += `; Max-Age=${Math.floor(maxAge / 1000)}`;
  return c;
}

const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';

// At most `max` calls per `ms` per key.
function limiter(max, ms) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const recent = (hits.get(key) || []).filter((x) => t - x < ms);
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (t - v[v.length - 1] > ms) hits.delete(k);
    return recent.length <= max;
  };
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const tokenOk = (given, expected) => !!expected && crypto.timingSafeEqual(digest(given), digest(expected));

function readForm(req, cb) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });
  req.on('end', () => cb(new URLSearchParams(body)));
}

// Only send people on to Slop Box addresses, never to another site.
function safeNext(next) {
  if (!next) return null;
  if (!DOMAIN) return next.startsWith('/') && !next.startsWith('//') ? next : null;
  try {
    const u = new URL(next);
    const ok = (u.protocol === 'https:' || u.protocol === 'http:') &&
      (u.hostname === DOMAIN || u.hostname.endsWith('.' + DOMAIN));
    return ok ? u.href : null;
  } catch { return null; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body, scripts = []) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#16121f">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main class="narrow">
  <header><a class="logo-link" href="/"><h1>Slop<span>Box</span></h1></a></header>
${body}
</main>
${scripts.map((s) => `<script src="${s}"></script>`).join('\n')}
</body>
</html>`;
}

// ---------- games.json ----------

// Re-read whenever it changes on disk. A broken edit keeps serving the last good copy.
let games = { mtimeMs: -1, body: '[]', list: [] };
function loadGames() {
  try {
    const { mtimeMs } = fs.statSync(GAMES_FILE);
    if (mtimeMs !== games.mtimeMs) {
      const list = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
      if (!Array.isArray(list)) throw new Error('games.json must be a JSON array');
      games = { mtimeMs, body: JSON.stringify(list), list: list.filter((g) => g && typeof g.id === 'string') };
    }
  } catch (e) {
    console.error(`Couldn't read ${GAMES_FILE}: ${e.message}. Serving the last good copy.`);
  }
  return games;
}
const gamesBody = () => loadGames().body;
// Everything /deploy may update: each game in games.json, plus the hub's own image.
const deployable = (id) => id === 'hub' || loadGames().list.some((g) => g.id === id);

// ---------- gate routes ----------

// Caddy's forward_auth calls this before every request to a game. 2xx lets the request through;
// anything else is sent back to the browser as is.
function check(req, res) {
  const c = cookies(req);
  const phase = gate.phase();
  if (gate.passValid(c.slopbox_pass)) return send(res, 204, 'text/plain', '');

  // Page loads get redirected. Background requests (live updates, actions, WebSockets) don't:
  // while games are open they pass, and when closed they get a plain 403.
  const method = req.headers['x-forwarded-method'] || 'GET';
  const mode = req.headers['sec-fetch-mode'];
  const isPageLoad = method === 'GET' && (mode ? mode === 'navigate' : /text\/html/.test(req.headers.accept || ''));
  const scheme = DOMAIN ? 'https' : 'http';
  const original = `${scheme}://${req.headers['x-forwarded-host'] || DOMAIN}${req.headers['x-forwarded-uri'] || '/'}`;

  if (phase === 'open') {
    if (!isPageLoad) return send(res, 204, 'text/plain', '');
    return redirect(res, `${ORIGIN}/pass?next=${encodeURIComponent(original)}`);
  }
  if (!isPageLoad) return send(res, 403, 'text/plain', 'Slop Box is closed');
  return redirect(res, `${ORIGIN}/closed?next=${encodeURIComponent(original)}`);
}

// Gives the device a pass for this opening (shared by every game subdomain), then sends it back.
function pass(req, res, url) {
  const next = safeNext(url.searchParams.get('next')) || `${ORIGIN}/`;
  if (gate.phase() !== 'open') return redirect(res, `/closed?next=${encodeURIComponent(next)}`);
  redirect(res, next, {
    'Set-Cookie': cookie('slopbox_pass', gate.newPass(), { maxAge: 2 * 24 * HOUR, domain: DOMAIN || undefined }),
  });
}

function closedPage(req, res, url) {
  const next = safeNext(url.searchParams.get('next')) || '';
  send(res, 200, TYPES['.html'], page('Slop Box is closed', `
  <section class="panel" data-next="${esc(next)}">
    <h2>Games are closed</h2>
    <p>The host opens them at the start of a party. This page lets you in as soon as they do.</p>
    <p class="muted">Hosting? <a class="text-link" href="/admin">Log in</a></p>
  </section>`, ['/status.js']));
}

function adminPage(req, res, url) {
  const c = cookies(req);
  const err = url.searchParams.get('e');
  if (!gate.adminValid(c.slopbox_admin)) {
    const message = !gate.hasPassword ? 'Admin login is turned off: SLOPBOX_ADMIN_PASSWORD isn’t set on the server.'
      : err === 'wrong' ? 'That password didn’t work.'
      : err === 'slow' ? 'Too many tries. Wait a minute and try again.' : '';
    return send(res, 200, TYPES['.html'], page('Slop Box host', `
  <section class="panel">
    <h2>Host login</h2>
    <p>Logging in opens every game for ${OPEN_MS / HOUR} hours.</p>
    ${message ? `<p class="error">${esc(message)}</p>` : ''}
    <form method="post" action="/admin/login" class="stack">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
      <button class="btn" type="submit">Log in and open games</button>
    </form>
  </section>`));
  }
  const s = gate.status();
  const ts = (n) => (n ? String(n) : '');
  const label = s.phase === 'open' ? 'Games are open' : s.phase === 'grace' ? 'Games are closing' : 'Games are closed';
  const detail = s.phase === 'open'
    ? `Open until <time data-ts="${ts(s.openUntil)}"></time> (<span data-left="${ts(s.openUntil)}"></span> left).`
    : s.phase === 'grace'
      ? `New players can’t join. Devices already playing can finish until <time data-ts="${ts(s.graceUntil)}"></time>.`
      : 'Nobody can reach the games.';
  const btn = (action, text, cls = '') => `<form method="post" action="/admin/${action}"><button class="btn ${cls}" type="submit">${text}</button></form>`;
  send(res, 200, TYPES['.html'], page('Slop Box host', `
  <section class="panel">
    <p class="status status-${s.phase}">${label}</p>
    <p>${detail}</p>
    <div class="row">
      ${s.phase === 'closed' ? btn('open', `Open for ${OPEN_MS / HOUR} hours`) : btn('extend', 'Extend 1 hour')}
      ${s.phase !== 'closed' ? btn('close', 'Close now', 'secondary') : ''}
    </div>
    <p class="muted">Close now also stops games already in progress.</p>
  </section>
${updatesPanel(btn)}
  <div class="muted links"><a class="text-link" href="/">Back to the games</a> · <form class="inline" method="post" action="/admin/logout"><button class="link-button" type="submit">Log out</button></form></div>`, ['/status.js']));
}

// Admin page: each game's last update, skipped scheduled updates, its latest manual deploy, and the
// switch that blocks manual deploys during a party.
function updatesPanel(btn) {
  const when = (ts) => `<time data-when="${ts}"></time>`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const DEPLOY_TEXT = { running: 'running now', updated: 'updated', current: 'nothing to update', failed: 'failed' };
  const rows = [...loadGames().list.map((g) => ({ id: g.id, name: g.name || g.id })), { id: 'hub', name: 'Hub (this page)' }]
    .map(({ id, name }) => {
      const u = updates.info(id);
      const lines = [];
      lines.push(u.last ? `Last update: ${when(u.last.at)}, ${u.last.kind}` : 'No updates recorded yet');
      if (u.skipped) {
        lines.push(`<span class="warn">Skipped ${plural(u.skipped.count, 'time')} while games were open, most recently ${when(u.skipped.last)}.` +
          ' It updates at Watchtower’s next run after games close.</span>');
      }
      const d = u.deploy;
      if (d) {
        const text = `Manual deploy ${when(d.started)}: ${DEPLOY_TEXT[d.state] || d.state}`;
        lines.push(d.state === 'failed' ? `<span class="error">${text}. ${esc(d.message)}</span>` : text);
      }
      return `<li><strong>${esc(name)}</strong>${lines.map((l) => `<span>${l}</span>`).join('')}</li>`;
    });
  const off = !DEPLOY_TOKEN || !WATCHTOWER_TOKEN;
  return `  <section class="panel">
    <h2>Updates</h2>
    <p>While games are open, and for the grace period after, Watchtower skips its scheduled updates of Slop Box games. It catches up on a later run.</p>
    ${off ? '<p class="error">Manual deploys are off: set SLOPBOX_DEPLOY_TOKEN and WATCHTOWER_API_TOKEN in the server’s .env.</p>'
      : updates.blocked ? '<p class="status status-grace">Manual deploys are blocked</p><p>Devs’ <strong>Deploy now</strong> runs fail until you allow them again.</p>'
      : '<p>Devs can still restart their own game with <strong>Deploy now</strong>, even during a party.</p>'}
    <ul class="updates">${rows.join('')}</ul>
    ${off ? '' : `<div class="row">${updates.blocked ? btn('allow-deploys', 'Allow manual deploys') : btn('block-deploys', 'Block manual deploys', 'secondary')}</div>`}
  </section>`;
}

function adminAction(req, res, action) {
  // Forms only post from the hub itself. Browsers send Origin on POST; reject other sites.
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN) return send(res, 403, 'text/plain', 'Forbidden');
  readForm(req, (form) => {
    const ip = clientIp(req);
    if (action === 'login') {
      if (!gate.allowAttempt(ip)) return redirect(res, '/admin?e=slow');
      if (!gate.passwordOk(form.get('password') || '')) {
        console.log(`Admin login failed from ${ip}`);
        return redirect(res, '/admin?e=wrong');
      }
      gate.open(OPEN_MS);
      console.log(`Admin logged in from ${ip}; games open until ${new Date(gate.status().openUntil).toISOString()}`);
      return redirect(res, '/admin', { 'Set-Cookie': cookie('slopbox_admin', gate.newAdminSession(), { maxAge: gate.ADMIN_MS }) });
    }
    if (!gate.adminValid(cookies(req).slopbox_admin)) return redirect(res, '/admin');
    if (action === 'open') gate.open(OPEN_MS);
    else if (action === 'extend') gate.extend(HOUR);
    else if (action === 'close') gate.closeNow();
    else if (action === 'block-deploys') updates.setBlocked(true);
    else if (action === 'allow-deploys') updates.setBlocked(false);
    else if (action === 'logout') return redirect(res, '/admin', { 'Set-Cookie': cookie('slopbox_admin', '', { maxAge: 0 }) });
    else return send(res, 404, 'text/plain', 'Not found');
    console.log(`Admin ${action} from ${ip}; phase is now ${gate.phase()}${updates.blocked ? ', manual deploys blocked' : ''}`);
    redirect(res, '/admin');
  });
}

// ---------- update routes ----------

// Watchtower's pre-update hook calls this from inside the game's container, over the slopbox
// network: 200 lets the update through, 423 makes the hook exit 75, so Watchtower skips the game.
// Caddy answers 404 for this path itself, and anything that came through Caddy (which adds
// X-Forwarded-For) is refused here too, so nobody outside can fill the update log.
function updateAllowed(req, res, url) {
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) return send(res, 404, 'text/plain', 'Not found');
  const id = url.searchParams.get('id') || '';
  if (!ID_RE.test(id)) return send(res, 400, 'text/plain', 'Bad id');
  const r = updates.allowed(id);
  console.log(`Update hook for ${id}: ${r.ok ? 'allowed' : 'skipped'} (${r.reason})`);
  send(res, r.ok ? 200 : 423, 'text/plain', `${r.ok ? 'Update allowed' : 'Update skipped'}: ${r.reason}`, { 'Cache-Control': 'no-store' });
}

// POST /deploy?id=<id> starts a manual deploy and waits up to DEPLOY_WAIT_MS for it.
// GET /deploy?id=<id> reports on the latest one, for the workflow to check back.
// Both answer JSON { id, state, message, started, finished }. state is running (202), updated or
// current (200), failed (502), or refused (4xx/503) when the call itself isn't allowed.
const deployLimit = limiter(10, 60e3);
const DEPLOY_CODES = { running: 202, updated: 200, current: 200, failed: 502 };
function deployRoute(req, res, url) {
  req.resume(); // no body is expected; drain it anyway
  const id = url.searchParams.get('id') || '';
  const reply = (status, state, message, extra = {}) =>
    send(res, status, TYPES['.json'], JSON.stringify(Object.assign({ id, state, message }, extra)), { 'Cache-Control': 'no-store' });
  const replyWith = (d) => reply(DEPLOY_CODES[d.state] || 500, d.state, d.message, { started: d.started, finished: d.finished });

  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, 'refused', 'Use POST to deploy, or GET to check on a deploy.');
  const ip = clientIp(req);
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const authed = tokenOk(token, DEPLOY_TOKEN);
  // Count every deploy and every bad token. Status checks with the right token are free.
  if ((req.method === 'POST' || !authed) && !deployLimit(ip)) return reply(429, 'refused', 'Too many deploy calls. Wait a minute.');
  if (!DEPLOY_TOKEN) return reply(503, 'refused', 'Manual deploys are off: SLOPBOX_DEPLOY_TOKEN isn’t set on the server.');
  if (!authed) {
    console.log(`Deploy call with a bad token from ${ip}`);
    return reply(401, 'refused', 'Wrong or missing deploy token.');
  }
  if (!ID_RE.test(id) || !deployable(id)) return reply(404, 'refused', `“${id}” isn’t a game in games.json.`);

  if (req.method === 'GET') {
    const d = updates.deployStatus(id);
    return d ? replyWith(d) : reply(404, 'none', 'No manual deploy has run for this game yet.');
  }

  if (!updates.isRunning(id)) {
    if (!WATCHTOWER_TOKEN) return reply(503, 'refused', 'Manual deploys are off: WATCHTOWER_API_TOKEN isn’t set on the server.');
    if (updates.blocked) return reply(423, 'refused', 'The host has blocked manual deploys during a party. Try again later.');
    console.log(`Manual deploy of ${id} from ${ip}`);
  }
  const done = updates.deploy(id, `ghcr.io/slop-box/${id}`);
  done.then((d) => console.log(`Manual deploy of ${id}: ${d.state}. ${d.message}`));
  let timer;
  Promise.race([done, new Promise((r) => { timer = setTimeout(r, DEPLOY_WAIT_MS); })]).then(() => {
    clearTimeout(timer);
    replyWith(updates.deployStatus(id));
  });
}

// ---------- static files ----------

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'text/plain', 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, TYPES['.html'], page('Not found', '<section class="panel"><h2>Nothing here</h2><p><a class="text-link" href="/">Back to Slop Box</a></p></section>'));
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    send(res, 200, type, data, { 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300' });
  });
}

// ---------- server ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://hub');
  const p = url.pathname;

  if (req.method === 'POST' && p.startsWith('/admin/')) return adminAction(req, res, p.slice('/admin/'.length));
  if (p === '/deploy') return deployRoute(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');

  if (p === '/healthz') return send(res, 200, 'text/plain', 'ok', { 'Cache-Control': 'no-store' });
  if (p === '/update-allowed') return updateAllowed(req, res, url);
  if (p === '/check') return check(req, res);
  if (p === '/pass') return pass(req, res, url);
  if (p === '/status') return send(res, 200, TYPES['.json'], JSON.stringify(gate.status()), { 'Cache-Control': 'no-store' });
  if (p === '/closed') return closedPage(req, res, url);
  if (p === '/admin') return adminPage(req, res, url);
  if (p === '/games.json') return send(res, 200, TYPES['.json'], gamesBody());

  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
  serveStatic(res, decoded);
});

server.listen(PORT, () => {
  gamesBody();
  console.log(`Slop Box hub on :${PORT} for ${ORIGIN} (games from ${GAMES_FILE}); games are ${gate.phase()}`);
});

// Node as PID 1 ignores SIGTERM by default, which makes `docker stop` wait 10 s.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
