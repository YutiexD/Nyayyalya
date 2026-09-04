/**
 * Logger for the directory services. Deliberately separate from the core API's
 * logger: these are standalone processes simulating third-party systems and must
 * not import anything from backend/.
 */
import pino from 'pino';

export function createLogger({ service, logLevel, nodeEnv }) {
  return pino({
    level: nodeEnv === 'test' ? 'silent' : logLevel,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Directories hold phone numbers on record. Never log a whole document.
    redact: { paths: ['phone', '*.phone', 'aadhaarLast4', '*.aadhaarLast4'], censor: '[redacted]' },
    transport:
      nodeEnv === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
  });
}
