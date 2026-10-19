import type {
  ClientMessage,
  ErrorReason,
  IceServer,
  ServerMessage,
  SessionRequest,
  SignalData,
} from '@remote-assist/protocol';
import { randomInt, randomUUID } from 'node:crypto';
import type { Log } from './log.ts';
import { RateLimiter } from './rateLimit.ts';

/** A connected app, as the rooms see it. */
export interface Peer {
  readonly ip: string;
  send(message: ServerMessage): void;
}

interface Room {
  readonly id: string;
  code: string | null;
  readonly host: Peer;
  helper: Peer | null;
  expiry: ReturnType<typeof setTimeout> | null;
}

export interface RoomsOptions {
  codeTtlMs: number;
  maxRooms: number;
  iceServers: () => IceServer[];
  log: Log;
}

const WINDOW_MS = 10 * 60 * 1000;

export type RoomMessage = Extract<
  ClientMessage,
  { t: 'host.open' | 'helper.join' | 'signal' | 'leave' }
>;

/**
 * Rooms join one host and one helper for a session: either through a one-time code, or for
 * paired devices through a signed request. Knows nothing about sockets.
 */
export class Rooms {
  private readonly options: RoomsOptions;
  private readonly rooms = new Set<Room>();
  private readonly byCode = new Map<string, Room>();
  private readonly byPeer = new Map<Peer, Room>();
  // Plenty for people, useless for guessing: 20 tries per 10 minutes against 10^8 codes.
  private readonly opens = new RateLimiter(20, WINDOW_MS);
  private readonly joins = new RateLimiter(20, WINDOW_MS);

  constructor(options: RoomsOptions) {
    this.options = options;
  }

  get size(): number {
    return this.rooms.size;
  }

  handle(peer: Peer, message: RoomMessage): void {
    switch (message.t) {
      case 'host.open':
        return this.open(peer);
      case 'helper.join':
        return this.join(peer, message.code);
      case 'signal':
        return this.relay(peer, message.data);
      case 'leave':
        return this.leave(peer);
    }
  }

  /**
   * A paired helper's request to a host (both signed in, pairing checked by the caller). The
   * host gets the signed request to check against the key it pinned when pairing.
   */
  openSession(
    host: Peer,
    helper: Peer,
    ids: { host: string; helper: string },
    request: SessionRequest,
  ): void {
    if (this.byPeer.has(helper)) return fail(helper, 'bad-message', 'Already in a session.');
    if (this.byPeer.has(host)) return fail(helper, 'busy', 'They are already in a session.');
    if (this.rooms.size >= this.options.maxRooms) {
      return fail(helper, 'server-busy', 'The server is busy. Try again in a minute.');
    }
    const room: Room = { id: randomUUID(), code: null, host, helper, expiry: null };
    this.rooms.add(room);
    this.byPeer.set(host, room);
    this.byPeer.set(helper, room);
    const iceServers = this.options.iceServers();
    host.send({ t: 'paired', iceServers, peer: ids.helper, request });
    helper.send({ t: 'paired', iceServers, peer: ids.host });
    this.options.log('room.requested', { room: room.id, rooms: this.rooms.size });
  }

  /** The peer's connection closed. */
  disconnect(peer: Peer): void {
    this.leave(peer);
  }

  prune(nowMs = Date.now()): void {
    this.opens.prune(nowMs);
    this.joins.prune(nowMs);
  }

  closeAll(): void {
    for (const room of this.rooms) this.close(room, 'shutdown');
  }

  private open(peer: Peer): void {
    if (this.byPeer.has(peer)) return fail(peer, 'bad-message', 'Already in a session.');
    if (!this.opens.take(peer.ip)) {
      return fail(peer, 'rate-limited', 'Too many attempts. Wait a few minutes, then try again.');
    }
    if (this.rooms.size >= this.options.maxRooms) {
      return fail(peer, 'server-busy', 'The server is busy. Try again in a minute.');
    }

    const code = this.newCode();
    const room: Room = { id: randomUUID(), code, host: peer, helper: null, expiry: null };
    room.expiry = setTimeout(() => this.expire(room), this.options.codeTtlMs);
    this.rooms.add(room);
    this.byCode.set(code, room);
    this.byPeer.set(peer, room);
    peer.send({ t: 'code', code, expiresAt: Date.now() + this.options.codeTtlMs });
    this.options.log('room.opened', { room: room.id, rooms: this.rooms.size });
  }

  private join(peer: Peer, code: string): void {
    if (this.byPeer.has(peer)) return fail(peer, 'bad-message', 'Already in a session.');
    if (!this.joins.take(peer.ip)) {
      return fail(peer, 'rate-limited', 'Too many attempts. Wait a few minutes, then try again.');
    }
    const room = this.byCode.get(code);
    if (!room) {
      return fail(
        peer,
        'invalid-code',
        'That code does not work. Check the numbers, or ask for a new code.',
      );
    }

    // Codes are single use: once someone has joined, nobody else can.
    this.byCode.delete(code);
    room.code = null;
    if (room.expiry) clearTimeout(room.expiry);
    room.expiry = null;
    room.helper = peer;
    this.byPeer.set(peer, room);

    const iceServers = this.options.iceServers();
    room.host.send({ t: 'paired', iceServers });
    peer.send({ t: 'paired', iceServers });
    this.options.log('room.paired', { room: room.id });
  }

  private relay(peer: Peer, data: SignalData): void {
    const room = this.byPeer.get(peer);
    const other = room && (room.host === peer ? room.helper : room.host);
    if (!other) return fail(peer, 'not-in-session', 'There is nobody to connect to yet.');
    other.send({ t: 'signal', data });
  }

  private leave(peer: Peer): void {
    const room = this.byPeer.get(peer);
    if (!room) return;
    const other = room.host === peer ? room.helper : room.host;
    this.close(room, 'left');
    other?.send({ t: 'peer.left' });
  }

  private expire(room: Room): void {
    if (room.helper) return;
    this.close(room, 'expired');
    fail(
      room.host,
      'code-expired',
      'The code expired before anyone used it. Start again for a new one.',
    );
  }

  private close(room: Room, reason: string): void {
    if (room.expiry) clearTimeout(room.expiry);
    if (room.code) this.byCode.delete(room.code);
    this.byPeer.delete(room.host);
    if (room.helper) this.byPeer.delete(room.helper);
    this.rooms.delete(room);
    this.options.log('room.closed', { room: room.id, reason, rooms: this.rooms.size });
  }

  private newCode(): string {
    for (;;) {
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      if (!this.byCode.has(code)) return code;
    }
  }
}

function fail(peer: Peer, reason: ErrorReason, message: string): void {
  peer.send({ t: 'error', reason, message });
}
