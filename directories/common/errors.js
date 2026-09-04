/**
 * Error types and the single error shape every directory service returns.
 *
 * Clients see exactly:  { error: { code, message } }
 * Clients never see:    stack traces, Mongo driver messages, file paths, config.
 *
 * These services simulate external government systems. An attacker probing them
 * should learn nothing from an error beyond a stable machine-readable code.
 */

import { mongoReady } from '../../shared/mongo.js';

/** Driver/ODM failures that mean "the database is unreachable", not "bug in a route". */
const MONGO_ERROR_NAMES = new Set([
  'MongoNetworkError',
  'MongoServerSelectionError',
  'MongoNotConnectedError',
  'MongoTimeoutError',
  'MongooseError',
  'MongooseServerSelectionError',
]);

export class DirectoryError extends Error {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    stable SCREAMING_SNAKE code
   * @param {string} message safe, human-readable message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'DirectoryError';
    this.status = status;
    this.code = code;
    this.expose = true;
    Error.captureStackTrace?.(this, DirectoryError);
  }
}

export const BadRequest = (code, message) => new DirectoryError(400, code, message);
export const NotFound = (code = 'NOT_FOUND', message = 'Record not found') =>
  new DirectoryError(404, code, message);
export const MethodNotAllowed = (message) =>
  new DirectoryError(405, 'METHOD_NOT_ALLOWED', message);
export const Conflict = (code, message) => new DirectoryError(409, code, message);
export const PayloadTooLarge = (message = 'Request body too large') =>
  new DirectoryError(413, 'PAYLOAD_TOO_LARGE', message);
export const ServiceUnavailable = (code, message) => new DirectoryError(503, code, message);

/** Terminal 404 for any path that matched no route. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

/**
 * Terminal error handler. Anything that is not a DirectoryError is logged in full
 * and reported to the caller as an opaque 500 — no driver text, no stack.
 */
export function errorHandler(logger) {
  return function handleError(err, req, res, _next) {
    if (err instanceof DirectoryError) {
      logger.debug?.({ code: err.code, status: err.status, path: req.path }, 'request rejected');
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }

    // express.json() body-parser failures.
    if (err?.type === 'entity.too.large') {
      return res
        .status(413)
        .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res
        .status(400)
        .json({ error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' } });
    }

    // A directory that cannot reach its database must say so, not answer "not
    // found" and not look like an application bug. Lexx fails access closed on a
    // 503; a 500 would be indistinguishable from a broken endpoint.
    if (!mongoReady() || MONGO_ERROR_NAMES.has(err?.name)) {
      logger.error({ err: err?.message, path: req.path }, 'database unavailable');
      return res.status(503).json({
        error: {
          code: 'DIRECTORY_UNAVAILABLE',
          message: 'This authority directory is temporarily unable to answer. Try again shortly.',
        },
      });
    }

    logger.error({ err: err?.message, stack: err?.stack, path: req.path }, 'unhandled error');
    return res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  };
}
