/**
 * Signaling protocol between the apps and the server (JSON over WebSocket), and a small client.
 *
 * Phase 2 flow: the host asks for a session code, the helper joins with it, and the server relays
 * WebRTC offers, answers and ICE candidates between the two. Media never touches the server.
 *
 * This file is imported by the server, which Node runs as TypeScript directly, so it keeps to
 * erasable syntax and has no relative imports.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** Eight digits, read aloud over the phone ("4827 1953"). */
export const sessionCode = z.string().regex(/^\d{8}$/);

const sdp = z.string().min(1).max(20_000);

const iceCandidate = z.object({
  candidate: z.string().max(1_000),
  sdpMid: z.string().max(64).nullish(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullish(),
  usernameFragment: z.string().max(256).nullish(),
});

export const signalData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), sdp }),
  z.object({ kind: z.literal('answer'), sdp }),
  z.object({ kind: z.literal('candidate'), candidate: iceCandidate }),
]);
export type SignalData = z.infer<typeof signalData>;

export const iceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServer>;

export const clientMessage = z.discriminatedUnion('t', [
  /** Host: start a session and get a code to read to the helper. */
  z.object({ t: z.literal('host.open'), v: z.literal(PROTOCOL_VERSION) }),
  /** Helper: join the session with the code the host read out. */
  z.object({ t: z.literal('helper.join'), v: z.literal(PROTOCOL_VERSION), code: sessionCode }),
  /** Either side: pass WebRTC negotiation to the other side. */
  z.object({ t: z.literal('signal'), data: signalData }),
  z.object({ t: z.literal('leave') }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

export const errorReason = z.enum([
  'bad-message',
  'invalid-code',
  'code-expired',
  'rate-limited',
  'not-in-session',
  'server-busy',
]);
export type ErrorReason = z.infer<typeof errorReason>;

export const serverMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('code'), code: sessionCode, expiresAt: z.number() }),
  /** Both sides: the other side is here. ICE servers include short-lived TURN credentials. */
  z.object({ t: z.literal('paired'), iceServers: z.array(iceServer) }),
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

/** A WebSocket connection to the signaling server. Works wherever a global `WebSocket` exists. */
export class SignalingClient {
  private readonly url: string;
  private readonly onEvent: (event: SignalingEvent) => void;
  private socket: WebSocket | null = null;

  constructor(url: string, onEvent: (event: SignalingEvent) => void) {
    this.url = url;
    this.onEvent = onEvent;
  }

  /** Connects and sends `first`. Rejects if the server cannot be reached. */
  async open(first: ClientMessage): Promise<void> {
    this.close();
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('The Remote Assist server did not answer.'));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true });
      socket.addEventListener(
        'error',
        () => (clearTimeout(timer), reject(new Error('Could not reach the Remote Assist server.'))),
        { once: true },
      );
    });
    socket.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string') return;
      const message = parseServerMessage(data);
      if (message) this.onEvent(message);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onEvent({ t: 'closed' });
    });
    this.send(first);
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
