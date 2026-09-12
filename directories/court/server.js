#!/usr/bin/env node
/**
 * COURT AUTHORITY DIRECTORY — :6002, db `dir_court`
 *
 * Stands in for eCourts. Source of truth for judges, the sitting roster, case
 * listings, registry staff and who is on record for whom.
 *
 * This is the only one of the three with write endpoints, and both are simulated
 * registry acts: POST /directory/vakalatnama (the registrar accepting a vakalatnama)
 * and POST /directory/listing (the registry registering a chargesheet and allotting a
 * CNR). They are declared once, here, as the only exceptions to the read-only guard;
 * every other method on /directory/* is refused with 405 before it reaches a route.
 *
 *   node directories/court/server.js
 */
import { loadConfig } from '../common/config.js';
import { createLogger } from '../common/logger.js';
import { createApp } from '../common/app.js';
import { startService } from '../common/bootstrap.js';
import { models } from './models/index.js';
import { directoryRouter } from './routes/directory.js';

const config = loadConfig({
  service: 'directory-court',
  portVar: 'DIRECTORY_COURT_PORT',
  portDefault: 6002,
  dbVar: 'MONGO_DB_DIR_COURT',
  dbDefault: 'dir_court',
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
      router: directoryRouter(config),
      writeExceptions: [
        { method: 'POST', path: '/directory/vakalatnama' },
        { method: 'POST', path: '/directory/listing' },
      ],
    }),
});
