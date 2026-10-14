// BLINDS cloud saves (v63): a backup of your progress on the server, so
// uninstalling or changing phones doesn't lose anything.
//
//   POST /cs/save     {token, data: {...}}  -> {ok, at}           (data = the game's progress, max 48 KB)
//   POST /cs/load     {token}               -> {ok, save: {data, at} | null}
//   POST /cs/delete   {token}               -> {ok}               (DELETE ACCOUNT in the game)
//
// `token` is the server-signed token a Google / Discord sign-in gets (see
// auth.js and leaderboard.js makeToken), so only signed-in players have a
// backup, and each can only reach their own.
//
// Storage: Upstash when UPSTASH_REDIS_REST_URL / _TOKEN are set (survives
// restarts and deploys), otherwise memory (wiped on restart - for testing).
//   cs:save  hash  account id ("google:123" / "discord:456") -> {"data": {...}, "at": ms}
const crypto = require('crypto');
const { readToken } = require('./leaderboard');

const MAX_BODY = 56 * 1024;
const MAX_SAVE_BYTES = 48 * 1024;
const MAX_CALLS_PER_IP_PER_MIN = 60;  // save / load / delete
const MIN_SAVE_GAP_MS = 8 * 1000;     // per account

// ---------------------------------------------------------------- storage

class MemoryKeep {
  constructor() { this.kind = 'memory'; this.h = new Map(); }
  H(k) { if (!this.h.has(k)) this.h.set(k, new Map()); return this.h.get(k); }
  async hget(k, f) { return this.H(k).get(f) ?? null; }
  async hset(k, f, v) { this.H(k).set(f, v); }
  async hdel(k, f) { return this.H(k).delete(f); }
}

class UpstashKeep {
  constructor(url, token) { this.url = url.replace(/\/+$/, ''); this.token = token; this.kind = 'upstash'; }
  async cmd(list) {
    const r = await fetch(this.url + '/pipeline', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
      body: JSON.stringify(list),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error('upstash ' + r.status);
    const out = await r.json();
    return out.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
  }
  async hget(k, f) { const [v] = await this.cmd([['HGET', k, f]]); return v ?? null; }
  async hset(k, f, v) { await this.cmd([['HSET', k, f, v]]); }
  async hdel(k, f) { const [n] = await this.cmd([['HDEL', k, f]]); return Number(n) > 0; }
}

const keep = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new UpstashKeep(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN)
  : new MemoryKeep();

// ---------------------------------------------------------------- helpers

const stats = { saves: 0, loads: 0, deletes: 0, refused: 0, storageErrors: 0 };
const ipWin = new Map();    // ip -> {calls, minStart}
const lastSave = new Map(); // account id -> ms

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => { if (tooBig) return; size += c.length; if (size > MAX_BODY) { tooBig = true; resolve(null); return; } chunks.push(c); });
    req.on('end', () => { if (!tooBig) { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } } });
    req.on('error', () => resolve(null));
  });
}

function ipEntry(ip) {
  const now = Date.now();
  let e = ipWin.get(ip);
  if (!e) { e = { calls: 0, minStart: now }; ipWin.set(ip, e); }
  if (now - e.minStart >= 60000) { e.calls = 0; e.minStart = now; }
  if (ipWin.size > 20000) for (const [k, v] of ipWin) if (now - v.minStart >= 60000) ipWin.delete(k);
  return e;
}

// Google / Discord only: the signed token is the proof of who you are.
async function accountFor(token) {
  const id = readToken(token);
  if (!id || !/^(google|discord):/.test(id)) return null;
  return id;
}

// ---------------------------------------------------------------- handlers

async function save(req, res, ip) {
  if (++ipEntry(ip).calls > MAX_CALLS_PER_IP_PER_MIN) { stats.refused++; return send(res, 429, { error: 'too_many_requests' }); }
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad_request' });
  const id = await accountFor(body.token);
  if (!id) return send(res, 401, { error: 'sign_in_required' });
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return send(res, 400, { error: 'bad_data' });
  const now = Date.now();
  if (now - (lastSave.get(id) || 0) < MIN_SAVE_GAP_MS) { stats.refused++; return send(res, 429, { error: 'too_soon' }); }
  const text = JSON.stringify({ data: body.data, at: now });
  if (Buffer.byteLength(text) > MAX_SAVE_BYTES) return send(res, 413, { error: 'too_big' });
  lastSave.set(id, now);
  if (lastSave.size > 50000) for (const [k, v] of lastSave) if (now - v > 60000) lastSave.delete(k);
  await keep.hset('cs:save', id, text);
  stats.saves++;
  return send(res, 200, { ok: true, at: now });
}

async function load(req, res, ip) {
  if (++ipEntry(ip).calls > MAX_CALLS_PER_IP_PER_MIN) { stats.refused++; return send(res, 429, { error: 'too_many_requests' }); }
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad_request' });
  const id = await accountFor(body.token);
  if (!id) return send(res, 401, { error: 'sign_in_required' });
  const raw = await keep.hget('cs:save', id);
  stats.loads++;
  let saveObj = null;
  if (raw) { try { saveObj = JSON.parse(raw); } catch { saveObj = null; } }
  return send(res, 200, { ok: true, save: saveObj });
}

async function remove(req, res, ip) {
  if (++ipEntry(ip).calls > MAX_CALLS_PER_IP_PER_MIN) { stats.refused++; return send(res, 429, { error: 'too_many_requests' }); }
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad_request' });
  const id = await accountFor(body.token);
  if (!id) return send(res, 401, { error: 'sign_in_required' });
  await keep.hdel('cs:save', id);
  lastSave.delete(id);
  stats.deletes++;
  return send(res, 200, { ok: true });
}

const ROUTES = { '/cs/save': save, '/cs/load': load, '/cs/delete': remove };

function handle(req, res, ip) {
  const path = String(req.url || '').split('?')[0];
  const fn = ROUTES[path];
  if (!fn) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
    res.end();
    return true;
  }
  if (req.method !== 'POST') { send(res, 405, { error: 'post_only' }); return true; }
  fn(req, res, ip).catch((err) => {
    stats.storageErrors++;
    console.error('cloud save error:', err.message);
    if (!res.headersSent) send(res, 503, { error: 'storage_unavailable' });
  });
  return true;
}

function info() {
  return { storage: keep.kind, ...stats };
}

module.exports = { handle, info };
