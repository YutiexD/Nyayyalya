/**
 * BSA s.63 certificates — read, download, verify.
 *
 * Certificates are no longer created or signed by people. The system issues one per
 * exhibit when it is uploaded and signs it with the LEXX Certificate Authority key
 * (services/certificateIssuer.js). This controller:
 *
 *   - lists and returns certificates (repairing a missing one on the way);
 *   - serves the stored PDF;
 *   - runs the one-click verification (services/certificateVerifier.js) for an
 *     authenticated reader, and records the result in the ledger;
 *   - answers the public, token-based verifier with the same result and checks;
 *   - publishes the authority's public key so any signature can be re-checked.
 *
 * The manual generate / sign-part-a / sign-part-b flow and the Part B sync from the
 * forensic verdict are gone. Verification never consults the forensic verdict.
 */
import { z } from 'zod';

import { Certificate } from '../models/Certificate.js';
import { Case } from '../models/Case.js';
import {
  ACTION,
  CERTIFICATE_STATUS,
  DECISION,
  LEDGER_EVENT,
  RESOURCE_TYPE,
  SUBJECT_TYPE,
} from '../models/enums.js';
import { appendEvent } from '../services/ledger.js';
import { readCertificatePdf, verificationUrlFor } from '../services/certificatePdf.js';
import { ensureSystemCertificateQuietly, isSystemCertificate } from '../services/certificateIssuer.js';
import { verifyCertificateRecord, VERIFICATION_RESULT } from '../services/certificateVerifier.js';
import { authorityPublicKey, SYSTEM_SIGNER_LABEL } from '../services/systemSigner.js';
import {
  buildPublicEvidenceView,
  publicCertificateView,
  publicEvidenceForLabel,
  PUBLIC_DISCLOSURE,
} from '../services/publicEvidenceView.js';
import { writeAudit } from '../middleware/audit.js';
import { BadRequest, Conflict, NotFound } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('certificate');

// ---------------------------------------------------------------- validation ----

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Malformed id');

/** `randomBase64Url(32)` — 32 bytes, 43 base64url characters. */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Malformed verification token');

/** Validate `?evidenceId=` before the resolver is asked to load it. */
export function validateEvidenceQuery(req, res, next) {
  const r = z.object({ evidenceId: objectId }).safeParse({ evidenceId: req.query.evidenceId });
  if (!r.success) {
    return next(BadRequest('VALIDATION_FAILED', 'Request failed validation', { fields: ['evidenceId'] }));
  }
  return next();
}

// ---------------------------------------------------------------- views ----

/** The small, uniform view every list and get returns. Carries no signing payloads. */
export function certificateView(cert, { exhibitCode = null } = {}) {
  const system = isSystemCertificate(cert);
  const onBehalf = system
    ? cert.issuedOnBehalfOf
    : { name: cert.partA?.deponentName, authorityId: cert.partA?.deponentAuthorityId, role: null };
  const id = String(cert._id);
  return {
    certificateId: id,
    evidenceId: String(cert.evidenceId),
    exhibitCode: cert.exhibitCode ?? exhibitCode ?? null,
    status: cert.status ?? CERTIFICATE_STATUS.ACTIVE,
    issuedAt: cert.issuedAt ?? cert.generatedAt ?? null,
    templateVersion: cert.templateVersion ?? 'v1.0',
    issuedOnBehalfOf: onBehalf
      ? { name: onBehalf.name ?? null, authorityId: onBehalf.authorityId ?? null, role: onBehalf.role ?? null }
      : null,
    signedBy: system && cert.systemSignature?.signature ? SYSTEM_SIGNER_LABEL : null,
    verificationToken: cert.verificationToken,
    verificationUrl: verificationUrlFor(cert.verificationToken),
    pdfUrl: `/api/certificates/${id}/pdf`,
    lastVerification: cert.lastVerification
      ? { result: cert.lastVerification.result, at: cert.lastVerification.at, byRole: cert.lastVerification.byRole ?? null }
      : null,
  };
}

async function listFor(evidenceId, exhibitCode) {
  // A certificate that failed to issue at upload is repaired here. Never fails the read.
  await ensureSystemCertificateQuietly(evidenceId);
  const certificates = await Certificate.find({ evidenceId }).sort({ status: 1, generatedAt: -1 }).lean();
  const active = certificates.find((c) => (c.status ?? CERTIFICATE_STATUS.ACTIVE) === CERTIFICATE_STATUS.ACTIVE);
  return {
    evidenceId: String(evidenceId),
    exhibitCode: exhibitCode ?? null,
    active: active ? certificateView(active, { exhibitCode }) : null,
    certificates: certificates.map((c) => certificateView(c, { exhibitCode })),
    total: certificates.length,
  };
}

// ================================================================ READS ====

/** GET /api/certificates?evidenceId=   (anyone who may read the exhibit) */
export async function listForEvidence(req, res, next) {
  try {
    const evidence = req.resource;
    return res.json(await listFor(evidence._id, evidence.exhibitCode));
  } catch (err) {
    return next(err);
  }
}

/** GET /api/fsl/referrals/:id/certificates   (the examiner, through their referral) */
export async function listForReferral(req, res, next) {
  try {
    const referral = req.resource;
    return res.json(await listFor(referral.evidenceId, referral.exhibitCode));
  } catch (err) {
    return next(err);
  }
}

/** GET /api/certificates/:id */
export async function getCertificate(req, res) {
  return res.json({ certificate: certificateView(req.resource) });
}

/** GET /api/certificates/authority-key  and  GET /public/certificate-authority-key — no auth. */
export function authorityKey(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.json(authorityPublicKey());
}

/**
 * GET /api/certificates/:id/pdf
 *
 * Serves the STORED document — the exact bytes that were signed — rather than a fresh
 * render, so what a reader downloads is what verification checks.
 */
export async function getPdf(req, res, next) {
  try {
    const certificate = await Certificate.findById(req.resource._id).lean();
    if (!certificate) throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');

    let pdf = null;
    try {
      pdf = await readCertificatePdf(certificate);
    } catch (err) {
      log.warn({ certificateId: String(certificate._id), err: err.message }, 'stored certificate PDF unreadable');
    }
    if (!pdf) {
      throw Conflict(
        'CERTIFICATE_DOCUMENT_UNAVAILABLE',
        'The stored certificate document is missing or has been altered. Verify the certificate for details.'
      );
    }

    await writeAudit(req, {
      action: ACTION.DOWNLOAD,
      resourceType: RESOURCE_TYPE.CERTIFICATE,
      resourceId: certificate._id,
      resourceLabel: certificate.exhibitCode ?? null,
      caseId: certificate.caseId,
      decision: DECISION.ALLOW,
      reason: 'CERTIFICATE_PDF_DOWNLOAD',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="s63-certificate-${certificate.exhibitCode ?? certificate._id}.pdf"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (certificate.pdfSha256) res.setHeader('X-Lexx-Pdf-Sha256', certificate.pdfSha256);
    return res.send(pdf);
  } catch (err) {
    return next(err);
  }
}

// ============================================================ VERIFICATION ====

/**
 * POST (or GET) /api/certificates/:id/verify   (anyone who may read the certificate)
 *
 * One click, no input. Response: { certificateId, exhibitCode, result, verifiedAt, checks }.
 * The result is written to the ledger as CERTIFICATE_VERIFIED with the actor.
 */
export async function verifyCertificate(req, res, next) {
  try {
    const outcome = await verifyCertificateRecord(req.resource._id);
    if (!outcome) throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');
    const { certificate: cert, evidence, result, verifiedAt, checks } = outcome;
    const exhibitCode = cert.exhibitCode ?? evidence?.exhibitCode ?? null;

    await appendEvent({
      eventType: LEDGER_EVENT.CERTIFICATE_VERIFIED,
      caseId: cert.caseId,
      subjectId: cert._id,
      subjectType: SUBJECT_TYPE.CERTIFICATE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        certificateId: String(cert._id),
        exhibitCode,
        result,
        failedChecks: checks.filter((c) => !c.ok).map((c) => c.key),
        verifiedAt,
      },
    });
    await Certificate.updateOne(
      { _id: cert._id },
      { $set: { lastVerification: { result, at: verifiedAt, byRole: req.user.role ?? null } } }
    );
    await writeAudit(req, {
      action: ACTION.VERIFY,
      resourceType: RESOURCE_TYPE.CERTIFICATE,
      resourceId: cert._id,
      resourceLabel: exhibitCode,
      caseId: cert.caseId,
      decision: DECISION.ALLOW,
      reason: result === VERIFICATION_RESULT.VERIFIED ? 'CERTIFICATE_VERIFIED' : 'CERTIFICATE_VERIFICATION_FAILED',
    });

    return res.json({ certificateId: String(cert._id), exhibitCode, result, verifiedAt, checks });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /public/verify/:token   — PUBLIC, NO AUTH. Mount OUTSIDE /api.
 *
 * A token holder is entitled to know that the certificate is genuine and unaltered,
 * who registered the exhibit and where its case stands. The response carries the same
 * `result` and `checks` as the authenticated verifier, public court identifiers and
 * digests, and the shared public evidence view (services/publicEvidenceView.js): the
 * registering official, the exhibit's identity (title withheld for a sensitive case),
 * forensic STATUS and the lifecycle. It must NEVER carry the description, a party's,
 * victim's or witness's name, device serial numbers, the forensic opinion, the AI
 * analysis or any narrative — the builder lists every field explicitly for that reason.
 */
export async function publicVerify(req, res, next) {
  try {
    const parsed = tokenSchema.safeParse(req.params.token);
    if (!parsed.success) {
      // A malformed token is answered exactly like an unknown one.
      return res.status(404).json({ valid: false, reason: 'CERTIFICATE_NOT_FOUND' });
    }
    const found = await Certificate.findOne({ verificationToken: parsed.data }).select('_id').lean();
    if (!found) return res.status(404).json({ valid: false, reason: 'CERTIFICATE_NOT_FOUND' });

    const outcome = await verifyCertificateRecord(found._id);
    if (!outcome) return res.status(404).json({ valid: false, reason: 'CERTIFICATE_NOT_FOUND' });
    const { certificate, evidence } = outcome;

    // The copy a holder has in hand, if they sent its digest (hashed in their browser).
    let copy = null;
    if (typeof req.query.copy === 'string') {
      const digest = req.query.copy.trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(digest)) {
        const earlier = (certificate.pdfHistory ?? []).find((h) => h.sha256 === digest);
        copy = {
          sha256: digest,
          match: digest === certificate.pdfSha256 ? 'CURRENT' : earlier ? 'EARLIER_VERSION' : 'NO_MATCH',
          supersededAt: earlier?.supersededAt ?? null,
        };
      }
    }

    const caseDoc = await Case.findById(certificate.caseId).lean();

    // The shared public view (services/publicEvidenceView.js): the same evidence,
    // uploader, case, forensic-status and lifecycle blocks a scanned QR label shows.
    // `result` and `checks` stay those of THIS certificate, so a superseded token
    // still answers FAILED on `activeCertificate`.
    const view = evidence
      ? await buildPublicEvidenceView({ evidence, outcome, caseDoc })
      : {
          result: outcome.result,
          checks: outcome.checks,
          verifiedAt: outcome.verifiedAt,
          evidence: null,
          uploadedBy: null,
          case: null,
          certificate: publicCertificateView(certificate, { caseDoc, pdfIntegrity: outcome.pdfIntegrity }),
          forensic: null,
          lifecycle: [],
          disclosure: PUBLIC_DISCLOSURE,
        };

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ...view,
      valid: true,
      issuer: 'LEXX',
      copy,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /public/evidence/:labelToken   — PUBLIC, NO AUTH. Mount OUTSIDE /api.
 *
 * What the permanent QR label on a physical exhibit opens: the exhibit's verification
 * (its ACTIVE certificate, re-verified, nothing recorded), who registered it, where the
 * case stands and its lifecycle. Same view as the certificate verifier. An unknown or
 * malformed token is 404 LABEL_NOT_FOUND.
 */
export async function publicEvidence(req, res, next) {
  try {
    const view = await publicEvidenceForLabel(req.params.labelToken);
    if (!view) {
      return res.status(404).json({
        valid: false,
        reason: 'LABEL_NOT_FOUND',
        error: { code: 'LABEL_NOT_FOUND', message: 'No exhibit carries this label' },
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ...view, valid: true, issuer: 'LEXX' });
  } catch (err) {
    return next(err);
  }
}

// ============================================================ retired API ====

/**
 * @deprecated No-op, kept only so existing importers (controllers/fsl.js) keep loading.
 * Part B is no longer synced from the forensic verdict: a v3.0 certificate's Part B is
 * the ingest hash attestation and carries no verdict. Remove the import and call site.
 */
export async function syncCertificatePartB() {
  return null;
}

export default {
  validateEvidenceQuery,
  listForEvidence,
  listForReferral,
  getCertificate,
  getPdf,
  authorityKey,
  verifyCertificate,
  publicVerify,
  publicEvidence,
  certificateView,
  syncCertificatePartB,
};
