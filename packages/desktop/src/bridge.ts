import {
  ReplayGuard,
  checkSessionRequest,
  confirmationWords,
  createSessionRequest,
  signText,
  signedText,
  verifyText,
  type Identity,
  type SignedSessionRequest,
} from '@remote-assist/crypto';
import {
  PROTOCOL_VERSION,
  SignalingClient,
  displayName,
  sessionCode,
  signalData,
  type ClientMessage,
  type DeviceRole,
  type ErrorReason,
  type SignalData,
  type SignalingEvent,
} from '@remote-assist/protocol';
import {
  PeopleChannels,
  SessionChannels,
  type ApprovalRequest,
  type PairingState,
  type PeopleState,
  type SessionEvent,
  type TrustedPeer,
} from './channels';
import type { Settings, TrustStore } from './stores';

export type Handle = (channel: string, listener: (...args: unknown[]) => unknown) => void;

export interface ServerBridgeOptions {
  url: string;
  role: DeviceRole;
  identity: Identity;
  trust: TrustStore;
  settings: Settings;
  defaultName: string;
  /** Registers an IPC handler that only answers this app's window. */
  handle: Handle;
  /** Sends an IPC message to this app's window. */
  toWindow(channel: string, payload: unknown): void;
  /** One-time code sessions (development and tests); off in normal use. */
  allowCodeSessions: boolean;
  /** Helper: make sure it's really the owner before asking to help (Touch ID). */
  confirmRequest?(peer: TrustedPeer): Promise<boolean>;
  /** Something needs the person's attention: a pairing to confirm, a request, an approval. */
  onAttention?(): void;
}

const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Errors that end a pairing in progress rather than a session. */
const PAIRING_ERRORS = new Set<ErrorReason>([
  'invalid-code',
  'code-expired',
  'rate-limited',
  'pairing-cancelled',
  'not-approved',
]);

type StoredPeer = Omit<TrustedPeer, 'online'>;

/**
 * Each app's connection to the server, run in its main process: the device key never reaches
 * the window. It stays signed in (reconnecting when needed), runs pairing, and guards sessions:
 * - a host only accepts session requests signed by a helper it pinned, fresh and not replayed;
 * - in paired sessions, offers and answers are signed by the sender's key and checked by the
 *   receiver, so nobody in between (not even the server) can swap in their own connection.
 * Anything that fails a check ends the session ("fail closed").
 */
export class ServerBridge {
  private readonly options: ServerBridgeOptions;
  private readonly guard = new ReplayGuard();
  private client: SignalingClient | null = null;
  private connection: PeopleState['connection'] = 'connecting';
  private online = new Set<string>();
  private pairing: PairingState = { step: 'idle' };
  private pairingCode: string | null = null;
  private matchedPeer: { id: string; name: string; role: DeviceRole } | null = null;
  private approvals: ApprovalRequest[] = [];
  /** The current session: whose key its offers and answers must be signed with, if paired. */
  private session: { peer: StoredPeer | null; nonce: string | null } | null = null;
  private pendingRequest: SignedSessionRequest | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(options: ServerBridgeOptions) {
    this.options = options;
    this.registerHandlers();
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.client?.close();
    this.client = null;
  }

  state(): PeopleState {
    return {
      device: this.options.identity.id,
      name: this.name,
      named: this.options.settings.name !== undefined,
      connection: this.connection,
      peers: this.options.trust
        .list()
        .map((peer) => ({ ...peer, online: this.online.has(peer.id) })),
      pairing: this.pairing,
      approvals: this.approvals,
    };
  }

  private get name(): string {
    return this.options.settings.name ?? this.options.defaultName;
  }

  // Connection

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setConnection('connecting');
    const { identity, role } = this.options;
    const client = new SignalingClient({
      url: this.options.url,
      onEvent: (event) => this.onEvent(client, event),
      authenticate: (nonce) => ({
        t: 'auth',
        v: PROTOCOL_VERSION,
        device: identity.id,
        role,
        name: this.name,
        sig: signText(identity, signedText.auth(nonce)),
      }),
    });
    this.client = client;
    try {
      await client.connect();
      this.retries = 0;
    } catch {
      if (this.client === client) this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.setConnection('offline');
    clearTimeout(this.retryTimer);
    const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries += 1;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private reconnect(): void {
    clearTimeout(this.retryTimer);
    this.client?.close();
    this.client = null;
    this.retries = 0;
    void this.connect();
  }

  private send(message: ClientMessage): void {
    this.client?.send(message);
  }

  private requireOnline(): void {
    if (this.connection !== 'online' || !this.client?.connected) {
      throw new Error('Not connected to the Remote Assist server. Check the internet connection.');
    }
  }

  // Server events

  private onEvent(client: SignalingClient, event: SignalingEvent): void {
    if (client !== this.client) return;
    switch (event.t) {
      case 'authed':
        this.online = new Set(event.peers.filter((peer) => peer.online).map((peer) => peer.id));
        // Pairings this device removed while offline: tell the server now.
        for (const peer of event.peers) {
          if (!this.options.trust.get(peer.id)) client.send({ t: 'pair.remove', peer: peer.id });
        }
        this.setConnection('online');
        return;
      case 'closed':
        this.online.clear();
        if (this.isPairing())
          this.setPairing({ step: 'failed', message: 'The connection was lost.' });
        this.forward(event);
        this.scheduleRetry();
        return;
      case 'presence':
        if (event.online) this.online.add(event.peer);
        else this.online.delete(event.peer);
        this.pushState();
        return;
      case 'pair.code':
        this.pairingCode = event.code;
        this.setPairing({ step: 'code', code: event.code, needsApproval: event.needsApproval });
        return;
      case 'pair.pending':
        this.setPairing({ step: 'waiting-approval' });
        return;
      case 'pair.matched':
        return this.onMatched(event.peer);
      case 'pair.done':
        return this.onPairingDone(event.peer);
      case 'pair.removed':
        this.options.trust.remove(event.peer);
        this.online.delete(event.peer);
        this.pushState();
        return;
      case 'pair.approval': {
        const host = this.options.trust.get(event.host);
        if (!host) return;
        this.approvals = [
          ...this.approvals.filter((a) => a.host !== event.host || a.helper.id !== event.helper.id),
          { host: event.host, hostName: host.name, helper: event.helper },
        ];
        this.pushState();
        this.options.onAttention?.();
        return;
      }
      case 'error':
        if (this.isPairing() && PAIRING_ERRORS.has(event.reason)) {
          this.setPairing({ step: 'failed', message: event.message });
          return;
        }
        break;
      case 'paired':
        return this.onPaired(client, event);
      case 'signal':
        if (!this.checkSignal(client, event.data)) return;
        break;
      case 'peer.left':
        this.session = null;
        break;
    }
    this.forward(event);
  }

  private onMatched(peer: { id: string; name: string; role: DeviceRole }): void {
    const code = this.pairingCode;
    if (!code) return;
    const me = this.options.identity.id;
    const [host, helper] = this.options.role === 'host' ? [me, peer.id] : [peer.id, me];
    this.matchedPeer = peer;
    this.setPairing({
      step: 'confirm',
      peer: { id: peer.id, name: peer.name },
      words: confirmationWords(host, helper, code),
    });
    this.options.onAttention?.();
  }

  private onPairingDone(peerId: string): void {
    const peer = this.matchedPeer;
    if (!peer || peer.id !== peerId) return;
    const stored = { id: peer.id, name: peer.name, role: peer.role, pairedAt: Date.now() };
    this.options.trust.add(stored);
    this.online.add(peer.id);
    this.pairingCode = null;
    this.matchedPeer = null;
    this.setPairing({ step: 'done', peer: { ...stored, online: true } });
  }

  private onPaired(client: SignalingClient, event: Extract<SignalingEvent, { t: 'paired' }>): void {
    const { trust, identity } = this.options;
    if (event.request) {
      // Host: only a fresh request, signed by a helper this computer paired with, counts.
      const check = checkSessionRequest(
        event.request,
        identity.id,
        (id) => trust.get(id)?.role === 'helper',
        this.guard,
      );
      const peer = trust.get(event.request.from);
      if (check !== 'ok' || !peer) {
        console.warn(`Refused a session request: ${check}`);
        client.send({ t: 'leave' });
        return;
      }
      this.session = { peer, nonce: event.request.nonce };
      this.forward({ t: 'verified', peer: { id: peer.id, name: peer.name } });
      this.options.onAttention?.();
    } else if (event.peer) {
      // Helper: the room it asked for, with the host it asked about.
      const peer = trust.get(event.peer);
      const request = this.pendingRequest;
      if (!peer || !request || request.to !== event.peer) {
        client.send({ t: 'leave' });
        return;
      }
      this.session = { peer, nonce: request.nonce };
      this.pendingRequest = null;
    } else {
      // A one-time code session: there is no pinned key to check against.
      this.session = { peer: null, nonce: null };
    }
    this.forward(event);
  }

  /** In paired sessions, offers and answers must carry the peer's signature. */
  private checkSignal(client: SignalingClient, data: SignalData): boolean {
    if (data.kind !== 'offer' && data.kind !== 'answer') return true;
    const session = this.session;
    if (!session?.peer || !session.nonce) return true;
    const text = signedText.sdp(session.nonce, data.kind, data.sdp);
    if (data.sig && verifyText(session.peer.id, text, data.sig)) return true;
    client.send({ t: 'leave' });
    this.session = null;
    this.forward({
      t: 'tampered',
      message:
        'The connection details were changed on the way, so the session was stopped for safety.',
    });
    return false;
  }

  // Window

  private registerHandlers(): void {
    const { handle, role, trust, identity } = this.options;

    handle(SessionChannels.signal, (data) => {
      const parsed = signalData.safeParse(data);
      if (!parsed.success) throw new Error('Invalid signaling data');
      let message = parsed.data;
      const session = this.session;
      if (
        (message.kind === 'offer' || message.kind === 'answer') &&
        session?.peer &&
        session.nonce
      ) {
        const text = signedText.sdp(session.nonce, message.kind, message.sdp);
        message = { ...message, sig: signText(identity, text) };
      }
      this.send({ t: 'signal', data: message });
    });
    handle(SessionChannels.leave, () => {
      this.send({ t: 'leave' });
      this.session = null;
      this.pendingRequest = null;
    });

    if (role === 'host') {
      handle(SessionChannels.host, () => {
        if (!this.options.allowCodeSessions) throw new Error('One-time codes are turned off.');
        this.requireOnline();
        this.send({ t: 'host.open' });
      });
    } else {
      handle(SessionChannels.join, (code) => {
        if (!this.options.allowCodeSessions) throw new Error('One-time codes are turned off.');
        const parsed = sessionCode.safeParse(code);
        if (!parsed.success) throw new Error('A session code has 8 digits.');
        this.requireOnline();
        this.send({ t: 'helper.join', code: parsed.data });
      });
      handle(SessionChannels.request, async (peerId) => {
        const peer = trust.get(String(peerId));
        if (!peer || peer.role !== 'host')
          throw new Error('You are not paired with this computer.');
        this.requireOnline();
        const confirm = this.options.confirmRequest;
        if (confirm && !(await confirm({ ...peer, online: this.online.has(peer.id) }))) {
          throw new Error("Couldn't confirm it's you, so nothing was sent.");
        }
        const request = createSessionRequest(identity, peer.id);
        this.pendingRequest = request;
        this.send({ t: 'session.request', request });
      });
    }

    handle(PeopleChannels.get, () => this.state());
    handle(PeopleChannels.startPairing, () => {
      if (role !== 'host') throw new Error('Only the computer being helped shows a code.');
      this.requireOnline();
      this.pairingCode = null;
      this.send({ t: 'pair.open' });
    });
    handle(PeopleChannels.redeemPairing, (code) => {
      if (role !== 'helper') throw new Error('Only a helper enters a pairing code.');
      const parsed = sessionCode.safeParse(code);
      if (!parsed.success) throw new Error('A pairing code has 8 digits.');
      this.requireOnline();
      this.pairingCode = parsed.data;
      this.setPairing({ step: 'redeeming' });
      this.send({ t: 'pair.redeem', code: parsed.data });
    });
    handle(PeopleChannels.confirmPairing, (match) => {
      if (this.pairing.step !== 'confirm') return;
      const peer = this.pairing.peer;
      if (match === true) {
        this.send({ t: 'pair.confirm', peer: peer.id });
        this.setPairing({ step: 'confirmed', peer });
      } else {
        this.send({ t: 'pair.cancel' });
        this.setPairing({
          step: 'failed',
          message:
            'The words did not match, so nothing was paired. Try once more; if they differ again, stop: someone may be interfering.',
        });
      }
    });
    handle(PeopleChannels.cancelPairing, () => {
      if (this.isPairing()) this.send({ t: 'pair.cancel' });
      this.pairingCode = null;
      this.matchedPeer = null;
      this.setPairing({ step: 'idle' });
    });
    handle(PeopleChannels.remove, (id) => {
      const peerId = String(id);
      trust.remove(peerId);
      this.online.delete(peerId);
      // If offline, the server hears about it on the next sign-in.
      this.send({ t: 'pair.remove', peer: peerId });
      this.pushState();
    });
    handle(PeopleChannels.rename, (id, name) => {
      const parsed = displayName.safeParse(name);
      if (!parsed.success) throw new Error('A name has 1 to 40 characters.');
      trust.rename(String(id), parsed.data);
      this.pushState();
    });
    handle(PeopleChannels.answerApproval, (host, helper, approve) => {
      const hostId = String(host);
      const helperId = String(helper);
      this.approvals = this.approvals.filter((a) => a.host !== hostId || a.helper.id !== helperId);
      this.send({ t: 'pair.approve', host: hostId, helper: helperId, approve: approve === true });
      this.pushState();
    });
    handle(PeopleChannels.setName, (name) => {
      const parsed = displayName.safeParse(name);
      if (!parsed.success) throw new Error('A name has 1 to 40 characters.');
      if (parsed.data === this.name) return;
      this.options.settings.name = parsed.data;
      this.reconnect();
      this.pushState();
    });
  }

  private forward(event: SessionEvent): void {
    this.options.toWindow(SessionChannels.event, event);
  }

  private isPairing(): boolean {
    return !['idle', 'done', 'failed'].includes(this.pairing.step);
  }

  private setPairing(pairing: PairingState): void {
    this.pairing = pairing;
    this.pushState();
  }

  private setConnection(connection: PeopleState['connection']): void {
    this.connection = connection;
    this.pushState();
  }

  private pushState(): void {
    this.options.toWindow(PeopleChannels.state, this.state());
  }
}
