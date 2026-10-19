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
import type { ControlStatus, SessionCommand, SessionOutcome } from '../../shared/api';
import { startPausedCard } from './pausedCard';
import {
  DEFAULT_LIMITS,
  SessionTimers,
  type SessionLimits,
  type TimerEvent,
} from './sessionTimers';

export type HostState =
  | { name: 'contacting' }
  | { name: 'waiting'; code: string }
  /** Someone joined with the code: nothing is shared until the person answers. */
  | { name: 'asking'; helperName: string; secondsLeft: number }
  | { name: 'connecting'; helperName: string }
  | {
      name: 'live';
      helperName: string;
      paused: boolean;
      reconnecting: boolean;
      control: ControlStatus | null;
    }
  | { name: 'ended'; message: string };

export interface HostSessionOptions {
  fakeScreen: boolean;
  forceRelay: boolean;
  limits?: Partial<SessionLimits>;
}

/** How long a dropped connection may take to come back before the session ends. */
const RECONNECT_GRACE_MS = 15_000;
/** How long ICE may stay disconnected before asking for fresh candidates. */
const ICE_RESTART_DELAY_MS = 2_000;
/** A helper always introduces itself right after joining; this is only a fallback. */
const INTRO_WAIT_MS = 5_000;

/**
 * One help session on Grandma's side. The screen is not captured until she says yes, she alone
 * can pause and continue, and every way out (Stop, a locked screen, no activity, the time limit,
 * the helper leaving) ends it the same way: control off, capture stopped, bar removed.
 * The host always makes the WebRTC offers, including ICE restarts.
 */
export class HostSession {
  private readonly options: HostSessionOptions;
  private readonly limits: SessionLimits;
  private readonly timers: SessionTimers;
  private readonly listeners = new Set<() => void>();
  private readonly stopListening: () => void;
  private readonly stopCommands: () => void;
  private state: HostState = { name: 'contacting' };
  private source: ScreenSource | null = null;
  private pausedCard: ScreenSource | null = null;
  private iceServers: IceServer[] | null = null;
  private helperName: string | null = null;
  private askedAt = 0;
  private wasLive = false;
  private pc: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private control: RTCDataChannel | null = null;
  private controlStatus: ControlStatus | null = null;
  /** From the helper's `hello`; control stays off until it has arrived. */
  private helperMachine: string | null = null;
  private tuned = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private introTimer: ReturnType<typeof setTimeout> | undefined;
  private countdown: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(options: HostSessionOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.timers = new SessionTimers(this.limits, this.onTimer);
    this.stopListening = window.hostApi.onSessionEvent(this.onEvent);
    this.stopCommands = window.hostApi.onSessionCommand(this.onCommand);
  }

  /** Asks the server for a code. Nothing is captured yet. */
  static start(options: HostSessionOptions): HostSession {
    const session = new HostSession(options);
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

  get screen(): MediaStream | null {
    return this.source?.stream ?? null;
  }

  /** "Yes, let … help". Call it straight from the click: capturing needs that click. */
  async accept(): Promise<void> {
    if (this.state.name !== 'asking' || !this.iceServers || !this.helperName) return;
    this.timers.stopConsent();
    clearInterval(this.countdown);
    void window.hostApi.requestAttention(false);
    this.set({ name: 'connecting', helperName: this.helperName });
    try {
      this.source = this.options.fakeScreen ? startFakeScreen() : await captureScreen();
    } catch (error) {
      console.error(error);
      this.end(describeCaptureError(error), 'error');
      return;
    }
    // The person may have pressed Stop (or the helper left) while the capture was starting.
    if (this.getState().name !== 'connecting') {
      this.source.stop();
      return;
    }
    this.source.stream
      .getVideoTracks()[0]
      ?.addEventListener('ended', () =>
        this.end('Screen sharing was stopped outside the app.', 'stopped'),
      );
    this.connect(this.iceServers);
  }

  /** "No, not now". */
  decline(): void {
    this.refuse('no');
  }

  /** Cancel while waiting for a helper, or Stop during a session. */
  stop(): void {
    if (this.state.name === 'asking') this.refuse('no');
    else this.end('You stopped sharing your screen.', 'stopped');
  }

  pause(): void {
    if (this.state.name !== 'live' || this.state.paused || !this.sender) return;
    // Stop forwarding input first, then turn the gate off and hide the screen.
    this.set({ ...this.state, paused: true });
    void window.hostApi.setRemoteControl(false);
    this.pausedCard ??= startPausedCard();
    void this.sender.replaceTrack(this.pausedCard.stream.getVideoTracks()[0] ?? null);
    this.timers.pause();
    this.sendPeer({ t: 'paused', paused: true });
    this.updateChrome();
  }

  resume(): void {
    if (this.state.name !== 'live' || !this.state.paused || !this.sender || !this.source) return;
    void this.sender.replaceTrack(this.source.stream.getVideoTracks()[0] ?? null);
    this.set({ ...this.state, paused: false });
    this.timers.resume();
    this.sendPeer({ t: 'paused', paused: false });
    this.updateChrome();
    void this.refreshControl();
  }

  /** Turns the helper's mouse and keyboard on, and tells the helper whether that works. */
  async refreshControl(): Promise<void> {
    if (this.state.name !== 'live' || this.state.paused || !this.helperMachine) return;
    const status = await window.hostApi.setRemoteControl(true, this.helperMachine);
    // Paused or ended while waiting for the answer: the latest decision wins.
    if (this.state.name !== 'live' || this.state.paused) {
      void window.hostApi.setRemoteControl(false);
      return;
    }
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
        this.iceServers = event.iceServers;
        this.introTimer = setTimeout(() => this.ask('Someone'), INTRO_WAIT_MS);
        break;
      case 'signal':
        if (event.data.kind === 'intro') this.ask(event.data.name);
        else void this.onSignal(event.data);
        break;
      // Once live, the video connection no longer needs the server.
      case 'peer.left':
        if (!live) this.end('Your helper left before connecting.', 'helper-left');
        break;
      case 'error':
        if (!live) this.end(event.message, 'error');
        break;
      case 'closed':
        if (!live) this.end('Lost contact with the Remote Assist server.', 'error');
        break;
    }
  };

  private readonly onCommand = (command: SessionCommand): void => {
    if (command === 'pause') this.pause();
    else if (command === 'resume') this.resume();
    else if (command === 'stop') this.stop();
    else this.end('Your screen locked, so the session ended.', 'locked');
  };

  private readonly onTimer = (event: TimerEvent): void => {
    if (event.t === 'consent-expired') {
      this.refuse('timeout');
    } else if (event.t === 'idle-warning') {
      this.sendPeer({ t: 'idle', secondsLeft: event.secondsLeft });
    } else if (event.t === 'idle-ended') {
      this.end('The session ended because nothing happened for a while.', 'idle');
    } else {
      this.end('The session reached its time limit.', 'time-limit');
    }
  };

  /** Shows the consent question. Only the first introduction counts. */
  private ask(name: string): void {
    if (this.state.name !== 'waiting' || !this.iceServers) return;
    clearTimeout(this.introTimer);
    this.helperName = name;
    this.askedAt = Date.now();
    const deadline = this.askedAt + this.limits.consentMs;
    const secondsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    this.set({ name: 'asking', helperName: name, secondsLeft: secondsLeft() });
    this.countdown = setInterval(() => {
      if (this.state.name === 'asking') this.set({ ...this.state, secondsLeft: secondsLeft() });
    }, 1000);
    this.timers.startConsent();
    void window.hostApi.requestAttention(true);
  }

  private refuse(reason: 'no' | 'timeout'): void {
    if (this.state.name !== 'asking') return;
    void window.hostApi.sendSignal({ kind: 'declined', reason });
    if (reason === 'no') this.end('You said no. Nothing was shared.', 'declined');
    else this.end('Nobody answered in time, so nothing was shared.', 'unanswered');
  }

  private connect(iceServers: IceServer[]): void {
    const track = this.source?.stream.getVideoTracks()[0];
    if (!this.source || !track) return this.end('The screen capture has no video.', 'error');
    prepareScreenTrack(track);

    const pc = createPeerConnection(iceServers, this.options.forceRelay ? 'relay' : 'all');
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
      if (move && this.acceptsInput()) {
        this.timers.activity();
        window.hostApi.sendInput({ t: 'move', ...move });
      }
    });

    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        void window.hostApi.sendSignal({ kind: 'candidate', candidate: candidateInit(candidate) });
      }
    });
    // Fires for the first offer and again after every restartIce().
    pc.addEventListener('negotiationneeded', () => void this.offer());
    pc.addEventListener('connectionstatechange', () => this.onConnectionState());
  }

  private acceptsInput(): boolean {
    return this.state.name === 'live' && !this.state.paused;
  }

  private onPeerMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    const message = parsePeerMessage(data);
    if (!message) return;
    if (message.t === 'end') {
      this.end('Your helper disconnected.', 'helper-left');
    } else if (message.t === 'hello') {
      this.helperMachine = message.machine;
      void this.refreshControl();
    } else if (isInputEvent(message) && this.acceptsInput()) {
      this.timers.activity();
      window.hostApi.sendInput(message);
    }
  }

  private sendPeer(message: PeerMessage): void {
    if (this.control?.readyState === 'open') this.control.send(JSON.stringify(message));
  }

  private updateChrome(): void {
    if (this.state.name === 'live') {
      void window.hostApi.setSessionChrome({
        helperName: this.state.helperName,
        paused: this.state.paused,
      });
    }
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
        for (const candidate of this.pendingCandidates.splice(0)) {
          await pc.addIceCandidate(candidate);
        }
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
    if (!pc || this.state.name === 'ended' || !this.helperName) return;
    const state = pc.connectionState;
    if (state === 'connected') {
      clearTimeout(this.restartTimer);
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      if (this.state.name === 'live') {
        this.set({ ...this.state, reconnecting: false });
        return;
      }
      this.wasLive = true;
      this.set({
        name: 'live',
        helperName: this.helperName,
        paused: false,
        reconnecting: false,
        control: this.controlStatus,
      });
      this.timers.startLive();
      this.updateChrome();
      void this.refreshControl();
    } else if (state === 'disconnected' || state === 'failed') {
      if (this.state.name !== 'live') {
        if (state === 'failed') {
          this.end(
            "Could not connect to your helper's computer. Try again; if it keeps failing, your networks may need the relay server.",
            'lost',
          );
        }
        return;
      }
      // Nothing may stay pressed while the helper can't see what it is doing.
      window.hostApi.sendInput({ t: 'release' });
      this.set({ ...this.state, reconnecting: true });
      // After a network change (Wi-Fi to hotspot) only fresh ICE candidates can reconnect.
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(
        () => pc.restartIce(),
        state === 'failed' ? 0 : ICE_RESTART_DELAY_MS,
      );
      this.graceTimer ??= setTimeout(
        () => this.end('The connection was lost.', 'lost'),
        RECONNECT_GRACE_MS,
      );
    }
  }

  private end(message: string, outcome: SessionOutcome = 'error'): void {
    if (this.state.name === 'ended') return;
    clearTimeout(this.introTimer);
    clearInterval(this.countdown);
    clearTimeout(this.restartTimer);
    clearTimeout(this.graceTimer);
    this.timers.dispose();
    this.sendPeer({ t: 'end' });
    void window.hostApi.setRemoteControl(false);
    void window.hostApi.requestAttention(false);
    void window.hostApi.setSessionChrome(null);
    this.stopListening();
    this.stopCommands();
    void window.hostApi.leaveSession();
    this.source?.stop();
    this.pausedCard?.stop();
    const pc = this.pc;
    // Let the goodbye message leave before the connection is torn down.
    if (pc) setTimeout(() => pc.close(), 200);
    if (this.helperName) {
      void window.hostApi.recordSession({
        askedAt: this.askedAt,
        endedAt: Date.now(),
        helperName: this.helperName,
        wasLive: this.wasLive,
        outcome,
      });
    }
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

function describeCaptureError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'macOS did not allow screen recording. Turn it on in System Settings, then quit and reopen the app.';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No screen was found to share.';
  }
  return `Screen sharing could not start: ${error instanceof Error ? error.message : String(error)}`;
}

/** Errors thrown in the main process arrive wrapped in "Error invoking remote method …". */
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
