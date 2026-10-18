import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;

const TURN_SECRET = 'e2e-turn-secret-that-is-long-enough-1234';

/** Starts the signaling server on a free port; resolves with its WebSocket URL. */
async function startServer(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(root, 'server/src/index.ts')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`The server exited with code ${code}`)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      const event = JSON.parse(line) as { event: string; port?: number };
      if (event.event === 'listening' && event.port) resolve(event.port);
    });
  });
  return { url: `ws://127.0.0.1:${port}/ws`, stop: () => void child.kill() };
}

interface TurnServer {
  start(): void;
  stop(): void;
}

/**
 * A small JavaScript TURN server standing in for coturn. Like coturn's `use-auth-secret`, it
 * accepts any unexpired `<expiry>:<name>` username whose password is the HMAC of it.
 */
function startTurn(ip: string, port: number): TurnServer {
  const Turn = require('node-turn') as new (config: Record<string, unknown>) => TurnServer;
  const credentials = new Proxy({} as Record<string, string | undefined>, {
    get: (_target, username) => {
      if (typeof username !== 'string') return undefined;
      const expiry = Number(username.split(':')[0]);
      if (!(expiry * 1000 > Date.now())) return undefined;
      return createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    },
  });
  const server = new Turn({
    authMech: 'long-term',
    credentials,
    realm: 'remote-assist',
    listeningIps: [ip],
    relayIps: [ip],
    listeningPort: port,
    debugLevel: 'OFF',
  });
  server.start();
  return server;
}

function lanAddress(): string {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
  if (!address) throw new Error('No network interface: the relay test needs one.');
  return address.address;
}

/** Launches a built app with the synthetic test screen, which needs no Screen Recording permission. */
async function launch(app: 'host' | 'helper', env: Record<string, string>) {
  const application = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'apps', app)],
    env: { ...process.env, RA_FAKE_SCREEN: '1', ...env },
  });
  return { application, page: await application.firstWindow() };
}

const numberFrom = async (page: Page, testId: string, attribute?: string) => {
  const element = page.getByTestId(testId);
  return Number(attribute ? await element.getAttribute(attribute) : await element.textContent());
};

/** Runs one full session; returns what the helper measured. */
async function share(env: Record<string, string>, options: { tryWrongCode?: boolean } = {}) {
  const host = await launch('host', env);
  const helper = await launch('helper', env);
  try {
    await host.page.getByRole('button', { name: 'Start sharing my screen' }).click();
    const codeText = host.page.getByTestId('session-code');
    await expect(codeText).toHaveText(/^\d{4} \d{4}$/);
    const code = (await codeText.textContent()) ?? '';

    if (options.tryWrongCode) {
      const wrong = code === '0000 0000' ? '1111 1111' : '0000 0000';
      await helper.page.getByTestId('code-input').fill(wrong);
      await helper.page.getByRole('button', { name: 'Connect' }).click();
      await expect(helper.page.getByRole('alert')).toContainText('That code does not work');
    }

    await helper.page.getByTestId('code-input').fill(code);
    await helper.page.getByRole('button', { name: 'Connect' }).click();
    await expect(host.page.getByTestId('status')).toHaveText('Your screen is being shared', {
      timeout: 20_000,
    });
    await expect(helper.page.getByTestId('remote-video')).toBeVisible();

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
