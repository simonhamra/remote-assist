import {
  isMainFrame,
  lockDown,
  machineId,
  registerSignalingBridge,
  trustedHandler,
  trustedListener,
} from '@remote-assist/desktop/main';
import { InputAgent } from '@remote-assist/native-input';
import { parseInputEvent } from '@remote-assist/protocol';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  screen,
  session,
  shell,
  systemPreferences,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Streams,
} from 'electron';
import { join } from 'node:path';
import { Channels, type AppConfig, type ControlStatus, type ScreenPermission } from '../shared/api';
import { InputController } from './inputController';

const config: AppConfig = {
  fakeScreen: process.env.RA_FAKE_SCREEN === '1',
  forceRelay: process.env.RA_FORCE_RELAY === '1',
};
const signalingUrl = process.env.RA_SIGNALING_URL ?? 'ws://127.0.0.1:8787/ws';
/** RA_INPUT_DRY_RUN=1: log input events instead of posting them (tests; no permission needed). */
const inputDryRun = process.env.RA_INPUT_DRY_RUN === '1';

// The peer is someone you paired with on purpose, so share real LAN addresses instead of mDNS
// names. mDNS resolution needs multicast, which is less reliable and more likely to trigger
// the macOS Local Network prompt.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let mainWindow: BrowserWindow | null = null;
/** The display chosen for capture; remote input is mapped onto the same one. */
let capturedDisplayId: string | null = null;
const handle = trustedHandler(() => mainWindow);
const listen = trustedListener(() => mainWindow);

const agent = new InputAgent(
  app.isPackaged
    ? join(process.resourcesPath, 'input-agent')
    : join(app.getAppPath(), '../../packages/native-input/bin/input-agent'),
  {
    dryRun: inputDryRun,
    onMessage: (message) => {
      if (inputDryRun || message.event === 'error')
        console.log(`[input-agent] ${JSON.stringify(message)}`);
    },
  },
);

const input = new InputController({
  send: (command) => agent.send(command),
  display: () => {
    const displays = screen.getAllDisplays();
    return (displays.find((d) => String(d.id) === capturedDisplayId) ?? screen.getPrimaryDisplay())
      .bounds;
  },
  ownWindows: () =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.isVisible() && !w.isMinimized())
      .map((w) => w.getBounds()),
  ownWindowFocused: () => BrowserWindow.getFocusedWindow() !== null,
});

function controlStatus(helperMachine: unknown): ControlStatus {
  if (!agent.available) return { available: false, reason: 'unsupported' };
  // Dry runs post nothing, so the end-to-end tests can run both apps on one computer.
  if (!inputDryRun && helperMachine === machineId()) {
    return { available: false, reason: 'same-computer' };
  }
  const trusted = inputDryRun || systemPreferences.isTrustedAccessibilityClient(false);
  return trusted ? { available: true } : { available: false, reason: 'permission' };
}

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
  lockDown(win);

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

/** Only our own window may capture, only the screen, and only right after a button press. */
async function chooseScreen(
  request: DisplayMediaRequestHandlerHandlerRequest,
): Promise<Streams | null> {
  if (!isMainFrame(mainWindow, request.frame) || !request.userGesture || !request.videoRequested) {
    return null;
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const primaryId = String(screen.getPrimaryDisplay().id);
  const source = sources.find((s) => s.display_id === primaryId) ?? sources[0];
  if (!source) return null;
  capturedDisplayId = source.display_id || primaryId;
  return { video: source };
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

function registerIpc(): void {
  handle(Channels.config, () => config);
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
  registerSignalingBridge({ url: signalingUrl, role: 'host', handle, getWindow: () => mainWindow });

  listen(Channels.input, (event) => {
    const parsed = parseInputEvent(event);
    if (parsed) input.handle(parsed);
  });
  handle(Channels.setRemoteControl, (enabled, helperMachine): ControlStatus => {
    const status = controlStatus(helperMachine);
    input.setEnabled(enabled === true && status.available);
    return status;
  });
  handle(Channels.openAccessibilitySettings, async () => {
    if (process.platform !== 'darwin') return;
    // Adds the app to the Accessibility list (switched off) and shows macOS's own prompt.
    systemPreferences.isTrustedAccessibilityClient(true);
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
  });
}

void app.whenReady().then(() => {
  configureSession();
  registerIpc();
  mainWindow = createWindow();
  // Whatever happens to the window, the helper loses the mouse and keyboard.
  mainWindow.webContents.on('render-process-gone', () => input.setEnabled(false));
  mainWindow.on('closed', () => {
    input.setEnabled(false);
    mainWindow = null;
  });
});

// Closing the agent's input makes it release everything before it exits.
app.on('will-quit', () => agent.stop());

// Closing the window ends any sharing, so there is nothing left to keep running.
app.on('window-all-closed', () => app.quit());
