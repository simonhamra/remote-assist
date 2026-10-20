import { lockDown } from '@remote-assist/desktop/main';
import { BrowserWindow, type Display } from 'electron';
import { Channels, type ChromeState } from '../shared/api';

const BAR_SIZE = { width: 620, height: 72 };

export interface SessionChromeOptions {
  barPreload: string;
  load(win: BrowserWindow, page: 'bar' | 'border'): void;
  /** The session started, paused, resumed or ended (`null`). */
  onChange?(state: ChromeState | null): void;
}

const sandboxed = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  spellcheck: false,
};

/**
 * While a session is live: a small bar with Pause and Stop that stays above everything, on every
 * desktop and over full-screen apps, and a coloured border around the shared screen. The border
 * lets clicks through and is left out of the screen capture: it's for the person at this
 * computer. The input gate treats the bar as this app's own window, so the helper can't press it.
 */
export class SessionChrome {
  private readonly options: SessionChromeOptions;
  private bar: BrowserWindow | null = null;
  /** Set once the bar's page has loaded and can receive its state. */
  private barReady = false;
  private border: BrowserWindow | null = null;
  private state: ChromeState | null = null;

  constructor(options: SessionChromeOptions) {
    this.options = options;
  }

  get barWindow(): BrowserWindow | null {
    return this.bar;
  }

  show(state: ChromeState, display: Display): void {
    this.state = state;
    this.bar ??= this.createBar(display);
    this.border ??= this.createBorder(display);
    this.sendState();
    this.options.onChange?.(state);
    // Nothing is shared while paused, so the border goes away too.
    if (state.paused) this.border.hide();
    else if (this.border.webContents.getURL()) this.border.showInactive();
  }

  hide(): void {
    if (this.state) this.options.onChange?.(null);
    this.bar?.destroy();
    this.border?.destroy();
    this.bar = null;
    this.barReady = false;
    this.border = null;
    this.state = null;
  }

  private sendState(): void {
    if (this.state && this.bar && this.barReady) {
      this.bar.webContents.send(Channels.barState, this.state);
    }
  }

  private createBar(display: Display): BrowserWindow {
    const { workArea } = display;
    const bar = new BrowserWindow({
      ...BAR_SIZE,
      x: Math.round(workArea.x + (workArea.width - BAR_SIZE.width) / 2),
      y: workArea.y + 12,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Only Stop ends the session; the bar can't be closed by accident.
      closable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'Remote Assist',
      backgroundColor: '#1f2430',
      webPreferences: { ...sandboxed, preload: this.options.barPreload },
    });
    bar.setAlwaysOnTop(true, 'screen-saver');
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    lockDown(bar);
    this.barReady = false;
    bar.webContents.on('did-finish-load', () => {
      this.barReady = true;
      this.sendState();
    });
    // Shown without taking the keyboard away from whatever Grandma is doing.
    bar.once('ready-to-show', () => bar.showInactive());
    this.options.load(bar, 'bar');
    return bar;
  }

  private createBorder(display: Display): BrowserWindow {
    const border = new BrowserWindow({
      ...display.workArea,
      frame: false,
      transparent: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      enableLargerThanScreen: true,
      webPreferences: sandboxed,
    });
    border.setIgnoreMouseEvents(true);
    border.setAlwaysOnTop(true, 'screen-saver');
    border.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    border.setContentProtection(true);
    lockDown(border);
    border.once('ready-to-show', () => {
      if (this.state && !this.state.paused) border.showInactive();
    });
    this.options.load(border, 'border');
    return border;
  }
}
