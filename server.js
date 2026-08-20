const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// roomId -> array of ws clients (max 2)
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.room = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const roomId = String(msg.room || '').slice(0, 64);
      if (!roomId) return;

      const peers = rooms.get(roomId) || [];
      if (peers.length >= 2) {
        send(ws, { type: 'room-full' });
        return;
      }

      ws.delay = Number(msg.delay) || 0;

      const isInitiator = peers.length === 1;
      const existing = peers[0];
      peers.push(ws);
      rooms.set(roomId, peers);
      ws.room = roomId;

      send(ws, { type: 'joined', initiator: isInitiator, peerDelay: existing ? existing.delay : undefined });

      if (isInitiator) {
        send(existing, { type: 'peer-joined', peerDelay: ws.delay });
      }
      return;
    }

    if (msg.type === 'delay-change') {
      ws.delay = Number(msg.delay) || 0;
    }

    // Relay signaling messages (offer/answer/ice-candidate/delay-change) to the other peer in the room
    if (['offer', 'answer', 'ice-candidate', 'delay-change'].includes(msg.type)) {
      const peers = rooms.get(ws.room) || [];
      const other = peers.find((p) => p !== ws);
      if (other) send(other, msg);
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const peers = rooms.get(ws.room) || [];
    const remaining = peers.filter((p) => p !== ws);
    if (remaining.length > 0) {
      send(remaining[0], { type: 'peer-left' });
      rooms.set(ws.room, remaining);
    } else {
      rooms.delete(ws.room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Delay Video running at http://localhost:${PORT}`);
});
