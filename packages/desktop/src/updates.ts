import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** How long nobody has touched the computer before the host may restart to update. */
export const QUIET_IDLE_SECONDS = 15 * 60;

export interface QuietMoment {
  /** Someone is helping, or being asked whether they may. */
  busy: boolean;
  windowVisible: boolean;
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: number;
}

/** A restart to install an update must go unnoticed: nothing on screen, nobody at the computer. */
export function isQuietMoment({ busy, windowVisible, idleSeconds }: QuietMoment): boolean {
  return !busy && !windowVisible && idleSeconds >= QUIET_IDLE_SECONDS;
}

export interface Updates {
  /** Quits, installs the downloaded update and starts the app again. */
  installNow(): void;
}

/**
 * Checks for updates a minute after launch and every 6 hours, downloads them in the background
 * and installs them when the app quits. Updates come from the address baked in at packaging
 * (`app-update.yml`); macOS checks they are signed by the same developer as the running app.
 * Returns null in development and in builds made without an update address.
 */
export function startAutoUpdates(
  options: { onDownloaded?(version: string): void } = {},
): Updates | null {
  if (!app.isPackaged || !existsSync(join(process.resourcesPath, 'app-update.yml'))) return null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  // electron-updater logs failures itself (offline, server down); they must not crash the app,
  // and an 'error' event without a listener would.
  autoUpdater.on('error', () => {});
  autoUpdater.on('update-downloaded', (info) => options.onDownloaded?.(info.version));
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  return { installNow: () => autoUpdater.quitAndInstall(true, true) };
}
