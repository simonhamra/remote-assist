/** The contract between the helper's main process and its renderer, exposed as `window.helperApi`. */

export const Channels = {
  config: 'config:get',
  copy: 'clipboard:write',
  showProbe: 'probe:show',
  hideProbe: 'probe:hide',
} as const;

export interface AppConfig {
  /** RA_FAKE_SCREEN=1: the host shares a synthetic screen with a timecode at a known spot. */
  fakeScreen: boolean;
}

/** A rectangle in 0–1 coordinates relative to the primary display. */
export interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HelperApi {
  getConfig(): Promise<AppConfig>;
  copyText(text: string): Promise<void>;
  /** Shows the latency probe strip on the primary display and returns where it is. */
  showProbe(): Promise<ProbeRect>;
  hideProbe(): Promise<void>;
}
