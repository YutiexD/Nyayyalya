#!/usr/bin/env node
/**
 * LEGAL & FSL AUTHORITY DIRECTORY — :6003, db `dir_legal`
 *
 * Stands in for the Bar Council of India (advocates, certificates of practice,
 * legal aid panels) and the FSL LIMS (s.79A-notified laboratories and their
 * examiners). Read-only: every route is a GET and any other method on
 * /directory/* is refused with 405.
 *
 *   node directories/legal/server.js
 */
import { loadConfig } from '../common/config.js';
import { createLogger } from '../common/logger.js';
import { createApp } from '../common/app.js';
import { startService } from '../common/bootstrap.js';
import { models } from './models/index.js';
import { directoryRouter } from './routes/directory.js';

const config = loadConfig({
  service: 'directory-legal',
  portVar: 'DIRECTORY_LEGAL_PORT',
  portDefault: 6003,
  dbVar: 'MONGO_DB_DIR_LEGAL',
  dbDefault: 'dir_legal',
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
      // No exceptions. Nothing may write to the Bar Council or the FSL LIMS.
      writeExceptions: [],
    }),
});
