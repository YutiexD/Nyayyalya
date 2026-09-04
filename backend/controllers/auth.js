/**
 * Authentication.
 *
 * # The provisioning rule
 *
 * Nobody self-registers. A Lexx account exists only if the person already exists and
 * is ACTIVE in their authority directory. Role and scope are PULLED FROM THE
 * DIRECTORY and never read from the request body — search this file for `req.body`
 * and you will find only credentials and a public key, never `role`, `authority` or
 * `scope`.
 *
 * # Why login re-checks the directory
 *
 * Step 4 of the login flow re-verifies against the live directory every time. A
 * transferred officer, a suspended advocate or a rotated judge therefore loses access
 * on their next login without anyone in Lexx doing anything. That is the entire
 * argument for federating identity out to the authority directories, so it is not
 * optional and it does not fall back to cached data when a directory is down.
 */
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import env from '../config/env.js';
import { User } from '../models/User.js';
import { OtpChallenge, OTP_PURPOSE } from '../models/OtpChallenge.js';
import { USER_STATUS, CREATED_VIA, DECISION } from '../models/enums.js';
import { resolveIdentity } from '../services/directoryClient.js';
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeAllForUser,
} from '../services/tokens.js';
import {
  sha256Hex,
  randomNumericCode,
  publicKeyFingerprint,
  timingSafeEqualStr,
} from '../config/crypto.js';
import { writeAuthAudit } from '../middleware/audit.js';
import { BadRequest, Unauthorized, Gone, TooManyRequests, Forbidden } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('auth');

const BCRYPT_ROUNDS = env.BCRYPT_ROUNDS;

// ---------------------------------------------------------------- schemas ----

const authorityIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  // The domain's identifier alphabet. Rejects operator-injection payloads and any
  // character that could change the meaning of a URL or a query.
  .regex(/^[A-Za-z0-9/_.-]+$/, 'Identifier contains unsupported characters');

const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password is too long');

const publicKeyJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1).max(128),
  y: z.string().min(1).max(128),
});

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw BadRequest('VALIDATION_FAILED', 'Request failed validation', {
      fields: r.error.issues.map((i) => i.path.join('.') || '(root)'),
    });
  }
  return r.data;
};

// ---------------------------------------------------------------- helpers ----

const maskPhone = (phone) =>
  !phone ? null : `${'•'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;

/**
 * Issue an OTP. Any previous unconsumed challenge for the same purpose is invalidated
 * so that only the newest code works — otherwise requesting a second code would leave
 * two valid codes and double the guessing surface.
 */
async function issueOtp({ authorityId, purpose, phone, ip }) {
  await OtpChallenge.deleteMany({ authorityId, purpose, consumedAt: null });

  const code = randomNumericCode(6);
  await OtpChallenge.create({
    authorityId,
    purpose,
    codeHash: sha256Hex(code),
    maskedPhone: maskPhone(phone),
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    expiresAt: new Date(Date.now() + env.OTP_TTL_SEC * 1000),
    ip: ip ?? null,
  });

  // In a real deployment this is where the SMS gateway is called.
  log.info({ authorityId, purpose }, 'OTP issued');

  return code;
}

/**
 * Verify and consume an OTP. Single-use, attempt-capped, purpose-bound.
 * Returns nothing on success; throws a safe error otherwise.
 */
async function consumeOtp({ authorityId, purpose, code }) {
  const challenge = await OtpChallenge.findOne({
    authorityId,
    purpose,
    consumedAt: null,
  }).sort({ createdAt: -1 });

  if (!challenge) throw Unauthorized('OTP_INVALID', 'That code is not valid');

  if (challenge.expiresAt <= new Date()) {
    throw Unauthorized('OTP_EXPIRED', 'That code has expired. Request a new one.');
  }
  if (challenge.attempts >= challenge.maxAttempts) {
    throw TooManyRequests('OTP_ATTEMPTS_EXCEEDED', 'Too many attempts. Request a new code.');
  }

  // Count the attempt before comparing, so a crash mid-verify cannot reset the cap.
  challenge.attempts += 1;
  await challenge.save();

  if (!timingSafeEqualStr(sha256Hex(String(code)), challenge.codeHash)) {
    throw Unauthorized('OTP_INVALID', 'That code is not valid');
  }

  // Atomic consume: two concurrent requests must not both succeed with one code.
  const consumed = await OtpChallenge.findOneAndUpdate(
    { _id: challenge._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );
  if (!consumed) throw Unauthorized('OTP_INVALID', 'That code is not valid');
}

/** Directory-derived facts, or a safe refusal. Never falls back to cached authority. */
async function verifyAgainstDirectory(authorityId) {
  const identity = await resolveIdentity(authorityId);
  if (!identity) return { ok: false, reason: 'IDENTITY_NOT_IN_DIRECTORY', identity: null };
  if (!identity.active) {
    return { ok: false, reason: identity.inactiveReason ?? 'IDENTITY_NOT_ACTIVE', identity };
  }
  return { ok: true, reason: null, identity };
}

const sessionResponse = (user, accessToken, refreshToken) => ({
  accessToken,
  refreshToken,
  expiresIn: env.JWT_ACCESS_TTL_SEC,
  user: user.toSessionContext(),
});

// ================================================================ handlers ====

/**
 * POST /api/auth/verify-identity  { authorityId }
 * Checks the directory and returns a masked phone. No account is created here.
 */
export async function verifyIdentity(req, res, next) {
  try {
    const authorityId = parse(authorityIdSchema, req.body?.authorityId);
    const { ok, reason, identity } = await verifyAgainstDirectory(authorityId);

    if (!ok) {
      // The fake-PIS demo: rejected AND recorded.
      await writeAuthAudit(req, { authorityId, decision: DECISION.DENY, reason });
      throw Forbidden('IDENTITY_NOT_VERIFIED', 'This identity could not be verified', { reason });
    }

    const existing = await User.findOne({ authorityId }).lean();

    await writeAuthAudit(req, {
      authorityId,
      decision: DECISION.ALLOW,
      reason: 'IDENTITY_VERIFIED',
    });

    return res.json({
      authorityId,
      name: identity.name,
      authority: identity.authority,
      role: identity.role,
      scope: identity.scope,
      maskedPhone: maskPhone(identity.phone),
      accountExists: Boolean(existing),
      // Tells the client which flow to run next; not itself a credential.
      nextStep: existing ? 'LOGIN' : 'ACTIVATE',
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/auth/request-otp  { authorityId, purpose }
 * Sends an OTP to the phone ON RECORD IN THE DIRECTORY — never to a number supplied
 * in the request, which would make the second factor attacker-chosen.
 */
export async function requestOtp(req, res, next) {
  try {
    const authorityId = parse(authorityIdSchema, req.body?.authorityId);
    const purpose = parse(
      z.enum([OTP_PURPOSE.ACTIVATION, OTP_PURPOSE.LOGIN]).default(OTP_PURPOSE.LOGIN),
      req.body?.purpose
    );

    const { ok, reason, identity } = await verifyAgainstDirectory(authorityId);
    if (!ok) {
      await writeAuthAudit(req, { authorityId, decision: DECISION.DENY, reason });
      throw Forbidden('IDENTITY_NOT_VERIFIED', 'This identity could not be verified', { reason });
    }

    const existing = await User.findOne({ authorityId }).lean();
    if (purpose === OTP_PURPOSE.ACTIVATION && existing) {
      throw BadRequest('ACCOUNT_EXISTS', 'This account is already activated. Sign in instead.');
    }
    if (purpose === OTP_PURPOSE.LOGIN && !existing) {
      throw BadRequest('ACCOUNT_NOT_ACTIVATED', 'This account has not been activated yet.');
    }

    const code = await issueOtp({
      authorityId,
      purpose,
      phone: identity.phone,
      ip: req.ip,
    });

    return res.json({
      sent: true,
      maskedPhone: maskPhone(identity.phone),
      expiresInSec: env.OTP_TTL_SEC,
      // Demo affordance only. Refused when NODE_ENV=production (ADR-004).
      ...(env.DEMO_ECHO_OTP ? { demoOtp: code } : {}),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/auth/activate  { authorityId, otp, password, publicKeyJwk }
 * Creates the account with role and scope taken from the directory response.
 */
export async function activate(req, res, next) {
  try {
    const body = parse(
      z.object({
        authorityId: authorityIdSchema,
        otp: z.string().regex(/^\d{4,8}$/, 'Invalid code'),
        password: passwordSchema,
        publicKeyJwk: publicKeyJwkSchema,
      }),
      req.body
    );

    const { ok, reason, identity } = await verifyAgainstDirectory(body.authorityId);
    if (!ok) {
      await writeAuthAudit(req, {
        authorityId: body.authorityId,
        decision: DECISION.DENY,
        reason,
      });
      throw Forbidden('IDENTITY_NOT_VERIFIED', 'This identity could not be verified', { reason });
    }

    if (await User.exists({ authorityId: body.authorityId })) {
      throw BadRequest('ACCOUNT_EXISTS', 'This account is already activated. Sign in instead.');
    }

    await consumeOtp({
      authorityId: body.authorityId,
      purpose: OTP_PURPOSE.ACTIVATION,
      code: body.otp,
    });

    const user = await User.create({
      authorityId: body.authorityId,
      // ---- everything below comes from the DIRECTORY, not from the request ----
      authority: identity.authority,
      role: identity.role,
      name: identity.name,
      scope: identity.scope,
      // ------------------------------------------------------------------------
      passwordHash: await bcrypt.hash(body.password, BCRYPT_ROUNDS),
      publicKeyJwk: body.publicKeyJwk,
      publicKeyFingerprint: publicKeyFingerprint(body.publicKeyJwk),
      phone: identity.phone,
      directoryLastVerifiedAt: new Date(),
      status: USER_STATUS.ACTIVE,
      createdVia: CREATED_VIA.DIRECTORY_FIRST_LOGIN,
    });

    await writeAuthAudit(req, {
      authorityId: body.authorityId,
      decision: DECISION.ALLOW,
      reason: 'ACCOUNT_ACTIVATED',
    });

    const accessToken = signAccessToken(user.toSessionContext());
    const refreshToken = await issueRefreshToken(user._id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.status(201).json(sessionResponse(user, accessToken, refreshToken));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/auth/login  { authorityId, password, otp }
 *
 * 1. look up the local user
 * 2. verify the password
 * 3. verify the OTP
 * 4. RE-CHECK THE DIRECTORY LIVE  ← the whole point
 * 5. issue tokens
 */
export async function login(req, res, next) {
  const authorityIdRaw = typeof req.body?.authorityId === 'string' ? req.body.authorityId : null;
  try {
    const body = parse(
      z.object({
        authorityId: authorityIdSchema,
        password: z.string().min(1).max(200),
        otp: z.string().regex(/^\d{4,8}$/, 'Invalid code'),
      }),
      req.body
    );

    const user = await User.findOne({ authorityId: body.authorityId }).select('+passwordHash +phone');

    // Uniform failure for "no such user" and "wrong password", and the bcrypt
    // comparison runs either way so the timing does not distinguish them.
    const passwordOk = user
      ? await bcrypt.compare(body.password, user.passwordHash)
      : await bcrypt.compare(body.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');

    if (!user || !passwordOk) {
      await writeAuthAudit(req, {
        authorityId: body.authorityId,
        decision: DECISION.DENY,
        reason: 'BAD_CREDENTIALS',
      });
      throw Unauthorized('BAD_CREDENTIALS', 'Sign-in failed');
    }

    if (user.isLocked()) {
      await writeAuthAudit(req, {
        authorityId: body.authorityId,
        decision: DECISION.DENY,
        reason: 'ACCOUNT_LOCKED',
      });
      throw TooManyRequests('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }

    if (user.status !== USER_STATUS.ACTIVE) {
      await writeAuthAudit(req, {
        authorityId: body.authorityId,
        decision: DECISION.DENY,
        reason: `USER_${user.status}`,
      });
      throw Forbidden('USER_NOT_ACTIVE', 'This account is not active');
    }

    await consumeOtp({
      authorityId: body.authorityId,
      purpose: OTP_PURPOSE.LOGIN,
      code: body.otp,
    });

    // ---- Step 4: live directory re-verification -------------------------------
    const { ok, reason, identity } = await verifyAgainstDirectory(body.authorityId);
    if (!ok) {
      await writeAuthAudit(req, {
        authorityId: body.authorityId,
        decision: DECISION.DENY,
        reason: reason ?? 'DIRECTORY_REVERIFICATION_FAILED',
      });
      throw Forbidden('DIRECTORY_REVERIFICATION_FAILED', 'Your authority record no longer permits access', {
        reason,
      });
    }

    // Adopt the directory's current answer. A transfer or roster rotation changes the
    // session's scope here, silently and correctly, without an admin touching Lexx.
    user.authority = identity.authority;
    user.role = identity.role;
    user.name = identity.name ?? user.name;
    user.scope = identity.scope;
    user.directoryLastVerifiedAt = new Date();
    user.lastLoginAt = new Date();
    user.failedLoginCount = 0;
    await user.save();

    await writeAuthAudit(req, {
      authorityId: body.authorityId,
      decision: DECISION.ALLOW,
      reason: 'LOGIN_SUCCESS',
    });

    const accessToken = signAccessToken(user.toSessionContext());
    const refreshToken = await issueRefreshToken(user._id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json(sessionResponse(user, accessToken, refreshToken));
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      log.info({ authorityId: authorityIdRaw, code: err.code }, 'login denied');
    }
    return next(err);
  }
}

/**
 * POST /api/auth/refresh  { refreshToken }
 * Rotates the refresh token AND re-verifies the directory, so a long-lived session
 * cannot outlive the authority that justified it.
 */
export async function refresh(req, res, next) {
  try {
    const { refreshToken: presented } = parse(
      z.object({ refreshToken: z.string().min(10).max(500) }),
      req.body
    );

    const rotated = await rotateRefreshToken(presented, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    const user = await User.findById(rotated.userId);
    if (!user || user.status !== USER_STATUS.ACTIVE) {
      throw Forbidden('USER_NOT_ACTIVE', 'This account is not active');
    }

    const { ok, reason, identity } = await verifyAgainstDirectory(user.authorityId);
    if (!ok) {
      await revokeAllForUser(user._id, 'DIRECTORY_REVERIFICATION_FAILED');
      await writeAuthAudit(req, {
        authorityId: user.authorityId,
        decision: DECISION.DENY,
        reason: reason ?? 'DIRECTORY_REVERIFICATION_FAILED',
      });
      throw Forbidden('DIRECTORY_REVERIFICATION_FAILED', 'Your authority record no longer permits access', {
        reason,
      });
    }

    user.authority = identity.authority;
    user.role = identity.role;
    user.scope = identity.scope;
    user.directoryLastVerifiedAt = new Date();
    await user.save();

    const accessToken = signAccessToken(user.toSessionContext());
    return res.json(sessionResponse(user, accessToken, rotated.refreshToken));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/auth/rotate-key  { otp, publicKeyJwk }
 *
 * Register a new signing key for a new device.
 *
 * This is a real operational need — a lost or replaced phone otherwise locks an
 * officer out of signing anything — but it is also a high-value target: whoever
 * controls the registered key can sign as this officer from now on. So it costs a
 * live session AND a fresh OTP to the phone on record, and it is audited.
 *
 * It does NOT invalidate past signatures: every evidence record pins the public key
 * that actually made its signature (`Evidence.signerPublicKeyJwk`), so history stays
 * verifiable against the old key forever. Without that pin, rotating a key would
 * silently mark every exhibit the officer ever uploaded as unverifiable.
 */
export async function rotateKey(req, res, next) {
  try {
    const body = parse(
      z.object({
        otp: z.string().regex(/^\d{4,8}$/, 'Invalid code'),
        publicKeyJwk: publicKeyJwkSchema,
      }),
      req.body
    );

    // The directory must still vouch for them — a suspended officer cannot re-key.
    const { ok, reason } = await verifyAgainstDirectory(req.user.authorityId);
    if (!ok) {
      await writeAuthAudit(req, {
        authorityId: req.user.authorityId,
        decision: DECISION.DENY,
        reason: reason ?? 'DIRECTORY_REVERIFICATION_FAILED',
      });
      throw Forbidden('DIRECTORY_REVERIFICATION_FAILED', 'Your authority record no longer permits access');
    }

    await consumeOtp({
      authorityId: req.user.authorityId,
      purpose: OTP_PURPOSE.LOGIN,
      code: body.otp,
    });

    const user = await User.findById(req.user.userId);
    if (!user) throw Unauthorized('SESSION_USER_MISSING', 'Session is not valid');

    const previousFingerprint = user.publicKeyFingerprint;
    user.publicKeyJwk = body.publicKeyJwk;
    user.publicKeyFingerprint = publicKeyFingerprint(body.publicKeyJwk);
    await user.save();

    // Any other session holding the old device's context is no longer trustworthy.
    await revokeAllForUser(user._id, 'SIGNING_KEY_ROTATED');

    await writeAuthAudit(req, {
      authorityId: req.user.authorityId,
      decision: DECISION.ALLOW,
      reason: 'SIGNING_KEY_ROTATED',
    });

    log.info(
      { authorityId: req.user.authorityId, previousFingerprint, newFingerprint: user.publicKeyFingerprint },
      'signing key rotated'
    );

    return res.json({
      rotated: true,
      publicKeyFingerprint: user.publicKeyFingerprint,
      previousFingerprint,
      note: 'Existing evidence remains verifiable against the key that signed it.',
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/auth/me */
export async function me(req, res) {
  return res.json({ user: req.user });
}

/** POST /api/auth/logout */
export async function logout(req, res, next) {
  try {
    await revokeAllForUser(req.user.userId, 'LOGOUT');
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/auth/register → 410 Gone.
 * Left in place deliberately: a reviewer who pokes at it sees the design choice
 * stated rather than a 404 that looks like an oversight.
 */
export function registerGone(req, res, next) {
  next(Gone('SELF_REGISTRATION_DISABLED', 'Accounts are provisioned by your authority directory'));
}

export default {
  verifyIdentity,
  requestOtp,
  activate,
  login,
  refresh,
  rotateKey,
  me,
  logout,
  registerGone,
};
