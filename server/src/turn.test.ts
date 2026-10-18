import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { iceServersFor, turnCredentials } from './turn.ts';

const SECRET = 'a-test-secret-that-is-long-enough-1234';

describe('turnCredentials', () => {
  it('follows the coturn use-auth-secret scheme', () => {
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    const { username, credential, expiresAt } = turnCredentials(SECRET, 3600, now);
    expect(expiresAt).toBe(now / 1000 + 3600);
    expect(username).toBe(`${expiresAt}:remote-assist`);
    expect(credential).toBe(createHmac('sha1', SECRET).update(username).digest('base64'));
  });
});

describe('iceServersFor', () => {
  it('is empty without STUN or TURN (local network only)', () => {
    expect(iceServersFor(loadConfig({}))).toEqual([]);
  });

  it('includes STUN and fresh TURN credentials', () => {
    const config = loadConfig({
      STUN_URLS: 'stun:turn.example:3478',
      TURN_URLS: 'turn:turn.example:3478?transport=udp, turn:turn.example:3478?transport=tcp',
      TURN_SECRET: SECRET,
    });
    const [stun, turn] = iceServersFor(config);
    expect(stun).toEqual({ urls: ['stun:turn.example:3478'] });
    expect(turn).toMatchObject({
      urls: ['turn:turn.example:3478?transport=udp', 'turn:turn.example:3478?transport=tcp'],
      username: expect.stringMatching(/^\d+:remote-assist$/),
      credential: expect.any(String),
    });
  });

  it('refuses TURN without a strong secret', () => {
    expect(() => loadConfig({ TURN_URLS: 'turn:x:3478', TURN_SECRET: 'short' })).toThrow(/32/);
  });
});
