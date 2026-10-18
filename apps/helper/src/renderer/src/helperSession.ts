import type { IceServer, SignalData, SignalingEvent } from '@remote-assist/protocol';
import {
  candidateInit,
  createPeerConnection,
  preferVideoCodecs,
  tuneReceiver,
} from '@remote-assist/rtc';

export type HelperState =
  | { name: 'contacting' }
  | { name: 'connecting' }
  | { name: 'live'; reconnecting: boolean; stream: MediaStream | null }
  | { name: 'ended'; message: string; wasLive: boolean };

/** How long a dropped connection may take to come back (the host restarts ICE) before ending. */
const RECONNECT_GRACE_MS = 15_000;

/** The helper's side of one session: joins with the host's code and receives the screen. */
export class HelperSession {
  private readonly forceRelay: boolean;
  private readonly listeners = new Set<() => void>();
  private readonly stopListening: () => void;
  private state: HelperState = { name: 'contacting' };
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private wasLive = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(forceRelay: boolean) {
    this.forceRelay = forceRelay;
    this.stopListening = window.helperApi.onSessionEvent(this.onEvent);
  }

  static join(code: string, options: { forceRelay: boolean }): HelperSession {
    const session = new HelperSession(options.forceRelay);
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
    this.end('You disconnected.');
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
      if (channel.label !== 'ctl') return;
      channel.addEventListener('message', ({ data }) => {
        if (isEndMessage(data)) this.end('They stopped sharing their screen.');
      });
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
      this.set({ name: 'live', reconnecting: false, stream: this.stream });
    } else if (state === 'disconnected' || state === 'failed') {
      if (!this.wasLive) {
        if (state === 'failed') this.end('Could not connect to their computer. Try again.');
        return;
      }
      this.set({ name: 'live', reconnecting: true, stream: this.stream });
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
    this.pc?.close();
    this.set({ name: 'ended', message, wasLive: this.wasLive });
  }

  private set(state: HelperState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

function isEndMessage(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === 'object' && message !== null && 't' in message && message.t === 'end';
  } catch {
    return false;
  }
}

/** Errors thrown in the main process arrive wrapped in "Error invoking remote method …". */
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
