// BLINDS relay server (v16).
// A tiny WebSocket relay: pairs two players (by room code or quick-match) and
// forwards small "game" packets between them. It never stores or inspects
// game state - the host device is authoritative for that.
//
// v16 hardening:
//  - every inbound packet is validated (a bare `null` used to crash the process)
//  - only whitelisted game "kind"s are relayed, payloads are capped at 16 KB
//  - per-socket rate limit (a flood closes the socket, it can't hurt others)
//  - a room is torn down as soon as either player leaves, so a stranger who
//    knows the code can never slip into a match that is already running
//  - process-level safety net so one bad handler can't take every match down
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 8080);
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_MSGS_PER_SECOND = 40;   // real traffic is a handful of packets per second
const MAX_STRIKES = 3;            // seconds over the limit before we hang up
const ALLOWED_KINDS = new Set([
  'client_board', 'call', 'call_result', 'game_begin', 'sync',
  'pause_request', 'pause_start', 'resume', 'emote', 'rematch', 'rematch_begin',
  'intro_profile', 'board_rejected',
]);

const rooms = new Map(); // code -> { host, client }
let waitingForMatch = null; // a single socket waiting for a "fully online" opponent, or null

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

function send(ws, packet) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(packet));
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
    send(other, { type: 'opponent_left' });
  }
}

function handleMessage(ws, buf) {
  // --- rate limit -------------------------------------------------------
  const now = Date.now();
  if (now - ws.windowStart >= 1000) {
    if (ws.msgCount > MAX_MSGS_PER_SECOND) ws.strikes += 1; else ws.strikes = Math.max(0, ws.strikes - 1);
    ws.windowStart = now;
    ws.msgCount = 0;
  }
  ws.msgCount += 1;
  if (ws.msgCount > MAX_MSGS_PER_SECOND) {
    if (ws.strikes + 1 >= MAX_STRIKES) return ws.close(1008, 'rate limit');
    return; // drop the excess packet silently
  }

  // --- parse + shape check ---------------------------------------------
  let p;
  try { p = JSON.parse(buf.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid packet' }); }
  if (!isPlainObject(p) || typeof p.type !== 'string') return send(ws, { type: 'error', message: 'Invalid packet' });

  switch (p.type) {
    case 'create_room': {
      removeSocket(ws);
      const roomCode = code();
      rooms.set(roomCode, { host: ws, client: null });
      ws.roomCode = roomCode;
      return send(ws, { type: 'room_created', code: roomCode });
    }

    case 'join_room': {
      removeSocket(ws);
      const roomCode = typeof p.code === 'string' ? p.code.trim().toUpperCase() : '';
      const room = /^[A-Z0-9]{6}$/.test(roomCode) ? rooms.get(roomCode) : null;
      if (!room || room.client) return send(ws, { type: 'error', message: 'Room unavailable' });
      room.client = ws;
      ws.roomCode = roomCode;
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
        rooms.set(roomCode, { host, client });
        host.roomCode = roomCode;
        client.roomCode = roomCode;
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
      const other = room.host === ws ? room.client : room.host;
      if (other) send(other, { type: 'game', kind: p.kind, data: isPlainObject(p.data) ? p.data : {} });
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

const server = http.createServer((req, res) => {
  if (auth.handle(req, res)) return;
  // Also serves as the health check / "wake-up" endpoint the game pings.
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('BLINDS relay is running.\n');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.isAlive = true;
  ws.windowStart = Date.now();
  ws.msgCount = 0;
  ws.strikes = 0;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    try {
      handleMessage(ws, buf);
    } catch (err) {
      console.error('handler error:', err);
      send(ws, { type: 'error', message: 'Server error' });
    }
  });

  ws.on('close', () => removeSocket(ws));
  ws.on('error', () => removeSocket(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000); // v40: a silently dead player is noticed within ~10 s, so their bot takes over quickly

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BLINDS relay listening on port ${PORT}`);
});
