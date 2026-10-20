import type { SessionEvent } from '@remote-assist/desktop/channels';
import {
  encodePointerMove,
  parsePeerMessage,
  type IceServer,
  type InputEvent,
  type PeerMessage,
  type SignalData,
} from '@remote-assist/protocol';
import {
  candidateInit,
  createPeerConnection,
  preferVideoCodecs,
  tuneReceiver,
} from '@remote-assist/rtc';

/** What the host reported about remote control: available, or why not. */
export type ControlState = Omit<Extract<PeerMessage, { t: 'control' }>, 't'>;

export type HelperState =
  | { name: 'contacting' }
  /** Paired: the person is being asked whether to let you help. */
  | { name: 'waiting' }
  | { name: 'connecting' }
  | {
      name: 'live';
      reconnecting: boolean;
      stream: MediaStream | null;
      control: ControlState | null;
      /** Only the person you help can pause, and only they can continue. */
      paused: boolean;
      /** When an idle session will end, if nothing happens before then. */
      idleEndsAt: number | null;
    }
  | { name: 'ended'; message: string; wasLive: boolean };

export interface HelperSessionOptions {
  forceRelay: boolean;
  machine: string;
  /** Shown on the consent question on their screen. */
  name: string;
}

/** How long a dropped connection may take to come back (the host restarts ICE) before ending. */
const RECONNECT_GRACE_MS = 15_000;

const DECLINED: Record<Extract<SignalData, { kind: 'declined' }>['reason'], string> = {
  no: 'They said no, so nothing was shared.',
  timeout: "They didn't answer in time, so nothing was shared.",
  unavailable:
    "They said yes, but their Mac didn't allow screen sharing. Talk them through Privacy & Security, then Screen Recording, in System Settings.",
};

/** The helper's side of one session: joins with the host's code and receives the screen. */
export class HelperSession {
  private readonly options: HelperSessionOptions;
  private readonly listeners = new Set<() => void>();
  private readonly stopListening: () => void;
  private state: HelperState = { name: 'contacting' };
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private control: ControlState | null = null;
  private paused = false;
  private idleEndsAt: number | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private pointerChannel: RTCDataChannel | null = null;
  private wasLive = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(options: HelperSessionOptions) {
    this.options = options;
    this.stopListening = window.helperApi.onSessionEvent(this.onEvent);
  }

  /** Asks a paired computer: the person there is asked whether to let you help. */
  static request(peerId: string, options: HelperSessionOptions): HelperSession {
    const session = new HelperSession(options);
    window.helperApi
      .requestSession(peerId)
      .catch((error: unknown) => session.end(friendlyError(error)));
    return session;
  }

  /** Joins a one-time code session. */
  static join(code: string, options: HelperSessionOptions): HelperSession {
    const session = new HelperSession(options);
    window.helperApi.joinSession(code).catch((error: unknown) => session.end(friendlyError(error)));
    return session;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): HelperState => this.state;

  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  disconnect(): void {
    this.sendInput({ t: 'release' });
    this.sendPeer({ t: 'end' });
    this.end('You disconnected.');
  }

  /** Pointer moves go on the unordered channel: a lost one is overtaken by the next. */
  sendPointer(x: number, y: number): void {
    if (this.pointerChannel?.readyState === 'open') {
      this.pointerChannel.send(encodePointerMove(x, y));
    }
    this.clearIdleWarning();
  }

  sendInput(event: InputEvent): void {
    this.sendPeer(event);
    if (event.t !== 'release') this.clearIdleWarning();
  }

  private clearIdleWarning(): void {
    if (this.idleEndsAt === null) return;
    this.idleEndsAt = null;
    this.updateLive({});
  }

  private updateLive(changes: Partial<Extract<HelperState, { name: 'live' }>>): void {
    if (this.state.name === 'live') this.set({ ...this.state, ...changes });
  }

  private sendPeer(message: PeerMessage): void {
    if (this.controlChannel?.readyState === 'open') {
      this.controlChannel.send(JSON.stringify(message));
    }
  }

  private onPeerMessage(data: unknown): void {
    const message = typeof data === 'string' ? parsePeerMessage(data) : null;
    if (message?.t === 'end') {
      this.end('They stopped sharing their screen.');
    } else if (message?.t === 'control') {
      this.control = {
        available: message.available,
        ...(message.reason ? { reason: message.reason } : {}),
      };
      this.updateLive({ control: this.control });
    } else if (message?.t === 'paused') {
      this.paused = message.paused;
      this.idleEndsAt = null;
      this.updateLive({ paused: this.paused, idleEndsAt: null });
    } else if (message?.t === 'idle') {
      this.idleEndsAt = Date.now() + message.secondsLeft * 1000;
      this.updateLive({ idleEndsAt: this.idleEndsAt });
    }
  }

  private readonly onEvent = (event: SessionEvent): void => {
    if (this.state.name === 'ended') return;
    switch (event.t) {
      case 'paired':
        this.connect(event.iceServers);
        void window.helperApi.sendSignal({ kind: 'intro', name: this.options.name });
        this.set({ name: 'waiting' });
        break;
      case 'signal':
        if (event.data.kind === 'declined') {
          this.end(DECLINED[event.data.reason]);
        } else {
          void this.onSignal(event.data);
        }
        break;
      // Once live, the video connection no longer needs the server.
      case 'peer.left':
        if (!this.wasLive) this.end('They cancelled before you connected.');
        break;
      case 'error':
        if (!this.wasLive) this.end(event.message);
        break;
      case 'closed':
        if (!this.wasLive) this.end('Lost contact with the Remote Assist server.');
        break;
      case 'tampered':
        this.end(event.message);
        break;
      case 'code':
      case 'verified':
        break;
    }
  };

  private connect(iceServers: IceServer[]): void {
    const pc = createPeerConnection(iceServers, this.options.forceRelay ? 'relay' : 'all');
    this.pc = pc;
    pc.addEventListener('track', (event) => {
      tuneReceiver(event.receiver);
      this.stream = event.streams[0] ?? new MediaStream([event.track]);
      if (this.state.name === 'live') this.set({ ...this.state, stream: this.stream });
    });
    pc.addEventListener('datachannel', ({ channel }) => {
      if (channel.label === 'ctl') {
        this.controlChannel = channel;
        channel.addEventListener('message', ({ data }) => this.onPeerMessage(data));
        channel.addEventListener('open', () =>
          this.sendPeer({ t: 'hello', machine: this.options.machine }),
        );
      } else if (channel.label === 'ptr') {
        this.pointerChannel = channel;
      }
    });
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        void window.helperApi.sendSignal({
          kind: 'candidate',
          candidate: candidateInit(candidate),
        });
      }
    });
    pc.addEventListener('connectionstatechange', () => this.onConnectionState());
  }

  private async onSignal(data: SignalData): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (data.kind === 'offer') {
        const first = !pc.remoteDescription;
        // The first offer means they said yes.
        if (this.state.name === 'waiting') this.set({ name: 'connecting' });
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const transceiver = pc.getTransceivers()[0];
        if (first && transceiver) preferVideoCodecs(transceiver, 'receive');
        await pc.setLocalDescription();
        const sdp = pc.localDescription?.sdp;
        if (sdp) await window.helperApi.sendSignal({ kind: 'answer', sdp });
        for (const candidate of this.pendingCandidates.splice(0))
          await pc.addIceCandidate(candidate);
      } else if (data.kind === 'candidate') {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else this.pendingCandidates.push(data.candidate);
      }
    } catch (error) {
      console.error('Negotiation step failed', error);
    }
  }

  private onConnectionState(): void {
    const pc = this.pc;
    if (!pc || this.state.name === 'ended') return;
    const state = pc.connectionState;
    if (state === 'connected') {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      this.wasLive = true;
      this.set(this.liveState(false));
    } else if (state === 'disconnected' || state === 'failed') {
      if (!this.wasLive) {
        if (state === 'failed') this.end('Could not connect to their computer. Try again.');
        return;
      }
      this.set(this.liveState(true));
      this.graceTimer ??= setTimeout(
        () => this.end('The connection was lost.'),
        RECONNECT_GRACE_MS,
      );
    }
  }

  private liveState(reconnecting: boolean): HelperState {
    return {
      name: 'live',
      reconnecting,
      stream: this.stream,
      control: this.control,
      paused: this.paused,
      idleEndsAt: this.idleEndsAt,
    };
  }

  private end(message: string): void {
    if (this.state.name === 'ended') return;
    clearTimeout(this.graceTimer);
    this.stopListening();
    void window.helperApi.leaveSession();
    const pc = this.pc;
    // Let a last release or goodbye message leave before the connection is torn down.
    if (pc) setTimeout(() => pc.close(), 200);
    this.set({ name: 'ended', message, wasLive: this.wasLive });
  }

  private set(state: HelperState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/** Errors thrown in the main process arrive wrapped in "Error invoking remote method …". */
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
