import type { MenuItemConstructorOptions } from 'electron';
import type { BarCommand, ChromeState } from '../shared/api';

/** Drawn at twice the menu bar's 18-point size, for sharp Retina screens. */
export const TRAY_ICON_PIXELS = 36;

export interface TrayActions {
  open(): void;
  command(command: BarCommand): void;
  quit(): void;
}

export function trayStatus(state: ChromeState | null): string {
  if (!state) return 'Remote Assist: no one is helping you';
  return state.paused
    ? `Paused: ${state.helperName} can't see your screen`
    : `${state.helperName} is helping you`;
}

/** The menu under the menu-bar icon. While someone helps, it has Pause and Stop too. */
export function trayMenu(
  state: ChromeState | null,
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [{ label: trayStatus(state), enabled: false }];
  if (state) {
    items.push(
      state.paused
        ? { label: 'Continue', click: () => actions.command('resume') }
        : { label: 'Pause', click: () => actions.command('pause') },
      { label: 'Stop', click: () => actions.command('stop') },
    );
  }
  items.push(
    { type: 'separator' },
    { label: 'Open Remote Assist', click: () => actions.open() },
    { type: 'separator' },
    { label: 'Quit Remote Assist', click: () => actions.quit() },
  );
  return items;
}

/**
 * The menu-bar icon as premultiplied BGRA pixels, black on transparent: a ring, with a dot in
 * the middle while someone is helping (like a recording light).
 */
export function trayIconBitmap(size: number, helping: boolean): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = size / 2;
  const outer = size * 0.42;
  const inner = outer - size * 0.09;
  const dot = size * 0.17;
  const samples = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const distance = Math.hypot(
            x + (sx + 0.5) / samples - centre,
            y + (sy + 0.5) / samples - centre,
          );
          if ((distance >= inner && distance <= outer) || (helping && distance <= dot)) covered++;
        }
      }
      pixels[(y * size + x) * 4 + 3] = Math.round((covered / samples ** 2) * 255);
    }
  }
  return pixels;
}
