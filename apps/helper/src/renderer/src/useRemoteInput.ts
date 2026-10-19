import type { MouseButton } from '@remote-assist/protocol';
import { useEffect, type RefObject } from 'react';
import type { HelperSession } from './helperSession';
import { KeyTranslator, contentBox, keyInput, pointerPosition, wheelPixels } from './remoteInput';

const BUTTONS: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right' };

/**
 * While `enabled`, the mouse, trackpad and keyboard over the video drive the remote computer.
 * Moves and scrolls are sent at most once per frame; clicks immediately, with their position.
 */
export function useRemoteInput(
  video: RefObject<HTMLVideoElement | null>,
  session: HelperSession,
  enabled: boolean,
): void {
  useEffect(() => {
    const element = video.current;
    if (!element || !enabled) return;

    const keys = new KeyTranslator();
    const pressed = new Set<number>();
    let move: { x: number; y: number } | null = null;
    let wheel: { dx: number; dy: number; x: number; y: number } | null = null;
    let frame = 0;

    const box = () =>
      contentBox(element.getBoundingClientRect(), element.videoWidth, element.videoHeight);

    const flush = () => {
      frame = 0;
      if (move) session.sendPointer(move.x, move.y);
      if (wheel) session.sendInput({ t: 'wheel', ...wheel });
      move = null;
      wheel = null;
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(flush);
    };

    const onMove = (event: PointerEvent) => {
      const picture = box();
      // During a drag, positions outside the picture stick to its edge.
      const point =
        picture && pointerPosition(event.clientX, event.clientY, picture, pressed.size > 0);
      if (!point) return;
      move = point;
      schedule();
    };
    const onDown = (event: PointerEvent) => {
      const picture = box();
      const point = picture && pointerPosition(event.clientX, event.clientY, picture);
      const button = BUTTONS[event.button];
      if (!point || !button) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      pressed.add(event.button);
      flush();
      session.sendInput({ t: 'button', button, down: true, ...point });
    };
    const onUp = (event: PointerEvent) => {
      const button = BUTTONS[event.button];
      if (!button || !pressed.delete(event.button)) return;
      const picture = box();
      const point = (picture && pointerPosition(event.clientX, event.clientY, picture, true)) ?? {
        x: 0,
        y: 0,
      };
      flush();
      session.sendInput({ t: 'button', button, down: false, ...point });
    };
    const onWheel = (event: WheelEvent) => {
      const picture = box();
      const point = picture && pointerPosition(event.clientX, event.clientY, picture);
      if (!picture || !point) return;
      event.preventDefault();
      const { dx, dy } = wheelPixels(event, picture.height);
      wheel = { dx: (wheel?.dx ?? 0) + dx, dy: (wheel?.dy ?? 0) + dy, ...point };
      wheel.dx = Math.max(-4_000, Math.min(4_000, wheel.dx));
      wheel.dy = Math.max(-4_000, Math.min(4_000, wheel.dy));
      schedule();
    };
    const onContextMenu = (event: Event) => event.preventDefault();
    // Every key goes to their computer. Cancelling it here also keeps the app menu from acting
    // on it (Electron only runs menu shortcuts for keys the page did not handle), so ⌘W closes
    // a window over there instead of this one.
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      for (const input of keys.translate(keyInput(event))) session.sendInput(input);
    };
    // Leaving the window (⌘Tab, a click elsewhere) must not leave keys or buttons held over there.
    const releaseAll = () => {
      keys.reset();
      pressed.clear();
      session.sendInput({ t: 'release' });
    };

    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('keyup', onKey, { capture: true });

    return () => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keyup', onKey, { capture: true });
      cancelAnimationFrame(frame);
      releaseAll();
    };
  }, [video, session, enabled]);
}
