/**
 * Process health: the anchor scheduler's state and the audit writer's state.
 *
 * Both exist for the same reason. A subsystem that fails quietly turns a product
 * claim into a lie nobody notices — "anchored every five minutes", "every
 * authorization decision is recorded" — so each has to be observable, and the audit
 * one has to be able to refuse work.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setSchedulerState,
  getSchedulerState,
  recordAuditSuccess,
  recordAuditFailure,
  getAuditHealth,
  auditIsHealthy,
  AUDIT_UNHEALTHY_THRESHOLD,
  __resetHealth,
} from '../../services/health.js';

beforeEach(() => __resetHealth());

describe('anchor scheduler state', () => {
  it('starts unknown, because nothing has reported yet', () => {
    expect(getSchedulerState().state).toBe('unknown');
  });

  it('records the state and a timestamp', () => {
    const before = Date.now();
    setSchedulerState('active');
    const s = getSchedulerState();
    expect(s.state).toBe('active');
    expect(s.detail).toBeNull();
    expect(s.since.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('carries an operator-facing detail for a failure', () => {
    setSchedulerState('failed', 'no RPC url configured');
    expect(getSchedulerState()).toMatchObject({
      state: 'failed',
      detail: 'no RPC url configured',
    });
  });

  it('hands back a copy, so a caller cannot mutate the process state', () => {
    setSchedulerState('active');
    const s = getSchedulerState();
    s.state = 'tampered';
    expect(getSchedulerState().state).toBe('active');
  });
});

describe('audit health', () => {
  it('starts healthy', () => {
    expect(auditIsHealthy()).toBe(true);
    expect(getAuditHealth().consecutiveFailures).toBe(0);
  });

  it('tolerates failures below the threshold — one blip is not an incident', () => {
    for (let i = 0; i < AUDIT_UNHEALTHY_THRESHOLD - 1; i += 1) {
      recordAuditFailure('connection reset');
    }
    expect(auditIsHealthy()).toBe(true);
    expect(getAuditHealth().consecutiveFailures).toBe(AUDIT_UNHEALTHY_THRESHOLD - 1);
  });

  it('goes unhealthy at the threshold', () => {
    for (let i = 0; i < AUDIT_UNHEALTHY_THRESHOLD; i += 1) recordAuditFailure('connection reset');
    expect(auditIsHealthy()).toBe(false);
    expect(getAuditHealth().lastFailureReason).toBe('connection reset');
    expect(getAuditHealth().lastFailureAt).toBeInstanceOf(Date);
  });

  it('recovers on the first successful write', () => {
    for (let i = 0; i < AUDIT_UNHEALTHY_THRESHOLD; i += 1) recordAuditFailure('x');
    expect(auditIsHealthy()).toBe(false);
    recordAuditSuccess();
    expect(auditIsHealthy()).toBe(true);
    expect(getAuditHealth().consecutiveFailures).toBe(0);
  });

  it('counts CONSECUTIVE failures, so an intermittent fault does not accumulate', () => {
    recordAuditFailure('a');
    recordAuditFailure('b');
    recordAuditSuccess();
    recordAuditFailure('c');
    recordAuditFailure('d');
    expect(auditIsHealthy()).toBe(true);
    expect(getAuditHealth().consecutiveFailures).toBe(2);
    // but the total is still the whole history — that is what an operator investigates
    expect(getAuditHealth().totalFailures).toBe(4);
  });

  it('truncates the reason, so a driver error cannot bloat the health payload', () => {
    recordAuditFailure('x'.repeat(5000));
    expect(getAuditHealth().lastFailureReason.length).toBe(200);
  });

  it('survives a non-string reason', () => {
    recordAuditFailure(undefined);
    expect(getAuditHealth().lastFailureReason).toBe('unknown');
  });
});
