import {
  createIdentity,
  createSessionRequest,
  signText,
  signedText,
  type Identity,
} from '@remote-assist/crypto';
import { PROTOCOL_VERSION, SignalingClient, type SignalingEvent } from '@remote-assist/protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../server/src/config.ts';
import { silentLog } from '../../../server/src/log.ts';
import { createSignalingServer, type SignalingServer } from '../../../server/src/server.ts';
import { ServerBridge } from './bridge';
import { PeopleChannels, SessionChannels, type SessionEvent } from './channels';
import { Settings, TrustStore } from './stores';

let server: SignalingServer;
let url: string;
const bridges: ServerBridge[] = [];

beforeEach(async () => {
  server = createSignalingServer(loadConfig({ PORT: '0' }), silentLog);
  url = `ws://127.0.0.1:${(await server.listen()).port}/ws`;
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  await server.close();
});

/** A bridge as one app's main process would run it, with its IPC replaced by plain calls. */
function app(role: 'host' | 'helper', name: string) {
  const folder = mkdtempSync(join(tmpdir(), 'ra-bridge-'));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  const identity = createIdentity();
  const bridge = new ServerBridge({
    url,
    role,
    identity,
    trust: new TrustStore(join(folder, 'trusted.json')),
    settings: new Settings(join(folder, 'settings.json')),
    defaultName: name,
    handle: (channel, listener) => void handlers.set(channel, listener),
    toWindow: (channel, payload) => void sent.push({ channel, payload }),
    allowCodeSessions: false,
  });
  bridges.push(bridge);
  bridge.start();
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(...args);
  };
  const events = () =>
    sent.filter((m) => m.channel === SessionChannels.event).map((m) => m.payload as SessionEvent);
  const event = <T extends SessionEvent['t']>(t: T) =>
    vi.waitFor(() => {
      const found = events()
        .filter((e) => e.t === t)
        .at(-1);
      if (!found) throw new Error(`no ${t} yet`);
      return found as Extract<SessionEvent, { t: T }>;
    });
  const step = (expected: string) =>
    vi.waitFor(() => expect(bridge.state().pairing.step).toBe(expected));
  return { bridge, identity, call, events, event, step, state: () => bridge.state() };
}

async function online(...apps: ReturnType<typeof app>[]) {
  await vi.waitFor(() => {
    for (const a of apps) expect(a.state().connection).toBe('online');
  });
}

async function pair(host: ReturnType<typeof app>, helper: ReturnType<typeof app>) {
  await online(host, helper);
  await host.call(PeopleChannels.startPairing);
  await host.step('code');
  const pairing = host.state().pairing;
  if (pairing.step !== 'code') throw new Error('no code');
  await helper.call(PeopleChannels.redeemPairing, pairing.code);
  await host.step('confirm');
  await helper.step('confirm');
  return { code: pairing.code };
}

/** A raw client signed in as `identity`: plays a device whose app has been tampered with. */
async function rawClient(identity: Identity, role: 'host' | 'helper') {
  const events: SignalingEvent[] = [];
  const client = new SignalingClient({
    url,
    onEvent: (event) => events.push(event),
    authenticate: (nonce) => ({
      t: 'auth',
      v: PROTOCOL_VERSION,
      device: identity.id,
      role,
      name: 'Raw',
      sig: signText(identity, signedText.auth(nonce)),
    }),
  });
  await client.connect();
  return { client, events };
}

describe('ServerBridge', () => {
  it('pairs two devices that see the same words, and pins each other', async () => {
    const host = app('host', 'Grandma');
    const helper = app('helper', 'Alex');
    await pair(host, helper);
    const hostView = host.state().pairing;
    const helperView = helper.state().pairing;
    if (hostView.step !== 'confirm' || helperView.step !== 'confirm')
      throw new Error('not matched');
    expect(hostView.words).toEqual(helperView.words);
    expect(hostView.peer.name).toBe('Alex');

    await host.call(PeopleChannels.confirmPairing, true);
    await helper.call(PeopleChannels.confirmPairing, true);
    await host.step('done');
    await helper.step('done');
    expect(host.state().peers).toEqual([
      expect.objectContaining({
        id: helper.identity.id,
        name: 'Alex',
        role: 'helper',
        online: true,
      }),
    ]);
    expect(helper.state().peers[0]?.id).toBe(host.identity.id);
  });

  it('pairs nothing when someone says the words differ', async () => {
    const host = app('host', 'Grandma');
    const helper = app('helper', 'Alex');
    await pair(host, helper);
    await host.call(PeopleChannels.confirmPairing, false);
    await host.step('failed');
    await helper.step('failed');
    expect(host.state().peers).toEqual([]);
  });

  it('runs a paired session with verified identity and signed offers and answers', async () => {
    const host = app('host', 'Grandma');
    const helper = app('helper', 'Alex');
    await pair(host, helper);
    await host.call(PeopleChannels.confirmPairing, true);
    await helper.call(PeopleChannels.confirmPairing, true);
    await helper.step('done');

    await helper.call(SessionChannels.request, host.identity.id);
    expect((await host.event('verified')).peer).toEqual({ id: helper.identity.id, name: 'Alex' });
    await helper.event('paired');

    await host.call(SessionChannels.signal, { kind: 'offer', sdp: 'v=0 offer' });
    const offer = await helper.event('signal');
    expect(offer.data).toMatchObject({ kind: 'offer', sdp: 'v=0 offer', sig: expect.any(String) });
    await helper.call(SessionChannels.signal, { kind: 'answer', sdp: 'v=0 answer' });
    expect((await host.event('signal')).data).toMatchObject({ kind: 'answer', sdp: 'v=0 answer' });
  });

  it('refuses a replayed request, and stops a session whose answer is not signed', async () => {
    const host = app('host', 'Grandma');
    const helper = app('helper', 'Alex');
    await pair(host, helper);
    await host.call(PeopleChannels.confirmPairing, true);
    await helper.call(PeopleChannels.confirmPairing, true);
    await helper.step('done');
    helper.bridge.stop();

    // Someone holding the helper's key replays one request twice: only the first is accepted.
    const raw = await rawClient(helper.identity, 'helper');
    const request = createSessionRequest(helper.identity, host.identity.id);
    raw.client.send({ t: 'session.request', request });
    await host.event('verified');
    raw.client.send({ t: 'leave' });
    raw.client.send({ t: 'session.request', request });
    await vi.waitFor(() => {
      if (!raw.events.some((e) => e.t === 'peer.left')) throw new Error('waiting');
    });
    expect(host.events().filter((e) => e.t === 'verified')).toHaveLength(1);

    // A fresh request, then an answer without the helper's signature: the host stops at once.
    raw.client.send({
      t: 'session.request',
      request: createSessionRequest(helper.identity, host.identity.id),
    });
    await vi.waitFor(() => expect(host.events().filter((e) => e.t === 'verified')).toHaveLength(2));
    raw.client.send({ t: 'signal', data: { kind: 'answer', sdp: 'v=0 swapped' } });
    expect((await host.event('tampered')).message).toMatch(/changed on the way/);
    raw.client.close();
  });
});
