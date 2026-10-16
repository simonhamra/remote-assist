/**
 * Latency probe. The current time is drawn on screen as a strip of black and white blocks, travels
 * through capture → encode → network → decode, and is read back from the received video. The
 * difference with the clock at that moment is the glass-to-glass latency. Both ends must share a
 * clock, so this only works with host and helper on the same machine.
 */

const TIME_BITS = 20; // milliseconds modulo 2^20, which wraps every ~17.5 minutes
const CHECK_BITS = 4;
const MODULUS = 2 ** TIME_BITS;

/** White start guard, time bits, checksum bits, black end guard. */
export const TIMECODE_BLOCKS = 1 + TIME_BITS + CHECK_BITS + 1;

/** A rectangle in 0–1 coordinates relative to the captured display (or video frame). */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function encodeTimecode(ms: number): boolean[] {
  const time = mod(Math.floor(ms), MODULUS);
  return [true, ...toBits(time, TIME_BITS), ...toBits(checksum(time), CHECK_BITS), false];
}

/** Returns the encoded time (modulo 2^20 ms), or null if the blocks are not a valid timecode. */
export function decodeTimecode(blocks: readonly boolean[]): number | null {
  if (blocks.length !== TIMECODE_BLOCKS || blocks[0] !== true || blocks.at(-1) !== false) {
    return null;
  }
  const time = fromBits(blocks.slice(1, 1 + TIME_BITS));
  const check = fromBits(blocks.slice(1 + TIME_BITS, 1 + TIME_BITS + CHECK_BITS));
  return checksum(time) === check ? time : null;
}

/** Milliseconds elapsed between a decoded timecode and `nowMs`. */
export function timecodeAge(nowMs: number, timecode: number): number {
  return mod(Math.floor(nowMs) - timecode, MODULUS);
}

/**
 * Reads the blocks from an RGBA image of the strip (for example a canvas `getImageData` of the
 * strip's region), sampling the centre of each block along the middle row.
 */
export function sampleTimecode(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): boolean[] {
  const y = Math.floor(height / 2);
  return Array.from({ length: TIMECODE_BLOCKS }, (_, i) => {
    const x = Math.floor(((i + 0.5) * width) / TIMECODE_BLOCKS);
    const offset = (y * width + x) * 4;
    const luma =
      0.299 * (pixels[offset] ?? 0) +
      0.587 * (pixels[offset + 1] ?? 0) +
      0.114 * (pixels[offset + 2] ?? 0);
    return luma > 128;
  });
}

export function drawTimecode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  blockWidth: number,
  blockHeight: number,
  ms: number,
): void {
  encodeTimecode(ms).forEach((white, i) => {
    ctx.fillStyle = white ? '#ffffff' : '#000000';
    ctx.fillRect(x + i * blockWidth, y, blockWidth, blockHeight);
  });
}

/** Nearest-rank percentile, `p` in 0–100. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function checksum(time: number): number {
  let check = 0;
  for (let shift = 0; shift < TIME_BITS; shift += 4) check ^= (time >> shift) & 0xf;
  return check;
}

function toBits(value: number, count: number): boolean[] {
  return Array.from({ length: count }, (_, i) => ((value >> (count - 1 - i)) & 1) === 1);
}

function fromBits(bits: readonly boolean[]): number {
  return bits.reduce((value, bit) => value * 2 + (bit ? 1 : 0), 0);
}

function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
