/**
 * Central error handling.
 *
 * Clients get `{ error: { code, message, details? } }` and nothing else. No stack
 * traces, no driver messages, no file paths, no configuration. Unexpected errors are
 * logged in full server-side and reported to the client as a generic 500 with a
 * correlation id, so an operator can find the detail without the client being handed
 * a map of the internals.
 */
import crypto from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';
import { isProd } from '../config/env.js';

const log = loggerFor('http');

/** 404 for unmatched routes. Registered after all other routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

// `next` is unused but REQUIRED: Express identifies error handlers by arity (4 args).
export function errorHandler(err, req, res, next) {
  // Known, intentional errors carry a safe message by construction.
  if (err instanceof AppError) {
    if (err.status >= 500) {
      log.error({ err: err.message, code: err.code, path: req.path }, 'application error');
    }
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  // ---- Translate known library errors into safe, stable API errors ----

  if (err?.name === 'ValidationError' && err?.errors) {
    // Mongoose validation. Field names are safe; raw messages may quote internals.
    return res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request failed validation',
        details: { fields: Object.keys(err.errors) },
      },
    });
  }

  if (err?.name === 'CastError') {
    // A malformed ObjectId is a bad request, not a server fault — and it must not
    // echo the offending value back.
    return res.status(400).json({
      error: { code: 'INVALID_IDENTIFIER', message: 'Malformed identifier' },
    });
  }

  if (err?.code === 11000) {
    return res.status(409).json({
      error: {
        code: 'DUPLICATE',
        message: 'That record already exists',
        details: { fields: Object.keys(err.keyPattern ?? {}) },
      },
    });
  }

  if (err?.code === 'LEDGER_IMMUTABLE' || err?.code === 'AUDIT_IMMUTABLE') {
    return res.status(409).json({
      error: { code: err.code, message: 'This record is append-only and cannot be modified' },
    });
  }

  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Upload exceeds the permitted size' },
    });
  }

  // Every other multer rejection is a malformed request, not a server fault.
  // Reporting these as 500 sends a caller hunting for a bug on our side when the
  // real answer is "you posted the wrong field name" or "you sent two files".
  if (typeof err?.code === 'string' && err.code.startsWith('LIMIT_')) {
    const MULTER_MESSAGES = {
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field in the upload',
      LIMIT_FILE_COUNT: 'Too many files in the upload',
      LIMIT_FIELD_COUNT: 'Too many fields in the upload',
      LIMIT_FIELD_KEY: 'A field name is too long',
      LIMIT_FIELD_VALUE: 'A field value is too long',
      LIMIT_PART_COUNT: 'Too many parts in the upload',
    };
    return res.status(400).json({
      error: {
        code: err.code,
        message: MULTER_MESSAGES[err.code] ?? 'Malformed upload',
        // `err.field` is the field name the client sent — echoing it back is safe and
        // is the one piece of information that makes this actionable.
        ...(err.field ? { details: { field: String(err.field).slice(0, 100) } } : {}),
      },
    });
  }

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' },
    });
  }

  // ---- Unexpected: log everything, disclose nothing ----
  const incidentId = crypto.randomUUID();
  log.error(
    { incidentId, err: err?.message, stack: err?.stack, path: req.path, method: req.method },
    'unhandled error'
  );

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      details: { incidentId },
      // Outside production the message helps; it is still never the stack.
      ...(isProd ? {} : { debug: err?.message }),
    },
  });
}

export default { errorHandler, notFoundHandler };
