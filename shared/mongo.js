/**
 * Mongoose connection helper, shared by the core API and the three directory services.
 *
 * Every service connects the same way: one URI, an explicit database name, bounded
 * server-selection so a dead database fails fast instead of hanging a request.
 */
import mongoose from 'mongoose';

mongoose.set('strictQuery', true);
// Index creation is explicit per-service at boot, not implicit per-model, so that a
// production deployment can build indexes deliberately rather than on first write.
mongoose.set('autoIndex', false);

/**
 * @param {object} opts
 * @param {string} opts.uri       Mongo connection URI
 * @param {string} opts.dbName    database name
 * @param {object} [opts.logger]  pino-like logger
 * @param {number} [opts.serverSelectionMs]
 * @returns {Promise<import('mongoose').Connection>}
 */
export async function connectMongo({ uri, dbName, logger, serverSelectionMs = 5000 }) {
  const log = logger ?? console;

  const conn = mongoose.connection;

  conn.on('error', (err) => log.error?.({ err: err.message, dbName }, 'mongo connection error'));
  conn.on('disconnected', () => log.warn?.({ dbName }, 'mongo disconnected'));
  conn.on('reconnected', () => log.info?.({ dbName }, 'mongo reconnected'));

  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: serverSelectionMs,
    // Fail a query rather than buffering it forever when the DB is unreachable.
    bufferCommands: false,
    maxPoolSize: 20,
    minPoolSize: 2,
  });

  log.info?.({ dbName }, 'mongo connected');
  return conn;
}

/** Build declared indexes for the given models. Called explicitly at boot. */
export async function syncIndexes(models, logger) {
  const log = logger ?? console;
  for (const model of models) {
    try {
      await model.createIndexes();
    } catch (err) {
      log.error?.({ err: err.message, model: model.modelName }, 'index creation failed');
      throw err;
    }
  }
  log.info?.({ count: models.length }, 'indexes ensured');
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}

/** Liveness probe used by /healthz. 1 === connected. */
export const mongoReady = () => mongoose.connection.readyState === 1;

export { mongoose };
