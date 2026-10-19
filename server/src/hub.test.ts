import {
  confirmationWords,
  createIdentity,
  createSessionRequest,
  signText,
  signedText,
  type Identity,
} from '@remote-assist/crypto';
import { PROTOCOL_VERSION, type ServerMessage } from '@remote-assist/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub } from './hub.ts';
import { silentLog } from './log.ts';
import { PairingStore } from './store.ts';

function fakeConnection(ip = '192.0.2.1') {
  const sent: ServerMessage[] = [];
  const connection = {
    ip,
    sent,
    closed: false,
    send: (message: ServerMessage) => void sent.push(message),
    close: () => {
      connection.closed = true;
    },
    /** The latest message of a type. */
    last<T extends ServerMessage['t']>(t: T) {
      return sent.filter((m) => m.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined;
    },
  };
  return connection;
}

let store: PairingStore;
let hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  store = new PairingStore();
  hub = new Hub({ store, codeTtlMs: 60_000, maxRooms: 10, iceServers: () => [], log: silentLog });
});

afterEach(() => {
  hub.closeAll();
  store.close();
  vi.useRealTimers();
});

function signIn(identity: Identity, role: 'host' | 'helper', name: string, ip?: string) {
  const connection = fakeConnection(ip);
  hub.connect(connection);
  const challenge = connection.last('challenge');
  if (!challenge) throw new Error('no challenge');
  hub.handle(connection, {
    t: 'auth',
    v: PROTOCOL_VERSION,
    device: identity.id,
    role,
    name,
    sig: signText(identity, signedText.auth(challenge.nonce)),
  });
  return connection;
}

/** Runs a full first pairing; returns the two connections. */
function pair(host: Identity, helper: Identity) {
  const h = signIn(host, 'host', 'Grandma');
  const k = signIn(helper, 'helper', 'Alex');
  hub.handle(h, { t: 'pair.open' });
  const code = h.last('pair.code')?.code ?? '';
  hub.handle(k, { t: 'pair.redeem', code });
  hub.handle(h, { t: 'pair.confirm', peer: helper.id });
  hub.handle(k, { t: 'pair.confirm', peer: host.id });
  return { host: h, helper: k, code };
}

describe('signing in', () => {
  it('requires a valid signature of the challenge', () => {
    const device = createIdentity();
    const connection = fakeConnection();
    hub.connect(connection);
    hub.handle(connection, { t: 'pair.open' });
    expect(connection.last('error')?.reason).toBe('unauthenticated');

    const other = createIdentity();
    hub.handle(connection, {
      t: 'auth',
      v: PROTOCOL_VERSION,
      device: device.id,
      role: 'host',
      name: 'Grandma',
      // Signed by a different key than the one claimed.
      sig: signText(other, signedText.auth(connection.last('challenge')?.nonce ?? '')),
    });
    expect(connection.last('error')?.reason).toBe('unauthenticated');
    expect(connection.closed).toBe(true);
  });

  it('accepts a signed challenge and replaces an older connection of the same device', () => {
    const device = createIdentity();
    const first = signIn(device, 'host', 'Grandma');
    expect(first.last('authed')).toEqual({ t: 'authed', device: device.id, peers: [] });
    signIn(device, 'host', 'Grandma');
    expect(first.closed).toBe(true);
  });
});

describe('pairing', () => {
  it('lets both sides derive the same words, then records the pairing', () => {
    const host = createIdentity();
    const helper = createIdentity();
    const { host: h, helper: k, code } = pair(host, helper);
    expect(h.last('pair.matched')?.peer).toEqual({ id: helper.id, name: 'Alex', role: 'helper' });
    expect(k.last('pair.matched')?.peer).toEqual({ id: host.id, name: 'Grandma', role: 'host' });
    // Both devices compute the words from the keys they were given and the code.
    expect(confirmationWords(host.id, helper.id, code)).toHaveLength(3);
    expect(h.last('pair.done')?.peer).toBe(helper.id);
    expect(k.last('pair.done')?.peer).toBe(host.id);
    expect(store.has(host.id, helper.id)).toBe(true);
  });

  it('does not record anything until both people confirm', () => {
    const host = createIdentity();
    const helper = createIdentity();
    const h = signIn(host, 'host', 'Grandma');
    const k = signIn(helper, 'helper', 'Alex');
    hub.handle(h, { t: 'pair.open' });
    hub.handle(k, { t: 'pair.redeem', code: h.last('pair.code')?.code ?? '' });
    hub.handle(h, { t: 'pair.confirm', peer: helper.id });
    expect(store.has(host.id, helper.id)).toBe(false);
    hub.handle(k, { t: 'pair.cancel' });
    expect(h.last('error')?.reason).toBe('pairing-cancelled');
    hub.handle(h, { t: 'pair.confirm', peer: helper.id });
    expect(store.has(host.id, helper.id)).toBe(false);
  });

  it('uses each code once, and lets it expire', () => {
    const host = createIdentity();
    const h = signIn(host, 'host', 'Grandma');
    hub.handle(h, { t: 'pair.open' });
    const code = h.last('pair.code')?.code ?? '';
    hub.handle(signIn(createIdentity(), 'helper', 'A'), { t: 'pair.redeem', code });
    const late = signIn(createIdentity(), 'helper', 'B');
    hub.handle(late, { t: 'pair.redeem', code });
    expect(late.last('error')?.reason).toBe('invalid-code');

    hub.handle(h, { t: 'pair.open' });
    vi.advanceTimersByTime(60_000);
    expect(h.last('error')?.reason).toBe('code-expired');
  });

  it('needs an existing helper to approve a new one, and tells them about it', () => {
    const host = createIdentity();
    const alex = createIdentity();
    const { host: h, helper: alexConnection } = pair(host, alex);

    const stranger = createIdentity();
    const s = signIn(stranger, 'helper', 'Stranger');
    hub.handle(h, { t: 'pair.open' });
    expect(h.last('pair.code')?.needsApproval).toBe(true);
    hub.handle(s, { t: 'pair.redeem', code: h.last('pair.code')?.code ?? '' });
    expect(s.last('pair.pending')).toBeDefined();
    expect(s.last('pair.matched')).toBeUndefined();
    expect(alexConnection.last('pair.approval')).toEqual({
      t: 'pair.approval',
      host: host.id,
      helper: { id: stranger.id, name: 'Stranger' },
    });

    // Only a paired helper can approve.
    hub.handle(s, { t: 'pair.approve', host: host.id, helper: stranger.id, approve: true });
    expect(s.last('pair.matched')).toBeUndefined();
    hub.handle(alexConnection, {
      t: 'pair.approve',
      host: host.id,
      helper: stranger.id,
      approve: false,
    });
    expect(s.last('error')?.reason).toBe('not-approved');
    expect(h.last('error')?.reason).toBe('not-approved');
  });

  it('forgets a pairing when either side removes it, and tells the other', () => {
    const host = createIdentity();
    const helper = createIdentity();
    const { host: h, helper: k } = pair(host, helper);
    hub.handle(h, { t: 'pair.remove', peer: helper.id });
    expect(store.has(host.id, helper.id)).toBe(false);
    expect(k.last('pair.removed')?.peer).toBe(host.id);
  });
});

describe('presence and session requests', () => {
  it('tells paired devices when each other come and go', () => {
    const host = createIdentity();
    const helper = createIdentity();
    const { host: h } = pair(host, helper);
    const again = signIn(helper, 'helper', 'Alex');
    expect(again.last('authed')?.peers).toEqual([{ id: host.id, online: true }]);
    hub.disconnect(again);
    expect(h.last('presence')).toEqual({ t: 'presence', peer: helper.id, online: false });
  });

  it('opens a room for a paired helper, with the signed request for the host to check', () => {
    const host = createIdentity();
    const helper = createIdentity();
    const { host: h, helper: k } = pair(host, helper);
    const request = createSessionRequest(helper, host.id);
    hub.handle(k, { t: 'session.request', request });
    expect(h.last('paired')).toEqual({ t: 'paired', iceServers: [], peer: helper.id, request });
    expect(k.last('paired')).toEqual({ t: 'paired', iceServers: [], peer: host.id });
  });

  it('refuses requests to unpaired, offline or busy hosts, and forged ones', () => {
    const host = createIdentity();
    const helper = createIdentity();
    const { host: h, helper: k } = pair(host, helper);

    const stranger = createIdentity();
    const s = signIn(stranger, 'helper', 'Stranger');
    hub.handle(s, { t: 'session.request', request: createSessionRequest(stranger, host.id) });
    expect(s.last('error')?.reason).toBe('not-paired');

    const forged = { ...createSessionRequest(helper, host.id), from: stranger.id };
    hub.handle(s, { t: 'session.request', request: forged });
    expect(s.last('error')?.reason).toBe('bad-message');

    // A second helper, approved by the first, can't interrupt a session in progress.
    const second = createIdentity();
    const k2 = signIn(second, 'helper', 'Sam');
    hub.handle(h, { t: 'pair.open' });
    hub.handle(k2, { t: 'pair.redeem', code: h.last('pair.code')?.code ?? '' });
    hub.handle(k, { t: 'pair.approve', host: host.id, helper: second.id, approve: true });
    hub.handle(h, { t: 'pair.confirm', peer: second.id });
    hub.handle(k2, { t: 'pair.confirm', peer: host.id });
    expect(store.has(host.id, second.id)).toBe(true);
    hub.handle(k, { t: 'session.request', request: createSessionRequest(helper, host.id) });
    hub.handle(k2, { t: 'session.request', request: createSessionRequest(second, host.id) });
    expect(k2.last('error')?.reason).toBe('busy');

    hub.disconnect(h);
    const third = signIn(helper, 'helper', 'Alex');
    hub.handle(third, { t: 'session.request', request: createSessionRequest(helper, host.id) });
    expect(third.last('error')?.reason).toBe('peer-offline');
  });
});
