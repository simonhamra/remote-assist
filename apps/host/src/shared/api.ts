import type { InputEvent, SignalData, SignalingEvent } from '@remote-assist/protocol';

/** The contract between the host's main process and its renderer, exposed as `window.hostApi`. */

export const Channels = {
  config: 'config:get',
  screenPermission: 'screen:permission',
  openScreenSettings: 'screen:open-settings',
  cpu: 'metrics:cpu',
  input: 'input:event',
  setRemoteControl: 'input:set-enabled',
  openAccessibilitySettings: 'input:open-accessibility-settings',
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
}

/** macOS Screen Recording status (always `granted` on other platforms). */
export type ScreenPermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

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
}
