import type { ScreenSource } from './peer';
import { TIMECODE_BLOCKS, drawTimecode, type NormalizedRect } from './timecode';

/**
 * A synthetic "screen" for automated tests (RA_FAKE_SCREEN=1): animated, with a latency timecode
 * at a fixed spot. It needs no macOS Screen Recording permission.
 */
export const FAKE_SCREEN = { width: 1920, height: 1080, block: 24, margin: 48 } as const;

export function fakeScreenTimecodeRect(): NormalizedRect {
  const { width, height, block, margin } = FAKE_SCREEN;
  return {
    x: margin / width,
    y: margin / height,
    width: (block * TIMECODE_BLOCKS) / width,
    height: block / height,
  };
}

export function startFakeScreen(): ScreenSource {
  const { width, height, block, margin } = FAKE_SCREEN;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available.');

  const started = performance.now();
  const draw = (): void => {
    const seconds = (performance.now() - started) / 1000;
    ctx.fillStyle = '#20314f';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#f4efe6';
    ctx.font = '600 56px system-ui, sans-serif';
    ctx.fillText('Test screen: nothing real is being shared', margin, 200);
    ctx.fillStyle = '#e9a23b';
    ctx.fillRect(margin + ((seconds * 400) % (width - 2 * margin - 200)), 420, 200, 200);
    drawTimecode(ctx, margin, margin, block, block, Date.now());
  };
  draw();
  const timer = setInterval(draw, 1000 / 60);
  const stream = canvas.captureStream(30);

  return {
    stream,
    stop: () => {
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
