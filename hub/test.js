'use strict';
// End-to-end test of the hub. Run: node hub/test.js
//   Part 1, party gate: starts the hub with tiny timings (open ~2 s, grace 3 s) and plays Caddy's
//   part by calling /check the way forward_auth does.
//   Part 2, updates: starts a second hub next to a fake Watchtower, which runs the update hook the
//   way the real one does, then answers.

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 8798;
const PORT2 = 8799;
const WATCHTOWER_PORT = 8797;
let BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = 'example.com';
const ORIGIN = `https://${DOMAIN}`;
const PASSWORD = 'test-password';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopbox-hub-test-'));
const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'slopbox-hub-test-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// node:http rather than fetch: fetch overrides Sec-Fetch-Mode, which the gate relies on.
function request(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + p, { method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: {
          get: (n) => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v == null ? null : v); },
          getSetCookie: () => res.headers['set-cookie'] || [],
        },
        text: async () => data,
        json: async () => JSON.parse(data),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const get = (p, headers = {}) => request('GET', p, null, headers);
const post = (p, body = '', headers = {}) =>
  request('POST', p, body, Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers));
const cookieFrom = (res, name) => {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(name + '='));
  return c ? c.split(';')[0] : null;
};
// What Caddy sends to /check for a request to quickpic.<domain><uri>
const check = (uri, { nav = true, cookie = '', method = 'GET' } = {}) => get('/check', Object.assign({
  'X-Forwarded-Method': method,
  'X-Forwarded-Host': `quickpic.${DOMAIN}`,
  'X-Forwarded-Uri': uri,
  'Sec-Fetch-Mode': nav ? 'navigate' : 'cors',
}, cookie ? { Cookie: cookie } : {}));

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function startHub(port, env) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), SLOPBOX_DOMAIN: DOMAIN, SLOPBOX_GATE_SECRET: 'test-secret' }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hub = { proc, log: '' };
  proc.stdout.on('data', (d) => { hub.log += d; });
  proc.stderr.on('data', (d) => { hub.log += d; });
  hub.exited = new Promise((r) => proc.on('exit', r));
  hubs.push(hub);
  return hub;
}
async function waitForHub() {
  for (let i = 0; i < 50; i++) { try { if ((await get('/healthz')).ok) return; } catch {} await sleep(100); }
  throw new Error(`hub at ${BASE} didn't start`);
}

const hubs = [];
let watchtower = null;
async function main() {
  try {
    await gateTests();
    await updateTests();
    console.log(`PASS (${passed} checks)`);
  } catch (e) {
    console.error(`FAIL after ${passed} checks:`, e.message);
    for (const h of hubs) console.error('--- hub log ---\n' + h.log);
    process.exitCode = 1;
  } finally {
    for (const h of hubs) h.proc.kill();
    if (watchtower) watchtower.close();
    for (const d of [dataDir, dataDir2]) fs.rmSync(d, { recursive: true, force: true });
  }
}

async function gateTests() {
  startHub(PORT, {
    SLOPBOX_ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir,
    GATE_OPEN_HOURS: String(2 / 3600), GATE_GRACE_MINUTES: String(3 / 60),
  });
  {
    await waitForHub();

    await step('landing page, games.json and status load', async () => {
      assert.equal((await get('/')).status, 200);
      assert.ok(Array.isArray(await (await get('/games.json')).json()));
      assert.equal((await (await get('/status')).json()).phase, 'closed');
    });

    await step('closed: a page load goes to the closed page, with the way back', async () => {
      const r = await check('/tv');
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), `${ORIGIN}/closed?next=${encodeURIComponent(`https://quickpic.${DOMAIN}/tv`)}`);
      assert.equal((await get('/closed?next=' + encodeURIComponent(`https://quickpic.${DOMAIN}/tv`))).status, 200);
    });

    await step('closed: background requests are refused', async () => {
      assert.equal((await check('/events', { nav: false })).status, 403);
    });

    await step('wrong password is rejected', async () => {
      const r = await post('/admin/login', 'password=nope');
      assert.equal(r.headers.get('location'), '/admin?e=wrong');
      assert.equal((await (await get('/status')).json()).phase, 'closed');
    });

    await step('a POST from another site is refused', async () => {
      assert.equal((await post('/admin/login', `password=${PASSWORD}`, { Origin: 'https://evil.test' })).status, 403);
    });

    let admin;
    await step('right password logs in and opens the games', async () => {
      const r = await post('/admin/login', `password=${PASSWORD}`, { Origin: ORIGIN });
      assert.equal(r.headers.get('location'), '/admin');
      admin = cookieFrom(r, 'slopbox_admin');
      assert.ok(admin);
      assert.equal((await (await get('/status')).json()).phase, 'open');
      assert.match(await (await get('/admin', { Cookie: admin })).text(), /Games are open/);
    });

    let pass;
    await step('open: a page load without a pass goes to /pass, which sets one and sends it back', async () => {
      const r = await check('/tv');
      assert.equal(r.status, 302);
      const to = new URL(r.headers.get('location'));
      assert.equal(to.origin + to.pathname, `${ORIGIN}/pass`);
      const p = await get(to.pathname + to.search);
      assert.equal(p.headers.get('location'), `https://quickpic.${DOMAIN}/tv`);
      pass = cookieFrom(p, 'slopbox_pass');
      assert.ok(pass);
      const raw = p.headers.getSetCookie().find((c) => c.startsWith('slopbox_pass='));
      assert.match(raw, new RegExp(`Domain=${DOMAIN.replace('.', '\\.')}`));
      assert.match(raw, /Secure/);
    });

    await step('open: requests with a pass go through', async () => {
      assert.equal((await check('/tv', { cookie: pass })).status, 204);
      assert.equal((await check('/action', { nav: false, method: 'POST', cookie: pass })).status, 204);
    });

    await step('open: background requests without a pass go through', async () => {
      assert.equal((await check('/events', { nav: false })).status, 204);
    });

    await step('/pass refuses to send people to another site', async () => {
      const r = await get('/pass?next=' + encodeURIComponent('https://evil.test/'));
      assert.equal(r.headers.get('location'), `${ORIGIN}/`);
    });

    await step('a forged pass is refused', async () => {
      const forged = pass.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
      assert.equal((await check('/tv', { cookie: forged })).status, 302);
    });

    await step('after the window: grace lets passes through and turns new devices away', async () => {
      await sleep(2500);
      assert.equal((await (await get('/status')).json()).phase, 'grace');
      assert.equal((await check('/tv', { cookie: pass })).status, 204);
      const r = await check('/tv');
      assert.equal(r.status, 302);
      assert.match(r.headers.get('location'), /\/closed\?next=/);
      assert.equal((await check('/events', { nav: false })).status, 403);
    });

    await step('extend during grace reopens, and existing passes keep working', async () => {
      await post('/admin/extend', '', { Cookie: admin, Origin: ORIGIN });
      assert.equal((await (await get('/status')).json()).phase, 'open');
      assert.equal((await check('/tv', { cookie: pass })).status, 204);
    });

    await step('admin actions need the admin login', async () => {
      const r = await post('/admin/close', '', { Origin: ORIGIN });
      assert.equal(r.headers.get('location'), '/admin');
      assert.equal((await (await get('/status')).json()).phase, 'open');
    });

    await step('close now shuts everyone out, passes included', async () => {
      await post('/admin/close', '', { Cookie: admin, Origin: ORIGIN });
      assert.equal((await (await get('/status')).json()).phase, 'closed');
      assert.equal((await check('/tv', { cookie: pass })).status, 302);
      assert.equal((await check('/events', { nav: false, cookie: pass })).status, 403);
    });

    await step('reopening starts a new window, so old passes stay invalid', async () => {
      await post('/admin/open', '', { Cookie: admin, Origin: ORIGIN });
      assert.equal((await (await get('/status')).json()).phase, 'open');
      assert.equal((await check('/tv', { cookie: pass })).status, 302); // sent to /pass for a new one
    });

    await step('gate state is saved to disk', async () => {
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'gate.json'), 'utf8'));
      assert.ok(saved.windowId && saved.openUntil > 0);
    });

    await step('more than 5 login tries a minute are slowed down', async () => {
      let last;
      for (let i = 0; i < 6; i++) last = await post('/admin/login', 'password=nope', { 'CF-Connecting-IP': '203.0.113.9' });
      assert.equal(last.headers.get('location'), '/admin?e=slow');
    });

    await step('odd input is handled', async () => {
      assert.equal((await get('/%E0%A4%A')).status, 400);
      assert.equal((await get('/..%2f..%2fgames.json')).status, 404);
      assert.equal((await check('/tv', { cookie: 'slopbox_pass=%E0%A4%A' })).status, 302); // malformed cookie: no crash, no pass
      assert.equal((await get('/healthz')).status, 200);
      assert.equal((await post('/admin/nope', '', { Cookie: admin })).status, 404);
    });
  }
}

// ---------- part 2: update lock and manual deploys ----------

const DEPLOY_TOKEN = 'deploy-token';
const WATCHTOWER_TOKEN = 'watchtower-token';
let currentHub = null;

// Fake Watchtower. For /v1/update?image=ghcr.io/slop-box/<id> it acts out one case per game id:
//   quickpic  a new image: runs the hook, then answers
//   current   no new image: answers without running the hook
//   broken    Watchtower itself fails
//   slow      takes longer than the hub waits before answering "running"
//   hub       the hub updating itself: runs the hook, then the hub's container is replaced
function startWatchtower() {
  const hook = async (id) => (await get(`/update-allowed?id=${id}`)).status;
  watchtower = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://watchtower');
    if (req.headers.authorization !== `Bearer ${WATCHTOWER_TOKEN}`) { res.writeHead(401); return res.end('Invalid token'); }
    const id = (u.searchParams.get('image') || '').replace('ghcr.io/slop-box/', '');
    if (id === 'broken') { res.writeHead(500); return res.end('boom'); }
    if (id === 'slow') await sleep(1500);
    if (id !== 'current') await hook(id);
    if (id === 'hub') { currentHub.proc.kill('SIGKILL'); return; } // never answers, like a replaced container
    res.writeHead(200);
    res.end();
  });
  return new Promise((r) => watchtower.listen(WATCHTOWER_PORT, '127.0.0.1', r));
}

const HUB2_ENV = {
  SLOPBOX_ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir2,
  SLOPBOX_DEPLOY_TOKEN: DEPLOY_TOKEN, WATCHTOWER_API_TOKEN: WATCHTOWER_TOKEN,
  WATCHTOWER_URL: `http://127.0.0.1:${WATCHTOWER_PORT}`, DEPLOY_WAIT_SECONDS: '1',
};

// Each call comes from its own IP, so the rate limit only trips where a test means it to.
let ipCount = 0;
const deploy = (id, { method = 'POST', token = DEPLOY_TOKEN, ip = `198.51.100.${++ipCount}` } = {}) =>
  request(method, `/deploy?id=${id}`, null, Object.assign({ 'CF-Connecting-IP': ip }, token ? { Authorization: `Bearer ${token}` } : {}));
const hookStatus = async (id) => (await get(`/update-allowed?id=${id}`)).status;

async function updateTests() {
  BASE = `http://127.0.0.1:${PORT2}`;
  const gamesFile = path.join(dataDir2, 'games.json');
  fs.writeFileSync(gamesFile, JSON.stringify(['quickpic', 'current', 'broken', 'slow']
    .map((id) => ({ id, name: id, needsTv: false, blurb: 'test' }))));
  HUB2_ENV.GAMES_FILE = gamesFile;
  await startWatchtower();
  currentHub = startHub(PORT2, HUB2_ENV);
  await waitForHub();

  await step('update lock: games closed, so a scheduled update goes through', async () => {
    assert.equal(await hookStatus('quickpic'), 200);
  });

  await step('update lock: not reachable through Caddy', async () => {
    assert.equal((await get('/update-allowed?id=quickpic', { 'X-Forwarded-For': '203.0.113.5' })).status, 404);
    assert.equal((await get('/update-allowed?id=Not_An_Id')).status, 400);
  });

  let admin;
  await step('update lock: games open, so scheduled updates are skipped and counted', async () => {
    const r = await post('/admin/login', `password=${PASSWORD}`, { Origin: ORIGIN });
    admin = cookieFrom(r, 'slopbox_admin');
    assert.equal(await hookStatus('quickpic'), 423);
    assert.equal(await hookStatus('quickpic'), 423);
    const page = await (await get('/admin', { Cookie: admin })).text();
    assert.match(page, /Skipped 2 times while games were open/);
    assert.match(page, /Last update: <time data-when="\d+"><\/time>, scheduled/);
  });

  await step('deploy: refuses a missing or wrong token, and unknown games', async () => {
    let r = await deploy('quickpic', { token: '' });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).state, 'refused');
    assert.equal((await deploy('quickpic', { token: 'nope' })).status, 401);
    assert.equal((await deploy('not-a-game')).status, 404);
    assert.equal((await deploy('../etc')).status, 404);
    assert.equal((await deploy('quickpic', { method: 'GET' })).status, 404); // no deploy has run yet
    r = await deploy('quickpic', { method: 'PUT' });
    assert.equal(r.status, 405);
  });

  await step('deploy: goes through while games are open, then the lock is back', async () => {
    const r = await deploy('quickpic');
    const body = await r.json();
    assert.equal(r.status, 200, body.message);
    assert.equal(body.state, 'updated');
    assert.ok(body.started && body.finished);
    assert.equal(await hookStatus('quickpic'), 423);
    const page = await (await get('/admin', { Cookie: admin })).text();
    assert.match(page, /Last update: <time data-when="\d+"><\/time>, manual/);
  });

  await step('deploy: no new image is reported as nothing to update', async () => {
    const r = await deploy('current');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state, 'current');
  });

  await step('deploy: a Watchtower failure fails the deploy', async () => {
    const r = await deploy('broken');
    const body = await r.json();
    assert.equal(r.status, 502);
    assert.equal(body.state, 'failed');
    assert.match(body.message, /Watchtower answered 500: boom/);
    assert.match(await (await get('/admin', { Cookie: admin })).text(), /Manual deploy .*: failed/);
  });

  await step('deploy: a slow one answers "running", and the workflow can check back', async () => {
    const r = await deploy('slow');
    assert.equal(r.status, 202);
    assert.equal((await r.json()).state, 'running');
    assert.equal(await hookStatus('slow'), 200); // a scheduled run during the deploy may update it too
    let s;
    for (let i = 0; i < 30; i++) {
      s = await deploy('slow', { method: 'GET' });
      if (s.status !== 202) break;
      await sleep(100);
    }
    assert.equal(s.status, 200);
    assert.equal((await s.json()).state, 'updated');
  });

  await step('deploy: the host can block manual deploys for a party', async () => {
    await post('/admin/block-deploys', '', { Cookie: admin, Origin: ORIGIN });
    assert.match(await (await get('/admin', { Cookie: admin })).text(), /Manual deploys are blocked/);
    const r = await deploy('quickpic');
    assert.equal(r.status, 423);
    assert.equal((await r.json()).state, 'refused');
    await post('/admin/allow-deploys', '', { Cookie: admin, Origin: ORIGIN });
    assert.equal((await deploy('current')).status, 200);
  });

  await step('deploy: more than 10 calls a minute from one address are slowed down', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await deploy('quickpic', { token: 'nope', ip: '203.0.113.7' });
    assert.equal(last.status, 429);
  });

  await step('deploy: the hub can deploy itself, and reports it after restarting', async () => {
    await deploy('hub').catch(() => {}); // the connection drops when the hub is replaced
    await currentHub.exited;
    currentHub = startHub(PORT2, HUB2_ENV);
    await waitForHub();
    const r = await deploy('hub', { method: 'GET' });
    const body = await r.json();
    assert.equal(r.status, 200, body.message);
    assert.equal(body.state, 'updated');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir2, 'updates.json'), 'utf8'));
    assert.equal(saved.games.hub.last.kind, 'manual');
  });
}

main();
