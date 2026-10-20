import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('electron-updater', () => ({ autoUpdater: {} }));

const { QUIET_IDLE_SECONDS, isQuietMoment, startAutoUpdates } = await import('./updates');

describe('updates', () => {
  it('restarts only when no one is helping, the window is closed and no one is at the computer', () => {
    const quiet = { busy: false, windowVisible: false, idleSeconds: QUIET_IDLE_SECONDS };
    expect(isQuietMoment(quiet)).toBe(true);
    expect(isQuietMoment({ ...quiet, busy: true })).toBe(false);
    expect(isQuietMoment({ ...quiet, windowVisible: true })).toBe(false);
    expect(isQuietMoment({ ...quiet, idleSeconds: QUIET_IDLE_SECONDS - 1 })).toBe(false);
  });

  it('does nothing in development', () => {
    expect(startAutoUpdates()).toBeNull();
  });
});
