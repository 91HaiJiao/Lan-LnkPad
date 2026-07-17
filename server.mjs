import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  MAX_MESSAGE_BYTES, MESSAGE_TYPES, normalizeRole, normalizeRoomCode,
  parseMessage, validatePayload, systemMessage
} from './shared/protocol.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2']
]);

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store'
  }));
  res.end(data);
}

function securityHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-resource-policy': 'same-origin',
    ...extra
  };
}

function generateRoomCode(rooms) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('could not allocate room code');
}

function lanAddresses(port) {
  const addresses = [];
  for (const [adapter, entries] of Object.entries(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      addresses.push({ adapter, ip: item.address, address: `${item.address}:${port}` });
    }
  }
  return addresses;
}

function safeStaticTarget(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part === '..' || part.startsWith('.'))) return null;
  let root;
  let relative;
  if (decoded === '/mobile' || decoded === '/mobile/') {
    root = path.join(PROJECT_ROOT, 'mobile'); relative = 'index.html';
  } else if (decoded.startsWith('/mobile/')) {
    root = path.join(PROJECT_ROOT, 'mobile'); relative = decoded.slice('/mobile/'.length);
  } else if (decoded.startsWith('/shared/')) {
    root = path.join(PROJECT_ROOT, 'shared'); relative = decoded.slice('/shared/'.length);
  } else if (decoded.startsWith('/desktop/')) {
    root = path.join(PROJECT_ROOT, 'desktop'); relative = decoded.slice('/desktop/'.length);
  } else {
    root = path.join(PROJECT_ROOT, 'desktop'); relative = decoded === '/' ? 'index.html' : decoded.slice(1);
  }
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) return null;
  return target;
}

function isOriginAllowed(req, allowAnyOrigin) {
  if (allowAnyOrigin) return true;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true; // native clients and file:// desktop
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'capacitor:' && parsed.hostname === 'localhost') return true;
    if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:') return true;
    const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    return parsed.hostname.toLowerCase() === requestHost || parsed.hostname === 'localhost';
  } catch { return false; }
}

export function createLanInkpadServer(options = {}) {
  const {
    heartbeatMs = 15_000,
    roomTtlMs = 30 * 60_000,
    maxConnectionsPerIp = 12,
    allowAnyOrigin = false,
    logger = console
  } = options;
  const rooms = new Map();
  const ipCounts = new Map();

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, version: '0.3.0', capabilities: ['drawing', 'webrtc-stream', 'zoom'], rooms: rooms.size });
    }
    if (requestUrl.pathname === '/api/network' && req.method === 'GET') {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 8788;
      return json(res, 200, { ok: true, version: '0.3.0', capabilities: ['drawing', 'webrtc-stream', 'zoom'], port, addresses: lanAddresses(port) });
    }
    if (requestUrl.pathname === '/api/room' && (req.method === 'POST' || req.method === 'GET')) {
      const room = generateRoomCode(rooms);
      rooms.set(room, { code: room, desktop: null, mobile: null, createdAt: Date.now(), lastActivity: Date.now() });
      return json(res, 201, { room, expiresInMs: roomTtlMs });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
    const target = safeStaticTarget(requestUrl.pathname);
    if (!target) return json(res, 400, { error: 'invalid_path' });
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      const type = MIME.get(path.extname(target).toLowerCase()) || 'application/octet-stream';
      res.writeHead(200, securityHeaders({
        'content-type': type,
        'content-length': info.size,
        'cache-control': type.startsWith('text/html') ? 'no-store' : 'no-cache'
      }));
      if (req.method === 'HEAD') return res.end();
      createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch {
      json(res, 404, { error: 'not_found' });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws' || !isOriginAllowed(req, allowAnyOrigin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const ip = req.socket.remoteAddress || 'unknown';
    if ((ipCounts.get(ip) || 0) >= maxConnectionsPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    let room, role;
    try { room = normalizeRoomCode(url.searchParams.get('room')); role = normalizeRole(url.searchParams.get('role')); }
    catch { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    const clientId = String(url.searchParams.get('clientId') || '').slice(0, 128);
    if (clientId && !/^[\w.:-]+$/.test(clientId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { room, role, clientId, ip }));
  });

  wss.on('connection', (ws, _req, identity) => {
    const { room: code, role, clientId, ip } = identity;
    let room = rooms.get(code);
    if (!room && role === 'desktop') {
      room = { code, desktop: null, mobile: null, createdAt: Date.now(), lastActivity: Date.now() };
      rooms.set(code, room);
    }
    if (!room) return ws.close(4004, 'room not found');
    if (room[role]) return ws.close(4009, `${role} already connected`);

    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    Object.assign(ws, { role, roomCode: code, clientId, isAlive: true });
    room[role] = ws; room.lastActivity = Date.now();
    const otherRole = role === 'desktop' ? 'mobile' : 'desktop';
    sendJSON(ws, systemMessage('room-state', { room: code, role, peerConnected: Boolean(room[otherRole]) }));
    if (room[otherRole]) sendJSON(room[otherRole], systemMessage('peer-joined', { role, clientId }));

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      room.lastActivity = Date.now(); ws.isAlive = true;
      if (isBinary) return closeProtocol(ws, 1003, 'binary messages unsupported');
      let message;
      try { message = validatePayload(parseMessage(data)); }
      catch (error) { return closeProtocol(ws, error instanceof RangeError ? 1009 : 1007, error.message); }
      if (!MESSAGE_TYPES.includes(message.type)) return;
      const peer = room[otherRole];
      if (peer) sendJSON(peer, { ...message, from: role, clientId, ts: Date.now() });
      else if (message.type === 'ping') sendJSON(ws, { type: 'pong', nonce: message.nonce, ts: Date.now() });
    });

    ws.once('close', () => {
      ipCounts.set(ip, Math.max(0, (ipCounts.get(ip) || 1) - 1));
      if (room[role] === ws) room[role] = null;
      room.lastActivity = Date.now();
      if (room[otherRole]) sendJSON(room[otherRole], systemMessage('peer-left', { role, clientId }));
      if (!room.desktop && !room.mobile) rooms.delete(code);
    });
    ws.on('error', (error) => logger.warn?.('websocket error:', error.message));
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else { ws.isAlive = false; ws.ping(); }
    }
    for (const [code, room] of rooms) {
      if (!room.desktop && !room.mobile && now - room.lastActivity > roomTtlMs) rooms.delete(code);
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }

  function listen(port = 8787, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
    });
  }

  return { server, wss, rooms, listen, close };
}

function sendJSON(ws, value) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(value));
}

function closeProtocol(ws, code, reason) {
  if (ws.readyState === 1) ws.close(code, String(reason).slice(0, 120));
}

export async function startServer(options = {}) {
  const app = createLanInkpadServer(options);
  const port = Number(options.port ?? process.env.PORT ?? 8788);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const address = await app.listen(port, host);
  console.log(`LAN Inkpad listening on http://${host}:${address.port}`);
  for (const item of lanAddresses(address.port)) console.log(`Phone address: http://${item.address}/mobile/`);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch((error) => { console.error(error); process.exitCode = 1; });
}
