import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HELPER_NAME,
  HOST_NAME,
  confirmWords,
  launch,
  nameHelper,
  pairingWords,
  startPairing,
  startServer,
  type LaunchedApp,
} from './helpers';

test('first run: guided setup with pairing and a practice run, resumed after a restart', async () => {
  const server = await startServer();
  // The same data folder across restarts, as on a real computer.
  const hostEnv = {
    RA_SIGNALING_URL: server.url,
    RA_ALLOW_CODE_SESSIONS: '0',
    RA_SKIP_SETUP: '0',
    RA_INPUT_DRY_RUN: '1',
    RA_DEVICE_NAME: HOST_NAME,
    RA_USER_DATA_DIR: mkdtempSync(join(tmpdir(), 'ra-e2e-setup-')),
  };
  let host: LaunchedApp | null = await launch('host', hostEnv);
  const helper = await launch('helper', {
    RA_SIGNALING_URL: server.url,
    RA_ALLOW_CODE_SESSIONS: '0',
  });
  const restartHost = async () => {
    await host?.application.close();
    host = null;
    host = await launch('host', hostEnv);
    return host;
  };

  try {
    await nameHelper(helper);
    let page = host.page;
    const progress = () => page.getByTestId('setup-progress');
    const button = (name: string) => page.getByRole('button', { name, exact: true });

    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await expect(progress()).toHaveText('Step 1 of 6');
    await button("Let's start").click();

    // Pairing happens inside setup, then setup carries on.
    await expect(progress()).toHaveText('Step 2 of 6');
    await startPairing(host, helper);
    await pairingWords(host, helper);
    await confirmWords(host, helper);
    await expect(page.getByTestId('setup-paired')).toContainText(HELPER_NAME);
    await button('Continue').click();

    // The test screen needs no Screen Recording permission. A real Mac restarts the app after
    // the permission is switched on: setup comes back to the same step.
    await expect(progress()).toHaveText('Step 3 of 6');
    await expect(page.getByTestId('setup-screen-ok')).toBeVisible();
    page = (await restartHost()).page;
    await expect(progress()).toHaveText('Step 3 of 6');
    await button('Continue').click();

    // Dry-run input needs no Accessibility permission.
    await expect(page.getByTestId('setup-control-ok')).toBeVisible();
    await button('Continue').click();

    // Only the installed app can start with the computer.
    await expect(page.getByTestId('setup-startup-unsupported')).toBeVisible();
    await button('Continue').click();

    // The practice run: saying no is safe, then yes, Pause, Continue and Stop.
    const practice = page.getByTestId('practice');
    await expect(practice).toContainText(`${HELPER_NAME} would like to help you`);
    await button('No, not now').click();
    await expect(practice).toContainText('saying no is always safe');
    await button('Try again').click();
    await button(`Yes, let ${HELPER_NAME} help`).click();
    const bar = page.getByTestId('practice-bar');
    await expect(bar).toContainText(`${HELPER_NAME} is helping you`);
    await button('Pause').click();
    await expect(bar).toContainText(`Paused: ${HELPER_NAME} can't see your screen`);
    await button('Continue').click();
    await button('Stop').click();
    await expect(page.getByTestId('practice-done')).toBeVisible();
    await button('Continue').click();

    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    await button('Finish').click();
    await expect(page.getByTestId('helpers')).toContainText(HELPER_NAME);
    // The practice shared nothing: no session bar ever appeared, and no request was recorded.
    expect(host.application.windows().some((p) => p.url().includes('bar.html'))).toBe(false);
    await expect(page.getByTestId('history')).toHaveCount(0);

    // Once finished, setup doesn't come back.
    page = (await restartHost()).page;
    await expect(page.getByTestId('helpers')).toContainText(HELPER_NAME);
    await expect(page.getByTestId('setup')).toHaveCount(0);
  } finally {
    await host?.application.close();
    await helper.application.close();
    server.stop();
  }
});

test('closing the window keeps the app ready, and a request brings it back', async () => {
  const server = await startServer();
  const env = { RA_SIGNALING_URL: server.url, RA_ALLOW_CODE_SESSIONS: '0' };
  const host = await launch('host', { ...env, RA_DEVICE_NAME: HOST_NAME });
  const helper = await launch('helper', env);
  const mainWindowVisible = () =>
    host.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible()),
    );
  try {
    await nameHelper(helper);
    await startPairing(host, helper);
    await pairingWords(host, helper);
    await confirmWords(host, helper);

    await host.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((win) => win.close()),
    );
    await expect.poll(mainWindowVisible).toBe(false);
    // Still running and still reachable.
    await expect(helper.page.getByTestId('hosts')).toContainText('Online');

    await helper.page.getByRole('button', { name: `Help ${HOST_NAME}` }).click();
    await expect.poll(mainWindowVisible).toBe(true);
    await expect(host.page.getByTestId('consent')).toContainText(
      `${HELPER_NAME} would like to help you`,
    );
    await host.page.getByRole('button', { name: 'No, not now' }).click();
    await expect(helper.page.getByRole('alert')).toHaveText('They said no, so nothing was shared.');
  } finally {
    await host.application.close();
    await helper.application.close();
    server.stop();
  }
});
