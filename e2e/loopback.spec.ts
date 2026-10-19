import { expect, test } from '@playwright/test';
import {
  TURN_SECRET,
  connect,
  lanAddress,
  launch,
  numberFrom,
  startServer,
  startTurn,
} from './helpers';

/** Runs one full session; returns what the helper measured. */
async function share(env: Record<string, string>, options: { tryWrongCode?: boolean } = {}) {
  const host = await launch('host', env);
  const helper = await launch('helper', env);
  try {
    await connect(host, helper, options);

    // Video is flowing, and the timecode drawn on the host comes back out of the decoded frames.
    await expect
      .poll(() => numberFrom(helper.page, 'stat-frames'), { timeout: 20_000 })
      .toBeGreaterThan(60);
    await expect
      .poll(() => numberFrom(helper.page, 'stat-latency', 'data-samples'), { timeout: 20_000 })
      .toBeGreaterThan(30);

    const measured = {
      latencyP50: await numberFrom(helper.page, 'stat-latency', 'data-p50'),
      latency: await helper.page.getByTestId('stat-latency').textContent(),
      resolution: await helper.page.getByTestId('stat-resolution').textContent(),
      codec: await helper.page.getByTestId('stat-codec').textContent(),
      path: (await helper.page.getByTestId('stat-path').textContent()) ?? '',
      hostCpu: await host.page.getByTestId('stat-cpu').textContent(),
    };
    console.log(`Measurements (${test.info().title}):`, measured);
    test.info().annotations.push({ type: 'measurements', description: JSON.stringify(measured) });

    // Stop on the host reaches the helper immediately through the control channel.
    await host.page.getByTestId('stop').click();
    await expect(helper.page.getByTestId('status')).toHaveText(
      'They stopped sharing their screen.',
      { timeout: 5_000 },
    );
    return measured;
  } finally {
    await host.application.close();
    await helper.application.close();
  }
}

test('connects directly through the signaling server, after rejecting a wrong code', async () => {
  const server = await startServer();
  try {
    const measured = await share({ RA_SIGNALING_URL: server.url }, { tryWrongCode: true });
    expect(measured.path).toMatch(/^direct/);
    expect(measured.latencyP50).toBeGreaterThan(0);
    expect(measured.latencyP50).toBeLessThan(250);
  } finally {
    server.stop();
  }
});

test('connects through the TURN relay when direct paths are not allowed', async () => {
  const ip = lanAddress();
  const turnPort = 34_000 + Math.floor(Math.random() * 1000);
  const turn = startTurn(ip, turnPort);
  const server = await startServer({
    TURN_URLS: `turn:${ip}:${turnPort}?transport=udp`,
    TURN_SECRET,
  });
  try {
    const measured = await share({ RA_SIGNALING_URL: server.url, RA_FORCE_RELAY: '1' });
    expect(measured.path).toMatch(/^relay/);
    expect(measured.latencyP50).toBeLessThan(400);
  } finally {
    server.stop();
    turn.stop();
  }
});
