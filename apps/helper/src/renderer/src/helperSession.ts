import {
  encodePointerMove,
  parsePeerMessage,
  type IceServer,
  type InputEvent,
  type PeerMessage,
  type SignalData,
  type SignalingEvent,
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
  | { name: 'connecting' }
  | {
      name: 'live';
      reconnecting: boolean;
      stream: MediaStream | null;
      control: ControlState | null;
    }
  | { name: 'ended'; message: string; wasLive: boolean };

/** How long a dropped connection may take to come back (the host restarts ICE) before ending. */
const RECONNECT_GRACE_MS = 15_000;

/** The helper's side of one session: joins with the host's code and receives the screen. */
export class HelperSession {
  private readonly forceRelay: boolean;
  private readonly machine: string;
  private readonly listeners = new Set<() => void>();
  private readonly stopListening: () => void;
  private state: HelperState = { name: 'contacting' };
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private control: ControlState | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private pointerChannel: RTCDataChannel | null = null;
  private wasLive = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(forceRelay: boolean, machine: string) {
    this.forceRelay = forceRelay;
    this.machine = machine;
    this.stopListening = window.helperApi.onSessionEvent(this.onEvent);
  }

  static join(code: string, options: { forceRelay: boolean; machine: string }): HelperSession {
    const session = new HelperSession(options.forceRelay, options.machine);
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
    if (this.pointerChannel?.readyState === 'open')
      this.pointerChannel.send(encodePointerMove(x, y));
  }

  sendInput(event: InputEvent): void {
    this.sendPeer(event);
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
      if (this.state.name === 'live') this.set({ ...this.state, control: this.control });
    }
  }

  private readonly onEvent = (event: SignalingEvent): void => {
    if (this.state.name === 'ended') return;
    switch (event.t) {
      case 'paired':
        this.connect(event.iceServers);
        break;
      case 'signal':
        void this.onSignal(event.data);
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
      case 'code':
        break;
    }
  };

  private connect(iceServers: IceServer[]): void {
    const pc = createPeerConnection(iceServers, this.forceRelay ? 'relay' : 'all');
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
          this.sendPeer({ t: 'hello', machine: this.machine }),
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
    this.set({ name: 'connecting' });
  }

  private async onSignal(data: SignalData): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (data.kind === 'offer') {
        const first = !pc.remoteDescription;
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
      this.set({ name: 'live', reconnecting: false, stream: this.stream, control: this.control });
    } else if (state === 'disconnected' || state === 'failed') {
      if (!this.wasLive) {
        if (state === 'failed') this.end('Could not connect to their computer. Try again.');
        return;
      }
      this.set({ name: 'live', reconnecting: true, stream: this.stream, control: this.control });
      this.graceTimer ??= setTimeout(
        () => this.end('The connection was lost.'),
        RECONNECT_GRACE_MS,
      );
    }
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
