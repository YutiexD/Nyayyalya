/**
 * Audit writing.
 *
 * Every authorization decision is recorded — allow AND deny. The denials are the
 * ones that matter: a log that only records successes cannot show you the advocate
 * who reached for an exhibit outside their disclosure set.
 *
 * Audit failures do not break the request they describe. An audit write that throws
 * would turn a logging outage into an outage of the whole system; instead we log
 * loudly and continue. That is a deliberate availability-over-completeness trade,
 * and it is stated in docs/SECURITY.md rather than left implicit.
 *
 * That trade has two limits, both added after review, because "we record every
 * authorization decision" is the system's strongest claim and a silent logging
 * outage would quietly make it false:
 *
 *   1. Failures are counted, not just logged. A sustained run flips this instance to
 *      degraded on /readyz, so the operator finds out from a health check rather than
 *      from a court.
 *   2. Two operations fail CLOSED via `requireHealthyAudit` — serving disclosure and
 *      filing a forensic report. Those are the acts this system makes its strongest
 *      evidentiary claims about, and neither is permitted to happen unrecorded.
 */
import { AuditEvent } from '../models/AuditEvent.js';
import { recordAuditSuccess, recordAuditFailure, auditIsHealthy, getAuditHealth } from '../services/health.js';
import { ServiceUnavailable } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('audit');

/** First hop only. XFF is client-controllable, so it is evidence, not identity. */
function clientIp(req) {
  const xff = req.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim().slice(0, 64);
  return (req.ip ?? req.socket?.remoteAddress ?? null)?.slice(0, 64) ?? null;
}

/**
 * @param {object} req
 * @param {object} entry
 * @param {string} entry.action
 * @param {string} entry.decision  ALLOW | DENY
 * @param {string} [entry.reason]
 * @param {string} [entry.resourceType]
 * @param {any}    [entry.resourceId]
 * @param {string} [entry.resourceLabel]
 * @param {any}    [entry.caseId]
 */
export async function writeAudit(req, entry) {
  try {
    const user = req.user ?? null;
    await AuditEvent.create({
      userId: user?.userId ?? null,
      authorityId: user?.authorityId ?? req.body?.authorityId ?? null,
      authority: user?.authority ?? null,
      role: user?.role ?? null,
      actorName: user?.name ?? null,

      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      resourceLabel: entry.resourceLabel ?? null,
      caseId: entry.caseId ?? null,

      decision: entry.decision,
      reason: entry.reason ?? null,

      method: req.method,
      path: req.originalUrl?.slice(0, 300) ?? req.path,
      ip: clientIp(req),
      userAgent: req.get('user-agent')?.slice(0, 400) ?? null,

      at: new Date(),
    });
    recordAuditSuccess();
  } catch (err) {
    // Still non-fatal to the request — but no longer invisible. A sustained run of
    // failures flips this instance to degraded on /readyz, and blocks the sensitive
    // operations guarded by requireHealthyAudit().
    recordAuditFailure(err.message);
    log.error({ err: err.message, action: entry.action }, 'audit write failed');
  }
}

/**
 * Audit an authentication attempt. Used for the fake-identity demo: an activation
 * attempt with an unknown PIS number is rejected AND recorded.
 */
export async function writeAuthAudit(req, { authorityId, decision, reason }) {
  try {
    await AuditEvent.create({
      authorityId: authorityId ?? null,
      action: 'LOGIN',
      decision,
      reason: reason ?? null,
      method: req.method,
      path: req.originalUrl?.slice(0, 300) ?? req.path,
      ip: clientIp(req),
      userAgent: req.get('user-agent')?.slice(0, 400) ?? null,
      at: new Date(),
    });
    recordAuditSuccess();
  } catch (err) {
    recordAuditFailure(err.message);
    log.error({ err: err.message }, 'auth audit write failed');
  }
}

/**
 * Guard for operations where an unrecorded decision is not an acceptable outcome.
 *
 * Serving disclosure and filing a forensic report are the two acts this system makes
 * the strongest evidentiary claims about. Performing either while the audit trail is
 * known to be broken would produce exactly the record a court should not trust: an
 * action that happened with no reliable account of who authorised it. Those fail
 * closed; everything else continues to fail open, as documented.
 */
export function requireHealthyAudit(req, res, next) {
  if (auditIsHealthy()) return next();
  const health = getAuditHealth();
  log.error({ consecutiveFailures: health.consecutiveFailures }, 'refusing sensitive operation: audit unhealthy');
  return next(
    ServiceUnavailable(
      'AUDIT_UNAVAILABLE',
      'This operation is refused because the audit trail cannot currently be written. It is not permitted to take place unrecorded.',
      { consecutiveFailures: health.consecutiveFailures }
    )
  );
}

export default { writeAudit, writeAuthAudit, requireHealthyAudit };
