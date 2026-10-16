import { describe, expect, it } from 'vitest';
import {
  TIMECODE_BLOCKS,
  decodeTimecode,
  encodeTimecode,
  percentile,
  sampleTimecode,
  timecodeAge,
} from './timecode';

const MODULUS = 2 ** 20;

/** Renders blocks into an RGBA buffer the way a scaled-down video frame would look. */
function render(blocks: boolean[], blockSize = 8, white = 255, black = 0) {
  const width = blocks.length * blockSize;
  const height = blockSize;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = blocks[Math.floor(x / blockSize)] ? white : black;
      pixels.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return { pixels, width, height };
}

describe('timecode', () => {
  it.each([0, 1, 123_456, MODULUS - 1, 1_760_000_000_123])('round-trips %d', (ms) => {
    const blocks = encodeTimecode(ms);
    expect(blocks).toHaveLength(TIMECODE_BLOCKS);
    expect(decodeTimecode(blocks)).toBe(ms % MODULUS);
  });

  it('rejects every single-block error', () => {
    const blocks = encodeTimecode(1_760_000_000_123);
    for (let i = 0; i < blocks.length; i++) {
      const damaged = blocks.map((bit, j) => (j === i ? !bit : bit));
      expect(decodeTimecode(damaged)).toBeNull();
    }
  });

  it('rejects the wrong number of blocks', () => {
    expect(decodeTimecode(encodeTimecode(5).slice(1))).toBeNull();
  });

  it('measures age across the 2^20 ms wrap-around', () => {
    const drawn = MODULUS - 10;
    expect(timecodeAge(MODULUS + 30, decodeTimecode(encodeTimecode(drawn)) ?? -1)).toBe(40);
  });

  it('reads blocks back from pixels, including washed-out video', () => {
    const blocks = encodeTimecode(987_654);
    const crisp = render(blocks);
    expect(sampleTimecode(crisp.pixels, crisp.width, crisp.height)).toEqual(blocks);
    const soft = render(blocks, 7, 200, 40);
    expect(decodeTimecode(sampleTimecode(soft.pixels, soft.width, soft.height))).toBe(987_654);
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const values = [50, 10, 40, 20, 30];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile([], 50)).toBeUndefined();
  });
});
