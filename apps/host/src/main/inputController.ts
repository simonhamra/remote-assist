import type { AgentCommand } from '@remote-assist/native-input';
import { POINTER_RANGE, type InputEvent } from '@remote-assist/protocol';
import { macKeyCode } from './keymap';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InputControllerDeps {
  send(command: AgentCommand): void;
  /** The display being shared, in screen points. */
  display(): Rect;
  /** This app's own visible windows: clicks and scrolls there are dropped. */
  ownWindows(): Rect[];
  /** True while this app has keyboard focus: typing is dropped then. */
  ownWindowFocused(): boolean;
  now?(): number;
}

export type InputOutcome = 'sent' | 'disabled' | 'rate-limited' | 'own-window' | 'unknown-key';

/** Far above what a person produces (pointer moves arrive about 60 times a second). */
const EVENTS_PER_SECOND = 400;

/**
 * The host's input gate: the only path from the helper to the mouse and keyboard. It runs in
 * the main process, so the helper (and even this app's own renderer) cannot get around it.
 */
export class InputController {
  private readonly deps: InputControllerDeps;
  private enabled = false;
  private windowStart = 0;
  private windowCount = 0;

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Turning control off always lets go of everything the helper was holding. */
  setEnabled(enabled: boolean): void {
    if (this.enabled && !enabled) this.deps.send({ op: 'release' });
    this.enabled = enabled;
  }

  handle(event: InputEvent): InputOutcome {
    if (!this.enabled) return 'disabled';
    // Letting go is always allowed, and never rate-limited.
    if (event.t === 'release') return this.send({ op: 'release' });
    if (!this.withinRate()) return 'rate-limited';

    switch (event.t) {
      case 'move':
        return this.send({ op: 'move', ...this.toScreen(event.x, event.y) });
      case 'button': {
        const point = this.toScreen(event.x, event.y);
        // Never let the helper click this app's own buttons (Stop, and later the consent screen).
        if (event.down && this.overOwnWindow(point)) return 'own-window';
        return this.send({ op: 'button', button: event.button, down: event.down, ...point });
      }
      case 'wheel': {
        const point = this.toScreen(event.x, event.y);
        if (this.overOwnWindow(point)) return 'own-window';
        return this.send({ op: 'scroll', dx: event.dx, dy: event.dy, ...point });
      }
      case 'key': {
        const keycode = macKeyCode(event.code);
        if (keycode === undefined) return 'unknown-key';
        if (event.down && this.deps.ownWindowFocused()) return 'own-window';
        return this.send({
          op: 'key',
          id: event.code,
          down: event.down,
          keycode,
          ...(event.char ? { char: event.char } : {}),
          ...(event.repeat ? { repeat: true } : {}),
        });
      }
      case 'text':
        if (this.deps.ownWindowFocused()) return 'own-window';
        return this.send({ op: 'text', text: event.text });
    }
  }

  private send(command: AgentCommand): InputOutcome {
    this.deps.send(command);
    return 'sent';
  }

  /** 0–65535 across the shared display → screen points, kept inside that display. */
  private toScreen(x: number, y: number): { x: number; y: number } {
    const display = this.deps.display();
    const clamp = (value: number, start: number, size: number) =>
      Math.min(start + size - 1, Math.max(start, value));
    return {
      x: clamp(display.x + (x / POINTER_RANGE) * display.width, display.x, display.width),
      y: clamp(display.y + (y / POINTER_RANGE) * display.height, display.y, display.height),
    };
  }

  private overOwnWindow(point: { x: number; y: number }): boolean {
    return this.deps
      .ownWindows()
      .some(
        (w) =>
          point.x >= w.x && point.x < w.x + w.width && point.y >= w.y && point.y < w.y + w.height,
      );
  }

  private withinRate(): boolean {
    const now = this.deps.now?.() ?? Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= EVENTS_PER_SECOND;
  }
}
