/**
 * Where a s.63 certificate stands, in one word — shared by the certificate controller,
 * the case overview and the FSL queue so every screen describes it the same way.
 *
 * v3.0 certificates are issued and signed by the system on upload, so they are either
 * ISSUED or (briefly, or after a failure the retry path will repair) PENDING_ISSUE.
 * The signature-collection states remain only to describe legacy v1.0/v2.0 records and
 * so existing importers of CERTIFICATE_STATE keep compiling; no v3.0 certificate ever
 * reaches them.
 */
import { CERTIFICATE_STATUS } from '../models/enums.js';
import { SYSTEM_SIGNER_LABEL } from './systemSigner.js';

const SYSTEM_TEMPLATE_VERSION = 'v3.0';

export const CERTIFICATE_STATE = Object.freeze({
  /** Issued and signed by the LEXX Certificate Authority, recorded in the ledger. */
  ISSUED: 'ISSUED',
  /** The record exists but its signature or ledger record has not been written yet. */
  PENDING_ISSUE: 'PENDING_ISSUE',
  /** Kept for history; replaced by the certificate it points at. */
  SUPERSEDED: 'SUPERSEDED',
  // ---- legacy (v1.0 / v2.0) only ----
  AWAITING_DEPONENT_SIGNATURE: 'AWAITING_DEPONENT_SIGNATURE',
  AWAITING_EXPERT_SIGNATURE: 'AWAITING_EXPERT_SIGNATURE',
  SIGNED_BY_DEPONENT: 'SIGNED_BY_DEPONENT',
  FULLY_SIGNED: 'FULLY_SIGNED',
});

export const CERTIFICATE_STATE_LABEL = Object.freeze({
  ISSUED: `Issued and signed by the ${SYSTEM_SIGNER_LABEL}`,
  PENDING_ISSUE: 'Being issued',
  SUPERSEDED: 'Superseded',
  AWAITING_DEPONENT_SIGNATURE: 'Legacy certificate — not signed',
  AWAITING_EXPERT_SIGNATURE: 'Legacy certificate — Part B not signed',
  SIGNED_BY_DEPONENT: 'Legacy certificate — signed by the deponent',
  FULLY_SIGNED: 'Legacy certificate — fully signed',
});

export function certificateState(cert) {
  if (!cert) return null;
  if (cert.status === CERTIFICATE_STATUS.SUPERSEDED) return CERTIFICATE_STATE.SUPERSEDED;
  if (cert.templateVersion === SYSTEM_TEMPLATE_VERSION) {
    return cert.systemSignature?.signature && Number.isInteger(cert.issuanceLedgerSeq)
      ? CERTIFICATE_STATE.ISSUED
      : CERTIFICATE_STATE.PENDING_ISSUE;
  }
  const has = (role) => (cert.signatures ?? []).some((s) => s.role === role);
  if (!has('PARTY')) return CERTIFICATE_STATE.AWAITING_DEPONENT_SIGNATURE;
  if (cert.partBComplete && !has('EXPERT')) return CERTIFICATE_STATE.AWAITING_EXPERT_SIGNATURE;
  if (!cert.partBComplete) return CERTIFICATE_STATE.SIGNED_BY_DEPONENT;
  return CERTIFICATE_STATE.FULLY_SIGNED;
}

/** The small form carried on an exhibit card. Names no signer. */
export function certificateSummary(cert) {
  if (!cert) return null;
  const state = certificateState(cert);
  const system = cert.templateVersion === SYSTEM_TEMPLATE_VERSION;
  return {
    certificateId: String(cert._id),
    status: cert.status ?? CERTIFICATE_STATUS.ACTIVE,
    state,
    stateLabel: CERTIFICATE_STATE_LABEL[state],
    templateVersion: cert.templateVersion ?? 'v1.0',
    issuedAt: cert.issuedAt ?? cert.generatedAt ?? null,
    signedBy: system && state === CERTIFICATE_STATE.ISSUED ? SYSTEM_SIGNER_LABEL : null,
    lastVerification: cert.lastVerification
      ? { result: cert.lastVerification.result, at: cert.lastVerification.at, byRole: cert.lastVerification.byRole ?? null }
      : null,
  };
}

export default { certificateState, certificateSummary, CERTIFICATE_STATE, CERTIFICATE_STATE_LABEL };
