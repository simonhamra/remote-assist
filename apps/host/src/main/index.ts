import {
  ServerBridge,
  Settings,
  TrustStore,
  isMainFrame,
  loadIdentity,
  lockDown,
  machineId,
  trustedHandler,
  trustedListener,
} from '@remote-assist/desktop/main';
import { InputAgent } from '@remote-assist/native-input';
import { displayName, parseInputEvent } from '@remote-assist/protocol';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  type Display,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Streams,
} from 'electron';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  Channels,
  type AppConfig,
  type ControlStatus,
  type ScreenPermission,
  type SessionCommand,
} from '../shared/api';
import { SessionHistory, isSessionRecord } from './history';
import { InputController } from './inputController';
import { SessionChrome } from './sessionChrome';

// Test and development switches. RA_USER_DATA_DIR gives each test instance its own data, and
// RA_TEST_MOCK_KEYCHAIN keeps tests away from the real macOS Keychain.
if (process.env.RA_USER_DATA_DIR) app.setPath('userData', process.env.RA_USER_DATA_DIR);
if (process.env.RA_TEST_MOCK_KEYCHAIN === '1') app.commandLine.appendSwitch('use-mock-keychain');

const testConsentMs = Number(process.env.RA_TEST_CONSENT_MS);
const config: AppConfig = {
  fakeScreen: process.env.RA_FAKE_SCREEN === '1',
  forceRelay: process.env.RA_FORCE_RELAY === '1',
  allowCodeSessions: process.env.RA_ALLOW_CODE_SESSIONS === '1',
  ...(testConsentMs > 0 ? { consentMs: testConsentMs } : {}),
};
const signalingUrl = process.env.RA_SIGNALING_URL ?? 'ws://127.0.0.1:8787/ws';
/** RA_INPUT_DRY_RUN=1: log input events instead of posting them (tests; no permission needed). */
const inputDryRun = process.env.RA_INPUT_DRY_RUN === '1';

// The peer is someone you paired with on purpose, so share real LAN addresses instead of mDNS
// names. mDNS resolution needs multicast, which is less reliable and more likely to trigger
// the macOS Local Network prompt.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let mainWindow: BrowserWindow | null = null;
/** The display chosen for capture; remote input and the session border use the same one. */
let capturedDisplayId: string | null = null;
const handle = trustedHandler(() => mainWindow);
const listen = trustedListener(() => mainWindow);

function loadPage(win: BrowserWindow, page: 'index' | 'bar' | 'border'): void {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void win.loadURL(`${devServer}/${page}.html`);
  else void win.loadFile(join(__dirname, `../renderer/${page}.html`));
}

const chrome = new SessionChrome({
  barPreload: join(__dirname, '../preload/bar.js'),
  load: loadPage,
});

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

function capturedDisplay(): Display {
  return (
    screen.getAllDisplays().find((d) => String(d.id) === capturedDisplayId) ??
    screen.getPrimaryDisplay()
  );
}

const input = new InputController({
  send: (command) => agent.send(command),
  display: () => capturedDisplay().bounds,
  // The windows Grandma uses to stay in control. (The screen border lets clicks through.)
  ownWindows: () =>
    [mainWindow, chrome.barWindow]
      .filter((w): w is BrowserWindow => !!w && w.isVisible() && !w.isMinimized())
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

function sendCommand(command: SessionCommand): void {
  mainWindow?.webContents.send(Channels.sessionCommand, command);
}

/** Someone asks to help, or pairing needs an answer: bring the window forward. */
function attention(): void {
  const win = mainWindow;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  if (process.platform === 'darwin') app.dock?.bounce('critical');
}

function startServerBridge(): ServerBridge {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This computer cannot store the device key securely.');
  }
  const data = app.getPath('userData');
  const bridge = new ServerBridge({
    url: signalingUrl,
    role: 'host',
    identity: loadIdentity(join(data, 'device-key.bin'), {
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (bytes) => safeStorage.decryptString(bytes),
    }),
    trust: new TrustStore(join(data, 'trusted-helpers.json')),
    settings: new Settings(join(data, 'settings.json')),
    defaultName: process.env.RA_DEVICE_NAME ?? defaultName(),
    handle,
    toWindow: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    allowCodeSessions: config.allowCodeSessions,
    onAttention: attention,
  });
  bridge.start();
  return bridge;
}

/** The macOS account name, capitalized: what a helper sees before naming this computer. */
function defaultName(): string {
  const name = userInfo().username || 'My computer';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 860,
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
  loadPage(win, 'index');
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
  const history = new SessionHistory(join(app.getPath('userData'), 'session-history.json'));

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

  // A question is waiting: bring the window to the front and keep it there until answered.
  handle(Channels.attention, (asking) => {
    const win = mainWindow;
    if (!win) return;
    if (asking !== true) {
      win.setAlwaysOnTop(false);
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true, 'floating');
    app.focus({ steal: true });
    win.focus();
    if (process.platform === 'darwin') app.dock?.bounce('critical');
  });

  handle(Channels.sessionChrome, (state) => {
    if (state === null) {
      chrome.hide();
      return;
    }
    const { helperName, paused } = (state ?? {}) as Record<string, unknown>;
    const name = displayName.safeParse(helperName);
    if (!name.success || typeof paused !== 'boolean') throw new Error('Invalid session state');
    chrome.show({ helperName: name.data, paused }, capturedDisplay());
  });

  // The session bar's buttons, passed on to the main window, which runs the session.
  trustedListener(() => chrome.barWindow)(Channels.barCommand, (command) => {
    if (command === 'pause' || command === 'resume' || command === 'stop') sendCommand(command);
  });

  handle(Channels.recordSession, async (record) => {
    if (isSessionRecord(record)) await history.add(record);
  });
  handle(Channels.history, () => history.list());
}

let bridge: ServerBridge | null = null;

void app.whenReady().then(() => {
  configureSession();
  registerIpc();
  bridge = startServerBridge();
  mainWindow = createWindow();
  // Whatever happens to the window, the helper loses the mouse and keyboard.
  mainWindow.webContents.on('render-process-gone', () => {
    input.setEnabled(false);
    chrome.hide();
  });
  mainWindow.on('closed', () => {
    input.setEnabled(false);
    chrome.hide();
    mainWindow = null;
  });

  // A locked screen, sleep or a switch to another user ends any session at once.
  powerMonitor.on('lock-screen', () => sendCommand('screen-locked'));
  powerMonitor.on('suspend', () => sendCommand('screen-locked'));
  if (process.platform === 'darwin') {
    powerMonitor.on('user-did-resign-active', () => sendCommand('screen-locked'));
  }
});

// Closing the agent's input makes it release everything before it exits.
app.on('will-quit', () => {
  agent.stop();
  bridge?.stop();
});

// Closing the window ends any sharing, so there is nothing left to keep running.
app.on('window-all-closed', () => app.quit());
