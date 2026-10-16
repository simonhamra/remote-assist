import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  screen,
  session,
  shell,
  systemPreferences,
  type DisplayMediaRequestHandlerHandlerRequest,
  type IpcMainInvokeEvent,
  type Streams,
  type WebFrameMain,
} from 'electron';
import { join } from 'node:path';
import { Channels, type AppConfig, type ScreenPermission } from '../shared/api';

const config: AppConfig = {
  fakeScreen: process.env.RA_FAKE_SCREEN === '1',
};

// The peer is someone you paired with on purpose, so share real LAN addresses instead of mDNS
// names. mDNS resolution needs multicast, which is less reliable and more likely to trigger
// the macOS Local Network prompt.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 540,
    height: 820,
    minWidth: 460,
    minHeight: 600,
    title: 'Remote Assist',
    backgroundColor: '#fbf7f0',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Keep the test screen animating and stats updating while the window is in the background.
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

function isMainFrame(frame: WebFrameMain | null): boolean {
  const main = mainWindow?.webContents.mainFrame;
  return (
    !!frame && !!main && frame.processId === main.processId && frame.routingId === main.routingId
  );
}

/** Only our own window may capture, only the screen, and only right after a button press. */
async function chooseScreen(
  request: DisplayMediaRequestHandlerHandlerRequest,
): Promise<Streams | null> {
  if (!isMainFrame(request.frame) || !request.userGesture || !request.videoRequested) return null;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const primaryId = String(screen.getPrimaryDisplay().id);
  const source = sources.find((s) => s.display_id === primaryId) ?? sources[0];
  return source ? { video: source } : null;
}

function configureSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(webContents === mainWindow?.webContents && permission === 'display-capture');
  });
  ses.setDisplayMediaRequestHandler((request, callback) => {
    chooseScreen(request).then(callback, (error: unknown) => {
      console.error('Screen capture failed', error);
      callback(null);
    });
  });
}

function handle(channel: string, listener: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (event.sender !== mainWindow?.webContents || !isMainFrame(event.senderFrame)) {
      throw new Error(`Rejected ${channel} from an unexpected sender`);
    }
    return listener(...args);
  });
}

function registerIpc(): void {
  handle(Channels.config, () => config);
  handle(Channels.copy, (text) => {
    if (typeof text !== 'string' || text.length > 50_000) throw new Error('Invalid clipboard text');
    clipboard.writeText(text);
  });
  handle(Channels.screenPermission, (): ScreenPermission => {
    if (process.platform !== 'darwin') return 'granted';
    const status = systemPreferences.getMediaAccessStatus('screen');
    return status === 'granted' ||
      status === 'denied' ||
      status === 'not-determined' ||
      status === 'restricted'
      ? status
      : 'unknown';
  });
  handle(Channels.openScreenSettings, async () => {
    if (process.platform === 'darwin') {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
    }
  });
  handle(Channels.cpu, () =>
    app.getAppMetrics().reduce((total, metric) => total + metric.cpu.percentCPUUsage, 0),
  );
}

void app.whenReady().then(() => {
  configureSession();
  registerIpc();
  mainWindow = createWindow();
  mainWindow.on('closed', () => (mainWindow = null));
});

// Closing the window ends any sharing, so there is nothing left to keep running.
app.on('window-all-closed', () => app.quit());
