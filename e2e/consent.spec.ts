import { expect, test, type Page } from '@playwright/test';
import {
  HELPER_NAME,
  connect,
  launch,
  requestHelp,
  sessionBar,
  startServer,
  type LaunchedApp,
} from './helpers';

/** What the host's input agent would have posted (it runs in dry-run mode in these tests). */
function posted(host: LaunchedApp): { type: string }[] {
  const prefix = '[input-agent] ';
  return host.output
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as { event: string; type: string })
    .filter((message) => message.event === 'posted');
}

/**
 * Lets the test act as a misbehaving helper: keeps hold of the helper's data channels so raw
 * messages can be sent past its own UI. Must run before the helper connects.
 */
async function captureChannels(helper: Page): Promise<void> {
  await helper.evaluate(() => {
    const Original = window.RTCPeerConnection;
    const channels: RTCDataChannel[] = [];
    Object.assign(window, { testChannels: channels });
    window.RTCPeerConnection = class extends Original {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        this.addEventListener('datachannel', ({ channel }) => channels.push(channel));
      }
    };
  });
}

/** Sends raw input straight down the data channels, as a modified helper app could. */
async function sendRaw(helper: Page, clicks: { x: number; y: number }[]): Promise<void> {
  await helper.evaluate((points) => {
    const channels = (window as unknown as { testChannels: RTCDataChannel[] }).testChannels;
    const ctl = channels.find((c) => c.label === 'ctl');
    const ptr = channels.find((c) => c.label === 'ptr');
    if (!ctl || !ptr) throw new Error('No data channels');
    const send = (message: unknown) => ctl.send(JSON.stringify(message));
    for (const { x, y } of points) {
      const move = new DataView(new ArrayBuffer(5));
      move.setUint8(0, 1);
      move.setUint16(1, x);
      move.setUint16(3, y);
      ptr.send(move.buffer);
      send({ t: 'button', button: 'left', down: true, x, y });
      send({ t: 'button', button: 'left', down: false, x, y });
    }
    send({ t: 'key', code: 'KeyA', down: true, char: 'a' });
    send({ t: 'key', code: 'KeyA', down: false });
    send({ t: 'text', text: 'not allowed' });
  }, clicks);
}

async function withApps(
  env: Record<string, string>,
  run: (host: LaunchedApp, helper: LaunchedApp) => Promise<void>,
): Promise<void> {
  const server = await startServer();
  const host = await launch('host', { RA_SIGNALING_URL: server.url, ...env });
  const helper = await launch('helper', { RA_SIGNALING_URL: server.url, ...env });
  try {
    await run(host, helper);
  } finally {
    await host.application.close();
    await helper.application.close();
    server.stop();
  }
}

test('nothing is shared until the person says yes, and "no" tells the helper', async () => {
  await withApps({}, async (host, helper) => {
    await requestHelp(host, helper);
    await expect(helper.page.getByTestId('status')).toHaveText(
      'Waiting for them to say yes on their screen…',
    );
    await expect(host.page.getByTestId('consent')).toContainText('see your screen');
    // While the question is open, the helper has no picture at all.
    await expect(helper.page.getByTestId('remote-video')).toHaveCount(0);

    await host.page.getByRole('button', { name: 'No, not now' }).click();
    await expect(host.page.getByTestId('status')).toHaveText('You said no. Nothing was shared.');
    await expect(helper.page.getByRole('alert')).toHaveText('They said no, so nothing was shared.');

    // The refusal is kept in the history on the host.
    await host.page.getByRole('button', { name: 'Done' }).click();
    await expect(host.page.getByTestId('history').locator('li').first()).toContainText(
      `${HELPER_NAME}: you said no`,
    );
  });
});

test('an unanswered question closes by itself', async () => {
  await withApps({ RA_TEST_CONSENT_MS: '2000' }, async (host, helper) => {
    await requestHelp(host, helper);
    await expect(host.page.getByTestId('status')).toHaveText(
      'Nobody answered in time, so nothing was shared.',
      { timeout: 10_000 },
    );
    await expect(helper.page.getByRole('alert')).toHaveText(
      "They didn't answer in time, so nothing was shared.",
    );
  });
});

test('pause hides the screen and stops even a misbehaving helper; the bar is out of reach', async () => {
  await withApps({ RA_INPUT_DRY_RUN: '1' }, async (host, helper) => {
    await captureChannels(helper.page);
    await connect(host, helper);
    await expect(helper.page.getByTestId('viewer-status')).toHaveText('Controlling their screen');

    const bar = await sessionBar(host);
    await expect(bar.getByTestId('bar-label')).toHaveText(`${HELPER_NAME} is helping you`);
    await bar.getByTestId('bar-pause').click();
    await expect(helper.page.getByTestId('paused-overlay')).toBeVisible();
    await expect(host.page.getByTestId('status')).toHaveText(
      `Paused: ${HELPER_NAME} can't see or use your screen`,
    );
    await expect(bar.getByTestId('bar-label')).toContainText('Paused');

    // While paused, nothing the helper sends gets through: clicks, keys, text, pointer moves.
    await host.page.waitForTimeout(500);
    const before = posted(host).length;
    await sendRaw(helper.page, [
      { x: 30_000, y: 30_000 },
      { x: 5_000, y: 60_000 },
    ]);
    await host.page.waitForTimeout(1000);
    expect(posted(host).length).toBe(before);

    // Only the person at the computer can continue.
    await bar.getByTestId('bar-pause').click();
    await expect(helper.page.getByTestId('paused-overlay')).toHaveCount(0);
    await expect(helper.page.getByTestId('viewer-status')).toHaveText('Controlling their screen');

    // Clicks aimed at the session bar are dropped; a click elsewhere goes through.
    const target = await host.application.evaluate(({ BrowserWindow, screen }) => {
      const barWindow = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('bar.html'),
      );
      const display = screen.getPrimaryDisplay().bounds;
      const b = barWindow?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
      const scale = (value: number, start: number, size: number) =>
        Math.round(((value - start) / size) * 65_535);
      return {
        x: scale(b.x + b.width / 2, display.x, display.width),
        y: scale(b.y + b.height / 2, display.y, display.height),
      };
    });
    await host.page.waitForTimeout(300);
    const beforeBar = posted(host).filter((e) => e.type === 'leftMouseDown').length;
    await sendRaw(helper.page, [target]);
    await host.page.waitForTimeout(800);
    expect(posted(host).filter((e) => e.type === 'leftMouseDown').length).toBe(beforeBar);
    await sendRaw(helper.page, [{ x: 3_000, y: 60_000 }]);
    await expect
      .poll(() => posted(host).filter((e) => e.type === 'leftMouseDown').length)
      .toBe(beforeBar + 1);

    // Stop on the bar ends the session for both, and the bar goes away.
    await bar.getByTestId('bar-stop').click();
    await expect(helper.page.getByTestId('status')).toHaveText(
      'They stopped sharing their screen.',
    );
    await expect(host.page.getByTestId('status')).toHaveText('You stopped sharing your screen.');
    await expect
      .poll(() => host.application.windows().some((page) => page.url().includes('bar.html')))
      .toBe(false);
  });
});

test('locking the screen ends the session at once', async () => {
  await withApps({}, async (host, helper) => {
    await connect(host, helper);
    await host.application.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
    await expect(host.page.getByTestId('status')).toHaveText(
      'Your screen locked, so the session ended.',
    );
    await expect(helper.page.getByTestId('status')).toHaveText(
      'They stopped sharing their screen.',
    );
  });
});
