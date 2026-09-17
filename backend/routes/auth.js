import { Router } from 'express';
import * as auth from '../controllers/auth.js';
import { requireSession } from '../middleware/authenticate.js';
import { limiter } from '../middleware/rateLimit.js';
import env from '../config/env.js';

const router = Router();

/**
 * Auth endpoints are the system's front door and the only place an unauthenticated
 * caller can do work, so they are rate limited by IP (see middleware/rateLimit.js for
 * the test and development-loopback exemptions, both refused in production).
 */

// Tighter on the endpoints that mint a factor or a session.
const otpLimiter = limiter(env.RATE_LIMIT_OTP);
const loginLimiter = limiter(env.RATE_LIMIT_LOGIN);
const lookupLimiter = limiter(env.RATE_LIMIT_LOOKUP);
// Refresh happens silently every few minutes from every open tab; sharing the sign-in
// budget with it would end a long session with RATE_LIMITED for no reason.
const refreshLimiter = limiter(env.RATE_LIMIT_LOOKUP * 5);

router.post('/verify-identity', lookupLimiter, auth.verifyIdentity);
router.post('/request-otp', otpLimiter, auth.requestOtp);
router.post('/activate', loginLimiter, auth.activate);
router.post('/login', loginLimiter, auth.login);
router.post('/refresh', refreshLimiter, auth.refresh);

// Re-keying a device costs a live session AND a fresh OTP.
router.post('/rotate-key', otpLimiter, ...requireSession, auth.rotateKey);

router.get('/me', ...requireSession, auth.me);
router.post('/logout', ...requireSession, auth.logout);

// Deliberately present, deliberately 410.
router.all('/register', auth.registerGone);

export default router;
