const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const rooms = new Map(); // code -> { host, client }

function code() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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

function removeSocket(ws) {
  const roomCode = ws.roomCode;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.host === ws) {
    if (room.client) send(room.client, { type: 'opponent_left' });
    rooms.delete(roomCode);
  } else if (room.client === ws) {
    if (room.host) send(room.host, { type: 'opponent_left' });
    room.client = null;
  }
  ws.roomCode = null;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('BLINDS relay is running.\n');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    let p;
    try { p = JSON.parse(buf.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid packet' }); }

    if (p.type === 'create_room') {
      removeSocket(ws);
      const roomCode = code();
      rooms.set(roomCode, { host: ws, client: null });
      ws.roomCode = roomCode;
      return send(ws, { type: 'room_created', code: roomCode });
    }

    if (p.type === 'join_room') {
      removeSocket(ws);
      const roomCode = String(p.code || '').trim().toUpperCase();
      const room = rooms.get(roomCode);
      if (!room || room.client) return send(ws, { type: 'error', message: 'Room unavailable' });
      room.client = ws;
      ws.roomCode = roomCode;
      send(ws, { type: 'room_joined', code: roomCode });
      return send(room.host, { type: 'opponent_joined' });
    }

    if (p.type === 'game') {
      const room = rooms.get(ws.roomCode);
      if (!room) return send(ws, { type: 'error', message: 'Not in a room' });
      const other = room.host === ws ? room.client : room.host;
      if (other) send(other, { type: 'game', kind: p.kind, data: p.data || {} });
      return;
    }

    if (p.type === 'leave') {
      removeSocket(ws);
      return ws.close();
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
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BLINDS relay listening on port ${PORT}`);
});
