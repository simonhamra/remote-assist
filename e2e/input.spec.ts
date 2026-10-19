import { expect, test, type Page } from '@playwright/test';
import { connect, launch, startServer, type LaunchedApp } from './helpers';

interface Posted {
  type: string;
  x?: number;
  y?: number;
  keycode?: number;
  flags?: number;
  text?: string;
}

const COMMAND = 0x100000;
const SHIFT = 0x20000;

/** What the host's input agent would have posted (it runs in dry-run mode in this test). */
function posted(host: LaunchedApp): Posted[] {
  const prefix = '[input-agent] ';
  return host.output
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as Posted & { event: string })
    .filter((message) => message.event === 'posted');
}

type KeyEvent = { type: 'keyDown' | 'keyUp'; keyCode: string; modifiers?: ('meta' | 'shift')[] };

/**
 * Key presses as the operating system would deliver them. (Playwright's own keyboard skips
 * Electron's `before-input-event`, which is where the helper captures keys.)
 */
async function pressKeys(app: LaunchedApp, events: KeyEvent[]): Promise<void> {
  await app.application.evaluate(({ BrowserWindow }, list) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    for (const event of list) contents?.sendInputEvent(event);
  }, events);
}

/** Only the keyboard events, so stray pointer moves don't matter. */
function lastKey(host: LaunchedApp): Posted | undefined {
  return posted(host)
    .filter((e) => ['keyDown', 'keyUp', 'flagsChanged'].includes(e.type))
    .at(-1);
}

/** Page coordinates of a spot on the remote picture, given as fractions of its size. */
function pictureSpot(page: Page, fx: number, fy: number) {
  return page.getByTestId('remote-video').evaluate(
    (video: HTMLVideoElement, [x, y]) => {
      const box = video.getBoundingClientRect();
      const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      return {
        x: box.left + (box.width - width) / 2 + (x ?? 0) * width,
        y: box.top + (box.height - height) / 2 + (y ?? 0) * height,
      };
    },
    [fx, fy],
  );
}

test('the helper uses the host mouse and keyboard, and nothing stays held afterwards', async () => {
  const server = await startServer();
  const env = { RA_SIGNALING_URL: server.url, RA_INPUT_DRY_RUN: '1' };
  const host = await launch('host', env);
  const helper = await launch('helper', env);
  try {
    await connect(host, helper);
    await expect(helper.page.getByTestId('viewer-status')).toHaveText('Controlling their screen');
    await expect(host.page.getByTestId('control-status')).toContainText(
      'can also use your mouse and keyboard',
    );
    await expect
      .poll(() =>
        helper.page.getByTestId('remote-video').evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBeGreaterThan(0);
    const display = await host.application.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().bounds,
    );
    // With the helper app in front, the host app has no keyboard focus (typing into the host
    // app's own window is blocked on purpose).
    await helper.application.evaluate(({ app }) => app.focus({ steal: true }));

    // A click at 10% / 10% of the picture lands at 10% / 10% of the host's display.
    const spot = await pictureSpot(helper.page, 0.1, 0.1);
    await helper.page.mouse.click(spot.x, spot.y);
    await expect
      .poll(() => posted(host).map((e) => e.type))
      .toEqual(expect.arrayContaining(['leftMouseDown', 'leftMouseUp']));
    const down = posted(host).find((e) => e.type === 'leftMouseDown');
    expect(down?.x).toBeCloseTo(display.x + display.width * 0.1, -1);
    expect(down?.y).toBeCloseTo(display.y + display.height * 0.1, -1);

    // A drag moves with the button held down.
    const from = await pictureSpot(helper.page, 0.2, 0.15);
    const to = await pictureSpot(helper.page, 0.3, 0.2);
    await helper.page.mouse.move(from.x, from.y);
    await helper.page.mouse.down();
    await helper.page.mouse.move(to.x, to.y, { steps: 5 });
    await helper.page.mouse.up();
    await expect.poll(() => posted(host).some((e) => e.type === 'leftMouseDragged')).toBe(true);

    // Typing arrives as text; a shortcut arrives as keys with the Command flag held.
    await pressKeys(helper, [
      { type: 'keyDown', keyCode: 'h' },
      { type: 'keyUp', keyCode: 'h' },
      { type: 'keyDown', keyCode: 'i' },
      { type: 'keyUp', keyCode: 'i' },
    ]);
    await expect
      .poll(() =>
        posted(host)
          .filter((e) => e.type === 'keyDown' && e.text)
          .map((e) => e.text)
          .join(''),
      )
      .toBe('hi');
    await pressKeys(helper, [
      { type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] },
      { type: 'keyDown', keyCode: 'a', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'a', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'Meta' },
    ]);
    await expect
      .poll(() => posted(host).some((e) => e.type === 'keyDown' && e.flags === COMMAND))
      .toBe(true);
    await expect.poll(() => lastKey(host)).toMatchObject({ type: 'flagsChanged', flags: 0 });

    // ⌘W goes to their computer: the helper's own window stays open.
    await pressKeys(helper, [
      { type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] },
      { type: 'keyDown', keyCode: 'w', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'w', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'Meta' },
    ]);
    await expect.poll(() => lastKey(host)).toMatchObject({ type: 'flagsChanged', flags: 0 });
    expect(
      await helper.application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);

    // Shift held while the helper disconnects is let go on the host.
    await pressKeys(helper, [{ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] }]);
    await expect.poll(() => lastKey(host)).toMatchObject({ type: 'flagsChanged', flags: SHIFT });
    await helper.page.getByRole('button', { name: 'Disconnect' }).click();
    await expect.poll(() => lastKey(host)).toMatchObject({ type: 'flagsChanged', flags: 0 });
    await expect(host.page.getByTestId('status')).toHaveText('Your helper disconnected.');
  } finally {
    await host.application.close();
    await helper.application.close();
    server.stop();
  }
});
