/**
 * Audit writing.
 *
 * Every authorization decision is recorded — allow AND deny. The denials are the
 * ones that matter: a log that only records successes cannot show you the advocate
 * who reached for an exhibit outside their disclosure set.
 *
 * Audit failures never break the request they describe. An audit write that throws
 * would turn a logging outage into an outage of the whole system; instead we log
 * loudly and continue. That is a deliberate availability-over-completeness trade,
 * and it is stated in docs/SECURITY.md rather than left implicit.
 */
import { AuditEvent } from '../models/AuditEvent.js';
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
  } catch (err) {
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
  } catch (err) {
    log.error({ err: err.message }, 'auth audit write failed');
  }
}

export default { writeAudit, writeAuthAudit };
