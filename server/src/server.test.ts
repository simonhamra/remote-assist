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

/** The same client the apps use, over Node's built-in WebSocket. */
function client() {
  const events: SignalingEvent[] = [];
  const signaling = new SignalingClient(`ws://${base}/ws`, (event) => events.push(event));
  const waitFor = <T extends SignalingEvent['t']>(t: T) =>
    vi.waitFor(() => {
      const event = events.find((e) => e.t === t);
      if (!event) throw new Error(`no ${t} yet`);
      return event as Extract<SignalingEvent, { t: T }>;
    });
  return { signaling, events, waitFor };
}

describe('signaling server', () => {
  it('pairs host and helper, relays negotiation and reports departures', async () => {
    const host = client();
    const helper = client();
    await host.signaling.open({ t: 'host.open', v: PROTOCOL_VERSION });
    const { code } = await host.waitFor('code');

    await helper.signaling.open({ t: 'helper.join', v: PROTOCOL_VERSION, code });
    const paired = await helper.waitFor('paired');
    expect(paired.iceServers[0]).toMatchObject({ urls: ['turn:127.0.0.1:3478'] });
    await host.waitFor('paired');

    host.signaling.send({ t: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
    expect((await helper.waitFor('signal')).data).toEqual({ kind: 'offer', sdp: 'v=0 offer' });
    helper.signaling.send({ t: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } });
    expect((await host.waitFor('signal')).data).toEqual({ kind: 'answer', sdp: 'v=0 answer' });

    helper.signaling.close();
    await host.waitFor('peer.left');
    host.signaling.close();
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
    await new Promise((resolve) => socket.on('open', resolve));
    const reply = new Promise<string>((resolve) =>
      socket.on('message', (data) => resolve(String(data))),
    );
    socket.send(JSON.stringify({ t: 'admin.shutdown' }));
    expect(JSON.parse(await reply)).toMatchObject({ t: 'error', reason: 'bad-message' });
    socket.close();
  });
});
