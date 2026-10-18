import { parseClientMessage, type ServerMessage } from '@remote-assist/protocol';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerConfig } from './config.ts';
import { jsonLog, type Log } from './log.ts';
import { RateLimiter } from './rateLimit.ts';
import { Rooms, type Peer } from './rooms.ts';
import { iceServersFor } from './turn.ts';

const HEARTBEAT_MS = 30_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
// A session needs a few dozen messages (offer, answer, ICE candidates); this is far above that.
const MESSAGES_PER_WINDOW = 200;
const MESSAGE_WINDOW_MS = 10_000;

export interface SignalingServer {
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createSignalingServer(config: ServerConfig, log: Log = jsonLog): SignalingServer {
  const rooms = new Rooms({
    codeTtlMs: config.codeTtlMs,
    maxRooms: config.maxRooms,
    iceServers: () => iceServersFor(config),
    log,
  });
  const messageRate = new RateLimiter(MESSAGES_PER_WINDOW, MESSAGE_WINDOW_MS);
  const responsive = new WeakSet<WebSocket>();
  let nextSocket = 0;

  const http = createServer((request, response) => {
    if (pathOf(request) === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    } else {
      response.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  http.on('upgrade', (request, socket, head) => {
    if (pathOf(request) !== '/ws' || !originAllowed(request, config)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => attach(ws, request));
  });

  function attach(ws: WebSocket, request: IncomingMessage): void {
    const socketKey = String(nextSocket++);
    const peer: Peer = {
      ip: clientIp(request, config),
      send: (message: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };
    responsive.add(ws);
    ws.on('pong', () => responsive.add(ws));
    ws.on('message', (data, isBinary) => {
      if (!messageRate.take(socketKey)) {
        ws.close(1008, 'Too many messages');
        return;
      }
      const message = isBinary ? null : parseClientMessage(data.toString());
      if (!message) {
        peer.send({ t: 'error', reason: 'bad-message', message: 'Unrecognized message.' });
        return;
      }
      rooms.handle(peer, message);
    });
    ws.on('close', () => rooms.disconnect(peer));
    ws.on('error', () => ws.terminate());
  }

  // Drop connections that stopped answering pings (laptop lid closed, network gone).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!responsive.has(ws)) {
        ws.terminate();
        continue;
      }
      responsive.delete(ws);
      ws.ping();
    }
    rooms.prune();
    messageRate.prune();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, () => resolve(http.address() as AddressInfo));
      }),
    close: async () => {
      clearInterval(heartbeat);
      rooms.closeAll();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

/** The apps connect from Node and send no Origin; web pages must be explicitly allowed. */
function originAllowed(request: IncomingMessage, config: ServerConfig): boolean {
  const origin = request.headers.origin;
  return origin === undefined || config.allowedOrigins.includes(origin);
}

function clientIp(request: IncomingMessage, config: ServerConfig): string {
  if (config.trustProxy) {
    // Caddy appends the address it saw, so the last entry is the one a client cannot forge.
    const header = request.headers['x-forwarded-for'];
    const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .at(-1);
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress ?? 'unknown';
}
