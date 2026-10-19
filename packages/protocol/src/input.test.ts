import { describe, expect, it } from 'vitest';
import {
  POINTER_RANGE,
  decodePointerMove,
  encodePointerMove,
  isInputEvent,
  parseInputEvent,
  parsePeerMessage,
  toPointerRange,
} from './input.ts';

describe('pointer moves', () => {
  it('round-trip through 5 bytes', () => {
    const encoded = encodePointerMove(12_345, POINTER_RANGE);
    expect(encoded.byteLength).toBe(5);
    expect(decodePointerMove(encoded)).toEqual({ x: 12_345, y: POINTER_RANGE });
  });

  it('clamp out-of-range values', () => {
    expect(decodePointerMove(encodePointerMove(-5, 70_000))).toEqual({ x: 0, y: POINTER_RANGE });
    expect(toPointerRange(1.2)).toBe(POINTER_RANGE);
    expect(toPointerRange(0.5)).toBe(32_768);
  });

  it('reject anything that is not a move', () => {
    expect(decodePointerMove(new ArrayBuffer(4))).toBeNull();
    expect(decodePointerMove('move')).toBeNull();
    const wrongKind = new Uint8Array([2, 0, 0, 0, 0]).buffer;
    expect(decodePointerMove(wrongKind)).toBeNull();
  });
});

describe('peer messages', () => {
  it('accept clicks, shortcuts, text and control state', () => {
    const messages = [
      { t: 'button', button: 'right', down: true, x: 100, y: 200 },
      { t: 'key', code: 'KeyA', down: true, char: 'a' },
      { t: 'text', text: 'Crème brûlée' },
      { t: 'release' },
      { t: 'end' },
      { t: 'hello', machine: '0123456789abcdef' },
      { t: 'control', available: false, reason: 'same-computer' },
      { t: 'paused', paused: true },
      { t: 'idle', secondsLeft: 60 },
    ];
    for (const message of messages) {
      expect(parsePeerMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  it('reject out-of-range positions, odd key codes and long text', () => {
    const bad = [
      { t: 'button', button: 'left', down: true, x: 70_000, y: 0 },
      { t: 'button', button: 'back', down: true, x: 0, y: 0 },
      { t: 'key', code: '../../etc', down: true },
      { t: 'text', text: 'x'.repeat(65) },
      { t: 'wheel', dx: 0, dy: 1e9, x: 0, y: 0 },
      { t: 'shell', command: 'rm' },
    ];
    for (const message of bad) expect(parsePeerMessage(JSON.stringify(message))).toBeNull();
    expect(parsePeerMessage('not json')).toBeNull();
  });

  it('tells input apart from session messages', () => {
    const click = parsePeerMessage(JSON.stringify({ t: 'release' }));
    const end = parsePeerMessage(JSON.stringify({ t: 'end' }));
    const hello = parsePeerMessage(JSON.stringify({ t: 'hello', machine: 'ffffffffffffffff' }));
    expect(click && isInputEvent(click)).toBe(true);
    expect(end && isInputEvent(end)).toBe(false);
    expect(hello && isInputEvent(hello)).toBe(false);
    const paused = parsePeerMessage(JSON.stringify({ t: 'paused', paused: true }));
    expect(paused && isInputEvent(paused)).toBe(false);
    expect(parseInputEvent({ t: 'end' })).toBeNull();
  });
});
