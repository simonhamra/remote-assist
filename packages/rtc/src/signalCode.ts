/**
 * Copy-paste signaling (Phase 1): an SDP offer or answer packed into a short text code that can be
 * sent by chat or email. The signaling server replaces this in Phase 2.
 */

const PREFIX = 'RA1.';
const MAX_CODE_LENGTH = 20_000;

export type SignalKind = 'offer' | 'answer';

export interface SignalPayload {
  kind: SignalKind;
  sdp: string;
}

export class SignalCodeError extends Error {
  override name = 'SignalCodeError';
}

export async function encodeSignal(payload: SignalPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ k: payload.kind, s: payload.sdp }));
  return PREFIX + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeSignal(code: string, expected: SignalKind): Promise<SignalPayload> {
  // Chat apps and email clients like to wrap long codes, so ignore all whitespace.
  const compact = code.replace(/\s+/g, '');
  if (!compact.startsWith(PREFIX) || compact.length > MAX_CODE_LENGTH) {
    throw new SignalCodeError(
      'This is not a Remote Assist code. Copy the whole code and try again.',
    );
  }

  let parsed: unknown;
  try {
    const bytes = await pipe(
      fromBase64Url(compact.slice(PREFIX.length)),
      new DecompressionStream('deflate-raw'),
    );
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    parsed = undefined;
  }
  if (!isSignal(parsed)) {
    throw new SignalCodeError('This code is incomplete or damaged. Copy the whole code again.');
  }
  if (parsed.k !== expected) {
    throw new SignalCodeError(
      expected === 'offer'
        ? 'This is a reply code. Paste the invite code here instead.'
        : 'This is an invite code. Paste the reply code here instead.',
    );
  }
  return { kind: parsed.k, sdp: parsed.s };
}

function isSignal(value: unknown): value is { k: SignalKind; s: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { k, s } = value as Record<string, unknown>;
  return (k === 'offer' || k === 'answer') && typeof s === 'string' && s.startsWith('v=0');
}

async function pipe(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
