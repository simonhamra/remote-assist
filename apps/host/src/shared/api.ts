import type { SignalData, SignalingEvent } from '@remote-assist/protocol';

/** The contract between the host's main process and its renderer, exposed as `window.hostApi`. */

export const Channels = {
  config: 'config:get',
  screenPermission: 'screen:permission',
  openScreenSettings: 'screen:open-settings',
  cpu: 'metrics:cpu',
} as const;

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
}
