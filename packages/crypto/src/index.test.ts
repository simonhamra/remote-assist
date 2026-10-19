import { describe, expect, it } from 'vitest';
import {
  DEVICE_ID,
  ReplayGuard,
  checkSessionRequest,
  confirmationWords,
  createIdentity,
  createSessionRequest,
  exportIdentity,
  importIdentity,
  randomNonce,
  signText,
  signedText,
  verifyText,
} from './index.ts';

describe('identity', () => {
  it('uses the public key as a 43-character ID and survives export and import', () => {
    const identity = createIdentity();
    expect(identity.id).toMatch(DEVICE_ID);
    const restored = importIdentity(exportIdentity(identity));
    expect(restored.id).toBe(identity.id);
    const signature = signText(restored, 'hello');
    expect(verifyText(identity.id, 'hello', signature)).toBe(true);
  });

  it('refuses keys of the wrong type', () => {
    expect(() => importIdentity('not a key')).toThrow();
  });
});

describe('signatures', () => {
  const alice = createIdentity();
  const mallory = createIdentity();

  it('verify only the signed text, by the signing device', () => {
    const signature = signText(alice, signedText.auth('n'));
    expect(verifyText(alice.id, signedText.auth('n'), signature)).toBe(true);
    expect(verifyText(alice.id, signedText.auth('m'), signature)).toBe(false);
    expect(verifyText(mallory.id, signedText.auth('n'), signature)).toBe(false);
  });

  it('reject malformed input without throwing', () => {
    expect(verifyText('short', 'x', 'y')).toBe(false);
    expect(verifyText(alice.id, 'x', 'A'.repeat(86))).toBe(false);
  });

  it('cover the whole SDP', () => {
    const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n';
    const signature = signText(alice, signedText.sdp('nonce', 'offer', sdp));
    const tampered = sdp.replace('AA:BB', 'CC:DD');
    expect(verifyText(alice.id, signedText.sdp('nonce', 'offer', sdp), signature)).toBe(true);
    expect(verifyText(alice.id, signedText.sdp('nonce', 'offer', tampered), signature)).toBe(false);
    expect(verifyText(alice.id, signedText.sdp('nonce', 'answer', sdp), signature)).toBe(false);
  });
});

describe('confirmationWords', () => {
  const host = createIdentity().id;
  const helper = createIdentity().id;

  it('gives both sides the same three words', () => {
    const words = confirmationWords(host, helper, '12345678');
    expect(words).toHaveLength(3);
    expect(words.every((word) => /^[a-z]+$/.test(word))).toBe(true);
    expect(confirmationWords(host, helper, '12345678')).toEqual(words);
  });

  it('changes when a key or the code is swapped', () => {
    const words = confirmationWords(host, helper, '12345678');
    const impostor = createIdentity().id;
    expect(confirmationWords(host, impostor, '12345678')).not.toEqual(words);
    expect(confirmationWords(host, helper, '12345679')).not.toEqual(words);
  });
});

describe('session requests', () => {
  const host = createIdentity();
  const helper = createIdentity();
  const trusted = (id: string) => id === helper.id;

  it('accept a fresh, signed request from a paired helper once', () => {
    const guard = new ReplayGuard();
    const request = createSessionRequest(helper, host.id);
    expect(checkSessionRequest(request, host.id, trusted, guard)).toBe('ok');
    expect(checkSessionRequest(request, host.id, trusted, guard)).toBe('replayed');
  });

  it('reject requests for someone else, from strangers, altered, or stale', () => {
    const guard = new ReplayGuard();
    const stranger = createIdentity();
    expect(
      checkSessionRequest(createSessionRequest(helper, stranger.id), host.id, trusted, guard),
    ).toBe('not-for-me');
    expect(
      checkSessionRequest(createSessionRequest(stranger, host.id), host.id, trusted, guard),
    ).toBe('unknown-helper');
    const altered = { ...createSessionRequest(helper, host.id), ts: Date.now() + 1 };
    expect(checkSessionRequest(altered, host.id, trusted, guard)).toBe('bad-signature');
    const stale = createSessionRequest(helper, host.id);
    expect(checkSessionRequest(stale, host.id, trusted, guard, Date.now() + 61_000)).toBe(
      'replayed',
    );
  });

  it('makes unique nonces', () => {
    expect(new Set(Array.from({ length: 100 }, randomNonce)).size).toBe(100);
  });
});
