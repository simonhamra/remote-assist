/**
 * Signaling protocol between the apps and the server (JSON over WebSocket), and a small client.
 *
 * Every connection starts with the device proving who it is: the server sends a challenge, the
 * device signs it with its key. Then:
 * - pairing: the host shows a code, the helper types it, both compare three words and confirm;
 * - paired sessions: the helper sends a signed request to a paired host, and the server opens a
 *   room for them (the host checks the signature against the key it pinned when pairing);
 * - one-time code sessions (development and tests): the host gets a code, the helper joins.
 * In a room the server relays WebRTC negotiation; offers and answers are signed in paired
 * sessions. Media never touches the server.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 2;

/** Eight digits, read aloud over the phone ("4827 1953"). */
export const sessionCode = z.string().regex(/^\d{8}$/);

/** A device's Ed25519 public key in base64url, which is also its ID. */
export const deviceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const deviceRole = z.enum(['host', 'helper']);
export type DeviceRole = z.infer<typeof deviceRole>;

const sdp = z.string().min(1).max(20_000);

const iceCandidate = z.object({
  candidate: z.string().max(1_000),
  sdpMid: z.string().max(64).nullish(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullish(),
  usernameFragment: z.string().max(256).nullish(),
});

/** A name to show people: no control or invisible formatting characters (no spoofing tricks). */
export const displayName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);

export const signalData = z.discriminatedUnion('kind', [
  /** `sig`: signed by the sender's device key in paired sessions. */
  z.object({ kind: z.literal('offer'), sdp, sig: signature.optional() }),
  z.object({ kind: z.literal('answer'), sdp, sig: signature.optional() }),
  z.object({ kind: z.literal('candidate'), candidate: iceCandidate }),
  /** Helper → host, right after joining: who is asking to help, for the consent screen. */
  z.object({ kind: z.literal('intro'), name: displayName }),
  /** Host → helper: the person said no, or didn't answer in time. Nothing was shared. */
  // `unavailable`: they said yes, but their screen could not be shared (usually a permission).
  z.object({ kind: z.literal('declined'), reason: z.enum(['no', 'timeout', 'unavailable']) }),
]);
export type SignalData = z.infer<typeof signalData>;

/** A helper's signed request to help a paired host (see `@remote-assist/crypto`). */
export const sessionRequest = z.object({
  from: deviceId,
  to: deviceId,
  nonce,
  ts: z.number().int(),
  sig: signature,
});
export type SessionRequest = z.infer<typeof sessionRequest>;

export const iceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServer>;

export const clientMessage = z.discriminatedUnion('t', [
  /** First message: the server's challenge, signed with the device key. */
  z.object({
    t: z.literal('auth'),
    v: z.literal(PROTOCOL_VERSION),
    device: deviceId,
    role: deviceRole,
    name: displayName,
    sig: signature,
  }),
  /** Host: start a one-time code session. */
  z.object({ t: z.literal('host.open') }),
  /** Helper: join a one-time code session. */
  z.object({ t: z.literal('helper.join'), code: sessionCode }),
  /** Host: start pairing and get a code. */
  z.object({ t: z.literal('pair.open') }),
  /** Helper: pair using the code the host showed. */
  z.object({ t: z.literal('pair.redeem'), code: sessionCode }),
  /** Either side: the person checked the three words and they match. */
  z.object({ t: z.literal('pair.confirm'), peer: deviceId }),
  z.object({ t: z.literal('pair.cancel') }),
  /** An already paired helper approves (or refuses) someone new pairing with the same host. */
  z.object({
    t: z.literal('pair.approve'),
    host: deviceId,
    helper: deviceId,
    approve: z.boolean(),
  }),
  /** Either side: forget a pairing. */
  z.object({ t: z.literal('pair.remove'), peer: deviceId }),
  /** Helper: ask to help a paired host. */
  z.object({ t: z.literal('session.request'), request: sessionRequest }),
  /** Either side: pass WebRTC negotiation to the other side. */
  z.object({ t: z.literal('signal'), data: signalData }),
  z.object({ t: z.literal('leave') }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;
export type AuthMessage = Extract<ClientMessage, { t: 'auth' }>;

export const errorReason = z.enum([
  'bad-message',
  'unauthenticated',
  'invalid-code',
  'code-expired',
  'rate-limited',
  'not-in-session',
  'server-busy',
  'not-paired',
  'peer-offline',
  'busy',
  'not-approved',
  'pairing-cancelled',
]);
export type ErrorReason = z.infer<typeof errorReason>;

const pairedPeer = z.object({ id: deviceId, name: displayName, role: deviceRole });
export type PairedPeer = z.infer<typeof pairedPeer>;

export const serverMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('challenge'), nonce }),
  /** Signed in. `peers`: the devices paired with this one, and whether they are online. */
  z.object({
    t: z.literal('authed'),
    device: deviceId,
    peers: z.array(z.object({ id: deviceId, online: z.boolean() })),
  }),
  z.object({ t: z.literal('presence'), peer: deviceId, online: z.boolean() }),
  z.object({ t: z.literal('code'), code: sessionCode, expiresAt: z.number() }),
  /** `needsApproval`: someone is already paired, so one of them must approve a new helper. */
  z.object({
    t: z.literal('pair.code'),
    code: sessionCode,
    expiresAt: z.number(),
    needsApproval: z.boolean(),
  }),
  /** Waiting for an already paired helper to approve. */
  z.object({ t: z.literal('pair.pending') }),
  /** Both sides: who is on the other end. Each device now shows the three words. */
  z.object({ t: z.literal('pair.matched'), peer: pairedPeer }),
  /** To already paired helpers: someone new wants to pair with this host. */
  z.object({
    t: z.literal('pair.approval'),
    host: deviceId,
    helper: z.object({ id: deviceId, name: displayName }),
  }),
  /** Both confirmed: the server has recorded the pairing. */
  z.object({ t: z.literal('pair.done'), peer: deviceId }),
  z.object({ t: z.literal('pair.removed'), peer: deviceId }),
  /**
   * Both sides: the other side is here. ICE servers include short-lived TURN credentials.
   * In paired sessions `peer` is the other device, and the host also gets the signed `request`.
   */
  z.object({
    t: z.literal('paired'),
    iceServers: z.array(iceServer),
    peer: deviceId.optional(),
    request: sessionRequest.optional(),
  }),
  z.object({ t: z.literal('signal'), data: signalData }),
  z.object({ t: z.literal('peer.left') }),
  z.object({ t: z.literal('error'), reason: errorReason, message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessage>;

export function parseClientMessage(text: string): ClientMessage | null {
  return parseJson(text, clientMessage);
}

export function parseServerMessage(text: string): ServerMessage | null {
  return parseJson(text, serverMessage);
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** "48271953" → "4827 1953" */
export function formatSessionCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

/** Accepts what people type ("4827 1953", "4827-1953") and keeps the digits. */
export function normalizeSessionCode(input: string): string {
  return input.replace(/\D/g, '');
}

/** What the client reports: server messages, plus `closed` when the connection drops. */
export type SignalingEvent = ServerMessage | { t: 'closed' };

const CONNECT_TIMEOUT_MS = 10_000;

export interface SignalingClientOptions {
  url: string;
  onEvent(event: SignalingEvent): void;
  /** Answers the server's challenge with a signed `auth` message. */
  authenticate(nonce: string): AuthMessage;
}

/** A WebSocket connection to the signaling server. Works wherever a global `WebSocket` exists. */
export class SignalingClient {
  private readonly options: SignalingClientOptions;
  private socket: WebSocket | null = null;

  constructor(options: SignalingClientOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Connects and signs in. Rejects if the server can't be reached or refuses the device. */
  async connect(): Promise<void> {
    this.close();
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        socket.close();
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail('The Remote Assist server did not answer.'),
        CONNECT_TIMEOUT_MS,
      );
      socket.addEventListener('error', () => fail('Could not reach the Remote Assist server.'), {
        once: true,
      });
      socket.addEventListener('message', ({ data }) => {
        const message = typeof data === 'string' ? parseServerMessage(data) : null;
        if (!message) return;
        if (message.t === 'challenge') {
          socket.send(JSON.stringify(this.options.authenticate(message.nonce)));
          return;
        }
        if (message.t === 'authed') {
          clearTimeout(timer);
          resolve();
        } else if (message.t === 'error' && message.reason === 'unauthenticated') {
          fail('The server did not accept this device.');
          return;
        }
        if (this.socket === socket) this.options.onEvent(message);
      });
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.options.onEvent({ t: 'closed' });
      });
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** Closes without reporting `closed`: the caller asked for it. */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
