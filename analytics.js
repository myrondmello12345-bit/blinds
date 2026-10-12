// BLINDS usage stats (v61).
//
//   POST /a/batch   {iid, v, lang, events: [{e, k?, d?}]}
//        -> {ok}
//   GET  /stats?key=STATS_KEY        a dashboard page (last 30 days)
//   GET  /stats.json?key=STATS_KEY   the same numbers as JSON
//
// Privacy by design: the server keeps COUNTS per day, nothing per player.
// The game sends a random install id only so one device's flood can be
// limited; it is never stored. Retention works without storing ids too:
// once a day the game itself reports "I was installed N days ago", and the
// server adds one to that install-day's day-N counter.
//
// Storage: the same Upstash Redis database as the leaderboard when
// UPSTASH_REDIS_REST_URL / _TOKEN are set (counts are added up in memory
// and written every 30 s, so it uses very few Upstash commands). Without
// them the counts live in memory and are wiped on restart.
//
// The dashboard is off until you set STATS_KEY (any long password) in Render.

const EVENTS = new Set([
  'first_open', 'day_active', 'session', 'session_end', 'screen',
  'tutorial_start', 'tutorial_done', 'tutorial_skip',
  'match_start', 'match_end', 'match_quit', 'first_match', 'first_win',
  'daily_start', 'daily_done', 'daily_fail',
  'level_up', 'shop_buy', 'gem_buy', 'iap_start', 'iap_done',
  'signin', 'lb_open', 'settings', 'review_prompt', 'reminder_on', 'reminder_off',
  'chat_quick', 'chat_typed', 'lang',
]);
const MAX_EVENTS = 60;
const MAX_BODY = 8192;
const MAX_BATCHES_PER_IP_PER_MIN = 30;
const MAX_BATCHES_PER_IID_PER_MIN = 6;
const MAX_FIELDS_PER_DAY = 3000;     // stops someone filling storage with junk labels
const FLUSH_MS = 30 * 1000;
const KEEP_DAYS = 400;
const RET_DAYS = [1, 2, 3, 7, 14, 30];

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const okLabel = (k) => typeof k === 'string' && /^[a-z0-9_]{1,24}$/.test(k);

// ---------------------------------------------------------------- storage

class MemoryCounts {
  constructor() { this.kind = 'memory'; this.days = new Map(); this.ret = new Map(); }
  async add(dayInc, retInc) {
    for (const [d, fields] of dayInc) {
      let h = this.days.get(d); if (!h) { h = new Map(); this.days.set(d, h); }
      for (const [f, n] of fields) h.set(f, (h.get(f) || 0) + n);
    }
    for (const [d, fields] of retInc) {
      let h = this.ret.get(d); if (!h) { h = new Map(); this.ret.set(d, h); }
      for (const [f, n] of fields) h.set(f, (h.get(f) || 0) + n);
    }
    // keep memory bounded
    const cutoff = day(Date.now() - KEEP_DAYS * 86400000);
    for (const m of [this.days, this.ret]) for (const k of m.keys()) if (k < cutoff) m.delete(k);
  }
  async read(days) {
    const out = {};
    for (const d of days) out[d] = { day: Object.fromEntries(this.days.get(d) || []), ret: Object.fromEntries(this.ret.get(d) || []) };
    return out;
  }
  fieldCount(d) { const h = this.days.get(d); return h ? h.size : 0; }
}

class UpstashCounts {
  constructor(url, token) { this.url = url.replace(/\/+$/, ''); this.token = token; this.kind = 'upstash'; this.fields = new Map(); }
  async cmd(list) {
    const r = await fetch(this.url + '/pipeline', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
      body: JSON.stringify(list),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('upstash ' + r.status);
    const out = await r.json();
    return out.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
  }
  async add(dayInc, retInc) {
    const list = [];
    const ttl = String(KEEP_DAYS * 86400);
    for (const [d, fields] of dayInc) {
      for (const [f, n] of fields) list.push(['HINCRBY', 'a:d:' + d, f, String(n)]);
      list.push(['EXPIRE', 'a:d:' + d, ttl]);
    }
    for (const [d, fields] of retInc) {
      for (const [f, n] of fields) list.push(['HINCRBY', 'a:r:' + d, f, String(n)]);
      list.push(['EXPIRE', 'a:r:' + d, ttl]);
    }
    for (let i = 0; i < list.length; i += 400) await this.cmd(list.slice(i, i + 400));
  }
  async read(days) {
    const list = [];
    for (const d of days) { list.push(['HGETALL', 'a:d:' + d]); list.push(['HGETALL', 'a:r:' + d]); }
    const res = await this.cmd(list);
    const pairs = (arr) => { const o = {}; for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0; return o; };
    const out = {};
    days.forEach((d, i) => { out[d] = { day: pairs(res[i * 2]), ret: pairs(res[i * 2 + 1]) }; });
    return out;
  }
  fieldCount(d) { return this.fields.get(d) || 0; }
}

const counts = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new UpstashCounts(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN)
  : new MemoryCounts();

// pending increments, written every FLUSH_MS
let pendDay = new Map();   // day -> Map(field -> n)
let pendRet = new Map();   // install day -> Map('d'+n -> n)
const seenFields = new Map(); // day -> Set(field)  (caps distinct labels per day)
const stats = { batches: 0, events: 0, refusedRate: 0, refusedBad: 0, flushErrors: 0, droppedFields: 0 };

function inc(map, d, f, n = 1) {
  let h = map.get(d); if (!h) { h = new Map(); map.set(d, h); }
  h.set(f, (h.get(f) || 0) + n);
}

function allowField(d, f) {
  let s = seenFields.get(d);
  if (!s) {
    s = new Set();
    seenFields.set(d, s);
    for (const k of seenFields.keys()) if (k < day(Date.now() - 3 * 86400000)) seenFields.delete(k);
  }
  if (s.has(f)) return true;
  if (s.size >= MAX_FIELDS_PER_DAY) { stats.droppedFields++; return false; }
  s.add(f);
  return true;
}

let flushing = false;
async function flush() {
  if (flushing || (pendDay.size === 0 && pendRet.size === 0)) return;
  flushing = true;
  const d = pendDay, r = pendRet;
  pendDay = new Map(); pendRet = new Map();
  try {
    await counts.add(d, r);
  } catch (err) {
    stats.flushErrors++;
    console.error('analytics storage error:', err.message);
    // put them back so a short outage loses nothing
    for (const [k, h] of d) for (const [f, n] of h) inc(pendDay, k, f, n);
    for (const [k, h] of r) for (const [f, n] of h) inc(pendRet, k, f, n);
  } finally { flushing = false; }
}
const timer = setInterval(flush, FLUSH_MS);
timer.unref();

// ---------------------------------------------------------------- limits

const ipCounts = new Map();
const iidCounts = new Map();
function under(map, key, max) {
  const now = Date.now();
  let e = map.get(key);
  if (!e || now - e.start >= 60000) { e = { n: 0, start: now }; map.set(key, e); }
  e.n += 1;
  if (map.size > 50000) for (const [k, v] of map) if (now - v.start >= 60000) map.delete(k);
  return e.n <= max;
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

// Takes one batch and turns it into counter increments.
function ingest(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.events)) return false;
  if (typeof body.iid !== 'string' || !/^[a-f0-9]{16,32}$/.test(body.iid)) return false;
  const today = day(now);
  const v = (typeof body.v === 'string' && /^[0-9]{1,4}$/.test(body.v)) ? body.v : '';
  const lang = okLabel(body.lang) ? body.lang : '';
  let n = 0;
  for (const ev of body.events.slice(0, MAX_EVENTS)) {
    if (!ev || typeof ev !== 'object' || !EVENTS.has(ev.e)) continue;
    n++;
    inc(pendDay, today, ev.e);
    if (okLabel(ev.k)) {
      const f = ev.e + ':' + ev.k;
      if (allowField(today, f)) inc(pendDay, today, f);
    }
    if (ev.e === 'day_active') {
      if (v && allowField(today, 'v:' + v)) inc(pendDay, today, 'v:' + v);
      if (lang && allowField(today, 'lang:' + lang)) inc(pendDay, today, 'lang:' + lang);
      // retention: "installed d days ago" -> +1 on that install day's day-d counter
      const d = Math.floor(Number(ev.d));
      if (Number.isFinite(d) && d >= 1 && d <= KEEP_DAYS) {
        const installDay = day(now - d * 86400000);
        inc(pendRet, installDay, 'd' + d);
      }
    }
    if (ev.e === 'first_open') inc(pendRet, today, 'd0');
  }
  stats.events += n;
  return true;
}

async function batch(req, res, ip) {
  if (!under(ipCounts, ip, MAX_BATCHES_PER_IP_PER_MIN)) { stats.refusedRate++; return send(res, 429, { error: 'too_many_requests' }); }
  const body = await readBody(req);
  if (body && typeof body.iid === 'string' && !under(iidCounts, body.iid, MAX_BATCHES_PER_IID_PER_MIN)) {
    stats.refusedRate++;
    return send(res, 429, { error: 'too_many_requests' });
  }
  if (!ingest(body)) { stats.refusedBad++; return send(res, 400, { error: 'bad_request' }); }
  stats.batches++;
  return send(res, 200, { ok: true });
}

function keyOk(url) {
  const want = process.env.STATS_KEY || '';
  return want.length >= 8 && url.searchParams.get('key') === want;
}

async function report() {
  await flush();
  const days = [];
  for (let i = 0; i < 30; i++) days.push(day(Date.now() - i * 86400000));
  const data = await counts.read(days);
  // include anything not yet flushed
  for (const d of days) {
    for (const [f, n] of (pendDay.get(d) || [])) data[d].day[f] = (data[d].day[f] || 0) + n;
    for (const [f, n] of (pendRet.get(d) || [])) data[d].ret[f] = (data[d].ret[f] || 0) + n;
  }
  const rows = days.map((d) => {
    const x = data[d].day, r = data[d].ret;
    const installs = r.d0 || 0;
    const ret = {};
    const age = Math.round((Date.parse(day(Date.now())) - Date.parse(d)) / 86400000);
    for (const k of RET_DAYS) ret['d' + k] = (installs && k <= age) ? Math.round(1000 * (r['d' + k] || 0) / installs) / 10 : null;
    return {
      day: d,
      active: x.day_active || 0,
      installs,
      sessions: x.session || 0,
      matches: x.match_start || 0,
      matchesPerPlayer: x.day_active ? Math.round(10 * (x.match_start || 0) / x.day_active) / 10 : 0,
      tutorialStart: x.tutorial_start || 0,
      tutorialDone: x.tutorial_done || 0,
      firstMatch: x.first_match || 0,
      firstWin: x.first_win || 0,
      dailyStart: x.daily_start || 0,
      dailyDone: x.daily_done || 0,
      retention: ret,
      all: x,
    };
  });
  return { generated: new Date().toISOString(), storage: counts.kind, days: rows };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function topFields(rows, prefix, limit = 12) {
  const sum = {};
  for (const r of rows.slice(0, 7)) for (const [f, n] of Object.entries(r.all)) if (f.startsWith(prefix)) sum[f.slice(prefix.length)] = (sum[f.slice(prefix.length)] || 0) + n;
  return Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function page(rep) {
  const pct = (v) => (v === null ? '<span class="m">-</span>' : v + '%');
  const rows = rep.days.map((r) => `<tr><td>${r.day}</td><td>${r.active}</td><td>${r.installs}</td><td>${r.sessions}</td><td>${r.matches}</td><td>${r.matchesPerPlayer}</td>` +
    `<td>${r.tutorialDone}/${r.tutorialStart}</td><td>${r.firstMatch}</td><td>${r.dailyDone}/${r.dailyStart}</td>` +
    RET_DAYS.map((k) => `<td>${pct(r.retention['d' + k])}</td>`).join('') + '</tr>').join('');
  const list = (title, pairs) => `<div class="card"><h3>${esc(title)}</h3>${pairs.length ? '<table>' + pairs.map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join('') + '</table>' : '<p class="m">nothing yet</p>'}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BLINDS stats</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;background:#10283A;color:#F4F1E8}h1{font-size:22px}table{border-collapse:collapse;width:100%}td,th{padding:5px 8px;border-bottom:1px solid #24465e;text-align:right;white-space:nowrap}td:first-child,th:first-child{text-align:left}th{color:#FFD33D;font-weight:600}.wrap{overflow-x:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}.card{background:#173B4D;border-radius:10px;padding:10px 12px}.card h3{margin:0 0 6px;font-size:15px;color:#FFD33D}.m{color:#8fb0c4}p{color:#bcd0dc}</style></head><body>
<h1>BLINDS stats</h1><p>Counts per day (UTC), newest first. Storage: ${esc(rep.storage)}. Retention = share of that day's new installs who opened the game again N days later (blank until that day has come).</p>
<div class="wrap"><table><tr><th>Day</th><th>Players</th><th>Installs</th><th>Sessions</th><th>Matches</th><th>Matches/player</th><th>Tutorial done</th><th>First match</th><th>Daily done</th>${RET_DAYS.map((k) => `<th>D${k}</th>`).join('')}</tr>${rows}</table></div>
<div class="grid">${list('Where sessions ended (7 days)', topFields(rep.days, 'session_end:'))}${list('Screens opened (7 days)', topFields(rep.days, 'screen:'))}${list('Match modes (7 days)', topFields(rep.days, 'match_start:'))}${list('Match results (7 days)', topFields(rep.days, 'match_end:'))}${list('Left mid-match (7 days)', topFields(rep.days, 'match_quit:'))}${list('Shop buys (7 days)', topFields(rep.days, 'shop_buy:'))}${list('Languages (7 days)', topFields(rep.days, 'lang:'))}${list('Game versions (7 days)', topFields(rep.days, 'v:'))}</div>
<p class="m">Generated ${esc(rep.generated)}</p></body></html>`;
}

function handle(req, res, ip) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/a/batch') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
      res.end();
      return true;
    }
    if (req.method !== 'POST') { send(res, 405, { error: 'method_not_allowed' }); return true; }
    batch(req, res, ip);
    return true;
  }
  if (p === '/stats' || p === '/stats.json') {
    if (!keyOk(url)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(process.env.STATS_KEY ? 'Not found\n' : 'Stats are off. Set STATS_KEY in the server environment to turn them on.\n');
      return true;
    }
    report().then((rep) => {
      if (p === '/stats.json') return send(res, 200, rep);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
      res.end(page(rep));
    }).catch((err) => {
      console.error('analytics report error:', err.message);
      send(res, 503, { error: 'storage_unavailable' });
    });
    return true;
  }
  return false;
}

function info() { return { storage: counts.kind, ...stats }; }

module.exports = { handle, info, flush, ingest, report, EVENTS, _counts: counts };
