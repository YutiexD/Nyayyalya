/**
 * The authorization middleware. Wraps the single policy point and audits the result.
 *
 * Usage:
 *   router.get('/:id', ...requireSession, authorize({
 *     action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.id'
 *   }), controller)
 *
 * The resource id is read from the REQUEST PATH by default, and the resolver then
 * loads that resource from the database itself. A controller cannot hand the policy
 * a resource object, so there is no way to smuggle a forged `stationCode` past it.
 */
import { resolve, resolveCreate } from '../services/accessResolver.js';
import { writeAudit } from './audit.js';
import { AuthorizationError, NotFound } from '../utils/errors.js';
import { ACTION, DECISION, DENY_REASON } from '../models/enums.js';

/** Safe dotted lookup, e.g. 'params.id' or 'body.caseId'. No prototype walking. */
function pick(req, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    return acc[key];
  }, req);
}

/**
 * @param {object} opts
 * @param {string} opts.action        ACTION value
 * @param {string} opts.resourceType  RESOURCE_TYPE value
 * @param {string} [opts.idFrom='params.id'] where to read the resource id from
 * @param {boolean} [opts.optionalId=false] collection-level route: no id required
 */
export function authorize({ action, resourceType, idFrom = 'params.id', optionalId = false }) {
  return async function authorizeMiddleware(req, res, next) {
    try {
      const resourceId = pick(req, idFrom);

      if (!resourceId && !optionalId) {
        return next(NotFound('RESOURCE_NOT_FOUND', 'Resource not found'));
      }

      const decision = await resolve({
        user: req.user,
        action,
        resourceType,
        resourceId: resourceId ?? null,
      });

      // Audit before responding, so a denial is recorded even if the response fails.
      await writeAudit(req, {
        action,
        resourceType,
        resourceId: resourceId ?? null,
        caseId: decision.caseDoc?._id ?? decision.resource?.caseId ?? null,
        resourceLabel:
          decision.resource?.exhibitCode ??
          decision.resource?.itemCode ??
          decision.resource?.firNumber ??
          null,
        decision: decision.allow ? DECISION.ALLOW : DECISION.DENY,
        reason: decision.reason,
      });

      if (!decision.allow) {
        // A missing resource and a forbidden resource look the same from outside, so
        // an unauthorised caller cannot probe for which case ids exist.
        if (decision.reason === DENY_REASON.RESOURCE_NOT_FOUND) {
          return next(NotFound('RESOURCE_NOT_FOUND', 'Resource not found'));
        }
        return next(new AuthorizationError(decision.reason));
      }

      // Hand the already-loaded, DB-authoritative documents to the controller so it
      // does not re-fetch — and, more importantly, cannot substitute something else.
      req.resource = decision.resource;
      req.caseDoc = decision.caseDoc;
      req.scopeFilter = decision.scopeFilter;

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Collection-level guard for list/search routes. Attaches `req.scopeFilter`, which
 * the controller MUST intersect with its query.
 */
export const authorizeCollection = (resourceType, action = ACTION.READ) =>
  authorize({ action, resourceType, optionalId: true, idFrom: '__none' });

/**
 * Guard for CREATE, where no resource exists to load yet.
 *
 * `contextFrom` may supply directory-derived facts for the policy to check (for
 * example the station a FIR belongs to). It must only ever be fed values the SERVER
 * resolved — never request-body fields — or it reintroduces exactly the bypass that
 * ADR-003 removes.
 */
export function authorizeCreate(resourceType, contextFrom = null) {
  return async function authorizeCreateMiddleware(req, res, next) {
    try {
      const context = typeof contextFrom === 'function' ? await contextFrom(req) : {};
      const decision = await resolveCreate({ user: req.user, resourceType, context });

      await writeAudit(req, {
        action: ACTION.WRITE,
        resourceType,
        caseId: context?.caseId ?? null,
        decision: decision.allow ? DECISION.ALLOW : DECISION.DENY,
        reason: decision.reason,
      });

      if (!decision.allow) return next(new AuthorizationError(decision.reason));

      req.createContext = context;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export default { authorize, authorizeCollection, authorizeCreate };
