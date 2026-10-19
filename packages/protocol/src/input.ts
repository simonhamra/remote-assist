/**
 * Remote input from the helper to the host, over the WebRTC data channels.
 *
 * - `ptr` (unordered, no retransmits): pointer moves as 5 binary bytes. A lost move is simply
 *   overtaken by the next one.
 * - `ctl` (ordered, reliable): everything else as JSON. Clicks and scrolls carry their own
 *   position, so they land where the helper pointed even if a move was lost.
 *
 * Positions are normalized to 0–65535 across the shared display, independent of its resolution.
 */
import { z } from 'zod';

export const POINTER_RANGE = 65_535;
const POINTER_MOVE = 1;
const POINTER_MOVE_BYTES = 5;

const coordinate = z.number().int().min(0).max(POINTER_RANGE);
const wheelDelta = z.number().min(-4_000).max(4_000);

export const mouseButton = z.enum(['left', 'right', 'middle']);
export type MouseButton = z.infer<typeof mouseButton>;

const inputOptions = [
  z.object({ t: z.literal('move'), x: coordinate, y: coordinate }),
  z.object({
    t: z.literal('button'),
    button: mouseButton,
    down: z.boolean(),
    x: coordinate,
    y: coordinate,
  }),
  /** Pixels; positive `dy` scrolls the content down, like DOM wheel events. */
  z.object({ t: z.literal('wheel'), dx: wheelDelta, dy: wheelDelta, x: coordinate, y: coordinate }),
  /**
   * A key by physical position (`KeyboardEvent.code`). For shortcuts, `char` is the character
   * the key types on the helper's keyboard, so the host can find the same character on its own
   * layout (⌘A must stay ⌘A between QWERTY and AZERTY).
   */
  z.object({
    t: z.literal('key'),
    code: z.string().regex(/^[A-Za-z0-9]{1,24}$/),
    down: z.boolean(),
    repeat: z.boolean().optional(),
    char: z.string().min(1).max(4).optional(),
  }),
  /** Typed characters, injected as text so the host's keyboard layout cannot scramble them. */
  z.object({ t: z.literal('text'), text: z.string().min(1).max(64) }),
  /** Let go of every held key and button: the helper's window lost focus, or it is leaving. */
  z.object({ t: z.literal('release') }),
] as const;

export const inputEvent = z.discriminatedUnion('t', [...inputOptions]);
export type InputEvent = z.infer<typeof inputEvent>;

/** Messages on the `ctl` channel, in both directions. */
export const peerMessage = z.discriminatedUnion('t', [
  ...inputOptions,
  /** Either side is ending the session. */
  z.object({ t: z.literal('end') }),
  /**
   * Helper → host, first thing: which computer the helper runs on (a short hash of its name).
   * The host keeps control off when it's the same computer, where it would only control itself.
   */
  z.object({ t: z.literal('hello'), machine: z.string().regex(/^[0-9a-f]{16}$/) }),
  /** Host → helper: whether remote control works right now, and if not, why. */
  z.object({
    t: z.literal('control'),
    available: z.boolean(),
    reason: z.enum(['permission', 'unsupported', 'same-computer']).optional(),
  }),
  /** Host → helper: paused (no picture, no control) or running again. Only the host decides. */
  z.object({ t: z.literal('paused'), paused: z.boolean() }),
  /** Host → helper: nothing has happened for a while; the session ends unless the helper acts. */
  z.object({ t: z.literal('idle'), secondsLeft: z.number().int().min(0).max(3_600) }),
]);
export type PeerMessage = z.infer<typeof peerMessage>;

export function parsePeerMessage(text: string): PeerMessage | null {
  try {
    const result = peerMessage.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseInputEvent(value: unknown): InputEvent | null {
  const result = inputEvent.safeParse(value);
  return result.success ? result.data : null;
}

const INPUT_TYPES: ReadonlySet<string> = new Set(
  inputOptions.map((option) => option.shape.t.value),
);

export function isInputEvent(message: PeerMessage): message is InputEvent {
  return INPUT_TYPES.has(message.t);
}

/** A fraction of the display (0–1) as a pointer coordinate, clamped. */
export function toPointerRange(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * POINTER_RANGE);
}

export function encodePointerMove(x: number, y: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(POINTER_MOVE_BYTES));
  view.setUint8(0, POINTER_MOVE);
  view.setUint16(1, clamp(x));
  view.setUint16(3, clamp(y));
  return view.buffer;
}

export function decodePointerMove(data: unknown): { x: number; y: number } | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength !== POINTER_MOVE_BYTES) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== POINTER_MOVE) return null;
  return { x: view.getUint16(1), y: view.getUint16(3) };
}

function clamp(value: number): number {
  return Math.min(POINTER_RANGE, Math.max(0, Math.round(value)));
}
