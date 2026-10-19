import {
  lockDown,
  machineId,
  registerSignalingBridge,
  trustedHandler,
} from '@remote-assist/desktop/main';
import { app, BrowserWindow, screen, session } from 'electron';
import { join } from 'node:path';
import { Channels, type AppConfig, type ProbeRect } from '../shared/api';

const config: AppConfig = {
  fakeScreen: process.env.RA_FAKE_SCREEN === '1',
  forceRelay: process.env.RA_FORCE_RELAY === '1',
  machine: machineId(),
};
const signalingUrl = process.env.RA_SIGNALING_URL ?? 'ws://127.0.0.1:8787/ws';

// See the host: real LAN addresses instead of mDNS names for a peer you chose to connect to.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

/** Size of the latency probe strip, in points. */
const PROBE_SIZE = { width: 520, height: 20 };

let mainWindow: BrowserWindow | null = null;
let probeWindow: BrowserWindow | null = null;
const handle = trustedHandler(() => mainWindow);

const sandboxed = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  spellcheck: false,
  backgroundThrottling: false,
} as const;

function loadPage(win: BrowserWindow, page: 'index' | 'probe'): void {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void win.loadURL(`${devServer}/${page}.html`);
  else void win.loadFile(join(__dirname, `../renderer/${page}.html`));
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: 'Remote Assist Helper',
    backgroundColor: '#111418',
    show: false,
    webPreferences: { ...sandboxed, preload: join(__dirname, '../preload/index.js') },
  });
  win.once('ready-to-show', () => win.show());
  lockDown(win);
  loadPage(win, 'index');
  return win;
}

/**
 * The probe is a small always-on-top strip showing the current time as blocks. When host and
 * helper run on the same Mac, the host captures it and the helper reads it back from the video.
 */
function showProbe(): ProbeRect {
  const display = screen.getPrimaryDisplay();
  if (!probeWindow) {
    const { workArea } = display;
    probeWindow = new BrowserWindow({
      x: workArea.x + 16,
      y: workArea.y + workArea.height - PROBE_SIZE.height - 16,
      ...PROBE_SIZE,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: sandboxed,
    });
    probeWindow.setAlwaysOnTop(true, 'screen-saver');
    probeWindow.setIgnoreMouseEvents(true);
    probeWindow.on('closed', () => (probeWindow = null));
    lockDown(probeWindow);
    loadPage(probeWindow, 'probe');
    probeWindow.showInactive();
  }
  const bounds = probeWindow.getBounds();
  const area = display.bounds;
  return {
    x: (bounds.x - area.x) / area.width,
    y: (bounds.y - area.y) / area.height,
    width: bounds.width / area.width,
    height: bounds.height / area.height,
  };
}

function hideProbe(): void {
  probeWindow?.close();
}

function registerIpc(): void {
  handle(Channels.config, () => config);
  handle(Channels.showProbe, () => showProbe());
  handle(Channels.hideProbe, () => hideProbe());
  registerSignalingBridge({
    url: signalingUrl,
    role: 'helper',
    handle,
    getWindow: () => mainWindow,
  });
}

void app.whenReady().then(() => {
  // The helper needs no camera, microphone or other device access.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  registerIpc();
  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
    hideProbe();
  });
});

app.on('window-all-closed', () => app.quit());
