/**
 * Process-level health state that `/readyz` reports.
 *
 * Two things live here, and both exist because a subsystem failing quietly is worse
 * than one failing loudly:
 *
 *   - the anchor scheduler's state, so "anchors every five minutes" is an observable
 *     claim rather than an assumed one;
 *   - the audit writer's state, so a system that has stopped recording authorization
 *     decisions cannot keep reporting itself healthy while its single strongest
 *     product claim is silently untrue.
 *
 * This is deliberately in-process and not persisted. It describes THIS instance right
 * now; a restart resets it, which is correct — the question it answers is "is the
 * subsystem running here, at this moment".
 */

/** @typedef {'active'|'disabled'|'failed'|'stopped'|'unknown'} SchedulerState */

let scheduler = { state: /** @type {SchedulerState} */ ('unknown'), detail: null, since: new Date() };

/**
 * @param {SchedulerState} state
 * @param {string|null} [detail] safe operator-facing reason, never a stack or secret
 */
export function setSchedulerState(state, detail = null) {
  scheduler = { state, detail, since: new Date() };
}

export const getSchedulerState = () => ({ ...scheduler });

// ---------------------------------------------------------------- audit ----

/**
 * Audit writes are best-effort by design (see middleware/audit.js): a logging outage
 * must not become an outage of the system it describes. But "best effort" must be
 * visible, or the claim "every authorization decision is recorded" quietly degrades
 * into "every decision we managed to record".
 *
 * `consecutiveFailures` — not a total — because one transient failure is noise and a
 * sustained run is a real incident.
 */
let audit = {
  healthy: true,
  consecutiveFailures: 0,
  totalFailures: 0,
  lastFailureAt: null,
  lastFailureReason: null,
};

/** Number of consecutive failures after which the instance reports itself degraded. */
export const AUDIT_UNHEALTHY_THRESHOLD = 3;

export function recordAuditSuccess() {
  audit.consecutiveFailures = 0;
  audit.healthy = true;
}

export function recordAuditFailure(reason) {
  audit.consecutiveFailures += 1;
  audit.totalFailures += 1;
  audit.lastFailureAt = new Date();
  audit.lastFailureReason = String(reason ?? 'unknown').slice(0, 200);
  if (audit.consecutiveFailures >= AUDIT_UNHEALTHY_THRESHOLD) audit.healthy = false;
}

export const getAuditHealth = () => ({ ...audit });

/** True when the audit trail is currently trustworthy enough to permit a sensitive act. */
export const auditIsHealthy = () => audit.healthy;

/** Test seam. */
export function __resetHealth() {
  scheduler = { state: 'unknown', detail: null, since: new Date() };
  audit = {
    healthy: true,
    consecutiveFailures: 0,
    totalFailures: 0,
    lastFailureAt: null,
    lastFailureReason: null,
  };
}
