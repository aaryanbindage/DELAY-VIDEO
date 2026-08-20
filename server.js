const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PEERS_PER_ROOM = 8;

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

// roomId -> Map<peerId, ws>
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.room = null;
  ws.delay = 0;

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

      const room = rooms.get(roomId) || new Map();
      if (room.size >= MAX_PEERS_PER_ROOM) {
        send(ws, { type: 'room-full' });
        return;
      }

      ws.delay = Number(msg.delay) || 0;

      // Tell the newcomer who's already here, so it can initiate a connection to each of them.
      const existingPeers = Array.from(room.values()).map((peer) => ({ id: peer.id, delay: peer.delay }));

      room.set(ws.id, ws);
      rooms.set(roomId, room);
      ws.room = roomId;

      send(ws, { type: 'joined', selfId: ws.id, peers: existingPeers });

      for (const peer of existingPeers) {
        send(room.get(peer.id), { type: 'peer-joined', id: ws.id, delay: ws.delay });
      }
      return;
    }

    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;

    if (msg.type === 'delay-change') {
      ws.delay = Number(msg.delay) || 0;
      for (const peer of room.values()) {
        if (peer !== ws) send(peer, { type: 'delay-change', from: ws.id, delay: ws.delay });
      }
      return;
    }

    // Directly-routed signaling messages (offer/answer/ice-candidate) carry a `to` peer id.
    if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
      const target = room.get(msg.to);
      if (target) send(target, { ...msg, from: ws.id });
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;

    room.delete(ws.id);
    if (room.size === 0) {
      rooms.delete(ws.room);
    } else {
      for (const peer of room.values()) {
        send(peer, { type: 'peer-left', id: ws.id });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Delay Video running at http://localhost:${PORT}`);
});
