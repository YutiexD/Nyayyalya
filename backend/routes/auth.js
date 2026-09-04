import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as auth from '../controllers/auth.js';
import { requireSession } from '../middleware/authenticate.js';
import env, { isTest, isProd } from '../config/env.js';

const router = Router();

/**
 * Auth endpoints are the system's front door and the only place an unauthenticated
 * caller can do work, so they are rate limited by IP.
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
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const isExempt = (req) => {
  if (isTest) return true;
  if (isProd) return false;
  return LOOPBACK.has(req.ip);
};

const limiter = (max, windowMs = 15 * 60 * 1000) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isExempt,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
  });

// Tighter on the endpoints that mint a factor or a session.
const otpLimiter = limiter(env.RATE_LIMIT_OTP);
const loginLimiter = limiter(env.RATE_LIMIT_LOGIN);
const lookupLimiter = limiter(env.RATE_LIMIT_LOOKUP);

router.post('/verify-identity', lookupLimiter, auth.verifyIdentity);
router.post('/request-otp', otpLimiter, auth.requestOtp);
router.post('/activate', loginLimiter, auth.activate);
router.post('/login', loginLimiter, auth.login);
router.post('/refresh', loginLimiter, auth.refresh);

// Re-keying a device costs a live session AND a fresh OTP.
router.post('/rotate-key', otpLimiter, ...requireSession, auth.rotateKey);

router.get('/me', ...requireSession, auth.me);
router.post('/logout', ...requireSession, auth.logout);

// Deliberately present, deliberately 410.
router.all('/register', auth.registerGone);

export default router;
