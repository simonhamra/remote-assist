import type { InputEvent, SignalData, SignalingEvent } from '@remote-assist/protocol';

/** The contract between the host's main process and its windows. */

export const Channels = {
  config: 'config:get',
  screenPermission: 'screen:permission',
  openScreenSettings: 'screen:open-settings',
  cpu: 'metrics:cpu',
  input: 'input:event',
  setRemoteControl: 'input:set-enabled',
  openAccessibilitySettings: 'input:open-accessibility-settings',
  attention: 'window:attention',
  sessionChrome: 'session:chrome',
  /** Main → main window: a `SessionCommand` from the session bar or the system. */
  sessionCommand: 'session:command',
  recordSession: 'history:record',
  history: 'history:get',
  /** Session bar → main: pause, resume or stop. */
  barCommand: 'bar:command',
  /** Main → session bar: a `ChromeState`. */
  barState: 'bar:state',
} as const;

/** Whether the helper can use the mouse and keyboard right now, and if not, why. */
export interface ControlStatus {
  available: boolean;
  /**
   * `permission`: macOS Accessibility is off. `unsupported`: no input agent in this build.
   * `same-computer`: the helper runs on this computer, so it would only control itself.
   */
  reason?: 'permission' | 'unsupported' | 'same-computer';
}

export interface AppConfig {
  /** RA_FAKE_SCREEN=1: share a synthetic test screen instead of the real display. */
  fakeScreen: boolean;
  /** RA_FORCE_RELAY=1: only connect through the TURN relay (to test it). */
  forceRelay: boolean;
  /** RA_TEST_CONSENT_MS: a shorter consent timeout, for tests only. */
  consentMs?: number;
}

/** macOS Screen Recording status (always `granted` on other platforms). */
export type ScreenPermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

/** What the session bar and screen border show while a session is live. */
export interface ChromeState {
  helperName: string;
  paused: boolean;
}

export type BarCommand = 'pause' | 'resume' | 'stop';
export type SessionCommand = BarCommand | 'screen-locked';

export const SESSION_OUTCOMES = [
  'declined',
  'unanswered',
  'stopped',
  'helper-left',
  'locked',
  'idle',
  'time-limit',
  'lost',
  'error',
] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/** One line of the session history kept on this computer (not on the server). */
export interface SessionRecord {
  askedAt: number;
  endedAt: number;
  helperName: string;
  wasLive: boolean;
  outcome: SessionOutcome;
}

/** Exposed to the main window as `window.hostApi`. */
export interface HostApi {
  getConfig(): Promise<AppConfig>;
  screenPermission(): Promise<ScreenPermission>;
  openScreenRecordingSettings(): Promise<void>;
  /** CPU used by all of this app's processes, in percent of one core. */
  cpuPercent(): Promise<number>;
  /** Connects to the server and asks for a session code (arrives as a `code` event). */
  startSession(): Promise<void>;
  sendSignal(data: SignalData): Promise<void>;
  leaveSession(): Promise<void>;
  /** Returns a function that stops listening. */
  onSessionEvent(listener: (event: SignalingEvent) => void): () => void;
  /** Passes one event from the helper to the input gate in the main process. */
  sendInput(event: InputEvent): void;
  /**
   * Turns remote control on while a session is live, and off when it ends. `helperMachine` is
   * the helper's computer, from its `hello` message.
   */
  setRemoteControl(enabled: boolean, helperMachine?: string): Promise<ControlStatus>;
  /** Asks macOS for Accessibility access and opens its settings pane. */
  openAccessibilitySettings(): Promise<void>;
  /** Brings the window to the front and keeps it there while a question waits for an answer. */
  requestAttention(asking: boolean): Promise<void>;
  /** Shows (or with `null`, removes) the session bar and the coloured screen border. */
  setSessionChrome(state: ChromeState | null): Promise<void>;
  /** Commands from the session bar and the system. Returns a function that stops listening. */
  onSessionCommand(listener: (command: SessionCommand) => void): () => void;
  recordSession(record: SessionRecord): Promise<void>;
  /** Most recent first. */
  sessionHistory(): Promise<SessionRecord[]>;
}

/** Exposed to the session bar as `window.barApi`. */
export interface BarApi {
  send(command: BarCommand): void;
  /** Returns a function that stops listening. */
  onState(listener: (state: ChromeState) => void): () => void;
}
