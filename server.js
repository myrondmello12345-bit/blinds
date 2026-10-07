// BLINDS relay server (v58).
// A tiny WebSocket relay: pairs two players (by room code or quick-match) and
// forwards small "game" packets between them. It never stores or inspects
// game state - the host device is authoritative for that.
//
// v16 hardening:
//  - every inbound packet is validated (a bare `null` used to crash the process)
//  - only whitelisted game "kind"s are relayed, payloads are capped (4 KB since v57)
//  - per-socket rate limit (a flood closes the socket, it can't hurt others)
//  - a room is torn down as soon as either player leaves, so a stranger who
//    knows the code can never slip into a match that is already running
//  - process-level safety net so one bad handler can't take every match down
//
// v57 hardening (after a load + attack test with thousands of simulated players):
//  - a ceiling on total connections and on connections per address, checked
//    BEFORE the WebSocket handshake, so the server can't be filled until it
//    runs out of memory
//  - idle rules: a socket that connects and does nothing is closed after 30 s;
//    a host waiting alone, a player stuck in the queue and a silent room are
//    closed after a while too
//  - slow-reader protection: if a player stops reading, the data queued for
//    them is capped and they are dropped instead of the server hoarding it
//  - a bytes-per-second budget next to the messages-per-second one
//  - wrong room codes are counted; guessing gets the socket (and, briefly,
//    the address) shut out
//  - create / join / quick-match can't be spammed
//  - sign-in requests are limited per address, so a spammer can no longer
//    push real players' pending sign-ins out
//  - short timeouts for half-open web requests
//  - /health reports live numbers; a line is logged every minute while busy
//  - on shutdown (every Render deploy) players are told at once, so their bot
//    takes over immediately instead of after a heartbeat timeout
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const pages = require('./pages');

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const PORT = Number(process.env.PORT || 8080);
const MAX_PAYLOAD_BYTES = 4 * 1024;      // the biggest real packet measured is under 300 bytes
const MAX_MSGS_PER_SECOND = 40;   // real traffic is a handful of packets per second
const MAX_BYTES_PER_SECOND = 16 * 1024; // a real player's busiest second measured is about 1.3 KB
const MAX_STRIKES = 3;            // seconds over the limit before we hang up
// Sized for Render's smallest instance (0.1 CPU, 512 MB). Raise MAX_CONNECTIONS
// with an environment variable on a bigger instance.
const MAX_CONNECTIONS = num('MAX_CONNECTIONS', 5000);
const MAX_PER_IP = num('MAX_PER_IP', 40);
const MAX_NEW_PER_IP_PER_MIN = num('MAX_NEW_PER_IP_PER_MIN', 120);
const MAX_TRACKED_ADDRESSES = 20000;
const MAX_BUFFERED_BYTES = 256 * 1024;  // data queued for one slow reader
const MAX_BAD_JOINS = 8;                // wrong codes on one socket
const MAX_BAD_JOINS_PER_IP_PER_MIN = 40;
const MAX_CONTROL_PER_MIN = 30;         // create / join / quick-match on one socket
const MAX_AUTH_STARTS_PER_IP_PER_MIN = 10;
const IDLE_NO_ACTION_MS = 30 * 1000;        // connected, never asked for anything
const IDLE_QUEUE_MS = 5 * 60 * 1000;        // waiting for a quick match (the game gives up after ~25 s)
const IDLE_HOST_ALONE_MS = 20 * 60 * 1000;  // waiting for a friend to type the code
const IDLE_ROOM_SILENT_MS = 10 * 60 * 1000; // two players, nothing sent
const ALLOWED_KINDS = new Set([
  'client_board', 'call', 'call_result', 'game_begin', 'sync',
  'pause_request', 'pause_start', 'resume', 'emote', 'rematch', 'rematch_begin',
  'intro_profile', 'board_rejected',
]);

const rooms = new Map(); // code -> { host, client, lastActive }
let waitingForMatch = null; // a single socket waiting for a "fully online" opponent, or null
const perIp = new Map();    // address -> { open, newCount, badJoins, authStarts, windowStart }
const stats = { startedAt: Date.now(), peak: 0, accepted: 0, refusedFull: 0, refusedIp: 0, kickedIdle: 0, kickedSlow: 0, kickedRate: 0, kickedGuessing: 0, relayed: 0, matches: 0 };
let shuttingDown = false;

process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

function code() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  let out = '';
  do {
    out = '';
    for (let i = 0; i < 6; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  } while (rooms.has(out));
  return out;
}

// The player's address. Behind Render (and its Cloudflare front) the socket's
// own address is the proxy, so the forwarded headers are used when present.
function ipOf(req) {
  const h = req.headers || {};
  const pick = h['cf-connecting-ip'] || h['true-client-ip'] || String(h['x-forwarded-for'] || '').split(',')[0];
  const ip = String(pick || '').trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  return ip.slice(0, 64);
}

function ipEntry(ip) {
  let e = perIp.get(ip);
  const now = Date.now();
  if (!e) {
    // The table itself must not become a way to use up memory.
    if (perIp.size >= MAX_TRACKED_ADDRESSES) {
      for (const [k, v] of perIp) if (v.open <= 0) perIp.delete(k);
    }
    e = { open: 0, newCount: 0, badJoins: 0, authStarts: 0, windowStart: now };
    perIp.set(ip, e);
  }
  if (now - e.windowStart >= 60000) { e.newCount = 0; e.badJoins = 0; e.authStarts = 0; e.windowStart = now; }
  return e;
}

function send(ws, packet) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  // A player who has stopped reading must not make the server hold their data.
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    stats.kickedSlow += 1;
    ws.terminate();
    return;
  }
  ws.send(JSON.stringify(packet));
}

// Closes a socket once and counts why. Packets that were already on their
// way in when it was closed are ignored (see the top of handleMessage).
function kick(ws, reason, closeCode, text) {
  if (ws.kicked) return;
  ws.kicked = true;
  stats[reason] += 1;
  ws.close(closeCode, text);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Removes a socket from the queue / its room. When either player leaves, the
// room is closed and the other player is told.
function removeSocket(ws) {
  if (waitingForMatch === ws) waitingForMatch = null;
  const roomCode = ws.roomCode;
  ws.roomCode = null;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  const other = room.host === ws ? room.client : (room.client === ws ? room.host : null);
  rooms.delete(roomCode);
  if (other) {
    other.roomCode = null;
    other.lastAction = Date.now(); // they get the normal 30 s to do something next
    send(other, { type: 'opponent_left' });
  }
}

function handleMessage(ws, buf) {
  if (ws.kicked) return;
  // --- rate limit -------------------------------------------------------
  const now = Date.now();
  if (now - ws.windowStart >= 1000) {
    if (ws.msgCount > MAX_MSGS_PER_SECOND || ws.byteCount > MAX_BYTES_PER_SECOND) ws.strikes += 1; else ws.strikes = Math.max(0, ws.strikes - 1);
    ws.windowStart = now;
    ws.msgCount = 0;
    ws.byteCount = 0;
  }
  ws.msgCount += 1;
  ws.byteCount += buf.length;
  if (ws.msgCount > MAX_MSGS_PER_SECOND || ws.byteCount > MAX_BYTES_PER_SECOND) {
    if (ws.strikes + 1 >= MAX_STRIKES) return kick(ws, 'kickedRate', 1008, 'rate limit');
    return; // drop the excess packet silently
  }

  // --- parse + shape check ---------------------------------------------
  let p;
  try { p = JSON.parse(buf.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid packet' }); }
  if (!isPlainObject(p) || typeof p.type !== 'string') return send(ws, { type: 'error', message: 'Invalid packet' });

  // --- create / join / quick-match can't be spammed ----------------------
  if (p.type === 'create_room' || p.type === 'join_room' || p.type === 'quick_match') {
    if (now - ws.controlWindow >= 60000) { ws.controlWindow = now; ws.controlCount = 0; }
    ws.controlCount += 1;
    if (ws.controlCount > MAX_CONTROL_PER_MIN) return kick(ws, 'kickedRate', 1008, 'too many requests');
    ws.lastAction = now;
  }

  switch (p.type) {
    case 'create_room': {
      removeSocket(ws);
      const roomCode = code();
      rooms.set(roomCode, { host: ws, client: null, lastActive: now });
      ws.roomCode = roomCode;
      return send(ws, { type: 'room_created', code: roomCode });
    }

    case 'join_room': {
      removeSocket(ws);
      const roomCode = typeof p.code === 'string' ? p.code.trim().toUpperCase() : '';
      const ipInfo = ipEntry(ws.ip);
      const blocked = ipInfo.badJoins >= MAX_BAD_JOINS_PER_IP_PER_MIN;
      const room = !blocked && /^[A-Z0-9]{6}$/.test(roomCode) ? rooms.get(roomCode) : null;
      if (!room || room.client) {
        // Wrong or full code. A few typos are fine; guessing is not.
        ws.badJoins += 1;
        ipInfo.badJoins += 1;
        send(ws, { type: 'error', message: 'Room unavailable' });
        if (ws.badJoins > MAX_BAD_JOINS) kick(ws, 'kickedGuessing', 1008, 'too many wrong codes');
        return;
      }
      room.client = ws;
      room.lastActive = now;
      ws.roomCode = roomCode;
      stats.matches += 1;
      send(ws, { type: 'room_joined', code: roomCode });
      return send(room.host, { type: 'opponent_joined' });
    }

    case 'quick_match': {
      removeSocket(ws);
      if (waitingForMatch && waitingForMatch.readyState === waitingForMatch.OPEN) {
        // Someone's already waiting - pair the two of them into a room.
        const host = waitingForMatch;
        const client = ws;
        waitingForMatch = null;
        const roomCode = code();
        rooms.set(roomCode, { host, client, lastActive: now });
        host.roomCode = roomCode;
        client.roomCode = roomCode;
        stats.matches += 1;
        send(host, { type: 'room_created', code: roomCode });
        send(host, { type: 'opponent_joined' });
        send(client, { type: 'room_joined', code: roomCode });
        return;
      }
      // Nobody's waiting yet - park here until someone else quick-matches.
      waitingForMatch = ws;
      return send(ws, { type: 'waiting_for_match' });
    }

    case 'game': {
      if (typeof p.kind !== 'string' || !ALLOWED_KINDS.has(p.kind)) return; // unknown kinds are dropped
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room) return send(ws, { type: 'error', message: 'Not in a room' });
      room.lastActive = now;
      const other = room.host === ws ? room.client : room.host;
      if (other) { stats.relayed += 1; send(other, { type: 'game', kind: p.kind, data: isPlainObject(p.data) ? p.data : {} }); }
      return;
    }

    case 'leave': {
      removeSocket(ws);
      return ws.close();
    }

    default:
      return; // ignore unknown packet types
  }
}

function health() {
  return {
    ok: !shuttingDown,
    players: wss.clients.size,
    rooms: rooms.size,
    waitingForMatch: waitingForMatch ? 1 : 0,
    limit: MAX_CONNECTIONS,
    peakPlayers: stats.peak,
    matchesStarted: stats.matches,
    refusedServerFull: stats.refusedFull,
    refusedPerAddress: stats.refusedIp,
    kickedIdle: stats.kickedIdle,
    kickedSlow: stats.kickedSlow,
    kickedRate: stats.kickedRate,
    kickedGuessing: stats.kickedGuessing,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    addressesTracked: perIp.size,
    uptimeMinutes: Math.round((Date.now() - stats.startedAt) / 60000),
  };
}

// Half-open or stalled web requests are dropped quickly instead of being held.
const server = http.createServer({
  headersTimeout: 10000,
  requestTimeout: 15000,
  keepAliveTimeout: 5000,
  connectionsCheckingInterval: 3000,
}, (req, res) => {
  const path = String(req.url || '').split('?')[0];
  if (path === '/auth/start') {
    const e = ipEntry(ipOf(req));
    e.authStarts += 1;
    if (e.authStarts > MAX_AUTH_STARTS_PER_IP_PER_MIN) {
      res.writeHead(429, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'retry-after': '60' });
      return res.end(JSON.stringify({ error: 'too_many_requests' }));
    }
  }
  if (auth.handle(req, res)) return;
  if (pages.handle(req, res)) return; // /about, /privacy, /terms
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(health()));
  }
  // Also serves as the health check / "wake-up" endpoint the game pings.
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('BLINDS relay is running.\n');
});
server.maxConnections = MAX_CONNECTIONS + 3000;

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });

function refuse(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* already gone */ }
  socket.destroy();
}

// Limits are checked here, before the handshake, so a refused connection
// costs almost nothing.
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  if (String(req.url || '').split('?')[0] !== '/ws') return refuse(socket, 404, 'Not Found');
  if (shuttingDown) return refuse(socket, 503, 'Service Unavailable');
  if (wss.clients.size >= MAX_CONNECTIONS) { stats.refusedFull += 1; return refuse(socket, 503, 'Service Unavailable'); }
  const ip = ipOf(req);
  const e = ipEntry(ip);
  e.newCount += 1;
  if (e.open >= MAX_PER_IP || e.newCount > MAX_NEW_PER_IP_PER_MIN) { stats.refusedIp += 1; return refuse(socket, 429, 'Too Many Requests'); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.ip = ip;
    e.open += 1;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const now = Date.now();
  ws.roomCode = null;
  ws.isAlive = true;
  ws.windowStart = now;
  ws.msgCount = 0;
  ws.byteCount = 0;
  ws.strikes = 0;
  ws.badJoins = 0;
  ws.controlWindow = now;
  ws.controlCount = 0;
  ws.lastAction = now;
  ws.queuedAt = 0;
  stats.accepted += 1;
  if (wss.clients.size > stats.peak) stats.peak = wss.clients.size;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    try {
      handleMessage(ws, buf);
    } catch (err) {
      console.error('handler error:', err);
      send(ws, { type: 'error', message: 'Server error' });
    }
  });

  let counted = true;
  const gone = () => {
    removeSocket(ws);
    if (counted) {
      counted = false;
      const e = perIp.get(ws.ip);
      if (e) e.open = Math.max(0, e.open - 1);
    }
  };
  ws.on('close', gone);
  ws.on('error', gone);
});

setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();

    // --- idle rules ---
    if (ws.readyState !== ws.OPEN) continue; // already closing
    let idle = false;
    if (!ws.roomCode) {
      if (waitingForMatch === ws) idle = now - ws.lastAction > IDLE_QUEUE_MS;
      else idle = now - ws.lastAction > IDLE_NO_ACTION_MS;
    } else {
      const room = rooms.get(ws.roomCode);
      if (room && !room.client) idle = now - room.lastActive > IDLE_HOST_ALONE_MS;
      else if (room) idle = now - room.lastActive > IDLE_ROOM_SILENT_MS;
    }
    if (idle) kick(ws, 'kickedIdle', 1000, 'idle');
  }
}, 5000); // v40: a silently dead player is noticed within ~10 s, so their bot takes over quickly

// Forget addresses with nothing open, and say how busy the server is.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of perIp) if (e.open <= 0 && now - e.windowStart > 120000) perIp.delete(ip);
  if (wss.clients.size > 0) console.log('status ' + JSON.stringify(health()));
}, 60000);

// Render sends SIGTERM on every deploy. Tell players straight away.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutting down: closing ' + wss.clients.size + ' connections');
  for (const ws of wss.clients) { try { ws.close(1012, 'server restarting'); } catch { /* ignore */ } }
  server.close();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BLINDS relay listening on port ${PORT} (limit ${MAX_CONNECTIONS} players, ${MAX_PER_IP} per address)`);
});
