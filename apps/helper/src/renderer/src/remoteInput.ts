import { toPointerRange, type InputEvent } from '@remote-assist/protocol';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the picture really is inside the video element (`object-fit: contain` letterboxes it). */
export function contentBox(element: Box, videoWidth: number, videoHeight: number): Box | null {
  if (!videoWidth || !videoHeight || !element.width || !element.height) return null;
  const scale = Math.min(element.width / videoWidth, element.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: element.left + (element.width - width) / 2,
    top: element.top + (element.height - height) / 2,
    width,
    height,
  };
}

/**
 * A pointer position over the picture as 0–65535 coordinates. Outside the picture it is null,
 * unless `clamp` is set (a drag that leaves the picture keeps going along its edge).
 */
export function pointerPosition(
  clientX: number,
  clientY: number,
  box: Box,
  clamp = false,
): { x: number; y: number } | null {
  const fx = (clientX - box.left) / box.width;
  const fy = (clientY - box.top) / box.height;
  if (!clamp && (fx < 0 || fx > 1 || fy < 0 || fy > 1)) return null;
  return { x: toPointerRange(fx), y: toPointerRange(fy) };
}

const LINE_PIXELS = 16;
const MAX_WHEEL = 4_000;

/** DOM wheel deltas in pixels, whatever unit the device reported. */
export function wheelPixels(
  event: { deltaX: number; deltaY: number; deltaMode: number },
  pageHeight: number,
): { dx: number; dy: number } {
  const factor = event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? pageHeight : 1;
  const clamp = (value: number) => Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, value * factor));
  return { dx: clamp(event.deltaX), dy: clamp(event.deltaY) };
}

/** The parts of a `KeyboardEvent` that decide what to send. */
export interface KeyInput {
  type: 'down' | 'up';
  key: string;
  code: string;
  repeat: boolean;
  composing: boolean;
  meta: boolean;
  control: boolean;
}

export function keyInput(event: KeyboardEvent): KeyInput {
  return {
    type: event.type === 'keyup' ? 'up' : 'down',
    key: event.key,
    code: event.code,
    repeat: event.repeat,
    composing: event.isComposing,
    meta: event.metaKey,
    control: event.ctrlKey,
  };
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
]);

/**
 * Decides how each key press reaches the host:
 * - typed characters go as text, so "é" stays "é" whatever the host's keyboard layout;
 * - shortcuts (with ⌘ or Ctrl), modifiers and special keys go as physical keys, with the
 *   character attached so the host can find the same shortcut on its own layout.
 */
export class KeyTranslator {
  private readonly heldKeys = new Set<string>();

  translate(input: KeyInput): InputEvent[] {
    if (input.type === 'up') {
      if (!this.heldKeys.delete(input.code)) return [];
      return [{ t: 'key', code: input.code, down: false }];
    }
    // Dead keys (´ then e) arrive as one composed character on the next key press.
    if (input.composing || ['Dead', 'Process', 'Unidentified'].includes(input.key)) return [];

    const character = [...input.key].length === 1 ? input.key : undefined;
    if (character && !input.meta && !input.control && !MODIFIER_CODES.has(input.code)) {
      return [{ t: 'text', text: character }];
    }
    if (!/^[A-Za-z0-9]{1,24}$/.test(input.code)) return [];
    this.heldKeys.add(input.code);
    return [
      {
        t: 'key',
        code: input.code,
        down: true,
        ...(input.repeat ? { repeat: true } : {}),
        ...(character ? { char: character } : {}),
      },
    ];
  }

  /** Forget held keys; the host is told to release everything separately. */
  reset(): void {
    this.heldKeys.clear();
  }
}
