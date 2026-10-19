import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;

export const TURN_SECRET = 'e2e-turn-secret-that-is-long-enough-1234';

/** Starts the signaling server on a free port; resolves with its WebSocket URL. */
export async function startServer(env: Record<string, string> = {}) {
  const args = ['--disable-warning=ExperimentalWarning', join(root, 'server/src/index.ts')];
  const child = spawn(process.execPath, args, {
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
export function startTurn(ip: string, port: number): TurnServer {
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

export function lanAddress(): string {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
  if (!address) throw new Error('No network interface: the relay test needs one.');
  return address.address;
}

export interface LaunchedApp {
  application: ElectronApplication;
  page: Page;
  /** Every line the app's main process printed to stdout so far. */
  output: string[];
}

/**
 * Launches a built app with the synthetic test screen (no Screen Recording permission needed),
 * its own fresh data folder, a mock keychain and no Touch ID prompt. One-time code sessions are
 * on, as most tests use them; pairing tests use the paired flow.
 */
export async function launch(
  app: 'host' | 'helper',
  env: Record<string, string>,
): Promise<LaunchedApp> {
  const application = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'apps', app)],
    env: {
      ...process.env,
      RA_FAKE_SCREEN: '1',
      RA_USER_DATA_DIR: mkdtempSync(join(tmpdir(), `ra-e2e-${app}-`)),
      RA_TEST_MOCK_KEYCHAIN: '1',
      RA_TEST_NO_TOUCH_ID: '1',
      RA_ALLOW_CODE_SESSIONS: '1',
      ...env,
    },
  });
  const output: string[] = [];
  const stdout = application.process().stdout;
  if (stdout) createInterface({ input: stdout }).on('line', (line) => output.push(line));
  return { application, page: await application.firstWindow(), output };
}

export const HELPER_NAME = 'Alex';
export const HOST_NAME = 'Grandma';

/** The helper's first screen asks for its name. */
export async function nameHelper(helper: LaunchedApp, name = HELPER_NAME): Promise<void> {
  await helper.page.getByTestId('name-input').fill(name);
  await helper.page.getByRole('button', { name: 'Continue' }).click();
  await expect(helper.page.getByRole('heading', { name: 'People you help' })).toBeVisible();
}

/** Host shows a one-time code; the helper (named first) types it. */
export async function requestHelp(
  host: LaunchedApp,
  helper: LaunchedApp,
  options: { tryWrongCode?: boolean } = {},
): Promise<void> {
  await nameHelper(helper);
  await host.page.getByRole('button', { name: 'Get help with a one-time code' }).click();
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
  await expect(host.page.getByTestId('consent')).toContainText(
    `${HELPER_NAME} would like to help you`,
  );
}

/** `requestHelp`, then the person says yes; resolves once the session is live. */
export async function connect(
  host: LaunchedApp,
  helper: LaunchedApp,
  options: { tryWrongCode?: boolean } = {},
): Promise<void> {
  await requestHelp(host, helper, options);
  await host.page.getByRole('button', { name: `Yes, let ${HELPER_NAME} help` }).click();
  await expect(host.page.getByTestId('status')).toHaveText(`${HELPER_NAME} is helping you`, {
    timeout: 20_000,
  });
  await expect(helper.page.getByTestId('remote-video')).toBeVisible();
}

/** The host's floating session bar (a window of its own). */
export async function sessionBar(host: LaunchedApp): Promise<Page> {
  const find = () => host.application.windows().find((page) => page.url().includes('bar.html'));
  await expect.poll(() => find() !== undefined).toBe(true);
  return find() as Page;
}

export async function numberFrom(page: Page, testId: string, attribute?: string): Promise<number> {
  const element = page.getByTestId(testId);
  return Number(attribute ? await element.getAttribute(attribute) : await element.textContent());
}

/** Host shows a pairing code; the helper (already named) types it. */
export async function startPairing(host: LaunchedApp, helper: LaunchedApp): Promise<void> {
  await host.page.getByRole('button', { name: /Pair with my helper|Add another helper/ }).click();
  const codeText = host.page.getByTestId('pairing-code');
  await expect(codeText).toHaveText(/^\d{4} \d{4}$/);
  await helper.page.getByRole('button', { name: 'Pair with someone' }).click();
  await helper.page.getByTestId('pairing-code-input').fill((await codeText.textContent()) ?? '');
  await helper.page.getByRole('button', { name: 'Pair', exact: true }).click();
}

/** Both sides show their three words; returns them. */
export async function pairingWords(host: LaunchedApp, helper: LaunchedApp) {
  const hostWords = host.page.getByTestId('pairing-words');
  const helperWords = helper.page.getByTestId('pairing-words');
  await expect(hostWords).toBeVisible();
  await expect(helperWords).toBeVisible();
  return { host: await hostWords.textContent(), helper: await helperWords.textContent() };
}

/** Both people say the words match; the pairing completes on both sides. */
export async function confirmWords(host: LaunchedApp, helper: LaunchedApp): Promise<void> {
  await host.page.getByRole('button', { name: 'Yes, they match' }).click();
  await helper.page.getByRole('button', { name: 'They match' }).click();
  await expect(host.page.getByTestId('pairing-status')).toContainText('can now help you');
  await expect(helper.page.getByTestId('pairing-status')).toContainText('Paired');
  await host.page.getByRole('button', { name: 'Done' }).click();
  await helper.page.getByRole('button', { name: 'Done' }).click();
}
