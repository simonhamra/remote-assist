import type { IceServer } from '@remote-assist/protocol';
import { createHmac } from 'node:crypto';
import type { ServerConfig } from './config.ts';

/**
 * Credentials for coturn's `use-auth-secret` mode (the "TURN REST API"): the username carries an
 * expiry time and the password is an HMAC of it, so nothing has to be stored or revoked.
 */
export function turnCredentials(secret: string, ttlSeconds: number, nowMs = Date.now()) {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiresAt}:remote-assist`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt };
}

export function iceServersFor(config: ServerConfig, nowMs = Date.now()): IceServer[] {
  const servers: IceServer[] = [];
  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls });
  if (config.turn) {
    const { username, credential } = turnCredentials(
      config.turn.secret,
      config.turn.ttlSeconds,
      nowMs,
    );
    servers.push({ urls: config.turn.urls, username, credential });
  }
  return servers;
}
