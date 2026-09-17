/**
 * What a member of the public learns about an exhibit — ONE builder, used by both public
 * endpoints:
 *
 *   GET /public/evidence/:labelToken   the permanent QR label stuck on the article
 *   GET /public/verify/:token          a s.63 certificate's verification token
 *
 * A person holding the physical article or its certificate is entitled to know that
 * the record is genuine and unaltered, who registered it, where the case stands, and
 * whether a laboratory has examined it. They are NOT entitled to what the exhibit shows
 * or what anyone concluded about it. So this view carries:
 *
 *   - the verification result of the exhibit's certificate (recomputed, recording nothing);
 *   - the exhibit's identity and digests — its title only when the case is not sensitive;
 *   - the registering official, as the directory names them;
 *   - public case identifiers and the stage;
 *   - whether a forensic examination has been reported, when, and by which laboratory;
 *   - the lifecycle milestones.
 *
 * And it NEVER carries: the description, victim / accused / witness names, the AI
 * analysis, the forensic opinion or its summary, device serial numbers or IMEIs,
 * ledger internals, storage keys or encryption data. Every field below is listed
 * explicitly for that reason — do not spread a document into it.
 */
import { Certificate } from '../models/Certificate.js';
import { Case } from '../models/Case.js';
import { Evidence } from '../models/Evidence.js';
import { User } from '../models/User.js';
import {
  CASE_STAGE,
  CERTIFICATE_STATUS,
  CLOSED_CASE_STAGES,
  FORENSIC_STATUS,
  ROLE_LABEL,
  SENSITIVITY_CLASS,
} from '../models/enums.js';
import { verifyCertificateRecord } from './certificateVerifier.js';
import { verificationUrlFor } from './certificatePdf.js';
import { isSystemCertificate } from './certificateIssuer.js';
import { SYSTEM_SIGNER_LABEL } from './systemSigner.js';
import { requiresCommittal, STAGE_LABEL } from './caseWorkflow.js';
import { labelUrlFor } from './evidenceLabel.js';
import { describeEvidenceLifecycle, LIFECYCLE_VARIANT } from './lifecycleDetails.js';

/** `randomBase64Url(32)` — 43 base64url characters. */
export const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const PUBLIC_RESULT = Object.freeze({
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  NO_CERTIFICATE: 'NO_CERTIFICATE',
});

export const PUBLIC_DISCLOSURE =
  'This verifier reports the integrity and progress of an evidence record: who registered it, where the case stands, and whether its certificate verifies. It discloses no case narrative, no party, victim or witness details, no evidence content, and no forensic or AI opinion.';

export const LIFECYCLE_STATE = Object.freeze({
  DONE: 'done',
  CURRENT: 'current',
  UPCOMING: 'upcoming',
  NOT_APPLICABLE: 'not_applicable',
});

/** A case whose exhibit titles are not shown publicly. */
export const isSensitiveCase = (caseDoc) =>
  Boolean(
    caseDoc &&
      (caseDoc.isVictimProtected ||
        (caseDoc.sensitivityClass && caseDoc.sensitivityClass !== SENSITIVITY_CLASS.ORDINARY))
  );

/** How far along the judicial path a stage is. Further investigation re-opens the police file. */
const STAGE_RANK = Object.freeze({
  [CASE_STAGE.UNDER_INVESTIGATION]: 0,
  [CASE_STAGE.FURTHER_INVESTIGATION]: 0,
  [CASE_STAGE.CHARGESHEET_FILED]: 1,
  [CASE_STAGE.COGNIZANCE_TAKEN]: 2,
  [CASE_STAGE.COMMITTED]: 3,
  [CASE_STAGE.TRIAL]: 4,
  [CASE_STAGE.CLOSED]: 5,
  [CASE_STAGE.DISPOSED]: 5,
});

const forensicExamined = (f) => Boolean(f && (f.opinion || f.status === FORENSIC_STATUS.REPORT_FILED));

/** When the certificate was issued, or null if it has not been (fully) issued. */
const certificateIssuedAt = (cert) => {
  if (!cert) return null;
  if (isSystemCertificate(cert)) {
    return cert.systemSignature?.signature && Number.isInteger(cert.issuanceLedgerSeq) ? cert.issuedAt ?? null : null;
  }
  return cert.issuedAt ?? cert.generatedAt ?? null;
};

// ------------------------------------------------------------------ pieces ----

function evidenceView(evidence, caseDoc) {
  const withheld = isSensitiveCase(caseDoc);
  const device = evidence.sourceDevice ?? null;
  return {
    exhibitCode: evidence.exhibitCode,
    title: withheld ? null : evidence.title ?? null,
    titleWithheld: withheld,
    fileType: evidence.mimeType ?? null,
    sizeBytes: evidence.sizeBytes ?? null,
    sha256: evidence.sha256Server ?? null,
    hashAlgorithm: 'SHA-256',
    registeredAt: evidence.createdAt ?? null,
    capturedAt: evidence.capturedAt ?? null,
    // The device class and its make/model only — never its serial number, IMEI or MAC.
    source: device
      ? { sourceType: device.sourceType ?? null, make: device.make ?? null, model: device.model ?? null }
      : null,
    labelUrl: labelUrlFor(evidence.labelToken),
  };
}

async function uploadedByView(evidence, caseDoc) {
  const user = evidence.uploadedByUserId
    ? await User.findById(evidence.uploadedByUserId).select('name role authorityId scope').lean()
    : null;
  if (!user) return { name: null, role: null, roleLabel: null, authorityId: null, unit: null };

  const scope = user.scope ?? {};
  let unit = null;
  if (scope.stationCode) {
    unit = scope.stationCode === caseDoc?.stationCode ? caseDoc?.stationName ?? scope.stationCode : scope.stationCode;
  } else if (scope.labId) {
    unit = scope.labId === evidence.forensic?.labId ? evidence.forensic?.labName ?? scope.labId : scope.labId;
  } else if (scope.courtId) {
    unit = scope.courtId === caseDoc?.courtId ? caseDoc?.courtName ?? scope.courtId : scope.courtId;
  }

  return {
    name: user.name ?? null,
    role: user.role ?? null,
    roleLabel: ROLE_LABEL[user.role] ?? null,
    authorityId: user.authorityId ?? null,
    unit,
  };
}

const caseView = (caseDoc) =>
  caseDoc
    ? {
        firNumber: caseDoc.firNumber ?? null,
        cnrNumber: caseDoc.cnrNumber ?? null,
        stationCode: caseDoc.stationCode ?? null,
        stationName: caseDoc.stationName ?? null,
        courtName: caseDoc.courtName ?? null,
        stage: caseDoc.stage ?? null,
        stageLabel: STAGE_LABEL[caseDoc.stage] ?? caseDoc.stage ?? null,
      }
    : null;

/**
 * The certificate as the public verifier shows it. Keeps every field the certificate
 * verifier has always returned, plus its verification link and last recorded check.
 */
export function publicCertificateView(cert, { evidence = null, caseDoc = null, pdfIntegrity = null } = {}) {
  if (!cert) return null;
  return {
    certificateId: String(cert._id),
    templateVersion: cert.templateVersion ?? 'v1.0',
    status: cert.status ?? CERTIFICATE_STATUS.ACTIVE,
    statute: 'Bharatiya Sakshya Adhiniyam, 2023 — section 63',
    issuedAt: cert.issuedAt ?? cert.generatedAt ?? null,
    exhibitCode: cert.exhibitCode ?? evidence?.exhibitCode ?? null,
    cnrNumber: caseDoc?.cnrNumber ?? null,
    firNumber: caseDoc?.firNumber ?? null,
    evidenceHash: cert.partA?.hashValue ?? null,
    hashAlgorithm: cert.partA?.hashAlgorithm ?? 'SHA-256',
    pdfSha256: cert.pdfSha256 ?? null,
    pdfIntegrity,
    signedBy: cert.systemSignature?.signature ? SYSTEM_SIGNER_LABEL : null,
    authorityKeyFingerprint: cert.systemSignature?.keyFingerprint ?? null,
    verificationUrl: cert.verificationToken ? verificationUrlFor(cert.verificationToken) : null,
    lastVerification: cert.lastVerification
      ? {
          result: cert.lastVerification.result ?? null,
          at: cert.lastVerification.at ?? null,
          byRole: cert.lastVerification.byRole ?? null,
        }
      : null,
  };
}

const forensicView = (f) => {
  const examined = forensicExamined(f);
  return {
    status: examined ? 'EXAMINED' : 'NOT_EXAMINED',
    examinedAt: examined ? f.reportedAt ?? null : null,
    labName: f?.labName ?? null,
  };
};

/**
 * The milestones, in order. Each is done, current, upcoming or not applicable:
 *
 *   - COMMITTED is not applicable when the offence does not require committal;
 *   - exactly one milestone is current — the first not-done, applicable one AFTER the
 *     last done one (so a forensic examination never reported does not stay "current"
 *     once the case has moved past it; it stays upcoming);
 *   - once the case is closed nothing is current, and what never happened is not
 *     applicable.
 *
 * @returns {{ key: string, label: string, state: string, at: Date|null }[]}
 */
export function lifecycleFor({ evidence, caseDoc, activeCertificate }) {
  const rank = STAGE_RANK[caseDoc?.stage] ?? 0;
  const committal = caseDoc ? requiresCommittal(caseDoc) : false;
  const closed = Boolean(caseDoc && CLOSED_CASE_STAGES.includes(caseDoc.stage));
  const certAt = certificateIssuedAt(activeCertificate);
  const examined = forensicExamined(evidence?.forensic);

  const milestones = [
    { key: 'UPLOADED', label: 'Evidence uploaded', done: true, at: evidence?.createdAt ?? null },
    { key: 'CERTIFICATE_ISSUED', label: 'Section 63 certificate issued', done: Boolean(certAt), at: certAt },
    {
      key: 'FORENSIC_EXAMINATION',
      label: 'Forensic examination',
      done: examined,
      at: examined ? evidence.forensic.reportedAt ?? null : null,
    },
    { key: 'CHARGESHEET_FILED', label: 'Chargesheet filed', done: rank >= 1, at: caseDoc?.chargesheetFiledOn ?? null },
    { key: 'COGNIZANCE_TAKEN', label: 'Cognizance taken', done: rank >= 2, at: caseDoc?.cognizanceTakenOn ?? null },
    {
      key: 'COMMITTED',
      label: 'Committed for trial',
      applicable: committal,
      done: committal && rank >= 3,
      at: caseDoc?.committedOn ?? null,
    },
    { key: 'TRIAL', label: 'Trial', done: rank >= 4, at: caseDoc?.trialStartedOn ?? null },
    { key: 'CLOSED', label: 'Case closed', done: rank >= 5, at: caseDoc?.closedOn ?? null },
  ];

  let lastDone = -1;
  milestones.forEach((m, i) => {
    if (m.applicable !== false && m.done) lastDone = i;
  });

  let currentGiven = false;
  return milestones.map((m, i) => {
    let state;
    if (m.applicable === false) state = LIFECYCLE_STATE.NOT_APPLICABLE;
    else if (m.done) state = LIFECYCLE_STATE.DONE;
    else if (closed) state = LIFECYCLE_STATE.NOT_APPLICABLE;
    else if (!currentGiven && i > lastDone) {
      state = LIFECYCLE_STATE.CURRENT;
      currentGiven = true;
    } else state = LIFECYCLE_STATE.UPCOMING;
    return { key: m.key, label: m.label, state, at: state === LIFECYCLE_STATE.DONE ? m.at : null };
  });
}

// ----------------------------------------------------------------- builder ----

/**
 * Build the public view.
 *
 * @param {object}  args
 * @param {object}  args.evidence            lean Evidence document
 * @param {object|null} args.outcome         `verifyCertificateRecord` result for the
 *                                           certificate being reported, or null if none
 * @param {object}  [args.caseDoc]           lean Case (loaded if omitted)
 * @param {object|null} [args.activeCertificate]  the exhibit's ACTIVE certificate
 *                                           (loaded if omitted); drives the lifecycle
 */
export async function buildPublicEvidenceView({ evidence, outcome = null, caseDoc, activeCertificate }) {
  const theCase =
    caseDoc === undefined ? await Case.findById(evidence.caseId).lean() : caseDoc;
  let active = activeCertificate;
  if (active === undefined) {
    const reported = outcome?.certificate;
    active =
      reported && (reported.status ?? CERTIFICATE_STATUS.ACTIVE) === CERTIFICATE_STATUS.ACTIVE
        ? reported
        : await Certificate.findOne({ evidenceId: evidence._id, status: CERTIFICATE_STATUS.ACTIVE }).lean();
  }

  return {
    result: outcome ? outcome.result : PUBLIC_RESULT.NO_CERTIFICATE,
    checks: outcome ? outcome.checks : [],
    verifiedAt: outcome?.verifiedAt ?? new Date(),
    evidence: evidenceView(evidence, theCase),
    uploadedBy: await uploadedByView(evidence, theCase),
    case: caseView(theCase),
    certificate: outcome?.certificate
      ? publicCertificateView(outcome.certificate, { evidence, caseDoc: theCase, pdfIntegrity: outcome.pdfIntegrity })
      : null,
    forensic: forensicView(evidence.forensic),
    lifecycle: await buildEvidenceLifecycle({
      evidence,
      caseDoc: theCase,
      activeCertificate: active,
      variant: LIFECYCLE_VARIANT.PUBLIC,
    }),
    disclosure: PUBLIC_DISCLOSURE,
  };
}

/**
 * The exhibit lifecycle with a description, actor and proofs on every milestone.
 * `variant` 'public' for the public pages; 'authenticated' for GET /api/evidence/:id/lifecycle.
 */
export async function buildEvidenceLifecycle({
  evidence,
  caseDoc = null,
  activeCertificate = null,
  variant = LIFECYCLE_VARIANT.PUBLIC,
}) {
  return describeEvidenceLifecycle({
    lifecycle: lifecycleFor({ evidence, caseDoc, activeCertificate }),
    evidence,
    caseDoc,
    activeCertificate,
    variant,
  });
}

/**
 * The view for a scanned QR label, or null when no exhibit carries that token (a
 * malformed token is answered the same way). Verifies the exhibit's ACTIVE
 * certificate; records nothing.
 */
export async function publicEvidenceForLabel(labelToken) {
  if (typeof labelToken !== 'string' || !PUBLIC_TOKEN_PATTERN.test(labelToken)) return null;
  const evidence = await Evidence.findOne({ labelToken }).select('-encryption -aiAnalysis').lean();
  if (!evidence) return null;

  const active = await Certificate.findOne({ evidenceId: evidence._id, status: CERTIFICATE_STATUS.ACTIVE }).lean();
  const outcome = active ? await verifyCertificateRecord(active._id) : null;
  return buildPublicEvidenceView({ evidence, outcome, activeCertificate: active ?? null });
}

export default {
  buildPublicEvidenceView,
  buildEvidenceLifecycle,
  publicEvidenceForLabel,
  publicCertificateView,
  lifecycleFor,
  isSensitiveCase,
  PUBLIC_RESULT,
  PUBLIC_TOKEN_PATTERN,
  PUBLIC_DISCLOSURE,
  LIFECYCLE_STATE,
};
