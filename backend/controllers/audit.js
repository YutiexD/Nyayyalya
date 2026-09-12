/**
 * The audit feed.
 *
 * Denials are the interesting rows. The dashboard leads with them, because a log that
 * only shows successes cannot show you the advocate who reached for an exhibit
 * outside their disclosure set — which is the moment the confidentiality boundary
 * becomes visible rather than theoretical.
 *
 * The feed is itself scoped: a supervisor sees denials within their own jurisdiction,
 * not the whole deployment. An audit log that leaks across boundaries would undo the
 * boundaries it exists to police.
 */
import { z } from 'zod';
import { AuditEvent } from '../models/AuditEvent.js';
import { Case } from '../models/Case.js';
import { materialiseScopeFilter } from '../services/accessResolver.js';
import { RESOURCE_TYPE, DECISION, AUTHORITY, ROLE } from '../models/enums.js';
import { BadRequest, Forbidden } from '../utils/errors.js';

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw BadRequest('VALIDATION_FAILED', 'Request failed validation', {
      fields: r.error.issues.map((i) => i.path.join('.') || '(root)'),
    });
  }
  return r.data;
};

/** Who may read an audit feed at all: station and district supervision, and the court. */
const AUDIT_READERS = new Set([ROLE.SHO, ROLE.DISTRICT_SP, ROLE.JUDGE]);

/**
 * GET /api/audit?caseId=&decision=DENY&limit=
 *
 * Supervisory visibility, bounded by the reader's own scope.
 */
export async function listAudit(req, res, next) {
  try {
    if (!AUDIT_READERS.has(req.user.role)) {
      throw Forbidden('AUDIT_NOT_PERMITTED', 'This role cannot read the audit feed');
    }

    const q = parse(
      z.object({
        caseId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
        decision: z.enum([DECISION.ALLOW, DECISION.DENY]).optional(),
        action: z.string().max(24).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional().default(100),
      }),
      req.query
    );

    // Intersect with the cases this reader may see. A null filter means nothing.
    const caseFilter = await materialiseScopeFilter(req.user, RESOURCE_TYPE.CASE);
    if (!caseFilter) return res.json({ events: [], total: 0 });

    const visibleCaseIds = await Case.distinct('_id', caseFilter);

    const filter = { caseId: { $in: visibleCaseIds } };
    if (q.caseId) {
      // Requesting a specific case cannot widen the set — only narrow it.
      filter.caseId = { $in: visibleCaseIds.filter((id) => String(id) === q.caseId) };
    }
    if (q.decision) filter.decision = q.decision;
    if (q.action) filter.action = q.action;

    const events = await AuditEvent.find(filter).sort({ at: -1 }).limit(q.limit).lean();

    return res.json({
      events: events.map((e) => ({
        at: e.at,
        actorName: e.actorName,
        authorityId: e.authorityId,
        authority: e.authority,
        role: e.role,
        action: e.action,
        resourceType: e.resourceType,
        resourceLabel: e.resourceLabel,
        caseId: e.caseId,
        decision: e.decision,
        reason: e.reason,
        // IP and user agent are retained in the record but not surfaced in the feed;
        // they are investigation material, not dashboard furniture.
      })),
      total: events.length,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/audit/security — authentication-layer events (failed identity checks,
 * rejected activations, denied logins). These carry no caseId, so they are gated on
 * role rather than case scope, and are limited to supervisory roles.
 */
export async function securityFeed(req, res, next) {
  try {
    if (
      !(req.user.authority === AUTHORITY.POLICE && (req.user.role === ROLE.SHO || req.user.role === ROLE.DISTRICT_SP)) &&
      req.user.role !== ROLE.JUDGE
    ) {
      throw Forbidden('AUDIT_NOT_PERMITTED', 'This role cannot read the security feed');
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const events = await AuditEvent.find({ action: 'LOGIN' }).sort({ at: -1 }).limit(limit).lean();

    return res.json({
      events: events.map((e) => ({
        at: e.at,
        authorityId: e.authorityId,
        decision: e.decision,
        reason: e.reason,
        ip: e.ip,
      })),
      total: events.length,
    });
  } catch (err) {
    return next(err);
  }
}

export default { listAudit, securityFeed };
