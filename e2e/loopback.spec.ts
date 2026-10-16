import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const electronPath = createRequire(import.meta.url)('electron') as string;

/** Launches a built app with the synthetic test screen, which needs no Screen Recording permission. */
async function launch(app: 'host' | 'helper') {
  const application = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'apps', app)],
    env: { ...process.env, RA_FAKE_SCREEN: '1' },
  });
  return { application, page: await application.firstWindow() };
}

const numberFrom = async (page: Page, testId: string, attribute?: string) => {
  const element = page.getByTestId(testId);
  return Number(attribute ? await element.getAttribute(attribute) : await element.textContent());
};

test('host shares its screen with the helper using copy-paste codes', async () => {
  const host = await launch('host');
  const helper = await launch('helper');
  try {
    await host.page.getByRole('button', { name: 'Start sharing my screen' }).click();
    const invite = host.page.getByTestId('invite-code');
    await expect(invite).toHaveValue(/^RA1\./);

    await helper.page.getByTestId('invite-input').fill(await invite.inputValue());
    await helper.page.getByRole('button', { name: 'Connect' }).click();
    const reply = helper.page.getByTestId('reply-code');
    await expect(reply).toHaveValue(/^RA1\./);

    await host.page.getByTestId('reply-input').fill(await reply.inputValue());
    await host.page.getByRole('button', { name: 'Connect' }).click();
    await expect(host.page.getByTestId('status')).toHaveText('Your screen is being shared', {
      timeout: 15_000,
    });
    await expect(helper.page.getByTestId('remote-video')).toBeVisible();

    // Video is flowing, and the timecode drawn on the host comes back out of the decoded frames.
    await expect
      .poll(() => numberFrom(helper.page, 'stat-frames'), { timeout: 20_000 })
      .toBeGreaterThan(60);
    await expect
      .poll(() => numberFrom(helper.page, 'stat-latency', 'data-samples'), { timeout: 20_000 })
      .toBeGreaterThan(30);

    const latencyP50 = await numberFrom(helper.page, 'stat-latency', 'data-p50');
    const report = {
      latency: await helper.page.getByTestId('stat-latency').textContent(),
      resolution: await helper.page.getByTestId('stat-resolution').textContent(),
      codec: await helper.page.getByTestId('stat-codec').textContent(),
      encoder: await host.page.getByTestId('stat-encoder').textContent(),
      path: await helper.page.getByTestId('stat-path').textContent(),
      hostCpu: await host.page.getByTestId('stat-cpu').textContent(),
    };
    console.log('Phase 1 loopback measurements:', report);
    test.info().annotations.push({ type: 'measurements', description: JSON.stringify(report) });
    expect(latencyP50).toBeGreaterThan(0);
    expect(latencyP50).toBeLessThan(250);

    // Stop on the host reaches the helper immediately through the control channel.
    await host.page.getByTestId('stop').click();
    await expect(helper.page.getByTestId('status')).toHaveText(
      'They stopped sharing their screen.',
      {
        timeout: 5_000,
      },
    );
  } finally {
    await host.application.close();
    await helper.application.close();
  }
});
