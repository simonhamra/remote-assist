import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebFrameMain,
} from 'electron';
import type { Handle } from './bridge';

export { ServerBridge, type Handle, type ServerBridgeOptions } from './bridge';
export { Settings, TrustStore, loadIdentity, type SecretBox } from './stores';
export { isQuietMoment, startAutoUpdates, type Updates } from './updates';

export type Listen = (channel: string, listener: (...args: unknown[]) => void) => void;

/**
 * The environment for development and test switches (RA_…, the dev server URL). The installed
 * app ignores them all, so no one can talk Grandma into starting it with a test setting such as
 * one-time code sessions, or a different server or page.
 */
export function devEnv(): NodeJS.ProcessEnv {
  return app.isPackaged ? {} : process.env;
}

/** Identifies this computer without revealing its name: the first 16 hex digits of a hash. */
export function machineId(): string {
  return createHash('sha256').update(`remote-assist:${hostname()}`).digest('hex').slice(0, 16);
}

/** App windows only ever show the app's own pages: no new windows, no navigation. */
export function lockDown(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

export function isMainFrame(win: BrowserWindow | null, frame: WebFrameMain | null): boolean {
  const main = win?.webContents.mainFrame;
  return (
    !!frame && !!main && frame.processId === main.processId && frame.routingId === main.routingId
  );
}

function fromWindow(win: BrowserWindow | null, event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!win && event.sender === win.webContents && isMainFrame(win, event.senderFrame);
}

/** Like `ipcMain.handle`, but only answers the main frame of the window `getWindow` returns. */
export function trustedHandler(getWindow: () => BrowserWindow | null): Handle {
  return (channel, listener) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!fromWindow(getWindow(), event)) {
        throw new Error(`Rejected ${channel} from an unexpected sender`);
      }
      return listener(...args);
    });
  };
}

/** Like `ipcMain.on` (fire-and-forget), with the same sender check; others are ignored. */
export function trustedListener(getWindow: () => BrowserWindow | null): Listen {
  return (channel, listener) => {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (fromWindow(getWindow(), event)) listener(...args);
    });
  };
}
