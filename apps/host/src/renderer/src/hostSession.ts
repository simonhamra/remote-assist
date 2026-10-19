import {
  decodePointerMove,
  isInputEvent,
  parsePeerMessage,
  type IceServer,
  type PeerMessage,
  type SignalData,
  type SignalingEvent,
} from '@remote-assist/protocol';
import {
  candidateInit,
  createPeerConnection,
  preferVideoCodecs,
  prepareScreenTrack,
  screenCaptureOptions,
  startFakeScreen,
  tuneSender,
  type ScreenSource,
} from '@remote-assist/rtc';
import type { ControlStatus } from '../../shared/api';

export type HostState =
  | { name: 'contacting' }
  | { name: 'waiting'; code: string }
  | { name: 'connecting' }
  | { name: 'live'; reconnecting: boolean; control: ControlStatus | null }
  | { name: 'ended'; message: string };

/** How long a dropped connection may take to come back before the session ends. */
const RECONNECT_GRACE_MS = 15_000;
/** How long ICE may stay disconnected before asking for fresh candidates. */
const ICE_RESTART_DELAY_MS = 2_000;

/**
 * One screen-sharing session: capture, the server connection (through the main process) and
 * the peer connection. The host always makes the offers, including ICE restarts.
 */
export class HostSession {
  readonly source: ScreenSource;
  private readonly forceRelay: boolean;
  private readonly listeners = new Set<() => void>();
  private readonly stopListening: () => void;
  private state: HostState = { name: 'contacting' };
  private pc: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private control: RTCDataChannel | null = null;
  private controlStatus: ControlStatus | null = null;
  /** From the helper's `hello`; control stays off until it has arrived. */
  private helperMachine: string | null = null;
  private tuned = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(source: ScreenSource, forceRelay: boolean) {
    this.source = source;
    this.forceRelay = forceRelay;
    this.stopListening = window.hostApi.onSessionEvent(this.onEvent);
    source.stream
      .getVideoTracks()[0]
      ?.addEventListener('ended', () => this.end('Screen sharing was stopped outside the app.'));
  }

  /** Starts capturing, then asks the server for a code. Call it straight from a click handler. */
  static async start(options: { fakeScreen: boolean; forceRelay: boolean }): Promise<HostSession> {
    const source = options.fakeScreen ? startFakeScreen() : await captureScreen();
    const session = new HostSession(source, options.forceRelay);
    window.hostApi.startSession().catch((error: unknown) => session.end(friendlyError(error)));
    return session;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): HostState => this.state;

  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  stop(): void {
    this.end('You stopped sharing your screen.');
  }

  /** Turns the helper's mouse and keyboard on, and tells the helper whether that works. */
  async refreshControl(): Promise<void> {
    if (this.state.name !== 'live' || !this.helperMachine) return;
    const status = await window.hostApi.setRemoteControl(true, this.helperMachine);
    if (this.state.name !== 'live') return;
    this.controlStatus = status;
    this.set({ ...this.state, control: status });
    this.sendPeer({ t: 'control', ...status });
  }

  private readonly onEvent = (event: SignalingEvent): void => {
    if (this.state.name === 'ended') return;
    const live = this.state.name === 'live';
    switch (event.t) {
      case 'code':
        this.set({ name: 'waiting', code: event.code });
        break;
      case 'paired':
        this.connect(event.iceServers);
        break;
      case 'signal':
        void this.onSignal(event.data);
        break;
      // Once live, the video connection no longer needs the server.
      case 'peer.left':
        if (!live) this.end('Your helper left before connecting.');
        break;
      case 'error':
        if (!live) this.end(event.message);
        break;
      case 'closed':
        if (!live) this.end('Lost contact with the Remote Assist server.');
        break;
    }
  };

  private connect(iceServers: IceServer[]): void {
    const track = this.source.stream.getVideoTracks()[0];
    if (!track) return this.end('The screen capture has no video.');
    prepareScreenTrack(track);

    const pc = createPeerConnection(iceServers, this.forceRelay ? 'relay' : 'all');
    this.pc = pc;
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [this.source.stream],
    });
    preferVideoCodecs(transceiver, 'send');
    this.sender = transceiver.sender;
    const control = pc.createDataChannel('ctl', { ordered: true });
    this.control = control;
    control.addEventListener('message', ({ data }) => this.onPeerMessage(data));
    control.addEventListener('open', () => {
      if (this.controlStatus) this.sendPeer({ t: 'control', ...this.controlStatus });
    });
    // Pointer moves: unordered and never retransmitted, so a late one can't hold up newer ones.
    const pointer = pc.createDataChannel('ptr', { ordered: false, maxRetransmits: 0 });
    pointer.binaryType = 'arraybuffer';
    pointer.addEventListener('message', ({ data }) => {
      const move = decodePointerMove(data);
      if (move && this.state.name === 'live') window.hostApi.sendInput({ t: 'move', ...move });
    });

    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        void window.hostApi.sendSignal({ kind: 'candidate', candidate: candidateInit(candidate) });
      }
    });
    // Fires for the first offer and again after every restartIce().
    pc.addEventListener('negotiationneeded', () => void this.offer());
    pc.addEventListener('connectionstatechange', () => this.onConnectionState());
    this.set({ name: 'connecting' });
  }

  private onPeerMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    const message = parsePeerMessage(data);
    if (!message) return;
    if (message.t === 'end') {
      this.end('Your helper disconnected.');
    } else if (message.t === 'hello') {
      this.helperMachine = message.machine;
      void this.refreshControl();
    } else if (isInputEvent(message) && this.state.name === 'live') {
      window.hostApi.sendInput(message);
    }
  }

  private sendPeer(message: PeerMessage): void {
    if (this.control?.readyState === 'open') this.control.send(JSON.stringify(message));
  }

  private async offer(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      await pc.setLocalDescription();
      const sdp = pc.localDescription?.sdp;
      if (sdp) await window.hostApi.sendSignal({ kind: 'offer', sdp });
    } catch (error) {
      console.error('Could not create an offer', error);
    }
  }

  private async onSignal(data: SignalData): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (data.kind === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        for (const candidate of this.pendingCandidates.splice(0))
          await pc.addIceCandidate(candidate);
        if (!this.tuned && this.sender) {
          this.tuned = true;
          await tuneSender(this.sender);
        }
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
      clearTimeout(this.restartTimer);
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      const firstTime = this.state.name !== 'live';
      this.set({ name: 'live', reconnecting: false, control: this.controlStatus });
      if (firstTime) void this.refreshControl();
    } else if (state === 'disconnected' || state === 'failed') {
      if (this.state.name !== 'live') {
        if (state === 'failed') {
          this.end(
            "Could not connect to your helper's computer. Try again; if it keeps failing, your networks may need the relay server.",
          );
        }
        return;
      }
      // Nothing may stay pressed while the helper can't see what it is doing.
      window.hostApi.sendInput({ t: 'release' });
      this.set({ name: 'live', reconnecting: true, control: this.controlStatus });
      // After a network change (Wi-Fi to hotspot) only fresh ICE candidates can reconnect.
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(
        () => pc.restartIce(),
        state === 'failed' ? 0 : ICE_RESTART_DELAY_MS,
      );
      this.graceTimer ??= setTimeout(
        () => this.end('The connection was lost.'),
        RECONNECT_GRACE_MS,
      );
    }
  }

  private end(message: string): void {
    if (this.state.name === 'ended') return;
    clearTimeout(this.restartTimer);
    clearTimeout(this.graceTimer);
    this.sendPeer({ t: 'end' });
    void window.hostApi.setRemoteControl(false);
    this.stopListening();
    void window.hostApi.leaveSession();
    this.source.stop();
    const pc = this.pc;
    // Let the goodbye message leave before the connection is torn down.
    if (pc) setTimeout(() => pc.close(), 200);
    this.set({ name: 'ended', message });
  }

  private set(state: HostState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

async function captureScreen(): Promise<ScreenSource> {
  const stream = await navigator.mediaDevices.getDisplayMedia(screenCaptureOptions());
  return { stream, stop: () => stream.getTracks().forEach((track) => track.stop()) };
}

/** Errors thrown in the main process arrive wrapped in "Error invoking remote method …". */
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
