import type { ServerMessage } from '@remote-assist/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLog } from './log.ts';
import { Rooms } from './rooms.ts';

function fakePeer(ip = '192.0.2.1') {
  const sent: ServerMessage[] = [];
  return { ip, sent, send: (message: ServerMessage) => void sent.push(message) };
}

const ICE = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }];

function newRooms(overrides: { maxRooms?: number } = {}) {
  return new Rooms({
    codeTtlMs: 60_000,
    maxRooms: overrides.maxRooms ?? 10,
    iceServers: () => ICE,
    log: silentLog,
  });
}

function codeOf(peer: ReturnType<typeof fakePeer>): string {
  const message = peer.sent.find((m) => m.t === 'code');
  if (!message || message.t !== 'code') throw new Error('no code sent');
  return message.code;
}

describe('Rooms', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pairs a helper with the host that holds the code', () => {
    const rooms = newRooms();
    const host = fakePeer();
    const helper = fakePeer('198.51.100.7');
    rooms.handle(host, { t: 'host.open' });
    const code = codeOf(host);
    expect(code).toMatch(/^\d{8}$/);

    rooms.handle(helper, { t: 'helper.join', code });
    expect(host.sent.at(-1)).toEqual({ t: 'paired', iceServers: ICE });
    expect(helper.sent.at(-1)).toEqual({ t: 'paired', iceServers: ICE });
  });

  it('lets a code be used only once', () => {
    const rooms = newRooms();
    const host = fakePeer();
    rooms.handle(host, { t: 'host.open' });
    const code = codeOf(host);
    rooms.handle(fakePeer(), { t: 'helper.join', code });

    const latecomer = fakePeer();
    rooms.handle(latecomer, { t: 'helper.join', code });
    expect(latecomer.sent.at(-1)).toMatchObject({ t: 'error', reason: 'invalid-code' });
  });

  it('relays signals in both directions, only between paired peers', () => {
    const rooms = newRooms();
    const host = fakePeer();
    const helper = fakePeer();
    rooms.handle(host, { t: 'signal', data: { kind: 'offer', sdp: 'v=0' } });
    expect(host.sent.at(-1)).toMatchObject({ t: 'error', reason: 'not-in-session' });

    rooms.handle(host, { t: 'host.open' });
    rooms.handle(helper, { t: 'helper.join', code: codeOf(host) });
    rooms.handle(host, { t: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
    rooms.handle(helper, { t: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } });
    expect(helper.sent.at(-1)).toEqual({ t: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
    expect(host.sent.at(-1)).toEqual({ t: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } });
  });

  it('tells the other side when someone leaves, and frees the room', () => {
    const rooms = newRooms();
    const host = fakePeer();
    const helper = fakePeer();
    rooms.handle(host, { t: 'host.open' });
    rooms.handle(helper, { t: 'helper.join', code: codeOf(host) });

    rooms.disconnect(helper);
    expect(host.sent.at(-1)).toEqual({ t: 'peer.left' });
    expect(rooms.size).toBe(0);
  });

  it('expires unused codes', () => {
    const rooms = newRooms();
    const host = fakePeer();
    rooms.handle(host, { t: 'host.open' });
    const code = codeOf(host);

    vi.advanceTimersByTime(60_000);
    expect(host.sent.at(-1)).toMatchObject({ t: 'error', reason: 'code-expired' });
    const helper = fakePeer();
    rooms.handle(helper, { t: 'helper.join', code });
    expect(helper.sent.at(-1)).toMatchObject({ t: 'error', reason: 'invalid-code' });
  });

  it('rate-limits join attempts per address', () => {
    const rooms = newRooms();
    const guesser = fakePeer('203.0.113.9');
    for (let i = 0; i < 20; i++) rooms.handle(guesser, { t: 'helper.join', code: '00000000' });
    expect(guesser.sent.at(-1)).toMatchObject({ reason: 'invalid-code' });
    rooms.handle(guesser, { t: 'helper.join', code: '00000000' });
    expect(guesser.sent.at(-1)).toMatchObject({ reason: 'rate-limited' });
  });

  it('refuses new rooms when full, and a second open on the same connection', () => {
    const rooms = newRooms({ maxRooms: 1 });
    const host = fakePeer();
    rooms.handle(host, { t: 'host.open' });
    rooms.handle(host, { t: 'host.open' });
    expect(host.sent.at(-1)).toMatchObject({ reason: 'bad-message' });

    const other = fakePeer();
    rooms.handle(other, { t: 'host.open' });
    expect(other.sent.at(-1)).toMatchObject({ reason: 'server-busy' });
  });
});
