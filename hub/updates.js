'use strict';
// Update lock and manual deploys (PLAN.md Step 11).
//
// Watchtower runs each Slop Box container's pre-update hook just before updating it. The hook asks
// /update-allowed, and exits 75 ("skip for now") unless the answer is yes. The answer is yes when
// games are closed, or when a manual deploy for that game is running. Every answer is recorded, so
// the admin page can show each game's last update and the scheduled updates skipped during a party.

const fs = require('fs');
const path = require('path');

const DEPLOY_TIMEOUT_MS = 10 * 60e3;

function createUpdates({ dataDir, gatePhase, watchtowerUrl, watchtowerToken, now = Date.now }) {
  // games[id] = {
  //   last:    { at, kind: 'scheduled' | 'manual' }  the last time the hook let an update through
  //   skipped: { count, first, last }                scheduled updates skipped since then
  //   deploy:  { state, started, finished, message, hookAt }  the latest manual deploy
  // }
  const file = path.join(dataDir, 'updates.json');
  const state = { blockDeploys: false, games: {} };
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Couldn't read ${file}: ${e.message}`);
  }
  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
    } catch (e) {
      console.error(`Couldn't save ${file}: ${e.message}`);
    }
  }
  const entry = (id) => state.games[id] || (state.games[id] = {});

  // A deploy still "running" at startup was cut off by a hub restart. When the hub deploys itself,
  // that's expected: Watchtower ran the hook (hookAt), then replaced this container.
  let recovered = false;
  for (const g of Object.values(state.games)) {
    const d = g.deploy;
    if (!d || d.state !== 'running') continue;
    recovered = true;
    d.finished = now();
    if (d.hookAt) Object.assign(d, { state: 'updated', message: 'Updated. Watchtower restarted it.' });
    else Object.assign(d, { state: 'failed', message: 'The hub restarted before Watchtower started the update. Try again.' });
  }
  if (recovered) save();

  // The hook's question. Returns { ok, reason }.
  function allowed(id) {
    const g = entry(id);
    const t = now();
    let reason;
    if (g.deploy && g.deploy.state === 'running') {
      g.deploy.hookAt = t;
      g.last = { at: t, kind: 'manual' };
      reason = 'manual deploy';
    } else if (gatePhase() === 'closed') {
      g.last = { at: t, kind: 'scheduled' };
      reason = 'games are closed';
    } else {
      const s = g.skipped || { count: 0, first: t };
      g.skipped = { count: s.count + 1, first: s.first, last: t };
      save();
      return { ok: false, reason: `games are ${gatePhase() === 'open' ? 'open' : 'still in their grace period'}` };
    }
    delete g.skipped;
    save();
    return { ok: true, reason };
  }

  // Ask Watchtower to update one image now. Resolves with the finished deploy record.
  // A second call for the same id while one runs joins the first.
  const running = new Map();
  function deploy(id, image) {
    if (running.has(id)) return running.get(id);
    const d = { state: 'running', started: now(), finished: null, message: 'Waiting for Watchtower.', hookAt: null };
    entry(id).deploy = d;
    save();
    const done = (async () => {
      try {
        // Watchtower answers once the update is done. The image filter keeps it to this one game.
        const r = await fetch(`${watchtowerUrl}/v1/update?image=${encodeURIComponent(image)}`, {
          headers: { Authorization: `Bearer ${watchtowerToken}` },
          signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS),
        });
        const body = (await r.text()).trim().slice(0, 300);
        if (!r.ok) throw new Error(`Watchtower answered ${r.status}${body ? `: ${body}` : ''}`);
        if (d.hookAt) Object.assign(d, { state: 'updated', message: 'Updated. Watchtower pulled the new image and restarted it.' });
        else Object.assign(d, {
          state: 'current',
          message: 'Nothing to update: Watchtower didn’t run the update hook, so the server already had this image. ' +
            '(If it should have updated, check that Watchtower has WATCHTOWER_LIFECYCLE_HOOKS=true.)',
        });
      } catch (e) {
        const why = e.name === 'TimeoutError' ? `Watchtower didn’t finish within ${DEPLOY_TIMEOUT_MS / 60e3} minutes.`
          : e.message.startsWith('Watchtower answered') ? e.message
          : `Couldn’t reach Watchtower at ${watchtowerUrl}: ${(e.cause && e.cause.code) || e.message}`;
        Object.assign(d, { state: 'failed', message: why });
      }
      d.finished = now();
      running.delete(id);
      save();
      return d;
    })();
    running.set(id, done);
    return done;
  }

  return {
    allowed,
    deploy,
    isRunning: (id) => running.has(id),
    deployStatus: (id) => (state.games[id] && state.games[id].deploy) || null,
    get blocked() { return !!state.blockDeploys; },
    setBlocked(on) { state.blockDeploys = !!on; save(); },
    info: (id) => state.games[id] || {},
  };
}

module.exports = { createUpdates };
