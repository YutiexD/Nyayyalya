#!/usr/bin/env node
/**
 * Apply the data migrations and build indexes without starting the API.
 *
 *   npm run migrate
 *
 * The API runs the same migrations at boot; this exists so they can be applied (and
 * their report read) deliberately, before a demo.
 */
import env from '../backend/config/env.js';
import { connectMongo, syncIndexes, disconnectMongo } from '../shared/mongo.js';
import { allModels } from '../backend/models/index.js';
import { runMigrations } from '../backend/services/migrations.js';

const log = {
  info: (obj, msg) => console.log(`[migrate] ${msg ?? ''}`, obj && typeof obj === 'object' ? JSON.stringify(obj, null, 2) : obj ?? ''),
  warn: (obj, msg) => console.warn(`[migrate] WARN ${msg ?? ''}`, JSON.stringify(obj)),
  error: (obj, msg) => console.error(`[migrate] ERROR ${msg ?? ''}`, JSON.stringify(obj)),
};

try {
  await connectMongo({ uri: env.MONGO_URI, dbName: env.MONGO_DB_CORE, logger: log, serverSelectionMs: env.MONGO_SERVER_SELECTION_MS });
  await runMigrations(log);
  await syncIndexes(allModels, log);
  await disconnectMongo();
  process.exit(0);
} catch (err) {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
}
