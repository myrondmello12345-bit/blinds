// BLINDS leaderboards (v60).
//
//   POST /lb/submit   {token, name, avatar, trophies, wins, level}
//        -> {ok, ranks: {trophies, wins}, scores: {trophies, wins}}
//   GET  /lb/top?board=trophies|wins&n=50
//        -> {board, total, entries: [{rank, name, avatar, level, score}]}
//   POST /lb/delete  {token}  -> {ok, removed}   (v61: DELETE ACCOUNT)
//   POST /lb/daily/submit  {token?, iid, name, avatar, day, calls, streak}   (v61)
//        -> {ok, rank, total}
//   GET  /lb/daily/top?day=N&n=50
//        -> {day, total, entries: [{rank, name, avatar, score, streak}]}
//
// Daily BLINDS (v61): one shared match a day; the score is how many numbers
// had been called when you spelled BLIND (16-25, fewer is better). Open to
// everyone - signed-in players are keyed by account, others by their random
// install id. Only the FIRST result per player per day counts, a result is
// only taken for today (or yesterday, around midnight), and each day's board
// is deleted after a week.
//
// Only players signed in with Google or Discord appear. The sign-in step
// (auth.js) hands the game a signed token; a submission without a valid
// token is refused, so nobody can post scores under someone else's account.
//
// Scores come from the player's device, so they can't be fully trusted.
// The server limits how fast a score can grow (about one win a minute),
// caps the first score an account posts, and limits how often each account
// and address can submit. That stops instant fake "999999" entries; it
// cannot stop someone who patiently cheats at the speed of a real player.
//
// Storage: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (a free
// Upstash Redis database) and the boards survive restarts and deploys.
// Without them the boards live in memory and are wiped on every restart.
const crypto = require('crypto');

const BOARDS = ['trophies', 'wins'];
const MAX_NAME = 14;
const FIRST_CAP = { trophies: 2000, wins: 100 };   // most a brand-new entry may claim
const GROWTH_PER_MIN = { trophies: 20, wins: 1 };   // about one won match a minute
const GROWTH_SLACK = { trophies: 40, wins: 2 };
const MIN_SUBMIT_GAP_MS = 15 * 1000;                 // per account
const MAX_SUBMITS_PER_IP_PER_MIN = 20;
const TOP_CACHE_MS = 15 * 1000; // at most; refreshed after 2 s once scores change
const SORT_REUSE_MS = 2 * 1000; // a busy board is re-sorted at most every 2 s
const MAX_TOP = 100;
const MAX_BODY = 2048;

// A few words that should never appear on a public board. Names containing
// them are shown as "Player".
// (Kept to words that don't hide inside ordinary names: no "kill" (skill), "sex" (Essex) etc.)
const BLOCKED = ['fuck', 'shit', 'cunt', 'nigg', 'faggot', 'nazi', 'hitler', 'whore', 'slut', 'bitch', 'pussy', 'porn', 'retard', 'rapist'];

function secret() {
  const s = process.env.LEADERBOARD_SECRET
    || ((process.env.GOOGLE_CLIENT_SECRET || '') + '|' + (process.env.DISCORD_CLIENT_SECRET || ''));
  return crypto.createHash('sha256').update('blinds-lb|' + s).digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

// Called by auth.js when a sign-in completes.
function makeToken(provider, id) {
  const body = b64(JSON.stringify({ p: provider, i: String(id) }));
  const mac = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + mac;
}

function readToken(token) {
  if (typeof token !== 'string' || token.length > 512 || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const want = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(mac || ''), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!d || typeof d.p !== 'string' || typeof d.i !== 'string' || !d.i) return null;
    return d.p + ':' + d.i;
  } catch { return null; }
}

function cleanName(raw) {
  let n = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').trim().slice(0, MAX_NAME);
  if (!n) n = 'Player';
  const flat = n.toLowerCase().replace(/[^a-z]/g, '').replace(/0/g, 'o');
  if (BLOCKED.some((w) => flat.includes(w))) n = 'Player';
  return n;
}

const cleanAvatar = (a) => (typeof a === 'string' && /^[a-z0-9_]{1,24}$/.test(a) ? a : 'classic');
const int = (v, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(n, hi)) : 0; };

// ---------------------------------------------------------------- storage

class MemoryStore {
  constructor() { this.recs = new Map(); this.kind = 'memory'; this.sorted = {}; this.version = 0; }
  async get(id) { return this.recs.get(id) || null; }
  async put(id, rec) { this.recs.set(id, rec); this.version++; }
  // Sorted copies are rebuilt at most every few seconds, so a busy board
  // costs one sort per board every few seconds instead of one per request.
  _sorted(board) {
    const c = this.sorted[board];
    if (c && (c.version === this.version || Date.now() - c.at < SORT_REUSE_MS)) return c.list;
    const list = [...this.recs.values()].sort((x, y) => (y[board] - x[board]) || (x.t - y.t));
    this.sorted[board] = { at: Date.now(), list, version: this.version };
    return list;
  }
  async top(board, n) {
    const all = this._sorted(board);
    return { total: this.recs.size, list: all.slice(0, n) };
  }
  // Rank from the sorted copy by binary search (at most a few seconds old).
  async remove(id) { const had = this.recs.delete(id); if (had) this.version++; return had; }
  async rank(board, id) {
    const me = this.recs.get(id);
    if (!me) return 0;
    const list = this._sorted(board);
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = list[mid];
      if (r[board] > me[board] || (r[board] === me[board] && r.t < me.t)) lo = mid + 1; else hi = mid;
    }
    return lo + 1;
  }
}

class UpstashStore {
  constructor(url, token) { this.url = url.replace(/\/+$/, ''); this.token = token; this.kind = 'upstash'; }
  async cmd(list) {
    const r = await fetch(this.url + '/pipeline', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
      body: JSON.stringify(list),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error('upstash ' + r.status);
    const out = await r.json();
    return out.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
  }
  async get(id) {
    const [v] = await this.cmd([['HGET', 'lb:rec', id]]);
    try { return v ? JSON.parse(v) : null; } catch { return null; }
  }
  async put(id, rec) {
    // score ties: older entries first, so the score carries a tiny time part
    const tie = (t) => 1 - t / 1e14;
    await this.cmd([
      ['HSET', 'lb:rec', id, JSON.stringify(rec)],
      ['ZADD', 'lb:trophies', String(rec.trophies + tie(rec.t)), id],
      ['ZADD', 'lb:wins', String(rec.wins + tie(rec.t)), id],
    ]);
  }
  async top(board, n) {
    const [ids, total] = await this.cmd([['ZREVRANGE', 'lb:' + board, '0', String(n - 1)], ['ZCARD', 'lb:' + board]]);
    if (!ids || !ids.length) return { total: total || 0, list: [] };
    const [vals] = await this.cmd([['HMGET', 'lb:rec', ...ids]]);
    const list = [];
    for (const v of vals || []) { try { if (v) list.push(JSON.parse(v)); } catch { /* skip */ } }
    return { total: total || 0, list };
  }
  async remove(id) {
    const [n] = await this.cmd([['HDEL', 'lb:rec', id], ['ZREM', 'lb:trophies', id], ['ZREM', 'lb:wins', id]]);
    return Number(n) > 0;
  }
  async rank(board, id) {
    const [r] = await this.cmd([['ZREVRANK', 'lb:' + board, id]]);
    return r === null || r === undefined ? 0 : Number(r) + 1;
  }
}

const store = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new UpstashStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN)
  : new MemoryStore();

// ---------------------------------------------------------------- limits

const lastSubmit = new Map(); // account -> ms
const ipCounts = new Map();   // ip -> {n, start}
const topCache = new Map();   // board:n -> {at, body, changes}
let changes = 0;
const stats = { dailySubmitted: 0, submitted: 0, refusedToken: 0, refusedRate: 0, clamped: 0, storageErrors: 0 };

function ipAllowed(ip) {
  const now = Date.now();
  let e = ipCounts.get(ip);
  if (!e || now - e.start >= 60000) { e = { n: 0, start: now }; ipCounts.set(ip, e); }
  e.n += 1;
  if (ipCounts.size > 20000) for (const [k, v] of ipCounts) if (now - v.start >= 60000) ipCounts.delete(k);
  return e.n <= MAX_SUBMITS_PER_IP_PER_MIN;
}

// ---------------------------------------------------------------- http

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (c) => { if (tooBig) return; data += c; if (data.length > MAX_BODY) { tooBig = true; resolve(null); } });
    req.on('end', () => { if (!tooBig) { try { resolve(JSON.parse(data)); } catch { resolve(null); } } });
    req.on('error', () => resolve(null));
  });
}

async function submit(req, res, ip) {
  if (!ipAllowed(ip)) { stats.refusedRate++; return send(res, 429, { error: 'too_many_requests' }); }
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad_request' });
  const id = readToken(body.token);
  if (!id) { stats.refusedToken++; return send(res, 401, { error: 'sign_in_required' }); }
  const now = Date.now();
  const last = lastSubmit.get(id) || 0;
  if (now - last < MIN_SUBMIT_GAP_MS) { stats.refusedRate++; return send(res, 429, { error: 'too_soon' }); }
  lastSubmit.set(id, now);
  if (lastSubmit.size > 50000) for (const [k, v] of lastSubmit) if (now - v > 60000) lastSubmit.delete(k);

  try {
    const prev = await store.get(id);
    const rec = {
      id,
      name: cleanName(body.name),
      avatar: cleanAvatar(body.avatar),
      level: int(body.level, 100) || 1,
      t: prev ? prev.t : now, // first appearance (breaks ties)
      at: now,
    };
    for (const b of BOARDS) {
      const claimed = int(body[b], 1e7);
      let allowed;
      if (!prev) allowed = FIRST_CAP[b];
      else {
        const minutes = Math.max(0, (now - (prev.at || prev.t)) / 60000);
        allowed = prev[b] + Math.floor(GROWTH_PER_MIN[b] * minutes) + GROWTH_SLACK[b];
      }
      if (claimed > allowed) stats.clamped++;
      rec[b] = Math.min(claimed, allowed);
      // trophies can fall (losses); wins never go down
      if (b === 'wins' && prev) rec[b] = Math.max(rec[b], prev[b]);
    }
    await store.put(id, rec);
    stats.submitted++;
    const ranks = {};
    for (const b of BOARDS) ranks[b] = await store.rank(b, id);
    changes++; // top lists refresh within 2 s
    return send(res, 200, { ok: true, ranks, scores: { trophies: rec.trophies, wins: rec.wins } });
  } catch (err) {
    stats.storageErrors++;
    console.error('leaderboard storage error:', err.message);
    return send(res, 503, { error: 'storage_unavailable' });
  }
}

// v61: DELETE ACCOUNT in the game removes the player from the TOP 100 boards.
async function remove(req, res, ip) {
  if (!ipAllowed(ip)) { stats.refusedRate++; return send(res, 429, { error: 'too_many_requests' }); }
  const body = await readBody(req);
  const id = body && readToken(body.token);
  if (!id) return send(res, 401, { error: 'sign_in_required' });
  try {
    const removed = await store.remove(id);
    lastSubmit.delete(id);
    changes++;
    return send(res, 200, { ok: true, removed });
  } catch (err) {
    stats.storageErrors++;
    console.error('leaderboard storage error:', err.message);
    return send(res, 503, { error: 'storage_unavailable' });
  }
}

async function top(res, url) {
  const board = BOARDS.includes(url.searchParams.get('board')) ? url.searchParams.get('board') : 'trophies';
  const n = Math.max(1, Math.min(int(url.searchParams.get('n') || 50, MAX_TOP), MAX_TOP));
  const key = board + ':' + n;
  const hit = topCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < TOP_CACHE_MS && (hit.changes === changes || age < SORT_REUSE_MS)) return send(res, 200, hit.body);
  try {
    const { total, list } = await store.top(board, n);
    const body = {
      board, total,
      entries: list.map((r, i) => ({ rank: i + 1, name: r.name, avatar: r.avatar, level: r.level, score: r[board] })),
    };
    topCache.set(key, { at: Date.now(), body, changes });
    return send(res, 200, body);
  } catch (err) {
    stats.storageErrors++;
    console.error('leaderboard storage error:', err.message);
    return send(res, 503, { error: 'storage_unavailable' });
  }
}


// ---------------------------------------------------------------- daily (v61)

const DAILY_MIN_CALLS = 16;   // fewest calls that can make 5 lines
const DAILY_MAX_CALLS = 25;
const DAILY_KEEP_DAYS = 8;
const DAILY_MAX_PER_DAY = 500000;
const utcDay = (ms = Date.now()) => Math.floor(ms / 86400000);

class MemoryDaily {
  constructor() { this.days = new Map(); this.sorted = new Map(); this.kind = 'memory'; }
  _day(d) { let m = this.days.get(d); if (!m) { m = new Map(); this.days.set(d, m); } return m; }
  async add(d, key, rec) {
    const m = this._day(d);
    if (m.has(key)) return false;
    if (m.size >= DAILY_MAX_PER_DAY) return false;
    m.set(key, rec);
    const cutoff = utcDay() - DAILY_KEEP_DAYS;
    for (const k of this.days.keys()) if (k < cutoff) { this.days.delete(k); this.sorted.delete(k); }
    return true;
  }
  _sortedList(d) {
    const m = this.days.get(d);
    if (!m) return [];
    const c = this.sorted.get(d);
    if (c && c.size === m.size && Date.now() - c.at < 60000) return c.list;
    if (c && Date.now() - c.at < SORT_REUSE_MS) return c.list;
    const list = [...m.values()].sort((x, y) => (x.calls - y.calls) || (x.t - y.t));
    this.sorted.set(d, { at: Date.now(), list, size: m.size });
    return list;
  }
  async top(d, n) { const m = this.days.get(d); return { total: m ? m.size : 0, list: this._sortedList(d).slice(0, n) }; }
  async get(d, key) { const m = this.days.get(d); return m ? (m.get(key) || null) : null; }
  async rank(d, key) {
    const me = await this.get(d, key);
    if (!me) return 0;
    const list = this._sortedList(d);
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = list[mid];
      if (r.calls < me.calls || (r.calls === me.calls && r.t < me.t)) lo = mid + 1; else hi = mid;
    }
    return lo + 1;
  }
}

class UpstashDaily {
  constructor(upstash) { this.u = upstash; this.kind = 'upstash'; }
  async add(d, key, rec) {
    const ttl = String(DAILY_KEEP_DAYS * 86400);
    const [isNew] = await this.u.cmd([['HSETNX', 'lbd:rec:' + d, key, JSON.stringify(rec)]]);
    if (!isNew) return false;
    await this.u.cmd([
      ['ZADD', 'lbd:' + d, String(rec.calls + rec.t / 1e14), key],
      ['EXPIRE', 'lbd:rec:' + d, ttl],
      ['EXPIRE', 'lbd:' + d, ttl],
    ]);
    return true;
  }
  async top(d, n) {
    const [keys, total] = await this.u.cmd([['ZRANGE', 'lbd:' + d, '0', String(n - 1)], ['ZCARD', 'lbd:' + d]]);
    if (!keys || !keys.length) return { total: total || 0, list: [] };
    const [vals] = await this.u.cmd([['HMGET', 'lbd:rec:' + d, ...keys]]);
    const list = [];
    for (const v of vals || []) { try { if (v) list.push(JSON.parse(v)); } catch { /* skip */ } }
    return { total: total || 0, list };
  }
  async get(d, key) {
    const [v] = await this.u.cmd([['HGET', 'lbd:rec:' + d, key]]);
    try { return v ? JSON.parse(v) : null; } catch { return null; }
  }
  async rank(d, key) {
    const [r] = await this.u.cmd([['ZRANK', 'lbd:' + d, key]]);
    return r === null || r === undefined ? 0 : Number(r) + 1;
  }
}

const daily = store.kind === 'upstash' ? new UpstashDaily(store) : new MemoryDaily();
const dailyCache = new Map(); // day:n -> {at, body, count}
let dailyChanges = 0;

async function dailySubmit(req, res, ip) {
  if (!ipAllowed(ip)) { stats.refusedRate++; return send(res, 429, { error: 'too_many_requests' }); }
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad_request' });
  let key = readToken(body.token);
  if (!key) {
    if (typeof body.iid !== 'string' || !/^[a-f0-9]{16,32}$/.test(body.iid)) return send(res, 400, { error: 'bad_request' });
    key = 'anon:' + body.iid;
  }
  const today = utcDay();
  const day = Math.floor(Number(body.day));
  if (!(day === today || day === today - 1)) return send(res, 400, { error: 'wrong_day' });
  const calls = Math.floor(Number(body.calls));
  if (!Number.isFinite(calls) || calls < DAILY_MIN_CALLS || calls > DAILY_MAX_CALLS) return send(res, 400, { error: 'bad_score' });
  try {
    const rec = { name: cleanName(body.name), avatar: cleanAvatar(body.avatar), calls, streak: int(body.streak, 3650), t: Date.now() };
    const added = await daily.add(day, key, rec);
    if (added) { stats.dailySubmitted++; dailyChanges++; }
    const [rank, { total }] = await Promise.all([daily.rank(day, key), daily.top(day, 1)]);
    return send(res, 200, { ok: true, counted: added, rank, total });
  } catch (err) {
    stats.storageErrors++;
    console.error('daily storage error:', err.message);
    return send(res, 503, { error: 'storage_unavailable' });
  }
}

async function dailyTop(res, url) {
  const today = utcDay();
  let day = Math.floor(Number(url.searchParams.get('day')));
  if (!Number.isFinite(day) || day > today || day < today - DAILY_KEEP_DAYS + 1) day = today;
  const n = Math.max(1, Math.min(int(url.searchParams.get('n') || 50, MAX_TOP), MAX_TOP));
  const key = day + ':' + n;
  const hit = dailyCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < TOP_CACHE_MS && (hit.changes === dailyChanges || age < SORT_REUSE_MS)) return send(res, 200, hit.body);
  try {
    const { total, list } = await daily.top(day, n);
    const body = { day, total, entries: list.map((r, i) => ({ rank: i + 1, name: r.name, avatar: r.avatar, score: r.calls, streak: r.streak || 0 })) };
    dailyCache.set(key, { at: Date.now(), body, changes: dailyChanges });
    if (dailyCache.size > 50) for (const k of dailyCache.keys()) { dailyCache.delete(k); if (dailyCache.size <= 25) break; }
    return send(res, 200, body);
  } catch (err) {
    stats.storageErrors++;
    console.error('daily storage error:', err.message);
    return send(res, 503, { error: 'storage_unavailable' });
  }
}

// Returns true when it handled the request.
function handle(req, res, ip) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/lb/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    res.end();
    return true;
  }
  if (url.pathname === '/lb/submit' && req.method === 'POST') { submit(req, res, ip); return true; }
  if (url.pathname === '/lb/top' && req.method === 'GET') { top(res, url); return true; }
  if (url.pathname === '/lb/delete' && req.method === 'POST') { remove(req, res, ip); return true; }
  if (url.pathname === '/lb/daily/submit' && req.method === 'POST') { dailySubmit(req, res, ip); return true; }
  if (url.pathname === '/lb/daily/top' && req.method === 'GET') { dailyTop(res, url); return true; }
  send(res, 404, { error: 'not_found' });
  return true;
}

function info() {
  return { storage: store.kind, ...stats };
}

module.exports = { handle, makeToken, readToken, cleanName, info, utcDay, _store: store, _daily: daily };
