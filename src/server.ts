// Entry point: read config, connect to Actual, start the HTTP server.

import { ActualClient } from './actual.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const actual = new ActualClient(config.actual);
const app = await buildApp({ actual, accountsFile: config.accountsFile, createMissingAccounts: config.createMissingAccounts });

// Connect in the background. If Actual is down at startup, /healthz reports it
// and the next preview tries again.
actual.connect().then(
  () => app.log.info('connected to Actual'),
  (err: Error) => app.log.error(err.message),
);

await app.listen({ port: config.port, host: '0.0.0.0' });

async function stop(signal: string) {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await actual.shutdown().catch((err: Error) => app.log.error(err.message));
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
