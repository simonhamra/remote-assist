import { describe, expect, it, vi } from 'vitest';
import { trayIconBitmap, trayMenu, trayStatus } from './tray';

const alphaAt = (pixels: Buffer, size: number, x: number, y: number) =>
  pixels[(y * size + x) * 4 + 3];

describe('tray menu', () => {
  const actions = { open: vi.fn(), command: vi.fn(), quit: vi.fn() };
  const labels = (items: ReturnType<typeof trayMenu>) =>
    items.filter((item) => item.type !== 'separator').map((item) => item.label);

  it('offers to open and quit when no one is helping', () => {
    expect(labels(trayMenu(null, actions))).toEqual([
      'Remote Assist: no one is helping you',
      'Open Remote Assist',
      'Quit Remote Assist',
    ]);
  });

  it('shows who is helping, with Pause and Stop', () => {
    const items = trayMenu({ helperName: 'Alex', paused: false }, actions);
    expect(labels(items)).toEqual([
      'Alex is helping you',
      'Pause',
      'Stop',
      'Open Remote Assist',
      'Quit Remote Assist',
    ]);
    const stop = items.find((item) => item.label === 'Stop')?.click as () => void;
    stop();
    expect(actions.command).toHaveBeenCalledWith('stop');
  });

  it('offers to continue while paused', () => {
    const items = trayMenu({ helperName: 'Alex', paused: true }, actions);
    expect(labels(items)).toContain('Continue');
    expect(trayStatus({ helperName: 'Alex', paused: true })).toBe(
      "Paused: Alex can't see your screen",
    );
  });
});

describe('tray icon', () => {
  it('is a ring, with a dot in the middle while someone helps', () => {
    const size = 36;
    const idle = trayIconBitmap(size, false);
    const helping = trayIconBitmap(size, true);
    expect(idle).toHaveLength(size * size * 4);
    // Colour channels stay black, so macOS can tint it for the menu bar.
    expect(idle.filter((_, i) => i % 4 !== 3).every((byte) => byte === 0)).toBe(true);
    expect(alphaAt(idle, size, 18, 18)).toBe(0);
    expect(alphaAt(helping, size, 18, 18)).toBe(255);
    expect(alphaAt(idle, size, 18, 3)).toBeGreaterThan(200);
    expect(alphaAt(idle, size, 0, 0)).toBe(0);
  });
});
