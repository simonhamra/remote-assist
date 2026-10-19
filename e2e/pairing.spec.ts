import { expect, test } from '@playwright/test';
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

/** Paired flow only: no one-time codes, as in normal use. */
async function withApps(
  helpers: string[],
  run: (host: LaunchedApp, ...helpers: LaunchedApp[]) => Promise<void>,
): Promise<void> {
  const server = await startServer();
  const env = { RA_SIGNALING_URL: server.url, RA_ALLOW_CODE_SESSIONS: '0' };
  const host = await launch('host', { ...env, RA_DEVICE_NAME: HOST_NAME });
  const helperApps = await Promise.all(helpers.map(() => launch('helper', env)));
  try {
    for (const [i, helper] of helperApps.entries()) await nameHelper(helper, helpers[i]);
    await run(host, ...helperApps);
  } finally {
    await host.application.close();
    for (const helper of helperApps) await helper.application.close();
    server.stop();
  }
}

test('pairs once with matching words, then a paired helper asks and is verified', async () => {
  await withApps([HELPER_NAME], async (host, helper) => {
    // Without a pairing there is nothing to ask for: no code sessions in normal use.
    await expect(host.page.getByRole('button', { name: /one-time code/ })).toHaveCount(0);

    await startPairing(host, helper);
    const words = await pairingWords(host, helper);
    expect(words.host).toMatch(/^[a-z]+ · [a-z]+ · [a-z]+$/);
    expect(words.host).toBe(words.helper);
    await confirmWords(host, helper);

    await expect(host.page.getByTestId('helpers')).toContainText(HELPER_NAME);
    await expect(host.page.getByTestId('helpers')).toContainText('Can help now');
    await helper.page.getByRole('button', { name: `Help ${HOST_NAME}` }).click();

    const consent = host.page.getByTestId('consent');
    await expect(consent).toContainText(`${HELPER_NAME} would like to help you`);
    await expect(host.page.getByTestId('consent-verified')).toBeVisible();
    await host.page.getByRole('button', { name: `Yes, let ${HELPER_NAME} help` }).click();
    await expect(host.page.getByTestId('status')).toHaveText(`${HELPER_NAME} is helping you`, {
      timeout: 20_000,
    });
    await expect(helper.page.getByTestId('remote-video')).toBeVisible();
    await host.page.getByTestId('stop').click();
    await expect(helper.page.getByTestId('status')).toHaveText(
      'They stopped sharing their screen.',
    );
  });
});

test('removing a helper takes their access away on both sides', async () => {
  await withApps([HELPER_NAME], async (host, helper) => {
    await startPairing(host, helper);
    await pairingWords(host, helper);
    await confirmWords(host, helper);
    await expect(helper.page.getByTestId('hosts')).toContainText(HOST_NAME);

    await host.page.getByTestId('helpers').getByRole('button', { name: 'Remove' }).click();
    await host.page.getByTestId('helpers').getByRole('button', { name: 'Remove' }).click();
    await expect(host.page.getByRole('button', { name: 'Pair with my helper' })).toBeVisible();
    await expect(helper.page.getByText("You haven't paired with anyone yet.")).toBeVisible();
  });
});

test('a second helper can only pair once the first one approves', async () => {
  await withApps([HELPER_NAME, 'Sam'], async (host, alex, sam) => {
    await startPairing(host, alex);
    await pairingWords(host, alex);
    await confirmWords(host, alex);

    await startPairing(host, sam);
    await expect(host.page.getByTestId('pairing-status')).toHaveText(
      'Waiting for one of your helpers to approve…',
    );
    await expect(sam.page.getByTestId('pairing-status')).toContainText(
      'waiting for them to approve',
    );
    // The first helper hears about it, and decides.
    const approval = alex.page.getByTestId('approval');
    await expect(approval).toContainText(`Sam wants to pair with ${HOST_NAME}'s computer`);
    await approval.getByRole('button', { name: 'Approve' }).click();

    const words = await pairingWords(host, sam);
    expect(words.host).toBe(words.helper);
    await confirmWords(host, sam);
    await expect(host.page.getByTestId('helpers').locator('li')).toHaveCount(2);
  });
});
