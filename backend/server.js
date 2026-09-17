#!/usr/bin/env node
/**
 * LEXX Core API entrypoint.
 *
 * Boot order matters: configuration is validated before anything else, the database
 * is connected and indexed before the listener opens, and shutdown drains in the
 * reverse order. A process that accepts requests before its indexes exist would
 * silently lose the unique constraints that the ledger's integrity depends on.
 */
import env, { assertGeminiConfigured } from './config/env.js';
import { createApp } from './app.js';
import { connectMongo, syncIndexes, disconnectMongo } from '../shared/mongo.js';
import { allModels } from './models/index.js';
import { startAnchorScheduler, stopAnchorScheduler } from './services/anchor.js';
import { setSchedulerState } from './services/health.js';
import { runMigrations } from './services/migrations.js';
import { resumePendingAnalyses } from './services/ai/analysisService.js';
import logger from './utils/logger.js';
import fs from 'node:fs';

async function main() {
  logger.info(
    { env: env.NODE_ENV, network: env.ANCHOR_NETWORK, chainId: env.ANCHOR_CHAIN_ID },
    'starting lexx-core'
  );

  // Every exhibit is analysed by Gemini on ingest. Without a key and a model the API
  // cannot do that, and it says so now rather than failing on the first upload.
  assertGeminiConfigured();
  logger.info({ geminiModel: env.GEMINI_MODEL }, 'gemini configured');

  fs.mkdirSync(env.STORAGE_DIR, { recursive: true });

  await connectMongo({
    uri: env.MONGO_URI,
    dbName: env.MONGO_DB_CORE,
    logger,
    serverSelectionMs: env.MONGO_SERVER_SELECTION_MS,
  });
  // Bring records written by earlier versions into line BEFORE indexes are built: the
  // one-active-certificate index cannot be created while duplicates exist.
  await runMigrations(logger);
  await syncIndexes(allModels, logger);

  // The batcher runs only after indexes exist — it writes AnchorBatch rows whose
  // uniqueness constraint is the guard against double-anchoring a sequence range.
  // Starting it before syncIndexes would remove exactly that protection.
  try {
    const timer = startAnchorScheduler();
    setSchedulerState(timer ? 'active' : 'disabled');
  } catch (err) {
    // A scheduler that fails to start must not take the API down with it, but it
    // must also never look healthy. /readyz reports 'failed' and stays degraded.
    setSchedulerState('failed', err.message);
    logger.error({ err: err.message }, 'anchor scheduler failed to start');
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'lexx-core listening');
    // Pick up analyses still pending from before a restart, or queued by migration.
    resumePendingAnalyses()
      .then((queued) => logger.info({ queued }, 'gemini analyses queued'))
      .catch((err) => logger.error({ err: err.message }, 'could not resume gemini analyses'));
  });

  // Slowloris protection.
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    // Stop the batcher first: a cycle that starts while Mongo is closing would fail
    // mid-write and leave a PENDING batch with no resolution.
    stopAnchorScheduler();
    setSchedulerState('stopped');
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
