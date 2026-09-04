/**
 * Boot sequence shared by the three directory services:
 *   connect Mongo → build declared indexes → listen → shut down cleanly.
 *
 * The service refuses to start without its database. A directory that answers
 * "not found" because it cannot reach Mongo would silently deny access to real
 * officers, so failing loudly at boot is the correct behaviour.
 */
import { connectMongo, syncIndexes, disconnectMongo } from '../../shared/mongo.js';

const SHUTDOWN_GRACE_MS = 10_000;

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {object} opts.logger
 * @param {import('mongoose').Model<any>[]} opts.models
 * @param {() => import('express').Express} opts.buildApp
 */
export async function startService({ config, logger, models, buildApp }) {
  try {
    await connectMongo({
      uri: config.mongoUri,
      dbName: config.dbName,
      logger,
      serverSelectionMs: config.serverSelectionMs,
    });
    await syncIndexes(models, logger);
  } catch (err) {
    logger.error(
      { err: err.message, dbName: config.dbName },
      'could not reach MongoDB — directory not started'
    );
    process.exit(1);
  }

  const app = buildApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info(
      { port: config.port, db: config.dbName },
      `${config.service} listening — read-only authority directory`
    );
  });

  server.on('error', (err) => {
    logger.error({ err: err.message, port: config.port }, 'http server error');
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.warn('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    try {
      await new Promise((resolve) => server.close(resolve));
      await disconnectMongo();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, 'unhandled rejection');
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, 'uncaught exception');
    shutdown('uncaughtException');
  });

  return server;
}

/**
 * Connect for a one-shot script (a seed run), do the work, disconnect.
 * Used by each seed.js when it is executed directly.
 */
export async function withMongo({ config, logger, models }, fn) {
  await connectMongo({
    uri: config.mongoUri,
    dbName: config.dbName,
    logger,
    serverSelectionMs: config.serverSelectionMs,
  });
  try {
    // Unique indexes on the natural keys are what make the seeds idempotent,
    // so they must exist before the first upsert.
    await syncIndexes(models, logger);
    return await fn();
  } finally {
    await disconnectMongo();
  }
}
