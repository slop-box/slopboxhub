'use strict';
// Slop Box hub: the landing page at <domain>. Plain Node, no dependencies.
// Later steps add the party gate (/admin, /check, /pass, /closed) and /deploy here (PLAN.md Steps 8 and 11).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
// In the image games.json sits next to server.js; in the repo it's one folder up. On the server, compose
// points GAMES_FILE at the cloned repo, so a `git pull` updates the list without rebuilding the image.
const GAMES_FILE = process.env.GAMES_FILE ||
  (fs.existsSync(path.join(__dirname, 'games.json')) ? path.join(__dirname, 'games.json') : path.join(__dirname, '..', 'games.json'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// games.json is re-read whenever it changes on disk. A broken edit keeps serving the last good copy.
let games = { mtimeMs: -1, body: '[]' };
function gamesBody() {
  try {
    const { mtimeMs } = fs.statSync(GAMES_FILE);
    if (mtimeMs !== games.mtimeMs) {
      const list = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
      if (!Array.isArray(list)) throw new Error('games.json must be a JSON array');
      games = { mtimeMs, body: JSON.stringify(list) };
    }
  } catch (e) {
    console.error(`Couldn't read ${GAMES_FILE}: ${e.message}. Serving the last good copy.`);
  }
  return games.body;
}

function send(res, status, type, body, cache = 'no-cache') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'text/plain', 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/html; charset=utf-8', '<!doctype html><title>Not found</title><p>Nothing here. <a href="/">Back to Slop Box</a></p>');
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    send(res, 200, type, data, type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300');
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://hub');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
  if (pathname === '/healthz') return send(res, 200, 'text/plain', 'ok', 'no-store');
  if (pathname === '/games.json') return send(res, 200, TYPES['.json'], gamesBody());
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
  serveStatic(res, decoded);
});

server.listen(PORT, () => {
  gamesBody();
  console.log(`Slop Box hub on :${PORT} (games from ${GAMES_FILE})`);
});

// Node as PID 1 ignores SIGTERM by default, which makes `docker stop` wait 10 s.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
