import type { PeopleApi, SessionEvent } from '@remote-assist/desktop/channels';
import type { InputEvent, SignalData } from '@remote-assist/protocol';

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
  setupState: 'setup:get',
  setSetupStep: 'setup:step',
  completeSetup: 'setup:complete',
  registerScreenRecording: 'setup:register-screen',
  accessibilityGranted: 'setup:accessibility',
  startAtLogin: 'setup:login-get',
  setStartAtLogin: 'setup:login-set',
  relaunch: 'setup:relaunch',
} as const;

/** The guided first-run setup, one screen per step. */
export const SETUP_STEPS = [
  'welcome',
  'pair',
  'screen',
  'control',
  'startup',
  'practice',
  'done',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupState {
  step: SetupStep;
  completed: boolean;
}

/** Starting with the computer: only possible for the installed app, not in development. */
export interface LoginItem {
  enabled: boolean;
  supported: boolean;
}

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
  /** RA_ALLOW_CODE_SESSIONS=1: one-time code sessions without pairing (development, tests). */
  allowCodeSessions: boolean;
  /** RA_TEST_CONSENT_MS: a shorter consent timeout, for tests only. */
  consentMs?: number;
  /** RA_SKIP_SETUP=1: start on the home screen (tests that aren't about setup). */
  skipSetup: boolean;
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
export interface HostApi extends PeopleApi {
  getConfig(): Promise<AppConfig>;
  screenPermission(): Promise<ScreenPermission>;
  openScreenRecordingSettings(): Promise<void>;
  /** CPU used by all of this app's processes, in percent of one core. */
  cpuPercent(): Promise<number>;
  /** Starts a one-time code session (the code arrives as a `code` event). */
  startSession(): Promise<void>;
  sendSignal(data: SignalData): Promise<void>;
  leaveSession(): Promise<void>;
  /** Returns a function that stops listening. */
  onSessionEvent(listener: (event: SessionEvent) => void): () => void;
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
  setupState(): Promise<SetupState>;
  setSetupStep(step: SetupStep): Promise<void>;
  completeSetup(): Promise<void>;
  /** Asks macOS once, so this app appears in the Screen Recording list. Shares nothing. */
  registerScreenRecording(): Promise<void>;
  /** True when the helper could use the mouse and keyboard, or when there is nothing to allow. */
  accessibilityGranted(): Promise<boolean>;
  startAtLogin(): Promise<LoginItem>;
  setStartAtLogin(enabled: boolean): Promise<LoginItem>;
  /** Restarts the app: a new Screen Recording permission only takes effect then. */
  relaunch(): Promise<void>;
}

/** Exposed to the session bar as `window.barApi`. */
export interface BarApi {
  send(command: BarCommand): void;
  /** Returns a function that stops listening. */
  onState(listener: (state: ChromeState) => void): () => void;
}
