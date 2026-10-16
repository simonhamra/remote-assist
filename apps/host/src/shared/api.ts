/** The contract between the host's main process and its renderer, exposed as `window.hostApi`. */

export const Channels = {
  config: 'config:get',
  copy: 'clipboard:write',
  screenPermission: 'screen:permission',
  openScreenSettings: 'screen:open-settings',
  cpu: 'metrics:cpu',
} as const;

export interface AppConfig {
  /** RA_FAKE_SCREEN=1: share a synthetic test screen instead of the real display. */
  fakeScreen: boolean;
}

/** macOS Screen Recording status (always `granted` on other platforms). */
export type ScreenPermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export interface HostApi {
  getConfig(): Promise<AppConfig>;
  copyText(text: string): Promise<void>;
  screenPermission(): Promise<ScreenPermission>;
  openScreenRecordingSettings(): Promise<void>;
  /** CPU used by all of this app's processes, in percent of one core. */
  cpuPercent(): Promise<number>;
}
