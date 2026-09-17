/**
 * Per-IP rate limiting for the unauthenticated surface: the auth endpoints and the
 * public verifiers.
 *
 * # Two exemptions, both narrow and both refused in production
 *
 * 1. **Tests.** The authorization matrix performs hundreds of legitimate logins;
 *    tripping the limiter there produces failures that look like authorization bugs.
 *
 * 2. **Loopback in development.** `npm run seed` provisions nine accounts in a few
 *    seconds, which is indistinguishable from an attack by rate alone. Rather than
 *    raise the limit for everyone — which would weaken the control in production too
 *    — requests originating from the local machine are exempt while `NODE_ENV` is not
 *    `production`.
 *
 * The production guard is what makes this safe: behind a reverse proxy, EVERY request
 * arrives from loopback, so this exemption would disable rate limiting entirely. It is
 * therefore hard-refused when `NODE_ENV=production`, regardless of any other setting.
 */
import rateLimit from 'express-rate-limit';
import { isTest, isProd } from '../config/env.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const isRateLimitExempt = (req) => {
  if (isTest) return true;
  if (isProd) return false;
  return LOOPBACK.has(req.ip);
};

/** A limiter allowing `max` requests per IP per window (default 15 minutes). */
export const limiter = (max, windowMs = 15 * 60 * 1000) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isRateLimitExempt,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
  });

export default { limiter, isRateLimitExempt };
