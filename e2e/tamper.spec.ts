import { expect, test } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
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
import { startTamperingProxy } from './proxy';

/** Host and helper connect through a proxy that can rewrite or replay what passes. */
async function throughProxy(
  run: (
    host: LaunchedApp,
    helper: LaunchedApp,
    proxy: Awaited<ReturnType<typeof startTamperingProxy>>,
  ) => Promise<void>,
): Promise<void> {
  const server = await startServer();
  const proxy = await startTamperingProxy(server.url);
  const env = { RA_SIGNALING_URL: proxy.url, RA_ALLOW_CODE_SESSIONS: '0' };
  const host = await launch('host', { ...env, RA_DEVICE_NAME: HOST_NAME });
  const helper = await launch('helper', env);
  try {
    await nameHelper(helper);
    await run(host, helper, proxy);
  } finally {
    await host.application.close();
    await helper.application.close();
    await proxy.close();
    server.stop();
  }
}

async function pairAndAsk(host: LaunchedApp, helper: LaunchedApp): Promise<void> {
  await startPairing(host, helper);
  await pairingWords(host, helper);
  await confirmWords(host, helper);
  await helper.page.getByRole('button', { name: `Help ${HOST_NAME}` }).click();
  await expect(host.page.getByTestId('consent')).toContainText(
    `${HELPER_NAME} would like to help you`,
  );
}

test('a key swapped during pairing shows different words, and nothing is paired', async () => {
  await throughProxy(async (host, helper, proxy) => {
    // The attacker hands the host its own key instead of the helper's.
    const attacker = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
    proxy.toClient.push((message, connection) => {
      if (message.t !== 'pair.matched' || connection.role !== 'host') return;
      return { ...message, peer: { ...(message.peer as object), id: attacker } };
    });

    await startPairing(host, helper);
    const words = await pairingWords(host, helper);
    expect(words.host).not.toBe(words.helper);

    // The person sees the difference and says so: nothing is pinned on either side.
    await host.page.getByRole('button', { name: 'No, they are different' }).click();
    await expect(host.page.getByTestId('pairing-status')).toContainText('did not match');
    await expect(helper.page.getByTestId('pairing-status')).toContainText('cancelled');
    await host.page.getByRole('button', { name: 'Done' }).click();
    await expect(host.page.getByRole('button', { name: 'Pair with my helper' })).toBeVisible();
  });
});

test('an offer altered on the way stops the session before anything connects', async () => {
  await throughProxy(async (host, helper, proxy) => {
    // In a paired session, the offer arriving at the helper gets a different fingerprint.
    proxy.toClient.push((message, connection) => {
      const data = message.data as { kind?: string; sdp?: string } | undefined;
      if (message.t !== 'signal' || connection.role !== 'helper' || data?.kind !== 'offer') return;
      return { ...message, data: { ...data, sdp: data.sdp?.replace(/sha-256 ../, 'sha-256 00') } };
    });

    await pairAndAsk(host, helper);
    await host.page.getByRole('button', { name: `Yes, let ${HELPER_NAME} help` }).click();
    await expect(helper.page.getByRole('alert')).toContainText('changed on the way');
    await expect(host.page.getByTestId('status')).toHaveText('Your helper left before connecting.');
    await expect(helper.page.getByTestId('remote-video')).toHaveCount(0);
  });
});

test('a replayed request is refused: no question appears', async () => {
  await throughProxy(async (host, helper, proxy) => {
    await pairAndAsk(host, helper);
    await host.page.getByRole('button', { name: 'No, not now' }).click();
    await host.page.getByRole('button', { name: 'Done' }).click();

    // The "server" sends the helper's earlier, genuine, signed request again.
    // (Choosing a name reconnects the helper, so look for the connection that sent it.)
    const helperConnection = proxy.connections.find((c) =>
      c.sent.some((m) => m.t === 'session.request'),
    );
    const request = helperConnection?.sent.find((m) => m.t === 'session.request');
    expect(request).toBeDefined();
    if (helperConnection && request) helperConnection.injectUpstream(request);

    await host.page.waitForTimeout(2000);
    await expect(host.page.getByTestId('consent')).toHaveCount(0);
    await expect(host.page.getByTestId('helpers')).toContainText(HELPER_NAME);
  });
});
