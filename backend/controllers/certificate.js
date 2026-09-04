/**
 * BSA s.63 certificates (spec §8 F9).
 *
 * # The feature is the refusal
 *
 * A s.63 certificate is a sworn statement. If the record cannot support every field
 * of Part A, the correct output is not a certificate with blanks in it — it is a
 * refusal naming exactly what is missing, so the officer can go and record the IMEI
 * rather than sign something they cannot stand behind. `generate` therefore returns
 * 400 with the precise missing list and writes nothing.
 *
 * # Where each field comes from
 *
 * Part A is assembled from the evidence record, the signing user's directory-derived
 * identity, and the LEDGER. `mannerOfProduction` in particular is rendered prose over
 * the append-only timeline — not free text typed by a deponent — so the account of
 * how the record was produced is one a verifier can check against the chain.
 *
 * Part B comes only from `evidence.forensic`, i.e. from a report actually filed by a
 * laboratory notified under s.79A of the IT Act. Lexx never authors an expert
 * opinion; with no report filed, Part B stays blank and `partBComplete` is false.
 *
 * # Signatures
 *
 * ECDSA P-256 (IEEE P1363) over the canonical hash of the certificate body, verified
 * against the key registered at activation — the same scheme and the same verifier
 * as evidence ingest. Signatures cover the body, not the PDF, so re-rendering the
 * document after a second signature cannot invalidate the first.
 */
import { z } from 'zod';

import { Certificate } from '../models/Certificate.js';
import { Evidence } from '../models/Evidence.js';
import { Case } from '../models/Case.js';
import { User } from '../models/User.js';
import {
  ACTION,
  DECISION,
  FORENSIC_STATUS,
  LEDGER_EVENT,
  RESOURCE_TYPE,
  ROLE,
  SOURCE_TYPE,
  SUBJECT_TYPE,
} from '../models/enums.js';
import { appendEvent, getSubjectTimeline, getCaseTimeline } from '../services/ledger.js';
import { canonicalHash } from '../services/canonical.js';
import { randomBase64Url, sha256Hex, verifyEcdsaP256 } from '../config/crypto.js';
import {
  renderCertificatePdf,
  storeCertificatePdf,
  readCertificatePdf,
  verificationUrlFor,
} from '../services/certificatePdf.js';
import { writeAudit } from '../middleware/audit.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('certificate');

// ---------------------------------------------------------------- validation ----

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw BadRequest('VALIDATION_FAILED', 'Request failed validation', {
      fields: r.error.issues.map((i) => i.path.join('.') || '(root)'),
    });
  }
  return r.data;
};

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Malformed id');

const generateSchema = z.object({ evidenceId: objectId });

/** ECDSA P-256 in IEEE P1363 encoding is exactly 64 bytes: r(32) || s(32). */
const signSchema = z.object({
  signature: z.string().regex(/^[0-9a-f]{128}$/i, 'Signature must be 64 bytes of hex'),
});

/** `randomBase64Url(32)` — 32 bytes, 43 base64url characters. */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Malformed verification token');

/**
 * Validate the generate body BEFORE the resolver is asked to load `evidenceId`.
 * Without this a malformed id reaches `Evidence.findById` as a cast error, which is
 * a worse answer than a plain validation failure.
 */
export function validateGenerateBody(req, res, next) {
  try {
    parse(generateSchema, req.body);
    return next();
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------- Part A ----

/**
 * How the deponent describes themselves on the certificate. A display mapping, not
 * an access decision — authorization has already happened in the resolver.
 */
const DESIGNATION = Object.freeze({
  [ROLE.IO]: 'Investigating Officer',
  [ROLE.SHO]: 'Station House Officer',
  [ROLE.MALKHANA_CUSTODIAN]: 'Malkhana Custodian',
  [ROLE.DISTRICT_SP]: 'Superintendent of Police',
  [ROLE.JUDGE]: 'Presiding Judge',
  [ROLE.REGISTRAR]: 'Registrar',
  [ROLE.EVIDENCE_CUSTODIAN]: 'Evidence Custodian',
  [ROLE.FSL_EXAMINER]: 'Forensic Examiner',
  [ROLE.PUBLIC_PROSECUTOR]: 'Public Prosecutor',
  [ROLE.DEFENCE_COUNSEL]: 'Advocate',
  [ROLE.VICTIM_COUNSEL]: 'Advocate',
  [ROLE.LEGAL_AID_COUNSEL]: 'Advocate',
});

function deponentDesignation(user) {
  const base = DESIGNATION[user.role] ?? null;
  if (!base) return null;
  const place = user.scope?.stationCode ?? user.scope?.courtId ?? user.scope?.labId ?? null;
  return place ? `${base}, ${place}` : base;
}

/**
 * Source types that describe a physical article. For these the Schedule's make,
 * model and colour columns have to be answerable; for CLOUD and OTHER there is no
 * article to describe and requiring a colour would be nonsense that officers would
 * learn to fill with junk.
 */
const PHYSICAL_SOURCE_TYPES = new Set([
  SOURCE_TYPE.MOBILE,
  SOURCE_TYPE.COMPUTER,
  SOURCE_TYPE.DVR,
  SOURCE_TYPE.CD_DVD,
  SOURCE_TYPE.FLASH_DRIVE,
  SOURCE_TYPE.SERVER,
]);

const ALWAYS_REQUIRED = Object.freeze([
  'deponentName',
  'deponentDesignation',
  'deponentAuthorityId',
  'sourceType',
  'hashValue',
  'hashAlgorithm',
  'mannerOfProduction',
  'conditionsStatement',
]);

/**
 * The missing-field list. Precision matters: this is what the officer is handed, and
 * a vague "certificate incomplete" is the difference between a fixable problem and a
 * dead end.
 */
export function missingPartAFields(partA) {
  const missing = [];
  const blank = (k) => partA[k] === null || partA[k] === undefined || partA[k] === '';

  for (const key of ALWAYS_REQUIRED) if (blank(key)) missing.push(`partA.${key}`);

  if (PHYSICAL_SOURCE_TYPES.has(partA.sourceType)) {
    for (const key of ['make', 'model', 'colour']) if (blank(key)) missing.push(`partA.${key}`);
  }

  // The article must be identifiable by SOMETHING. Either column satisfies it.
  if (blank('serialNumber') && blank('imeiOrUid')) {
    missing.push('partA.serialNumber OR partA.imeiOrUid');
  }

  return missing;
}

// --------------------------------------------- manner of production (ledger) ----

const actorLabel = (entry, actors) => {
  const user = actors.get(String(entry.actorUserId));
  if (!user) return 'an unidentified actor';
  return `${user.name} (${entry.actorRole ?? user.role}, ${user.authorityId})`;
};

const at = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** One ledger entry → one sentence. Unknown event types are skipped, not guessed. */
function sentenceFor(entry, actors) {
  const p = entry.payload ?? {};
  const who = actorLabel(entry, actors);
  const when = at(entry.occurredAt);

  switch (entry.eventType) {
    case LEDGER_EVENT.EVIDENCE_UPLOADED:
      return `On ${when} the electronic record was produced to Lexx by ${who}. The server recomputed its ${'SHA-256'} digest from the bytes received as ${p.sha256}, which matched the digest computed on the producing device before transmission, and the producer's ECDSA P-256 signature over that digest verified against the key registered to them. The event was written to the append-only ledger at sequence ${entry.seq} (entry hash ${entry.entryHash}).`;
    case LEDGER_EVENT.REFERRED_TO_FSL:
      return `On ${when} the exhibit was referred by ${who} to ${p.labName ?? p.labId ?? 'a forensic science laboratory'} for examination (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.FSL_EXAMINATION_STARTED:
      return `On ${when} examination of the exhibit was commenced by ${who} (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.FSL_REPORT_FILED:
      return `On ${when} a report was filed by ${who}${p.labName ? ` of ${p.labName}` : ''} (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.CUSTODY_TRANSFERRED:
      return `On ${when} custody of the related physical article was transferred by ${who}${p.toLocation ? ` to ${p.toLocation}` : ''}, the seal being recorded as ${p.sealIntact === false ? 'BROKEN' : 'intact'} (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.CUSTODY_ITEM_CREATED:
      return `On ${when} the related physical article was booked into custody by ${who}${p.sealNumber ? ` under seal ${p.sealNumber}` : ''} (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.DISCLOSURE_SERVED:
      return `On ${when} the disclosure pack containing this exhibit was served by ${who} (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.EXHIBIT_MARKED:
      return `On ${when} the exhibit was marked in court (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.INTEGRITY_EXCEPTION:
      return `On ${when} an integrity exception was recorded against this exhibit: ${p.reason ?? 'unspecified'} (ledger sequence ${entry.seq}). This entry is disclosed here because the ledger is append-only and the deponent's account must match it.`;
    default:
      return null;
  }
}

/**
 * Render the manner of production as prose over the ledger timeline.
 *
 * Two timelines are merged: entries whose SUBJECT is this exhibit, and case-level
 * entries that name its exhibit code (a referral or a disclosure event is recorded
 * against its own subject, but it is still part of how this record reached the
 * court). Entries are ordered by ledger sequence, which is the only ordering that
 * cannot be rearranged after the fact.
 */
export async function renderMannerOfProduction(evidence) {
  const [subjectEntries, caseEntries] = await Promise.all([
    getSubjectTimeline(evidence._id),
    getCaseTimeline(evidence.caseId),
  ]);

  const bySeq = new Map();
  for (const e of subjectEntries) bySeq.set(e.seq, e);
  for (const e of caseEntries) {
    const p = e.payload ?? {};
    const mentions =
      p.exhibitCode === evidence.exhibitCode ||
      String(p.evidenceId ?? '') === String(evidence._id) ||
      (Array.isArray(p.exhibitCodes) && p.exhibitCodes.includes(evidence.exhibitCode));
    if (mentions) bySeq.set(e.seq, e);
  }

  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  if (!entries.length) return null; // no chain, no account — Part A stays incomplete

  const actorIds = [...new Set(entries.map((e) => String(e.actorUserId)).filter((x) => x !== 'null'))];
  const actorDocs = await User.find({ _id: { $in: actorIds } })
    .select('_id name authorityId role')
    .lean();
  const actors = new Map(actorDocs.map((u) => [String(u._id), u]));

  const sentences = entries.map((e) => sentenceFor(e, actors)).filter(Boolean);
  if (!sentences.length) return null;

  return [
    `Exhibit ${evidence.exhibitCode} was produced as follows.`,
    ...sentences,
    'This account is rendered mechanically from the Lexx append-only ledger and is not free text supplied by the deponent. Each sequence number and entry hash cited above can be re-derived independently from the chain.',
  ].join(' ');
}

/**
 * The s.63(4)(c) conditions statement, rendered from what the record actually says.
 *
 * The deponent signs this as their own statement, so it asserts only things the
 * system can stand behind: regular use, the absence of any recorded integrity
 * exception, and the digest's stability since production.
 */
function renderConditionsStatement({ evidence, caseDoc, device, integrityExceptions }) {
  const article = [
    device.make,
    device.model,
    device.colour ? `(${device.colour})` : null,
    device.serialNumber ? `serial ${device.serialNumber}` : null,
    device.imeiOrUid ? `IMEI/UID ${device.imeiOrUid}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const where = caseDoc?.stationCode ? ` of ${caseDoc.stationCode}` : '';

  const exceptions = integrityExceptions
    ? 'An integrity exception has been recorded against this exhibit in the ledger and is set out in the manner of production above; this statement is qualified accordingly.'
    : 'No integrity exception has been recorded against this exhibit in the ledger.';

  return (
    `The ${device.sourceType.toLowerCase().replace(/_/g, ' ')} from which this electronic record was produced (${article || 'as described in Part A'}) ` +
    `was, throughout the material part of the period during which the record was produced, in regular use in the ordinary course of the activities${where}, ` +
    'and was operating properly throughout that period. The information contained in the electronic record was of a kind regularly fed into that device in the ordinary course of those activities. ' +
    `The record was copied from that device and its SHA-256 digest (${evidence.sha256Server}) was computed at the point of production; the copy held in the Lexx register hashes to that same value and any divergence would be reported by the register's verification function. ` +
    exceptions
  );
}

// ---------------------------------------------------------------- body hash ----

const pickPartA = (a = {}) => ({
  deponentName: a.deponentName ?? null,
  deponentDesignation: a.deponentDesignation ?? null,
  deponentAuthorityId: a.deponentAuthorityId ?? null,
  sourceType: a.sourceType ?? null,
  make: a.make ?? null,
  model: a.model ?? null,
  colour: a.colour ?? null,
  serialNumber: a.serialNumber ?? null,
  imeiOrUid: a.imeiOrUid ?? null,
  hashValue: a.hashValue ?? null,
  hashAlgorithm: a.hashAlgorithm ?? null,
  mannerOfProduction: a.mannerOfProduction ?? null,
  conditionsStatement: a.conditionsStatement ?? null,
});

const pickPartB = (b = {}) => ({
  expertName: b.expertName ?? null,
  labName: b.labName ?? null,
  section79ARef: b.section79ARef ?? null,
  examinationSummary: b.examinationSummary ?? null,
  expertOpinion: b.expertOpinion ?? null,
  reportSha256: b.reportSha256 ?? null,
  reportedAt: b.reportedAt ? new Date(b.reportedAt).toISOString() : null,
});

/**
 * What a signature covers. Explicit field list rather than the whole document, so
 * that adding an operational field (a pdf key, a timestamp) later cannot silently
 * invalidate signatures already collected.
 */
export function certificateBodyHash(cert) {
  return canonicalHash({
    certificateId: String(cert._id),
    evidenceId: String(cert.evidenceId),
    caseId: String(cert.caseId),
    templateVersion: cert.templateVersion ?? 'v1.0',
    partA: pickPartA(cert.partA),
    partB: pickPartB(cert.partB),
  });
}

const certificateView = (cert) => ({
  certificateId: String(cert._id),
  evidenceId: String(cert.evidenceId),
  caseId: String(cert.caseId),
  templateVersion: cert.templateVersion,
  generatedAt: cert.generatedAt,
  partA: pickPartA(cert.partA),
  partB: pickPartB(cert.partB),
  partAComplete: cert.partAComplete,
  partBComplete: cert.partBComplete,
  pdfSha256: cert.pdfSha256 ?? null,
  signatures: (cert.signatures ?? []).map((s) => ({
    role: s.role,
    signerName: s.signerName,
    pubKeyFingerprint: s.pubKeyFingerprint,
    signedPayloadHash: s.signedPayloadHash,
    signedAt: s.signedAt,
  })),
  verificationToken: cert.verificationToken,
  verificationUrl: verificationUrlFor(cert.verificationToken),
  bodyHash: certificateBodyHash(cert),
});

/** Render, store, and record the PDF hash. Called after every change to the body. */
async function refreshPdf(certDoc, { caseDoc, evidence }) {
  const pdf = await renderCertificatePdf({ certificate: certDoc, caseDoc, evidence });
  const stored = await storeCertificatePdf(certDoc, pdf);
  // `set()` rather than direct assignment: the document is a caller-owned parameter,
  // and mutating one across an await is exactly the pattern that produces torn state.
  certDoc.set({ pdfKey: stored.pdfKey, pdfSha256: stored.pdfSha256 });
  await certDoc.save();
  return { pdf, ...stored };
}

// ============================================================== 1. GENERATE ====

/**
 * POST /api/certificates/generate  { evidenceId }   (IO, REGISTRAR)
 *
 * A certificate is a point-in-time statement about a record. Generating a second one
 * does not edit the first — signed documents are never edited — it issues a new one,
 * which is also how Part B appears once a laboratory has filed its report.
 */
export async function generate(req, res, next) {
  try {
    const evidence = req.resource;
    const caseDoc = req.caseDoc;

    // The deponent is the session, resolved from the database this request. Nothing
    // about who is deposing comes from the body.
    const signer = await User.findById(req.user.userId).select('name authorityId role scope').lean();
    if (!signer) throw NotFound('SESSION_USER_MISSING', 'Session is not valid');

    const device = evidence.sourceDevice ?? {};
    const mannerOfProduction = await renderMannerOfProduction(evidence);

    const integrityExceptions = await hasIntegrityException(evidence);

    const partA = {
      deponentName: signer.name ?? null,
      deponentDesignation: deponentDesignation(req.user),
      deponentAuthorityId: signer.authorityId ?? null,
      sourceType: device.sourceType ?? null,
      make: device.make ?? null,
      model: device.model ?? null,
      colour: device.colour ?? null,
      serialNumber: device.serialNumber ?? null,
      imeiOrUid: device.imeiOrUid ?? null,
      hashValue: evidence.sha256Server ?? null,
      hashAlgorithm: 'SHA-256',
      mannerOfProduction,
      conditionsStatement: device.sourceType
        ? renderConditionsStatement({ evidence, caseDoc, device, integrityExceptions })
        : null,
    };

    const missing = missingPartAFields(partA);
    if (missing.length) {
      // Refusing is the feature. Nothing is written, and the refusal is audited so
      // the gap in the record is itself part of the record.
      await writeAudit(req, {
        action: ACTION.WRITE,
        resourceType: RESOURCE_TYPE.CERTIFICATE,
        resourceId: evidence._id,
        resourceLabel: evidence.exhibitCode,
        caseId: evidence.caseId,
        decision: DECISION.DENY,
        reason: 'CERTIFICATE_PART_A_INCOMPLETE',
      });
      throw BadRequest(
        'CERTIFICATE_PART_A_INCOMPLETE',
        'Part A of the section 63 certificate cannot be completed from the record. The certificate has NOT been generated.',
        {
          missing,
          exhibitCode: evidence.exhibitCode,
          remedy:
            'Record the missing particulars against the exhibit and generate the certificate again.',
        }
      );
    }

    const forensic = evidence.forensic ?? {};
    const reportFiled = forensic.status === FORENSIC_STATUS.REPORT_FILED;

    // Part B comes ONLY from a filed report. With none, it stays blank — Lexx does
    // not author, infer or summarise an expert opinion under any circumstances.
    const partB = reportFiled
      ? {
          expertName: forensic.examinerName ?? null,
          labName: forensic.labName ?? null,
          section79ARef: forensic.section79ARef ?? null,
          examinationSummary: forensic.examinationSummary ?? null,
          expertOpinion: forensic.opinion ?? null,
          reportSha256: forensic.reportSha256 ?? null,
          reportedAt: forensic.reportedAt ?? null,
        }
      : {};

    const partBComplete = Boolean(
      reportFiled && partB.expertName && partB.labName && partB.expertOpinion
    );

    const certificate = await Certificate.create({
      evidenceId: evidence._id,
      caseId: evidence.caseId,
      partA,
      partB,
      templateVersion: 'v1.0',
      generatedAt: new Date(),
      generatedByUserId: req.user.userId,
      // 32 bytes from the CSPRNG. This is the ONLY credential on a public endpoint,
      // so it must be unguessable rather than merely unique.
      verificationToken: randomBase64Url(32),
      partAComplete: true,
      partBComplete,
    });

    await refreshPdf(certificate, { caseDoc, evidence });

    await appendEvent({
      eventType: LEDGER_EVENT.CERTIFICATE_GENERATED,
      caseId: evidence.caseId,
      subjectId: certificate._id,
      subjectType: SUBJECT_TYPE.CERTIFICATE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        certificateId: String(certificate._id),
        evidenceId: String(evidence._id),
        exhibitCode: evidence.exhibitCode,
        templateVersion: certificate.templateVersion,
        hashValue: partA.hashValue,
        hashAlgorithm: partA.hashAlgorithm,
        partAComplete: true,
        partBComplete,
        pdfSha256: certificate.pdfSha256,
        bodyHash: certificateBodyHash(certificate),
        deponentAuthorityId: partA.deponentAuthorityId,
      },
    });

    return res.status(201).json({
      certificate: certificateView(certificate),
      // Said out loud, because an unsigned certificate with an empty Part B is a
      // legitimate and common state that must not be mistaken for a finished one.
      partBNote: partBComplete
        ? null
        : 'Part B is blank: no section 79A laboratory report has been filed for this exhibit.',
    });
  } catch (err) {
    return next(err);
  }
}

/** Has any integrity exception been recorded against this exhibit? */
async function hasIntegrityException(evidence) {
  const entries = await getSubjectTimeline(evidence._id);
  return entries.some((e) => e.eventType === LEDGER_EVENT.INTEGRITY_EXCEPTION);
}

// ================================================================ 2. READ ====

/** GET /api/certificates/:id — metadata and the body hash a signer needs. */
export async function getCertificate(req, res) {
  return res.json({ certificate: certificateView(req.resource) });
}

// =============================================================== 3. SIGNING ====

/**
 * Shared signing path for both parts.
 *
 * Three things are checked and none of them is negotiable:
 *   1. the certificate is not already signed in this role;
 *   2. the caller IS the person the certificate names in that role — you cannot sign
 *      a statement made in someone else's name;
 *   3. the signature verifies, with the caller's registered key, over the canonical
 *      body hash the server computed. A signature over anything else is rejected.
 */
async function applySignature(req, { role, deponentCheck }) {
  const body = parse(signSchema, req.body);

  const certificate = await Certificate.findById(req.resource._id);
  if (!certificate) throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');

  if (certificate.hasSignature(role)) {
    throw Conflict(
      'ALREADY_SIGNED',
      role === 'EXPERT'
        ? 'Part B of this certificate has already been signed'
        : 'Part A of this certificate has already been signed'
    );
  }

  await deponentCheck(certificate);

  const signer = await User.findById(req.user.userId).lean();
  if (!signer?.publicKeyJwk) {
    throw BadRequest('NO_REGISTERED_KEY', 'No signing key is registered for this account');
  }

  const signedPayloadHash = certificateBodyHash(certificate);
  if (!verifyEcdsaP256(signer.publicKeyJwk, body.signature, signedPayloadHash)) {
    throw BadRequest(
      'SIGNATURE_INVALID',
      'The signature does not verify against your registered key over this certificate. It has not been recorded.',
      { signedPayloadHash }
    );
  }

  const signedAt = new Date();
  certificate.signatures.push({
    role,
    userId: req.user.userId,
    signerName: signer.name,
    pubKeyFingerprint: signer.publicKeyFingerprint,
    signature: body.signature.toLowerCase(),
    signedPayloadHash,
    signedAt,
  });
  await certificate.save();

  const [caseDoc, evidence] = await Promise.all([
    Case.findById(certificate.caseId).lean(),
    Evidence.findById(certificate.evidenceId).lean(),
  ]);
  // The document a court is handed must show the signature it now carries.
  await refreshPdf(certificate, { caseDoc, evidence });

  await appendEvent({
    eventType: LEDGER_EVENT.CERTIFICATE_SIGNED,
    caseId: certificate.caseId,
    subjectId: certificate._id,
    subjectType: SUBJECT_TYPE.CERTIFICATE,
    actorUserId: req.user.userId,
    actorRole: req.user.role,
    actorSignature: body.signature.toLowerCase(),
    actorPubKeyFingerprint: signer.publicKeyFingerprint,
    payload: {
      certificateId: String(certificate._id),
      exhibitCode: evidence?.exhibitCode ?? null,
      part: role === 'EXPERT' ? 'B' : 'A',
      signerAuthorityId: signer.authorityId,
      signerFingerprint: signer.publicKeyFingerprint,
      signedPayloadHash,
      pdfSha256: certificate.pdfSha256,
    },
  });

  return certificate;
}

/** POST /api/certificates/:id/sign-part-a   (the deponent named in Part A) */
export async function signPartA(req, res, next) {
  try {
    const certificate = await applySignature(req, {
      role: 'PARTY',
      deponentCheck: async (cert) => {
        if (cert.partA?.deponentAuthorityId !== req.user.authorityId) {
          throw Forbidden(
            'NOT_THE_DEPONENT',
            'Part A names a different deponent. A certificate can only be signed by the person whose statement it is.'
          );
        }
      },
    });
    return res.json({ certificate: certificateView(certificate) });
  } catch (err) {
    return next(err);
  }
}

/** POST /api/certificates/:id/sign-part-b   (the examiner who filed the report) */
export async function signPartB(req, res, next) {
  try {
    const certificate = await applySignature(req, {
      role: 'EXPERT',
      deponentCheck: async (cert) => {
        if (!cert.partBComplete) {
          throw Conflict(
            'PART_B_NOT_FILED',
            'Part B is blank. There is nothing to sign until a section 79A laboratory has filed its report.'
          );
        }
        const evidence = await Evidence.findById(cert.evidenceId).select('forensic').lean();
        const examinerUserId = evidence?.forensic?.examinerUserId ?? null;
        if (!examinerUserId || String(examinerUserId) !== String(req.user.userId)) {
          throw Forbidden(
            'NOT_THE_REPORTING_EXAMINER',
            'Part B may only be signed by the examiner who filed the report it reproduces.'
          );
        }
      },
    });
    return res.json({ certificate: certificateView(certificate) });
  } catch (err) {
    return next(err);
  }
}

// ==================================================================== 4. PDF ====

/**
 * GET /api/certificates/:id/pdf   (scoped by the resolver)
 *
 * Rendered fresh and re-stored if the bytes have moved on (a signature was added
 * since the last render). The stored `pdfSha256` therefore always describes the
 * document a caller is actually handed, which is what the public verifier checks.
 */
export async function getPdf(req, res, next) {
  try {
    const certificate = await Certificate.findById(req.resource._id);
    if (!certificate) throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');

    const [caseDoc, evidence] = await Promise.all([
      Case.findById(certificate.caseId).lean(),
      Evidence.findById(certificate.evidenceId).lean(),
    ]);

    const pdf = await renderCertificatePdf({ certificate, caseDoc, evidence });
    const digest = sha256Hex(pdf);
    if (digest !== certificate.pdfSha256) {
      const stored = await storeCertificatePdf(certificate, pdf);
      certificate.pdfKey = stored.pdfKey;
      certificate.pdfSha256 = stored.pdfSha256;
      await certificate.save();
    }

    await writeAudit(req, {
      action: ACTION.DOWNLOAD,
      resourceType: RESOURCE_TYPE.CERTIFICATE,
      resourceId: certificate._id,
      resourceLabel: evidence?.exhibitCode ?? null,
      caseId: certificate.caseId,
      decision: DECISION.ALLOW,
      reason: 'CERTIFICATE_PDF_DOWNLOAD',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="s63-certificate-${evidence?.exhibitCode ?? certificate._id}.pdf"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Lexx-Pdf-Sha256', certificate.pdfSha256);
    return res.send(pdf);
  } catch (err) {
    return next(err);
  }
}

// ======================================================== 5. PUBLIC VERIFIER ====

/**
 * GET /public/verify/:token   — PUBLIC, NO AUTH. Mount OUTSIDE /api.
 *
 * # The confidentiality constraint, stated so it cannot be eroded by accident
 *
 * A token holder is anyone who can photograph a QR code. They are entitled to know
 * that the certificate in their hand is genuine and unaltered. They are entitled to
 * NOTHING ELSE.
 *
 * This response therefore carries, and may only ever carry:
 *   - that the certificate exists in the register;
 *   - whether the PDF hash still matches;
 *   - which signatures are present (role and time only);
 *   - the evidence hash the certificate attests to;
 *   - the case and exhibit reference — public court identifiers.
 *
 * It must NEVER carry: any person's name (deponent, expert, officer, advocate,
 * accused, victim), any designation or authority id, the laboratory, the expert
 * opinion, the examination summary, the manner-of-production narrative, the
 * conditions statement, the device make/model/colour/serial/IMEI, the exhibit title
 * or description, or any part of the case narrative. Validity, not contents.
 *
 * Every field below is listed explicitly for that reason. Do not spread a document
 * into this response.
 */
export async function publicVerify(req, res, next) {
  try {
    const token = req.params.token;
    const parsed = tokenSchema.safeParse(token);
    if (!parsed.success) {
      // A malformed token is answered exactly like an unknown one, so the shape of
      // the token space cannot be mapped from the outside.
      return res.status(404).json({ valid: false, reason: 'CERTIFICATE_NOT_FOUND' });
    }

    const certificate = await Certificate.findOne({ verificationToken: parsed.data }).lean();
    if (!certificate) {
      return res.status(404).json({ valid: false, reason: 'CERTIFICATE_NOT_FOUND' });
    }

    // ---- does the stored document still hash to what was published? ----
    let pdfIntegrity = 'PDF_MISSING';
    try {
      const stored = await readCertificatePdf(certificate);
      if (stored) {
        pdfIntegrity =
          sha256Hex(stored) === certificate.pdfSha256 ? 'PDF_INTACT' : 'PDF_MODIFIED';
      }
    } catch (err) {
      // A GCM tag failure means the stored object was altered. That is a finding.
      log.warn({ err: err.message }, 'certificate pdf could not be read for verification');
      pdfIntegrity = 'PDF_MODIFIED';
    }

    const [evidence, caseDoc] = await Promise.all([
      Evidence.findById(certificate.evidenceId).select('exhibitCode').lean(),
      Case.findById(certificate.caseId).select('cnrNumber firNumber').lean(),
    ]);

    const signatures = certificate.signatures ?? [];
    const has = (role) => signatures.find((s) => s.role === role) ?? null;
    const partySig = has('PARTY');
    const expertSig = has('EXPERT');

    return res.json({
      valid: true,
      issuer: 'LEXX',
      certificate: {
        certificateId: String(certificate._id),
        templateVersion: certificate.templateVersion,
        statute: 'Bharatiya Sakshya Adhiniyam, 2023 — section 63',
        generatedAt: certificate.generatedAt,
        // Public court identifiers for the case, and the exhibit's register code.
        exhibitCode: evidence?.exhibitCode ?? null,
        cnrNumber: caseDoc?.cnrNumber ?? null,
        firNumber: caseDoc?.firNumber ?? null,
        // The digest the certificate attests to — a holder of the exhibit can
        // recompute it and compare. It reveals nothing about the content.
        evidenceHash: certificate.partA?.hashValue ?? null,
        hashAlgorithm: certificate.partA?.hashAlgorithm ?? 'SHA-256',
        pdfSha256: certificate.pdfSha256 ?? null,
        pdfIntegrity,
        partAComplete: Boolean(certificate.partAComplete),
        partBComplete: Boolean(certificate.partBComplete),
        signatures: [
          { part: 'A', role: 'PARTY', present: Boolean(partySig), signedAt: partySig?.signedAt ?? null },
          { part: 'B', role: 'EXPERT', present: Boolean(expertSig), signedAt: expertSig?.signedAt ?? null },
        ],
      },
      disclosure:
        'This verifier reports the validity of a certificate. It discloses no case narrative, no party or witness details, and no evidence content.',
      verifiedAt: new Date(),
    });
  } catch (err) {
    return next(err);
  }
}

export default {
  validateGenerateBody,
  generate,
  getCertificate,
  signPartA,
  signPartB,
  getPdf,
  publicVerify,
  certificateBodyHash,
  missingPartAFields,
  renderMannerOfProduction,
};
