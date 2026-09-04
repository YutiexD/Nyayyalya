/**
 * The Express app every directory service is built from.
 *
 * The important thing in this file is `readOnlyGuard`. "Read-only to Lexx" is an
 * architectural claim; here it is a piece of code. Any method other than GET/HEAD
 * on /directory/* is refused with 405 before it reaches a route, with exactly one
 * explicit exception: POST /directory/vakalatnama in the court directory, which is
 * the registrar filing a vakalatnama — an act of the court, not of Lexx.
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { mongoReady } from '../../shared/mongo.js';
import { errorHandler, notFoundHandler } from './errors.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * @param {Array<{ method: string, path: string }>} writeExceptions
 *   The complete, explicit list of non-GET routes this service permits.
 */
export function readOnlyGuard(writeExceptions = []) {
  const allowed = new Set(writeExceptions.map((e) => `${e.method.toUpperCase()} ${e.path}`));

  return function enforceReadOnly(req, res, next) {
    if (!req.path.startsWith('/directory')) return next();
    if (READ_METHODS.has(req.method)) return next();

    // Normalise a trailing slash so /directory/vakalatnama/ cannot slip past.
    const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
    if (allowed.has(`${req.method} ${path}`)) return next();

    res.set('Allow', 'GET');
    return res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message:
          `This authority directory is read-only. ${req.method} ${path} is not permitted; ` +
          'records are maintained by the issuing authority, not by callers.',
      },
    });
  };
}

/**
 * @param {object} opts
 * @param {object} opts.config     from loadConfig()
 * @param {object} opts.logger
 * @param {import('express').Router} opts.router  the /directory router
 * @param {Array<{method:string,path:string}>} [opts.writeExceptions]
 */
export function createApp({ config, logger, router, writeExceptions = [] }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  // Keep the extended parser: `?x[$ne]=y` then arrives as an object and is
  // rejected explicitly by validate.scalarString rather than silently reshaped.
  app.set('query parser', 'extended');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header = server-to-server (the Lexx API, curl). Allowed.
        if (!origin) return callback(null, true);
        return callback(null, config.corsOrigins.includes(origin));
      },
      methods: ['GET', 'POST'],
      maxAge: 600,
    })
  );
  app.use(express.json({ limit: config.bodyLimit }));

  app.get('/healthz', (req, res) => {
    const connected = mongoReady();
    res.status(connected ? 200 : 503).json({
      status: connected ? 'ok' : 'degraded',
      service: config.service,
      db: connected ? 'connected' : 'disconnected',
    });
  });

  app.use(readOnlyGuard(writeExceptions));
  app.use('/directory', router);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}

/** Wrap an async route handler so a rejection reaches the error handler. */
export const route = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
