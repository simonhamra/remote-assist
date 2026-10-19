/**
 * Device identity and signatures (Ed25519), and the words people compare when pairing.
 *
 * Every device makes a key pair on first launch; its public key (43 base64url characters) is
 * also its ID. Pairing pins the other device's key, and from then on session requests and the
 * WebRTC offer and answer are signed, so the server can relay them but can't forge or alter them.
 *
 * Node only. The server runs this file as TypeScript directly: erasable syntax only.
 */
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

/** A device's Ed25519 public key in base64url; also the device's ID. */
export type DeviceId = string;

export interface Identity {
  id: DeviceId;
  privateKey: KeyObject;
}

export const DEVICE_ID = /^[A-Za-z0-9_-]{43}$/;
export const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
export const NONCE = /^[A-Za-z0-9_-]{22}$/;

export function createIdentity(): Identity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { id: idOf(privateKey), privateKey };
}

/** The private key as PKCS#8 PEM, to be stored encrypted. */
export function exportIdentity(identity: Identity): string {
  return identity.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

export function importIdentity(pem: string): Identity {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Not an Ed25519 key');
  return { id: idOf(privateKey), privateKey };
}

function idOf(privateKey: KeyObject): DeviceId {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('Unexpected key format');
  return jwk.x;
}

export function signText(identity: Identity, text: string): string {
  return sign(null, Buffer.from(text), identity.privateKey).toString('base64url');
}

export function verifyText(device: DeviceId, text: string, signature: string): boolean {
  if (!DEVICE_ID.test(device) || !SIGNATURE.test(signature)) return false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: device }, format: 'jwk' });
    return verify(null, Buffer.from(text), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export function randomNonce(): string {
  return randomBytes(16).toString('base64url');
}

export interface SessionRequestFields {
  from: DeviceId;
  to: DeviceId;
  nonce: string;
  ts: number;
}

/**
 * Exactly what each kind of signature covers. Each starts with its own label, so a signature
 * made for one purpose can never be passed off as another.
 */
export const signedText = {
  auth: (nonce: string): string => `remote-assist/auth/v1\n${nonce}`,
  sessionRequest: (r: SessionRequestFields): string =>
    `remote-assist/session-request/v1\n${r.from}\n${r.to}\n${r.nonce}\n${r.ts}`,
  sdp: (sessionNonce: string, kind: 'offer' | 'answer', sdp: string): string =>
    `remote-assist/sdp/v1\n${sessionNonce}\n${kind}\n${createHash('sha256').update(sdp).digest('hex')}`,
};

/**
 * Three words both people read out when pairing. Both devices derive them from the two keys and
 * the code: if anyone in between swapped a key, the words differ and the pairing is refused.
 * 3 × 11 bits from a 2048-word list, so a substitution goes unnoticed once in 8.6 billion tries.
 */
export function confirmationWords(host: DeviceId, helper: DeviceId, code: string): string[] {
  const d = createHash('sha256')
    .update(`remote-assist/pairing/v1\n${host}\n${helper}\n${code}`)
    .digest();
  const byte = (i: number) => d[i] ?? 0;
  const indexes = [
    (byte(0) << 3) | (byte(1) >> 5),
    ((byte(1) & 0x1f) << 6) | (byte(2) >> 2),
    ((byte(2) & 0x03) << 9) | (byte(3) << 1) | (byte(4) >> 7),
  ];
  return indexes.map((i) => wordlist[i] ?? '?');
}

/** Rejects anything outside the time window, or seen before within it (a replay). */
export class ReplayGuard {
  private readonly windowMs: number;
  private readonly seen = new Map<string, number>();

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  accept(nonce: string, timestamp: number, nowMs = Date.now()): boolean {
    for (const [seenNonce, at] of this.seen) {
      if (nowMs - at > 2 * this.windowMs) this.seen.delete(seenNonce);
    }
    if (!NONCE.test(nonce) || Math.abs(nowMs - timestamp) > this.windowMs) return false;
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowMs);
    return true;
  }
}

export interface SignedSessionRequest extends SessionRequestFields {
  sig: string;
}

export function createSessionRequest(identity: Identity, to: DeviceId): SignedSessionRequest {
  const fields = { from: identity.id, to, nonce: randomNonce(), ts: Date.now() };
  return { ...fields, sig: signText(identity, signedText.sessionRequest(fields)) };
}

export type RequestCheck = 'ok' | 'not-for-me' | 'unknown-helper' | 'bad-signature' | 'replayed';

/** The host's check of an incoming session request, in order of cheapness. */
export function checkSessionRequest(
  request: SignedSessionRequest,
  me: DeviceId,
  isTrusted: (device: DeviceId) => boolean,
  guard: ReplayGuard,
  nowMs = Date.now(),
): RequestCheck {
  if (request.to !== me) return 'not-for-me';
  if (!isTrusted(request.from)) return 'unknown-helper';
  if (!verifyText(request.from, signedText.sessionRequest(request), request.sig)) {
    return 'bad-signature';
  }
  return guard.accept(request.nonce, request.ts, nowMs) ? 'ok' : 'replayed';
}
