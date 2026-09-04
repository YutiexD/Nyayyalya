#!/usr/bin/env node
/**
 * POLICE AUTHORITY DIRECTORY — :6001, db `dir_police`
 *
 * Stands in for CCTNS. It is the source of truth for who is a police officer,
 * where they are posted and which FIRs exist. Lexx verifies against it and can
 * never write to it: every route below is a GET, and the read-only guard in
 * common/app.js rejects any other method on /directory/* with 405.
 *
 *   node directories/police/server.js
 */
import { loadConfig } from '../common/config.js';
import { createLogger } from '../common/logger.js';
import { createApp } from '../common/app.js';
import { startService } from '../common/bootstrap.js';
import { models } from './models/index.js';
import { directoryRouter } from './routes/directory.js';

const config = loadConfig({
  service: 'directory-police',
  portVar: 'DIRECTORY_POLICE_PORT',
  portDefault: 6001,
  dbVar: 'MONGO_DB_DIR_POLICE',
  dbDefault: 'dir_police',
});

const logger = createLogger(config);

await startService({
  config,
  logger,
  models,
  buildApp: () =>
    createApp({
      config,
      logger,
      router: directoryRouter(),
      // No exceptions. The police directory has no write endpoint at all.
      writeExceptions: [],
    }),
});
