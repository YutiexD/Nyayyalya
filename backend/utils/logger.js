/**
 * Structured logging. One logger, redaction on by default.
 *
 * Anything that could carry a secret or PII is redacted at the serialiser level so
 * a careless `log.info({ req })` cannot leak an Authorization header or an OTP.
 */
import pino from 'pino';
import env, { isTest } from '../config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  'passwordHash',
  '*.password',
  '*.passwordHash',
  'otp',
  '*.otp',
  'otpHash',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'transferToken',
  'privateKey',
  '*.privateKey',
  'ANCHOR_PRIVATE_KEY',
  'MASTER_KEK',
  'JWT_SECRET',
  'REFRESH_SECRET',
  'QR_SECRET',
  'dek',
  'wrappedDek',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[redacted]' },
  base: { service: 'lexx' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

/** Child logger for a named subsystem. */
export const loggerFor = (name) => logger.child({ module: name });

export default logger;
