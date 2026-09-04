#!/usr/bin/env node
/**
 * LEXX Core API entrypoint.
 *
 * Boot order matters: configuration is validated before anything else, the database
 * is connected and indexed before the listener opens, and shutdown drains in the
 * reverse order. A process that accepts requests before its indexes exist would
 * silently lose the unique constraints that the ledger's integrity depends on.
 */
import env from './config/env.js';
import { createApp } from './app.js';
import { connectMongo, syncIndexes, disconnectMongo } from '../shared/mongo.js';
import { allModels } from './models/index.js';
import logger from './utils/logger.js';
import fs from 'node:fs';

async function main() {
  logger.info(
    { env: env.NODE_ENV, network: env.ANCHOR_NETWORK, chainId: env.ANCHOR_CHAIN_ID },
    'starting lexx-core'
  );

  fs.mkdirSync(env.STORAGE_DIR, { recursive: true });

  await connectMongo({
    uri: env.MONGO_URI,
    dbName: env.MONGO_DB_CORE,
    logger,
    serverSelectionMs: env.MONGO_SERVER_SELECTION_MS,
  });
  await syncIndexes(allModels, logger);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'lexx-core listening');
  });

  // Slowloris protection.
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await disconnectMongo();
      process.exit(0);
    });
    // Do not hang forever waiting for a stuck connection to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal startup error');
  process.exit(1);
});
