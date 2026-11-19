'use strict';
// End-to-end test of the hub and party gate. Starts the hub with tiny timings (open ~2 s, grace 3 s)
// and plays Caddy's part by calling /check the way forward_auth does. Run: node hub/test.js

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = 'example.com';
const ORIGIN = `https://${DOMAIN}`;
const PASSWORD = 'test-password';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopbox-hub-test-'));

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

async function main() {
  const hub = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), SLOPBOX_DOMAIN: DOMAIN, SLOPBOX_ADMIN_PASSWORD: PASSWORD,
      SLOPBOX_GATE_SECRET: 'test-secret', DATA_DIR: dataDir,
      GATE_OPEN_HOURS: String(2 / 3600), GATE_GRACE_MINUTES: String(3 / 60),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  hub.stdout.on('data', (d) => { log += d; });
  hub.stderr.on('data', (d) => { log += d; });

  try {
    for (let i = 0; i < 50; i++) { try { if ((await get('/healthz')).ok) break; } catch {} await sleep(100); }

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

    console.log(`PASS (${passed} checks)`);
  } catch (e) {
    console.error(`FAIL after ${passed} checks:`, e.message);
    console.error('--- hub log ---\n' + log);
    process.exitCode = 1;
  } finally {
    hub.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main();
