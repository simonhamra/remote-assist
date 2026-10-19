import type { PeopleApi, SessionEvent } from '@remote-assist/desktop/channels';
import type { SignalData } from '@remote-assist/protocol';

/** The contract between the helper's main process and its renderer, exposed as `window.helperApi`. */

export const Channels = {
  config: 'config:get',
  showProbe: 'probe:show',
  hideProbe: 'probe:hide',
} as const;

export interface AppConfig {
  /** RA_FAKE_SCREEN=1: the host shares a synthetic screen with a timecode at a known spot. */
  fakeScreen: boolean;
  /** RA_FORCE_RELAY=1: only connect through the TURN relay (to test it). */
  forceRelay: boolean;
  /** RA_ALLOW_CODE_SESSIONS=1: one-time code sessions without pairing (development, tests). */
  allowCodeSessions: boolean;
  /** This computer, as the host's `hello` check sees it. */
  machine: string;
}

/** A rectangle in 0–1 coordinates relative to the primary display. */
export interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HelperApi extends PeopleApi {
  getConfig(): Promise<AppConfig>;
  /** Shows the latency probe strip on the primary display and returns where it is. */
  showProbe(): Promise<ProbeRect>;
  hideProbe(): Promise<void>;
  /** Joins a one-time code session with the code the host read out. */
  joinSession(code: string): Promise<void>;
  /** Asks to help a paired computer (after Touch ID, where the Mac has it). */
  requestSession(peerId: string): Promise<void>;
  sendSignal(data: SignalData): Promise<void>;
  leaveSession(): Promise<void>;
  /** Returns a function that stops listening. */
  onSessionEvent(listener: (event: SessionEvent) => void): () => void;
}
