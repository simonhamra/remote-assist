import { randomNonce, signedText, verifyText } from '@remote-assist/crypto';
import type {
  AuthMessage,
  ClientMessage,
  ErrorReason,
  IceServer,
  SessionRequest,
} from '@remote-assist/protocol';
import type { Log } from './log.ts';
import { Pairing, type Device } from './pairing.ts';
import { Rooms, type Peer } from './rooms.ts';
import type { PairingStore } from './store.ts';

/** A connection, as the hub sees it. */
export interface Connection extends Peer {
  close(): void;
}

export interface HubOptions {
  store: PairingStore;
  codeTtlMs: number;
  maxRooms: number;
  iceServers: () => IceServer[];
  log: Log;
}

/**
 * Everything the server does, without sockets: each connection first proves which device it
 * is by signing a challenge, then pairs, asks to help a paired host, or uses a one-time code.
 * Paired devices are told when each other come online or go offline.
 */
export class Hub {
  private readonly options: HubOptions;
  private readonly challenges = new Map<Connection, string>();
  private readonly devices = new Map<Connection, Device>();
  private readonly online = new Map<string, Connection>();
  private readonly rooms: Rooms;
  private readonly pairing: Pairing;
  /** Set on shutdown: late events from closing sockets are ignored (the database is closing). */
  private closed = false;

  constructor(options: HubOptions) {
    this.options = options;
    this.rooms = new Rooms(options);
    this.pairing = new Pairing({
      store: options.store,
      codeTtlMs: options.codeTtlMs,
      log: options.log,
      online: (id) => {
        const connection = this.online.get(id);
        return connection ? this.devices.get(connection) : undefined;
      },
    });
  }

  connect(connection: Connection): void {
    if (this.closed) return connection.close();
    const nonce = randomNonce();
    this.challenges.set(connection, nonce);
    connection.send({ t: 'challenge', nonce });
  }

  handle(connection: Connection, message: ClientMessage): void {
    if (this.closed) return;
    const device = this.devices.get(connection);
    if (!device) {
      if (message.t === 'auth') return this.authenticate(connection, message);
      return fail(connection, 'unauthenticated', 'Sign in first.');
    }
    switch (message.t) {
      case 'auth':
        return fail(connection, 'bad-message', 'Already signed in.');
      case 'host.open':
      case 'helper.join':
      case 'signal':
      case 'leave':
        return this.rooms.handle(connection, message);
      case 'session.request':
        return this.requestSession(connection, device, message.request);
      default:
        return this.pairing.handle(device, message);
    }
  }

  /** The connection closed. Safe to call more than once. */
  disconnect(connection: Connection): void {
    if (this.closed) return;
    this.challenges.delete(connection);
    this.rooms.disconnect(connection);
    const device = this.devices.get(connection);
    if (!device) return;
    this.devices.delete(connection);
    this.pairing.disconnect(device);
    if (this.online.get(device.id) === connection) {
      this.online.delete(device.id);
      this.announce(device.id, false);
    }
  }

  prune(nowMs = Date.now()): void {
    this.rooms.prune(nowMs);
    this.pairing.prune(nowMs);
  }

  closeAll(): void {
    this.closed = true;
    this.rooms.closeAll();
    this.pairing.closeAll();
  }

  private authenticate(connection: Connection, auth: AuthMessage): void {
    const nonce = this.challenges.get(connection);
    this.challenges.delete(connection);
    if (!nonce || !verifyText(auth.device, signedText.auth(nonce), auth.sig)) {
      fail(connection, 'unauthenticated', 'The server could not verify this device.');
      connection.close();
      return;
    }
    const device: Device = {
      ip: connection.ip,
      id: auth.device,
      role: auth.role,
      name: auth.name,
      send: (message) => connection.send(message),
    };
    this.devices.set(connection, device);
    // One connection per device: a newer one (app restart, network change) replaces the old.
    const previous = this.online.get(device.id);
    if (previous && previous !== connection) {
      this.disconnect(previous);
      previous.close();
    }
    this.online.set(device.id, connection);
    const peers = this.options.store.peersOf(device.id);
    connection.send({
      t: 'authed',
      device: device.id,
      peers: peers.map((id) => ({ id, online: this.online.has(id) })),
    });
    this.announce(device.id, true);
  }

  private requestSession(connection: Connection, device: Device, request: SessionRequest): void {
    if (device.role !== 'helper' || request.from !== device.id) {
      return fail(connection, 'bad-message', 'Only a helper can ask to help, as itself.');
    }
    // The host checks this against the key it pinned; checking here too stops forgeries early.
    if (!verifyText(request.from, signedText.sessionRequest(request), request.sig)) {
      return fail(connection, 'bad-message', 'The request is not signed correctly.');
    }
    if (!this.options.store.has(request.to, device.id)) {
      return fail(connection, 'not-paired', 'You are not paired with this computer.');
    }
    const host = this.online.get(request.to);
    if (!host) return fail(connection, 'peer-offline', 'Their computer is not online right now.');
    this.rooms.openSession(host, connection, { host: request.to, helper: device.id }, request);
  }

  private announce(id: string, online: boolean): void {
    for (const peer of this.options.store.peersOf(id)) {
      this.online.get(peer)?.send({ t: 'presence', peer: id, online });
    }
  }
}

function fail(connection: Peer, reason: ErrorReason, message: string): void {
  connection.send({ t: 'error', reason, message });
}
