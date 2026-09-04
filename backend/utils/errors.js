/**
 * Typed application errors and the shape of every API error response.
 *
 * Clients see: { error: { code, message, details? } }
 * Clients never see: stack traces, internal paths, driver messages, config values.
 */

export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code   stable machine-readable code (SCREAMING_SNAKE)
   * @param {string} message safe, human-readable message
   * @param {object} [details] safe structured detail (never secrets)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const BadRequest = (code, message, details) => new AppError(400, code, message, details);
export const Unauthorized = (code = 'UNAUTHENTICATED', message = 'Authentication required') =>
  new AppError(401, code, message);
export const Forbidden = (code, message = 'Access denied', details) =>
  new AppError(403, code, message, details);
export const NotFound = (code = 'NOT_FOUND', message = 'Resource not found') =>
  new AppError(404, code, message);
export const Conflict = (code, message, details) => new AppError(409, code, message, details);
export const Gone = (code, message) => new AppError(410, code, message);
export const PayloadTooLarge = (code, message, details) =>
  new AppError(413, code, message, details);
export const UnsupportedMedia = (code, message, details) =>
  new AppError(415, code, message, details);
export const TooManyRequests = (code = 'RATE_LIMITED', message = 'Too many requests', details) =>
  new AppError(429, code, message, details);
export const Internal = (code = 'INTERNAL_ERROR', message = 'Internal server error') =>
  new AppError(500, code, message);
export const ServiceUnavailable = (code, message, details) =>
  new AppError(503, code, message, details);

/**
 * Raised when an upstream authority directory is unreachable or misbehaving.
 * Kept distinct so callers can fail *closed* rather than guessing.
 */
export class DirectoryUnavailableError extends AppError {
  constructor(directory, cause) {
    super(
      503,
      'DIRECTORY_UNAVAILABLE',
      `The ${directory} authority directory is unavailable. Access cannot be verified.`,
      { directory }
    );
    this.name = 'DirectoryUnavailableError';
    this.cause = cause;
  }
}

/** Raised by the access resolver. Carries a safe reason code only. */
export class AuthorizationError extends AppError {
  constructor(reason, details) {
    super(403, reason, 'Access denied', details);
    this.name = 'AuthorizationError';
    this.reason = reason;
  }
}

export const isAppError = (e) => e instanceof AppError;
