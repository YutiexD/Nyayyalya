/**
 * Per-suite MongoDB lifecycle.
 *
 * Each test file gets a real, isolated `mongod`. Real Mongo rather than a mock is a
 * deliberate choice: the unique indexes and the append-only guards are security
 * controls, and a mock would happily let a test pass while the real constraint was
 * broken.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { allModels } from '../../models/index.js';

let server = null;

/** Start an isolated MongoDB and connect mongoose to it. Call in `beforeAll`. */
export async function startTestDb() {
  if (server) return mongoose.connection;
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), {
    dbName: 'lexx_test',
    serverSelectionTimeoutMS: 10_000,
    bufferCommands: false,
  });
  // Indexes are normally built explicitly at boot; tests need the same guarantees,
  // especially the unique constraints the concurrency tests rely on.
  for (const model of allModels) await model.createIndexes();
  return mongoose.connection;
}

/** Drop every document, keeping indexes. Call in `beforeEach` for isolation. */
export async function clearTestDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/** Tear down. Call in `afterAll`. */
export async function stopTestDb() {
  await mongoose.disconnect();
  if (server) {
    await server.stop();
    server = null;
  }
}
