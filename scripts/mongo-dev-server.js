#!/usr/bin/env node
/**
 * Local development MongoDB.
 *
 * Starts a real `mongod` (binary managed by mongodb-memory-server) on a FIXED port
 * with a PERSISTENT dbPath, so that:
 *   - all four databases live on one server, as they would in production,
 *   - `seed/` and `reset/` run as separate processes and still see the same data,
 *   - demo state survives restarting the API.
 *
 * This exists only because this host has no MongoDB installed. If you have a real
 * mongod, skip this entirely and point MONGO_URI at it — nothing else changes.
 *
 *   node scripts/mongo-dev-server.js          # foreground, Ctrl-C to stop
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MONGO_DEV_PORT ?? 27017);
const DB_PATH = path.join(ROOT, '.data', 'mongo');

fs.mkdirSync(DB_PATH, { recursive: true });

console.log('[mongo-dev] starting mongod...');
console.log(`[mongo-dev]   port:   ${PORT}`);
console.log(`[mongo-dev]   dbPath: ${DB_PATH}`);

let server;
try {
  server = await MongoMemoryServer.create({
    instance: {
      port: PORT,
      dbPath: DB_PATH,
      storageEngine: 'wiredTiger', // required for persistence across restarts
    },
  });
} catch (err) {
  console.error(`\n[mongo-dev] failed to start: ${err.message}`);
  if (String(err.message).match(/address already in use|EADDRINUSE/i)) {
    console.error(`[mongo-dev] Port ${PORT} is busy — a MongoDB may already be running.`);
    console.error('[mongo-dev] If so, you do not need this script at all.');
  }
  process.exit(1);
}

console.log(`\n[mongo-dev] ready at ${server.getUri()}`);
console.log('[mongo-dev] databases: lexx_core, dir_police, dir_court, dir_legal');
console.log('[mongo-dev] Ctrl-C to stop.\n');

const shutdown = async (signal) => {
  console.log(`\n[mongo-dev] ${signal} — stopping mongod...`);
  try {
    await server.stop();
  } catch {
    /* already gone */
  }
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Hold the process open.
await new Promise(() => {});
