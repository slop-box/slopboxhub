'use strict';
// Party gate: games are closed until the host logs in, then open for everyone for a few hours.
// Devices that joined while games were open keep working through a grace period, so a round in
// progress can finish. See PLAN.md Step 8.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createGate({ password, secret, dataDir, openMs, graceMs, now = Date.now }) {
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('SLOPBOX_GATE_SECRET is not set: using a random one, so passes and logins end when the hub restarts.');
  }
  if (!password) console.warn('SLOPBOX_ADMIN_PASSWORD is not set: nobody can log in, so games stay closed.');

  // windowId identifies one opening. Passes carry it, so a new opening (after games fully closed)
  // invalidates old passes. closedEarly means "Close now" was pressed, which skips the grace period.
  const stateFile = path.join(dataDir, 'gate.json');
  const state = { windowId: null, openUntil: 0, closedEarly: false };
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Couldn't read ${stateFile}: ${e.message}`);
  }
  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch (e) {
      console.error(`Couldn't save ${stateFile}: ${e.message}. The gate still works until the hub restarts.`);
    }
  }

  function phase() {
    const t = now();
    if (t < state.openUntil) return 'open';
    if (state.windowId && !state.closedEarly && t < state.openUntil + graceMs) return 'grace';
    return 'closed';
  }

  function status() {
    const p = phase();
    return {
      phase: p,
      openUntil: p === 'closed' ? null : state.openUntil,
      graceUntil: p === 'closed' ? null : state.openUntil + graceMs,
    };
  }

  // Open for `ms` from now (never shortens an opening). From fully closed, this starts a new window.
  function open(ms) {
    if (phase() === 'closed') state.windowId = crypto.randomBytes(9).toString('base64url');
    state.openUntil = Math.max(state.openUntil, now() + ms);
    state.closedEarly = false;
    save();
  }

  // Add `ms` to the current opening (or to now, during the grace period).
  function extend(ms) {
    if (phase() === 'closed') return open(ms);
    state.openUntil = Math.max(state.openUntil, now()) + ms;
    state.closedEarly = false;
    save();
  }

  function closeNow() {
    state.openUntil = Math.min(state.openUntil, now());
    state.closedEarly = true;
    save();
  }

  // Signed cookie values: base64url(JSON) + "." + HMAC.
  function sign(data) {
    const body = Buffer.from(JSON.stringify(data)).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
  }
  function verify(value) {
    if (!value) return null;
    const dot = value.lastIndexOf('.');
    if (dot < 1) return null;
    const body = value.slice(0, dot);
    const sig = Buffer.from(value.slice(dot + 1));
    const good = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('base64url'));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  }

  const newPass = () => sign({ t: 'pass', w: state.windowId });
  const passValid = (cookie) => {
    const d = verify(cookie);
    return !!d && d.t === 'pass' && d.w === state.windowId && phase() !== 'closed';
  };

  // Admin logins last 1 hour from when the password was typed; after that it must be typed again.
  const ADMIN_MS = 3600e3;
  const newAdminSession = () => sign({ t: 'admin', exp: now() + ADMIN_MS });
  const adminValid = (cookie) => {
    const d = verify(cookie);
    return !!d && d.t === 'admin' && d.exp > now();
  };

  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const passwordOk = (attempt) => !!password && crypto.timingSafeEqual(digest(attempt), digest(password));

  // At most 5 login attempts per minute per IP.
  const attempts = new Map();
  function allowAttempt(ip) {
    const t = now();
    const recent = (attempts.get(ip) || []).filter((x) => t - x < 60e3);
    recent.push(t);
    attempts.set(ip, recent);
    if (attempts.size > 1000) for (const [k, v] of attempts) if (t - v[v.length - 1] > 60e3) attempts.delete(k);
    return recent.length <= 5;
  }

  return {
    phase, status, open, extend, closeNow,
    newPass, passValid, newAdminSession, adminValid, ADMIN_MS,
    passwordOk, allowAttempt, hasPassword: !!password,
  };
}

module.exports = { createGate };
