/**
 * authenticate → resolveContext
 *
 * `authenticate` proves the bearer holds a token we signed.
 * `resolveContext` decides who that actually makes them, by reading the database.
 *
 * The split matters. A valid signature says the token was minted by us; it says
 * nothing about whether the user has since been suspended, transferred off a case,
 * or rotated off a court roster. Only the second step can know that.
 */
import { verifyAccessToken } from '../services/tokens.js';
import { User } from '../models/User.js';
import { USER_STATUS } from '../models/enums.js';
import { Unauthorized, Forbidden } from '../utils/errors.js';

/**
 * Strict `Authorization: Bearer <token>` parsing.
 *
 * RFC 6750 allows exactly one credential. An earlier version split on whitespace and
 * took the second field, which accepted `Bearer <token> anything-else`. That was not
 * exploitable on its own — the token still had to verify — but lenient header parsing
 * is precisely what request-smuggling and proxy-desync attacks feed on, and there is
 * no reason to accept a header shape no legitimate client sends.
 */
function bearerFrom(req) {
  const header = req.get('authorization');
  if (typeof header !== 'string') return null;

  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return null;

  const [scheme, value] = parts;
  if (!/^Bearer$/i.test(scheme) || !value) return null;
  // A JWT is three base64url segments and nothing else.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value)) return null;

  return value;
}

/** Verify the access token's signature and claims. Attaches `req.auth`. */
export function authenticate(req, res, next) {
  const token = bearerFrom(req);
  if (!token) return next(Unauthorized('NOT_AUTHENTICATED', 'Authentication required'));
  try {
    req.auth = verifyAccessToken(token);
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Load the authoritative session context from the database.
 *
 * This is the line that makes `role` and `scope` untrusted-from-the-client in
 * practice rather than only in principle: whatever the token claims, what the
 * resolver sees is what the database currently says.
 */
export async function resolveContext(req, res, next) {
  try {
    if (!req.auth?.sub) return next(Unauthorized('NOT_AUTHENTICATED', 'Authentication required'));

    const user = await User.findById(req.auth.sub);
    if (!user) return next(Unauthorized('SESSION_USER_MISSING', 'Session is not valid'));

    if (user.status !== USER_STATUS.ACTIVE) {
      // Takes effect on the NEXT request after suspension, not the next login.
      return next(
        Forbidden('USER_NOT_ACTIVE', 'This account is not active', { status: user.status })
      );
    }

    // Authority changed under the token (transfer, roster rotation, re-designation).
    // The token is stale; force a re-login so the new scope is derived from the
    // directory rather than silently carried over.
    if (req.auth.role !== user.role || req.auth.authority !== user.authority) {
      return next(
        Unauthorized('SESSION_STALE', 'Your role has changed. Please sign in again.')
      );
    }

    req.user = user.toSessionContext();
    req.userDoc = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Convenience for routes that need both. */
export const requireSession = [authenticate, resolveContext];

export default { authenticate, resolveContext, requireSession };
