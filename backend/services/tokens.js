/**
 * JWT and refresh-token issuance.
 *
 * The access token carries identity claims for lookup and staleness detection. It is
 * NOT the authorization input — `resolveContext` re-reads the user from the database
 * on every request and the resolver uses that. (ADR-005)
 *
 * Refresh tokens are hashed at rest, single-use, and rotated. Reuse of a consumed
 * token is treated as compromise and revokes the whole family.
 */
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import env from '../config/env.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { sha256Hex, randomBase64Url } from '../config/crypto.js';
import { Unauthorized } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('tokens');

const ISSUER = 'lexx';
const AUDIENCE = 'lexx-api';

/**
 * Mint a 15-minute access token.
 * `algorithm` is pinned, and verification pins it too — accepting whatever the
 * token's own header claims is the classic algorithm-confusion bug (`alg: none`,
 * or an RS256 public key replayed as an HS256 secret).
 */
export function signAccessToken(sessionContext) {
  return jwt.sign(
    {
      sub: sessionContext.userId,
      authorityId: sessionContext.authorityId,
      authority: sessionContext.authority,
      role: sessionContext.role,
      scope: sessionContext.scope,
      pubKeyFingerprint: sessionContext.publicKeyFingerprint ?? null,
      mfaAt: Math.floor(Date.now() / 1000),
    },
    env.JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: env.JWT_ACCESS_TTL_SEC,
      issuer: ISSUER,
      audience: AUDIENCE,
    }
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'], // pinned — never trust the token's own alg header
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch (err) {
    const reason = err?.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    throw Unauthorized(reason, 'Session is not valid');
  }
}

/** Issue a refresh token. Returns the plaintext exactly once. */
export async function issueRefreshToken(userId, { familyId, ip, userAgent } = {}) {
  const token = randomBase64Url(48);
  const tokenHash = sha256Hex(token);

  await RefreshToken.create({
    userId,
    tokenHash,
    familyId: familyId ?? crypto.randomUUID(),
    expiresAt: new Date(Date.now() + env.REFRESH_TTL_SEC * 1000),
    ip: ip ?? null,
    userAgent: userAgent ? String(userAgent).slice(0, 400) : null,
  });

  return token;
}

/**
 * Consume a refresh token and issue its successor.
 *
 * Reuse detection: presenting an already-consumed token means either an attacker is
 * replaying a stolen token, or the legitimate client is replaying after the attacker
 * already rotated it. Either way one of the two parties is hostile and we cannot tell
 * which, so the entire family is revoked and both must re-authenticate.
 */
export async function rotateRefreshToken(presentedToken, { ip, userAgent } = {}) {
  if (typeof presentedToken !== 'string' || !presentedToken) {
    throw Unauthorized('REFRESH_INVALID', 'Refresh token is not valid');
  }
  const tokenHash = sha256Hex(presentedToken);
  const record = await RefreshToken.findOne({ tokenHash });

  if (!record) throw Unauthorized('REFRESH_INVALID', 'Refresh token is not valid');

  if (record.consumedAt || record.revokedAt) {
    log.warn(
      { userId: String(record.userId), familyId: record.familyId },
      'refresh token reuse detected — revoking family'
    );
    await RefreshToken.updateMany(
      { familyId: record.familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revocationReason: 'TOKEN_REUSE_DETECTED' } }
    );
    throw Unauthorized('REFRESH_REUSED', 'Session ended for security reasons. Sign in again.');
  }

  if (record.expiresAt <= new Date()) {
    throw Unauthorized('REFRESH_EXPIRED', 'Session expired. Sign in again.');
  }

  const next = await issueRefreshToken(record.userId, {
    familyId: record.familyId,
    ip,
    userAgent,
  });

  record.consumedAt = new Date();
  record.replacedByHash = sha256Hex(next);
  await record.save();

  return { refreshToken: next, userId: record.userId, familyId: record.familyId };
}

/** Revoke every live refresh token for a user (logout, suspension, key change). */
export async function revokeAllForUser(userId, reason = 'LOGOUT') {
  await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revocationReason: reason } }
  );
}

export default { signAccessToken, verifyAccessToken, issueRefreshToken, rotateRefreshToken };
