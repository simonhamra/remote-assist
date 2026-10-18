import {
  PROTOCOL_VERSION,
  SignalingClient,
  sessionCode,
  signalData,
  type ClientMessage,
} from '@remote-assist/protocol';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import { SessionChannels } from './channels';

export type Handle = (channel: string, listener: (...args: unknown[]) => unknown) => void;

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

/** Like `ipcMain.handle`, but only answers the main frame of the window `getWindow` returns. */
export function trustedHandler(getWindow: () => BrowserWindow | null): Handle {
  return (channel, listener) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const win = getWindow();
      if (!win || event.sender !== win.webContents || !isMainFrame(win, event.senderFrame)) {
        throw new Error(`Rejected ${channel} from an unexpected sender`);
      }
      return listener(...args);
    });
  };
}

export interface SignalingBridgeOptions {
  url: string;
  role: 'host' | 'helper';
  handle: Handle;
  getWindow: () => BrowserWindow | null;
}

/**
 * Keeps the signaling connection in the main process (Phase 5 signs its messages with the
 * device key, which never reaches the renderer) and relays it to the window over IPC.
 */
export function registerSignalingBridge(options: SignalingBridgeOptions): void {
  const { url, role, handle, getWindow } = options;
  let client: SignalingClient | null = null;

  const start = async (first: ClientMessage): Promise<void> => {
    client?.close();
    const current = new SignalingClient(url, (event) => {
      if (client === current) getWindow()?.webContents.send(SessionChannels.event, event);
    });
    client = current;
    await current.open(first);
  };

  if (role === 'host') {
    handle(SessionChannels.host, () => start({ t: 'host.open', v: PROTOCOL_VERSION }));
  } else {
    handle(SessionChannels.join, (code) => {
      const parsed = sessionCode.safeParse(code);
      if (!parsed.success) throw new Error('A session code has 8 digits.');
      return start({ t: 'helper.join', v: PROTOCOL_VERSION, code: parsed.data });
    });
  }
  handle(SessionChannels.signal, (data) => {
    const parsed = signalData.safeParse(data);
    if (!parsed.success) throw new Error('Invalid signaling data');
    client?.send({ t: 'signal', data: parsed.data });
  });
  handle(SessionChannels.leave, () => {
    client?.send({ t: 'leave' });
    client?.close();
    client = null;
  });
}
