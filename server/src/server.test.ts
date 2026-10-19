import {
  createIdentity,
  createSessionRequest,
  signText,
  signedText,
  type Identity,
} from '@remote-assist/crypto';
import { PROTOCOL_VERSION, SignalingClient, type SignalingEvent } from '@remote-assist/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from './config.ts';
import { silentLog } from './log.ts';
import { createSignalingServer, type SignalingServer } from './server.ts';

let server: SignalingServer;
let base: string;

beforeEach(async () => {
  const config = loadConfig({
    PORT: '0',
    TURN_URLS: 'turn:127.0.0.1:3478',
    TURN_SECRET: 'a-test-secret-that-is-long-enough-1234',
  });
  server = createSignalingServer(config, silentLog);
  const { port } = await server.listen();
  base = `127.0.0.1:${port}`;
});

afterEach(() => server.close());

/** The same client the apps use, over Node's built-in WebSocket, signed in as `identity`. */
async function client(identity: Identity, role: 'host' | 'helper', name: string) {
  const events: SignalingEvent[] = [];
  const signaling = new SignalingClient({
    url: `ws://${base}/ws`,
    onEvent: (event) => events.push(event),
    authenticate: (nonce) => ({
      t: 'auth',
      v: PROTOCOL_VERSION,
      device: identity.id,
      role,
      name,
      sig: signText(identity, signedText.auth(nonce)),
    }),
  });
  await signaling.connect();
  const waitFor = <T extends SignalingEvent['t']>(t: T) =>
    vi.waitFor(() => {
      const event = events.filter((e) => e.t === t).at(-1);
      if (!event) throw new Error(`no ${t} yet`);
      return event as Extract<SignalingEvent, { t: T }>;
    });
  return { signaling, events, waitFor };
}

describe('signaling server', () => {
  it('pairs two devices, then relays a paired session', async () => {
    const hostKey = createIdentity();
    const helperKey = createIdentity();
    const host = await client(hostKey, 'host', 'Grandma');
    const helper = await client(helperKey, 'helper', 'Alex');

    host.signaling.send({ t: 'pair.open' });
    const { code } = await host.waitFor('pair.code');
    helper.signaling.send({ t: 'pair.redeem', code });
    expect((await host.waitFor('pair.matched')).peer.id).toBe(helperKey.id);
    host.signaling.send({ t: 'pair.confirm', peer: helperKey.id });
    helper.signaling.send({ t: 'pair.confirm', peer: hostKey.id });
    await helper.waitFor('pair.done');

    helper.signaling.send({
      t: 'session.request',
      request: createSessionRequest(helperKey, hostKey.id),
    });
    const paired = await host.waitFor('paired');
    expect(paired.peer).toBe(helperKey.id);
    expect(paired.iceServers[0]).toMatchObject({ urls: ['turn:127.0.0.1:3478'] });

    host.signaling.send({ t: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
    expect((await helper.waitFor('signal')).data).toEqual({ kind: 'offer', sdp: 'v=0 offer' });

    helper.signaling.close();
    await host.waitFor('peer.left');
    expect(await host.waitFor('presence')).toEqual({
      t: 'presence',
      peer: helperKey.id,
      online: false,
    });
    host.signaling.close();
  });

  it('still supports one-time code sessions for signed-in devices', async () => {
    const host = await client(createIdentity(), 'host', 'Grandma');
    const helper = await client(createIdentity(), 'helper', 'Alex');
    host.signaling.send({ t: 'host.open' });
    const { code } = await host.waitFor('code');
    helper.signaling.send({ t: 'helper.join', code });
    await helper.waitFor('paired');
    await host.waitFor('paired');
    host.signaling.close();
    helper.signaling.close();
  });

  it('refuses a device that cannot sign its challenge', async () => {
    const impostor = createIdentity();
    const claimed = createIdentity();
    const signaling = new SignalingClient({
      url: `ws://${base}/ws`,
      onEvent: () => {},
      authenticate: (nonce) => ({
        t: 'auth',
        v: PROTOCOL_VERSION,
        device: claimed.id,
        role: 'host',
        name: 'Grandma',
        sig: signText(impostor, signedText.auth(nonce)),
      }),
    });
    await expect(signaling.connect()).rejects.toThrow(/did not accept/);
  });

  it('answers health checks', async () => {
    const response = await fetch(`http://${base}/healthz`);
    expect(await response.text()).toBe('ok');
  });

  it('rejects web pages from other origins', async () => {
    const socket = new WebSocket(`ws://${base}/ws`, {
      headers: { Origin: 'https://evil.example' },
    });
    const status = await new Promise((resolve) =>
      socket.on('unexpected-response', (_request, response) => resolve(response.statusCode)),
    );
    expect(status).toBe(403);
  });

  it('reports unrecognized messages', async () => {
    const socket = new WebSocket(`ws://${base}/ws`);
    const messages: string[] = [];
    socket.on('message', (data) => messages.push(String(data)));
    await new Promise((resolve) => socket.on('open', resolve));
    socket.send(JSON.stringify({ t: 'admin.shutdown' }));
    await vi.waitFor(() => {
      if (!messages.some((m) => m.includes('bad-message'))) throw new Error('waiting');
    });
    socket.close();
  });
});
