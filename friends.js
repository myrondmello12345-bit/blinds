// BLINDS friends (v62).
//
// Every player has a friend code (8 letters/digits, made on their phone) and a
// secret that only their phone knows. The first phone to use a code owns it.
//
//   POST /fr/hello  {code, secret, name, avatar, trophies, level, busy, friends: [codes]}
//        -> {ok, friends: {CODE: {name, avatar, trophies, level, online, busy}},
//            invites: [{from, name, avatar, room}], added: [{code, name, ...}],
//            answers: [{from, answer}]}
//        The game calls this every few seconds while it is open. It says "I'm
//        here", asks how the friends are doing, and collects anything waiting.
//   POST /fr/add    {code, secret, friend}        -> {ok, friend: {...}}
//        The friend is told on their next hello, and their game adds you back.
//   POST /fr/invite {code, secret, to, room}      -> {ok} | {error: offline|busy|no_room|not_friends}
//        Only works if `to` has you on their list (or you added them in the last 15 min).
//        `room` is a private room the inviter has just created on this relay.
//   POST /fr/answer {code, secret, to, answer: "yes"|"no"|"busy"}  -> {ok}
//   POST /fr/cancel {code, secret, to}            -> {ok}
//
// Who is online and the invites live in memory only (they last a minute).
// Code owners, names and "X added you" notes are kept in Upstash when it is
// set up, so they survive restarts.
const crypto = require('crypto');
const { cleanName } = require('./leaderboard');

const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const SECRET_RE = /^[0-9a-f]{32}$/;
const ROOM_RE = /^[A-Z0-9]{6}$/;
const ONLINE_MS = 45 * 1000;
const INVITE_MS = 70 * 1000;
const MAX_FRIENDS = 100;
const MAX_BODY = 4096;
const MAX_PER_IP_PER_MIN = 120;
const MIN_HELLO_GAP_MS = 1500;
const MIN_INVITE_GAP_MS = 2500;
const MAX_ADDS_PER_HOUR = 40;
const MAX_INBOX = 50;
const CACHE_LIMIT = 200000;
// When hellos come in faster than this, the server asks games to say hello
// less often (the reply carries "slow": 1-5). Sized for Render's 0.1 CPU.
const TARGET_HELLOS_PER_SEC = Number(process.env.FRIENDS_TARGET_RATE) > 0 ? Number(process.env.FRIENDS_TARGET_RATE) : 120;

const cleanAvatar = (a) => (typeof a === 'string' && /^[a-z0-9_]{1,24}$/.test(a) ? a : 'classic');
const int = (v, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(n, hi)) : 0; };
const hashSecret = (s) => crypto.createHash('sha256').update('blinds-fr|' + s).digest('hex');

// ---------------------------------------------------------------- storage

class MemoryKeep {
  constructor() { this.kind = 'memory'; this.h = new Map(); }
  H(k) { if (!this.h.has(k)) this.h.set(k, new Map()); return this.h.get(k); }
  async hget(k, f) { return this.H(k).get(f) ?? null; }
  async hset(k, f, v) { this.H(k).set(f, v); }
  async hsetnx(k, f, v) { const m = this.H(k); if (m.has(f)) return false; m.set(f, v); return true; }
  async hmget(k, fs) { const m = this.H(k); return fs.map((f) => m.get(f) ?? null); }
  async hgetall(k) { return Object.fromEntries(this.H(k)); }
  async hdel(k, fs) { const m = this.H(k); for (const f of fs) m.delete(f); if (!m.size) this.h.delete(k); }
}

class UpstashKeep {
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
  async hget(k, f) { const [v] = await this.cmd([['HGET', k, f]]); return v ?? null; }
  async hset(k, f, v) { await this.cmd([['HSET', k, f, v]]); }
  async hsetnx(k, f, v) { const [n] = await this.cmd([['HSETNX', k, f, v]]); return Number(n) === 1; }
  async hmget(k, fs) { if (!fs.length) return []; const [v] = await this.cmd([['HMGET', k, ...fs]]); return v || fs.map(() => null); }
  async hgetall(k) {
    const [flat] = await this.cmd([['HGETALL', k]]);
    const o = {};
    if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
    else if (flat && typeof flat === 'object') Object.assign(o, flat);
    return o;
  }
  async hdel(k, fs) { if (fs.length) await this.cmd([['HDEL', k, ...fs]]); }
}

const keep = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new UpstashKeep(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN)
  : new MemoryKeep();

// ---------------------------------------------------------------- state

const owners = new Map();    // code -> secret hash (cache of fr:own)
const profiles = new Map();  // code -> {name, avatar, trophies, level} (cache of fr:prof)
const profJson = new Map();  // code -> last JSON written, so unchanged names cost nothing
const inboxRead = new Set(); // codes whose stored "added you" notes were read since start
const presence = new Map();  // code -> {seen, busy, hello}
const invites = new Map();   // to -> Map(from -> {room, at})
const answers = new Map();   // to -> [{from, answer, at}]
const addsPending = new Map(); // to -> Map(from -> at) not yet in storage-backed inbox read
const lists = new Map();      // code -> Set of friend codes from their last hello
const recentAdds = new Map(); // to -> Map(from -> at): who added them lately (may invite before the add-back)
const lastInvite = new Map(); // code -> ms
const addCounts = new Map();  // code -> {n, start}
const ipCounts = new Map();   // ip -> {n, start}
let roomCheck = () => true;
let rateWindowStart = Date.now();
let rateCount = 0;
let slow = 1; // multiplier sent to games; recomputed every 5 s
function noteHello(now) {
  rateCount++;
  if (now - rateWindowStart >= 5000) {
    const rate = rateCount / ((now - rateWindowStart) / 1000);
    // the slow-down that would bring the rate to the target, eased in
    const want = Math.min(5, Math.max(1, slow * rate / TARGET_HELLOS_PER_SEC));
    slow = Math.round((slow * 0.5 + want * 0.5) * 10) / 10;
    rateWindowStart = now;
    rateCount = 0;
  }
}
const stats = { hellos: 0, adds: 0, invites: 0, accepted: 0, declined: 0, refusedRate: 0, refusedSecret: 0, storageErrors: 0 };

function trim(map) {
  if (map.size <= CACHE_LIMIT) return;
  let n = map.size - Math.floor(CACHE_LIMIT * 0.9);
  for (const k of map.keys()) { if (n-- <= 0) break; map.delete(k); }
}

function sweep(now = Date.now()) {
  for (const [to, m] of invites) {
    for (const [from, inv] of m) if (now - inv.at > INVITE_MS) m.delete(from);
    if (!m.size) invites.delete(to);
  }
  for (const [to, list] of answers) {
    const keepList = list.filter((a) => now - a.at <= INVITE_MS);
    if (keepList.length) answers.set(to, keepList); else answers.delete(to);
  }
  for (const [code, p] of presence) if (now - p.seen > 10 * 60 * 1000) presence.delete(code);
  for (const [code, t] of lastInvite) if (now - t > 60000) lastInvite.delete(code);
  for (const [ip, e] of ipCounts) if (now - e.start >= 60000) ipCounts.delete(ip);
  for (const [c, e] of addCounts) if (now - e.start >= 3600000) addCounts.delete(c);
  for (const [to, m] of recentAdds) {
    for (const [from, at] of m) if (now - at > 15 * 60 * 1000) m.delete(from);
    if (!m.size) recentAdds.delete(to);
  }
}
setInterval(sweep, 15000).unref();

// ---------------------------------------------------------------- helpers

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

function ipAllowed(ip) {
  const now = Date.now();
  let e = ipCounts.get(ip);
  if (!e || now - e.start >= 60000) { e = { n: 0, start: now }; ipCounts.set(ip, e); }
  e.n += 1;
  return e.n <= MAX_PER_IP_PER_MIN;
}

// Is this phone the owner of `code`? The first secret seen for a code claims it.
async function verify(code, secret) {
  if (!CODE_RE.test(String(code)) || !SECRET_RE.test(String(secret))) return 'bad';
  const h = hashSecret(secret);
  let own = owners.get(code);
  if (own === undefined) {
    own = await keep.hget('fr:own', code);
    if (own === null) {
      const claimed = await keep.hsetnx('fr:own', code, h);
      own = claimed ? h : await keep.hget('fr:own', code);
    }
    owners.set(code, own);
    trim(owners);
  }
  return own === h ? 'ok' : 'taken';
}

function isOnline(code, now = Date.now()) {
  const p = presence.get(code);
  return !!p && now - p.seen <= ONLINE_MS * slow;
}

async function profilesFor(codes) {
  const missing = codes.filter((c) => !profiles.has(c));
  if (missing.length) {
    const vals = await keep.hmget('fr:prof', missing);
    missing.forEach((c, i) => {
      let p = null;
      try { p = vals[i] ? JSON.parse(vals[i]) : null; } catch { p = null; }
      profiles.set(c, p); // null = unknown code, cached too
    });
    trim(profiles);
  }
  return codes.map((c) => profiles.get(c) || null);
}

function publicInfo(code, p, now = Date.now()) {
  const pr = presence.get(code);
  return {
    code,
    name: p ? p.name : 'Player',
    avatar: p ? p.avatar : 'classic',
    trophies: p ? p.trophies : 0,
    level: p ? p.level : 1,
    online: isOnline(code, now),
    busy: !!(pr && pr.busy && isOnline(code, now)),
  };
}

async function auth(req, res, ip) {
  if (!ipAllowed(ip)) { stats.refusedRate++; send(res, 429, { error: 'too_many_requests' }); return null; }
  const body = await readBody(req);
  if (!body || typeof body !== 'object') { send(res, 400, { error: 'bad_request' }); return null; }
  const code = String(body.code || '');
  let v;
  try { v = await verify(code, body.secret); } catch (e) { stats.storageErrors++; send(res, 503, { error: 'storage' }); return null; }
  if (v === 'bad') { send(res, 400, { error: 'bad_code' }); return null; }
  if (v === 'taken') { stats.refusedSecret++; send(res, 409, { error: 'code_taken' }); return null; }
  return { body, code };
}

// ---------------------------------------------------------------- handlers

async function hello(req, res, ip) {
  const a = await auth(req, res, ip);
  if (!a) return;
  const { body, code } = a;
  const now = Date.now();
  const pr = presence.get(code);
  if (pr && now - pr.hello < MIN_HELLO_GAP_MS) { stats.refusedRate++; return send(res, 429, { error: 'too_soon' }); }
  presence.set(code, { seen: now, busy: !!body.busy, hello: now });
  stats.hellos++;
  noteHello(now);
  try {
    // my own card, as friends will see it
    const me = { name: cleanName(body.name), avatar: cleanAvatar(body.avatar), trophies: int(body.trophies, 1e7), level: int(body.level, 1000) || 1 };
    const js = JSON.stringify(me);
    if (profJson.get(code) !== js) {
      await keep.hset('fr:prof', code, js);
      profJson.set(code, js);
      trim(profJson);
    }
    profiles.set(code, me);

    // my friends
    const list = Array.isArray(body.friends)
      ? [...new Set(body.friends.map(String).filter((c) => CODE_RE.test(c) && c !== code))].slice(0, MAX_FRIENDS)
      : [];
    lists.set(code, new Set(list));
    trim(lists);
    const ps = await profilesFor(list);
    const friends = {};
    list.forEach((c, i) => { friends[c] = publicInfo(c, ps[i], now); });

    // waiting invites (newest first, still fresh)
    const out = [];
    const mine = invites.get(code);
    if (mine && body.busy) {
      // they're in a match now: tell the inviters at once
      for (const [from] of mine) {
        const list = answers.get(from) || [];
        if (list.length < MAX_INBOX) list.push({ from: code, answer: 'busy', at: now });
        answers.set(from, list);
      }
      invites.delete(code);
    } else if (mine) {
      for (const [from, inv] of mine) {
        if (now - inv.at > INVITE_MS) continue;
        const p = profiles.get(from);
        out.push({ from, room: inv.room, name: p ? p.name : 'Player', avatar: p ? p.avatar : 'classic', trophies: p ? p.trophies : 0, age: Math.round((now - inv.at) / 1000) });
      }
    }

    // people who added me
    let added = [];
    const notes = {};
    if (!inboxRead.has(code)) {
      Object.assign(notes, await keep.hgetall('fr:add:' + code));
      inboxRead.add(code);
      trim(inboxRead);
    }
    const pend = addsPending.get(code);
    if (pend) for (const [from, at] of pend) notes[from] = String(at);
    const fromCodes = Object.keys(notes).filter((c) => CODE_RE.test(c)).slice(0, MAX_INBOX);
    if (fromCodes.length) {
      const fps = await profilesFor(fromCodes);
      added = fromCodes.map((c, i) => publicInfo(c, fps[i], now));
      await keep.hdel('fr:add:' + code, Object.keys(notes));
      addsPending.delete(code);
    }

    // answers to my invites
    const ans = (answers.get(code) || []).map((x) => ({ from: x.from, answer: x.answer }));
    answers.delete(code);

    send(res, 200, { ok: true, friends, invites: out, added, answers: ans, slow });
  } catch (e) {
    stats.storageErrors++;
    send(res, 503, { error: 'storage' });
  }
}

async function add(req, res, ip) {
  const a = await auth(req, res, ip);
  if (!a) return;
  const { body, code } = a;
  const friend = String(body.friend || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!CODE_RE.test(friend)) return send(res, 400, { error: 'bad_friend_code' });
  if (friend === code) return send(res, 400, { error: 'self' });
  const now = Date.now();
  let e = addCounts.get(code);
  if (!e || now - e.start >= 3600000) { e = { n: 0, start: now }; addCounts.set(code, e); }
  if (++e.n > MAX_ADDS_PER_HOUR) { stats.refusedRate++; return send(res, 429, { error: 'too_many_adds' }); }
  try {
    const [p] = await profilesFor([friend]);
    if (!p) return send(res, 404, { error: 'not_found' });
    if (!recentAdds.has(friend)) recentAdds.set(friend, new Map());
    recentAdds.get(friend).set(code, now);
    trim(recentAdds);
    // tell them (kept in storage until their game picks it up)
    await keep.hset('fr:add:' + friend, code, String(now));
    if (inboxRead.has(friend)) {
      if (!addsPending.has(friend)) addsPending.set(friend, new Map());
      addsPending.get(friend).set(code, now);
    }
    stats.adds++;
    send(res, 200, { ok: true, friend: publicInfo(friend, p, now) });
  } catch (err) {
    stats.storageErrors++;
    send(res, 503, { error: 'storage' });
  }
}

async function invite(req, res, ip) {
  const a = await auth(req, res, ip);
  if (!a) return;
  const { body, code } = a;
  const to = String(body.to || '');
  const room = String(body.room || '');
  if (!CODE_RE.test(to) || to === code) return send(res, 400, { error: 'bad_friend_code' });
  if (!ROOM_RE.test(room)) return send(res, 400, { error: 'bad_room' });
  const now = Date.now();
  if (now - (lastInvite.get(code) || 0) < MIN_INVITE_GAP_MS) { stats.refusedRate++; return send(res, 429, { error: 'too_soon' }); }
  lastInvite.set(code, now);
  // only someone on their friends list (or who just added them) may invite them
  const theirs = lists.get(to);
  const added = recentAdds.get(to);
  const known = (theirs && theirs.has(code)) || (added && now - (added.get(code) || 0) < 15 * 60 * 1000);
  if (!known) return send(res, 403, { error: 'not_friends' });
  if (!roomCheck(room)) return send(res, 409, { error: 'no_room' });
  if (!isOnline(to, now)) return send(res, 409, { error: 'offline' });
  const pr = presence.get(to);
  if (pr && pr.busy) return send(res, 409, { error: 'busy' });
  if (!invites.has(to)) invites.set(to, new Map());
  const m = invites.get(to);
  if (m.size >= MAX_INBOX && !m.has(code)) return send(res, 429, { error: 'too_many' });
  m.set(code, { room, at: now });
  stats.invites++;
  send(res, 200, { ok: true });
}

async function answer(req, res, ip) {
  const a = await auth(req, res, ip);
  if (!a) return;
  const { body, code } = a;
  const to = String(body.to || '');
  if (!CODE_RE.test(to)) return send(res, 400, { error: 'bad_friend_code' });
  const ans = ['yes', 'busy'].includes(body.answer) ? body.answer : 'no';
  // the invite I (code) got from them (to)
  const m = invites.get(code);
  const had = !!(m && m.delete(to));
  if (m && !m.size) invites.delete(code);
  if (had) {
    if (ans === 'yes') stats.accepted++; else if (ans === 'no') stats.declined++;
    const list = answers.get(to) || [];
    if (list.length < MAX_INBOX) list.push({ from: code, answer: ans, at: Date.now() });
    answers.set(to, list);
  }
  send(res, 200, { ok: true });
}

async function cancel(req, res, ip) {
  const a = await auth(req, res, ip);
  if (!a) return;
  const { body, code } = a;
  const to = String(body.to || '');
  const m = invites.get(to);
  if (m) { m.delete(code); if (!m.size) invites.delete(to); }
  send(res, 200, { ok: true });
}

// Returns true when it handled the request.
function handle(req, res, ip) {
  const path = String(req.url || '').split('?')[0];
  if (!path.startsWith('/fr/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    res.end();
    return true;
  }
  if (req.method !== 'POST') { send(res, 405, { error: 'method_not_allowed' }); return true; }
  const run = { '/fr/hello': hello, '/fr/add': add, '/fr/invite': invite, '/fr/answer': answer, '/fr/cancel': cancel }[path];
  if (!run) { send(res, 404, { error: 'not_found' }); return true; }
  run(req, res, ip).catch(() => { try { send(res, 500, { error: 'server' }); } catch { /* sent */ } });
  return true;
}

function setRoomCheck(fn) { roomCheck = fn; }

function info() {
  let online = 0;
  const now = Date.now();
  for (const p of presence.values()) if (now - p.seen <= ONLINE_MS) online++;
  return { storage: keep.kind, online, slow, ...stats };
}

module.exports = { handle, info, setRoomCheck, CODE_RE };
