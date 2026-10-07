// BLINDS sign-in (v38): "Continue with Google / Discord" for the game.
//
// How it works (no native plugins, works on Android, Windows and Web):
//   1. The game POSTs /auth/start?provider=google  -> { sid, url }
//   2. The game opens `url` in the system browser; the player signs in there.
//   3. The provider redirects to  <PUBLIC_URL>/auth/callback/<provider>
//      with ?code=...&state=<sid>; this file swaps the code for the player's
//      profile and keeps it for a few minutes.
//   4. The game polls GET /auth/poll?sid=<sid> until it gets { status:"ok", ... }
//
// A provider is "enabled" only when its env vars are set - see DEPLOYMENT.md:
//   PUBLIC_URL                         e.g. https://blinds-3kcj.onrender.com
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET
// (GOOGLE_*_URL / DISCORD_*_URL can override the provider endpoints - used by
// the tests to point at a fake provider.)
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 2000;
const sessions = new Map(); // sid -> { provider, created, result }

function env(name, fallback = '') { return process.env[name] || fallback; }

function providers() {
  const base = {
    google: {
      id: env('GOOGLE_CLIENT_ID'), secret: env('GOOGLE_CLIENT_SECRET'),
      authUrl: env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
      tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
      profileUrl: env('GOOGLE_PROFILE_URL', 'https://openidconnect.googleapis.com/v1/userinfo'),
      scope: 'openid profile',
      toProfile: (p) => ({ id: String(p.sub || ''), name: String(p.name || p.given_name || 'Player') }),
    },
    discord: {
      id: env('DISCORD_CLIENT_ID'), secret: env('DISCORD_CLIENT_SECRET'),
      authUrl: env('DISCORD_AUTH_URL', 'https://discord.com/oauth2/authorize'),
      tokenUrl: env('DISCORD_TOKEN_URL', 'https://discord.com/api/oauth2/token'),
      profileUrl: env('DISCORD_PROFILE_URL', 'https://discord.com/api/users/@me'),
      scope: 'identify',
      toProfile: (p) => ({ id: String(p.id || ''), name: String(p.global_name || p.username || 'Player') }),
    },
  };
  return base;
}

function enabled(name) {
  const p = providers()[name];
  return !!(p && p.id && p.secret && env('PUBLIC_URL'));
}

function redirectUri(name) {
  return env('PUBLIC_URL').replace(/\/+$/, '') + '/auth/callback/' + name;
}

function request(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method, headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; if (data.length > 200000) req.destroy(new Error('too large')); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function prune() {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.created > SESSION_TTL_MS) sessions.delete(sid);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function page(res, title, message) {
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>BLINDS</title>` +
    `<body style="font-family:system-ui;background:#173B4D;color:#FFF7E8;text-align:center;padding:18vh 24px">` +
    `<h1 style="color:#FFD33D">${esc(title)}</h1><p style="font-size:1.2rem">${esc(message)}</p></body>`);
}

// Returns true when it handled the request.
function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/auth/')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    res.end();
    return true;
  }

  if (u.pathname === '/auth/providers') {
    json(res, 200, { google: enabled('google'), discord: enabled('discord') });
    return true;
  }

  if (u.pathname === '/auth/start') {
    const name = u.searchParams.get('provider') || '';
    if (!providers()[name]) { json(res, 400, { error: 'unknown provider' }); return true; }
    if (!enabled(name)) { json(res, 503, { error: 'not_configured' }); return true; }
    prune();
    const sid = crypto.randomBytes(16).toString('hex');
    sessions.set(sid, { provider: name, created: Date.now(), result: null });
    const p = providers()[name];
    const q = new URLSearchParams({
      client_id: p.id, redirect_uri: redirectUri(name), response_type: 'code', scope: p.scope, state: sid,
    });
    if (name === 'google') q.set('prompt', 'select_account');
    json(res, 200, { sid, url: `${p.authUrl}?${q.toString()}` });
    return true;
  }

  if (u.pathname === '/auth/poll') {
    const sid = u.searchParams.get('sid') || '';
    const s = sessions.get(sid);
    if (!s || Date.now() - s.created > SESSION_TTL_MS) { json(res, 404, { status: 'expired' }); return true; }
    if (!s.result) { json(res, 200, { status: 'pending' }); return true; }
    sessions.delete(sid); // one-time pickup
    json(res, 200, s.result);
    return true;
  }

  const m = u.pathname.match(/^\/auth\/callback\/([a-z]+)$/);
  if (m) {
    const name = m[1];
    const s = sessions.get(u.searchParams.get('state') || '');
    if (!providers()[name] || !enabled(name) || !s || s.provider !== name) {
      page(res, 'Link expired', 'Go back to BLINDS and press the sign-in button again.');
      return true;
    }
    const code = u.searchParams.get('code');
    if (!code) {
      s.result = { status: 'error', error: 'cancelled' };
      page(res, 'Sign-in cancelled', 'You can close this tab and go back to BLINDS.');
      return true;
    }
    const p = providers()[name];
    const form = new URLSearchParams({
      client_id: p.id, client_secret: p.secret, grant_type: 'authorization_code',
      code, redirect_uri: redirectUri(name),
    }).toString();
    request(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) }, body: form })
      .then((t) => {
        if (!t.json || !t.json.access_token) throw new Error('no token');
        return request(p.profileUrl, { headers: { authorization: 'Bearer ' + t.json.access_token } });
      })
      .then((r) => {
        const prof = r.json && p.toProfile(r.json);
        if (!prof || !prof.id) throw new Error('no profile');
        s.result = { status: 'ok', provider: name, id: prof.id, name: prof.name.slice(0, 40) };
        page(res, 'You are signed in!', 'You can close this tab and go back to BLINDS.');
      })
      .catch((err) => {
        console.error('auth error:', name, err.message);
        s.result = { status: 'error', error: 'failed' };
        page(res, 'Sign-in failed', 'Please go back to BLINDS and try again.');
      });
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle };
