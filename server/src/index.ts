import { loadConfig } from './config.ts';
import { jsonLog } from './log.ts';
import { createSignalingServer } from './server.ts';

const config = loadConfig();
const server = createSignalingServer(config);
const address = await server.listen();
jsonLog('listening', {
  host: address.address,
  port: address.port,
  stun: config.stunUrls.length > 0,
  turn: config.turn !== null,
  persistent: config.databasePath !== ':memory:',
});

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
