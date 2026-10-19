import { describe, expect, it } from 'vitest';
import {
  KeyTranslator,
  contentBox,
  pointerPosition,
  wheelPixels,
  type KeyInput,
} from './remoteInput';

describe('contentBox', () => {
  it('finds the letterboxed picture inside a wider element', () => {
    // A 16:10 screen shown in a 1280×600 area: bars on the left and right.
    expect(contentBox({ left: 0, top: 40, width: 1280, height: 600 }, 1728, 1080)).toEqual({
      left: 160,
      top: 40,
      width: 960,
      height: 600,
    });
  });

  it('is null before the video has a size', () => {
    expect(contentBox({ left: 0, top: 0, width: 100, height: 100 }, 0, 0)).toBeNull();
  });
});

describe('pointerPosition', () => {
  const box = { left: 160, top: 40, width: 960, height: 600 };

  it('maps the picture to 0–65535', () => {
    expect(pointerPosition(160, 40, box)).toEqual({ x: 0, y: 0 });
    expect(pointerPosition(1120, 640, box)).toEqual({ x: 65_535, y: 65_535 });
    expect(pointerPosition(640, 340, box)).toEqual({ x: 32_768, y: 32_768 });
  });

  it('ignores the black bars, except while dragging', () => {
    expect(pointerPosition(100, 300, box)).toBeNull();
    expect(pointerPosition(100, 300, box, true)).toEqual({ x: 0, y: 28_399 });
  });
});

describe('wheelPixels', () => {
  it('converts lines and pages to pixels, within limits', () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ dx: 0, dy: 48 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toEqual({ dx: 0, dy: 600 });
    expect(wheelPixels({ deltaX: -9_000, deltaY: 0, deltaMode: 0 }, 600)).toEqual({
      dx: -4_000,
      dy: 0,
    });
  });
});

describe('KeyTranslator', () => {
  const key = (overrides: Partial<KeyInput>): KeyInput => ({
    type: 'down',
    key: 'a',
    code: 'KeyA',
    repeat: false,
    composing: false,
    meta: false,
    control: false,
    ...overrides,
  });

  it('sends typed characters as text, including accents and Option characters', () => {
    const keys = new KeyTranslator();
    expect(keys.translate(key({ key: 'é', code: 'Digit2' }))).toEqual([{ t: 'text', text: 'é' }]);
    expect(keys.translate(key({ key: 'œ', code: 'KeyQ' }))).toEqual([{ t: 'text', text: 'œ' }]);
    // The key-up of a typed character has nothing left to release.
    expect(keys.translate(key({ type: 'up', key: 'é', code: 'Digit2' }))).toEqual([]);
  });

  it('sends shortcuts as physical keys carrying their character', () => {
    const keys = new KeyTranslator();
    expect(keys.translate(key({ key: 'Meta', code: 'MetaLeft', meta: true }))).toEqual([
      { t: 'key', code: 'MetaLeft', down: true },
    ]);
    // On an AZERTY Mac, ⌘A is the key in the QWERTY "Q" position.
    expect(keys.translate(key({ key: 'a', code: 'KeyQ', meta: true }))).toEqual([
      { t: 'key', code: 'KeyQ', down: true, char: 'a' },
    ]);
    expect(keys.translate(key({ type: 'up', key: 'a', code: 'KeyQ', meta: true }))).toEqual([
      { t: 'key', code: 'KeyQ', down: false },
    ]);
  });

  it('sends special keys and repeats as keys', () => {
    const keys = new KeyTranslator();
    expect(keys.translate(key({ key: 'Enter', code: 'Enter' }))).toEqual([
      { t: 'key', code: 'Enter', down: true },
    ]);
    expect(keys.translate(key({ key: 'ArrowDown', code: 'ArrowDown', repeat: true }))).toEqual([
      { t: 'key', code: 'ArrowDown', down: true, repeat: true },
    ]);
  });

  it('waits for dead keys to compose, and skips unknown codes', () => {
    const keys = new KeyTranslator();
    expect(keys.translate(key({ key: 'Dead', code: 'BracketLeft' }))).toEqual([]);
    expect(keys.translate(key({ key: 'Enter', code: '' }))).toEqual([]);
  });
});
