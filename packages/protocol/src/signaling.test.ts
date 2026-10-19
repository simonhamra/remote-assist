import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  formatSessionCode,
  normalizeSessionCode,
  parseClientMessage,
  parseServerMessage,
} from './signaling.ts';

const DEVICE = 'A'.repeat(43);
const SIG = 'B'.repeat(86);

describe('parseClientMessage', () => {
  it('accepts well-formed messages', () => {
    const auth = {
      t: 'auth',
      v: PROTOCOL_VERSION,
      device: DEVICE,
      role: 'helper',
      name: 'Alex',
      sig: SIG,
    };
    expect(parseClientMessage(JSON.stringify(auth))).toEqual(auth);
    expect(parseClientMessage(JSON.stringify({ t: 'host.open' }))).toEqual({ t: 'host.open' });
    const request = { from: DEVICE, to: DEVICE, nonce: 'C'.repeat(22), ts: 1, sig: SIG };
    expect(parseClientMessage(JSON.stringify({ t: 'session.request', request }))).toEqual({
      t: 'session.request',
      request,
    });
    const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0' };
    expect(
      parseClientMessage(JSON.stringify({ t: 'signal', data: { kind: 'candidate', candidate } })),
    ).toEqual({ t: 'signal', data: { kind: 'candidate', candidate } });
  });

  it('rejects malformed JSON, unknown types, bad codes, keys and versions', () => {
    expect(parseClientMessage('{nope')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'admin' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'helper.join', code: '1234' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'pair.remove', peer: 'short' }))).toBeNull();
    const oldAuth = { t: 'auth', v: 1, device: DEVICE, role: 'host', name: 'G', sig: SIG };
    expect(parseClientMessage(JSON.stringify(oldAuth))).toBeNull();
  });

  it('caps the size of relayed SDP', () => {
    const sdp = 'v=0' + 'x'.repeat(20_000);
    expect(
      parseClientMessage(JSON.stringify({ t: 'signal', data: { kind: 'offer', sdp } })),
    ).toBeNull();
  });
});

describe('parseServerMessage', () => {
  it('accepts a pairing with TURN credentials', () => {
    const message = {
      t: 'paired',
      iceServers: [{ urls: ['turn:turn.example:3478'], username: '1:ra', credential: 'x' }],
    };
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });
});

describe('consent signals', () => {
  const signal = (data: unknown) => parseClientMessage(JSON.stringify({ t: 'signal', data }));

  it('carry the helper name and the answer', () => {
    expect(signal({ kind: 'intro', name: '  Alex ' })).toEqual({
      t: 'signal',
      data: { kind: 'intro', name: 'Alex' },
    });
    expect(signal({ kind: 'declined', reason: 'timeout' })).not.toBeNull();
  });

  it('refuse names that are empty, too long, or hide formatting tricks', () => {
    expect(signal({ kind: 'intro', name: '   ' })).toBeNull();
    expect(signal({ kind: 'intro', name: 'x'.repeat(41) })).toBeNull();
    // A right-to-left override can make "Alex\u202Egnp.exe" display misleadingly.
    expect(signal({ kind: 'intro', name: 'Alex\u202Eevil' })).toBeNull();
    expect(signal({ kind: 'intro', name: 'Alex\nBank' })).toBeNull();
  });
});

describe('session codes', () => {
  it('formats and normalizes', () => {
    expect(formatSessionCode('48271953')).toBe('4827 1953');
    expect(normalizeSessionCode(' 4827-1953 ')).toBe('48271953');
  });
});
