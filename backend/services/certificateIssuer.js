/**
 * Automatic issue of BSA s.63 certificates (template v3.0).
 *
 * Police upload evidence; the system does the rest. `ensureSystemCertificate` is the
 * single, idempotent entry point — called after an upload, lazily when a certificate
 * is read and found missing, and by the boot migration for existing exhibits:
 *
 *   1. if the exhibit already has an ACTIVE, fully issued v3.0 certificate → return it;
 *   2. a legacy (v1.0 / v2.0) ACTIVE certificate is SUPERSEDED, never deleted;
 *   3. the certificate is inserted — the partial unique index makes a concurrent second
 *      insert fail, and the loser simply adopts the winner's certificate;
 *   4. the PDF is rendered and stored encrypted, the system key signs
 *      (body hash, PDF SHA-256, authority key), and CERTIFICATE_GENERATED is appended
 *      to the ledger. Only then is the certificate "issued".
 *
 * Nothing here reads the forensic verdict. Part B is the ingest hash attestation.
 */
import { Certificate } from '../models/Certificate.js';
import { Evidence } from '../models/Evidence.js';
import { Case } from '../models/Case.js';
import { User } from '../models/User.js';
import { Ledger } from '../models/Ledger.js';
import {
  CERTIFICATE_STATUS,
  LEDGER_EVENT,
  ROLE,
  SOURCE_TYPE,
  SUBJECT_TYPE,
} from '../models/enums.js';
import { appendEvent, getSubjectTimeline, getCaseTimeline } from './ledger.js';
import { canonicalHash } from './canonical.js';
import { randomBase64Url } from '../config/crypto.js';
import { renderCertificatePdf, storeCertificatePdf } from './certificatePdf.js';
import {
  authorityPublicKey,
  systemSign,
  SYSTEM_SIGNER_LABEL,
  SYSTEM_SIGNATURE_ALGORITHM,
} from './systemSigner.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('certificate-issuer');

export const SYSTEM_TEMPLATE_VERSION = 'v3.0';
export const REPLACED_BY_SYSTEM_CERTIFICATE = 'REPLACED_BY_SYSTEM_CERTIFICATE';
/** Ledger actor role for events the system writes on its own account. */
export const SYSTEM_ACTOR_ROLE = 'SYSTEM';

const ISSUANCE_LEASE_MS = 60_000;

export const isSystemCertificate = (c) => c?.templateVersion === SYSTEM_TEMPLATE_VERSION;

/** Signed AND recorded in the ledger. Anything less is still being issued. */
export const isIssued = (c) =>
  Boolean(isSystemCertificate(c) && c.systemSignature?.signature && Number.isInteger(c.issuanceLedgerSeq));

// ------------------------------------------------------------ who it is for ----

const DESIGNATION = Object.freeze({
  [ROLE.IO]: 'Investigating Officer',
  [ROLE.SHO]: 'Station House Officer',
  [ROLE.DISTRICT_SP]: 'Superintendent of Police',
  [ROLE.COURT]: 'Court',
  [ROLE.FSL_EXAMINER]: 'Forensic Examiner',
  [ROLE.PUBLIC_PROSECUTOR]: 'Public Prosecutor',
  [ROLE.DEFENCE_COUNSEL]: 'Advocate',
  [ROLE.VICTIM_COUNSEL]: 'Advocate',
  [ROLE.LEGAL_AID_COUNSEL]: 'Advocate',
});

export function designationFor(user) {
  const base = DESIGNATION[user?.role] ?? null;
  if (!base) return null;
  const place = user.scope?.stationCode ?? user.scope?.courtId ?? user.scope?.labId ?? null;
  return place ? `${base}, ${place}` : base;
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
      return `On ${when} the electronic record was produced to Lexx by ${who}. The server recomputed its SHA-256 digest from the bytes received as ${p.sha256}, which matched the digest computed on the producing device before transmission, and the producer's ECDSA P-256 signature over that digest verified against the key registered to them. The event was written to the append-only ledger at sequence ${entry.seq} (entry hash ${entry.entryHash}).`;
    case LEDGER_EVENT.REFERRED_TO_FSL:
      return `On ${when} the exhibit was referred by ${who} to ${p.labName ?? p.labId ?? 'a forensic science laboratory'} for examination (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.CUSTODY_TRANSFERRED:
      return `On ${when} custody of the related physical article was transferred by ${who}${p.toLocation ? ` to ${p.toLocation}` : ''}, the seal being recorded as ${p.sealIntact === false ? 'BROKEN' : 'intact'} (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.CUSTODY_ITEM_CREATED:
      return `On ${when} the related physical article was booked into custody by ${who}${p.sealNumber ? ` under seal ${p.sealNumber}` : ''} (ledger sequence ${entry.seq}).`;
    case LEDGER_EVENT.INTEGRITY_EXCEPTION:
      return `On ${when} an integrity exception was recorded against this exhibit: ${p.reason ?? 'unspecified'} (ledger sequence ${entry.seq}). It is disclosed here because the ledger is append-only and this account must match it.`;
    default:
      return null;
  }
}

/** The manner of production, rendered as prose over the ledger timeline. */
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
      (evidence.exhibitCode && p.exhibitCode === evidence.exhibitCode) ||
      String(p.evidenceId ?? '') === String(evidence._id);
    if (mentions) bySeq.set(e.seq, e);
  }

  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const actorIds = [...new Set(entries.map((e) => String(e.actorUserId)).filter((x) => x !== 'null'))];
  const actorDocs = actorIds.length
    ? await User.find({ _id: { $in: actorIds } }).select('_id name authorityId role').lean()
    : [];
  const actors = new Map(actorDocs.map((u) => [String(u._id), u]));

  const sentences = entries.map((e) => sentenceFor(e, actors)).filter(Boolean);
  if (!sentences.length) {
    return `Exhibit ${evidence.exhibitCode ?? String(evidence._id)} was produced to Lexx as an electronic record whose SHA-256 digest was recorded as ${evidence.sha256Server}. No ledger account of its production is available.`;
  }
  return [
    `Exhibit ${evidence.exhibitCode} was produced as follows.`,
    ...sentences,
    'This account is rendered mechanically from the Lexx append-only ledger and is not free text supplied by any person. Each sequence number and entry hash cited above can be re-derived independently from the chain.',
  ].join(' ');
}

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
  const sourceType = device.sourceType ?? SOURCE_TYPE.OTHER;
  const kind =
    sourceType === SOURCE_TYPE.OTHER ? 'device or system' : sourceType.toLowerCase().replace(/_/g, ' ');
  const where = caseDoc?.stationCode ? ` of ${caseDoc.stationCode}` : '';
  const exceptions = integrityExceptions
    ? 'An integrity exception has been recorded against this exhibit in the ledger and is set out in the manner of production above; this statement is qualified accordingly.'
    : 'No integrity exception has been recorded against this exhibit in the ledger.';

  return (
    `The ${kind} from which this electronic record was produced (${article || 'its make, model and identifiers were not recorded at upload'}) ` +
    `is stated, on behalf of the producing officer, to have been in regular use in the ordinary course of the activities${where} and operating properly throughout the material period, ` +
    'the information in the record being of a kind regularly fed into it in the ordinary course of those activities. ' +
    `The record's SHA-256 digest (${evidence.sha256Server}) was computed on the producing officer's device before transmission and recomputed by Lexx from the bytes received; the copy held in the Lexx register must hash to that same value, which the certificate verification checks. ` +
    exceptions
  );
}

async function buildPartA({ evidence, uploader, caseDoc }) {
  const device = evidence.sourceDevice ?? {};
  const timeline = await getSubjectTimeline(evidence._id);
  const integrityExceptions = timeline.some((e) => e.eventType === LEDGER_EVENT.INTEGRITY_EXCEPTION);
  return {
    deponentName: uploader?.name ?? null,
    deponentDesignation: designationFor(uploader),
    deponentAuthorityId: uploader?.authorityId ?? null,
    sourceType: device.sourceType ?? SOURCE_TYPE.OTHER,
    make: device.make || null,
    model: device.model || null,
    colour: device.colour || null,
    serialNumber: device.serialNumber || null,
    imeiOrUid: device.imeiOrUid || null,
    hashValue: evidence.sha256Server,
    hashAlgorithm: 'SHA-256',
    mannerOfProduction: await renderMannerOfProduction(evidence),
    conditionsStatement: renderConditionsStatement({ evidence, caseDoc, device, integrityExceptions }),
  };
}

function buildPartB(evidence) {
  const client = evidence.sha256Client ? String(evidence.sha256Client).toLowerCase() : null;
  const server = String(evidence.sha256Server).toLowerCase();
  return {
    attestedBy: SYSTEM_SIGNER_LABEL,
    hashAlgorithm: 'SHA-256',
    sha256Client: client,
    sha256Server: server,
    hashesMatch: client ? client === server : null,
    hashComputedAt: evidence.createdAt ?? null,
    statement:
      'The hash values above were computed when the electronic record was produced: first on the producing officer’s device, then by the Lexx server from the bytes it received. They are attested by the LEXX Certificate Authority. This Part contains no forensic or expert opinion; any laboratory examination is recorded separately and does not affect this certificate.',
  };
}

// ---------------------------------------------------------------- hashing ----

const iso = (d) => (d ? new Date(d).toISOString() : null);

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
  attestedBy: b.attestedBy ?? null,
  hashAlgorithm: b.hashAlgorithm ?? null,
  sha256Client: b.sha256Client ?? null,
  sha256Server: b.sha256Server ?? null,
  hashesMatch: typeof b.hashesMatch === 'boolean' ? b.hashesMatch : null,
  hashComputedAt: iso(b.hashComputedAt),
  statement: b.statement ?? null,
});

/** Canonical hash of everything the certificate says. Printed on the PDF. */
export function certificateBodyHash(cert) {
  const who = cert.issuedOnBehalfOf ?? {};
  return canonicalHash({
    certificateId: String(cert._id),
    evidenceId: String(cert.evidenceId),
    caseId: String(cert.caseId),
    exhibitCode: cert.exhibitCode ?? null,
    templateVersion: cert.templateVersion ?? null,
    issuedAt: iso(cert.generatedAt),
    verificationToken: cert.verificationToken,
    issuedOnBehalfOf: {
      name: who.name ?? null,
      authorityId: who.authorityId ?? null,
      role: who.role ?? null,
      designation: who.designation ?? null,
    },
    partA: pickPartA(cert.partA),
    partB: pickPartB(cert.partB),
  });
}

/** What the system key signs: the body, the exact PDF bytes, and the signing key. */
export const computeCertificateHash = ({ bodyHash, pdfSha256, keyFingerprint }) =>
  canonicalHash({
    bodyHash,
    pdfSha256: pdfSha256 ?? null,
    keyFingerprint: keyFingerprint ?? null,
    signer: SYSTEM_SIGNER_LABEL,
  });

// ---------------------------------------------------------------- issuing ----

async function createSystemCertificate(evidence) {
  const [uploader, caseDoc] = await Promise.all([
    User.findById(evidence.uploadedByUserId ?? evidence.signerUserId)
      .select('_id name authorityId role scope')
      .lean(),
    Case.findById(evidence.caseId).select('stationCode').lean(),
  ]);
  const partA = await buildPartA({ evidence, uploader, caseDoc });

  const doc = await Certificate.create({
    evidenceId: evidence._id,
    caseId: evidence.caseId,
    exhibitCode: evidence.exhibitCode ?? null,
    templateVersion: SYSTEM_TEMPLATE_VERSION,
    status: CERTIFICATE_STATUS.ACTIVE,
    generatedAt: new Date(),
    generatedByUserId: uploader?._id ?? evidence.uploadedByUserId ?? null,
    issuedOnBehalfOf: {
      userId: uploader?._id ?? null,
      name: uploader?.name ?? null,
      authorityId: uploader?.authorityId ?? null,
      role: uploader?.role ?? null,
      designation: designationFor(uploader),
    },
    partA,
    partB: buildPartB(evidence),
    partAComplete: true,
    partBComplete: true,
    // 32 bytes from the CSPRNG: the only credential on the public verifier.
    verificationToken: randomBase64Url(32),
    // The creator holds the issuance lease from the moment the record exists.
    issuanceLockedUntil: new Date(Date.now() + ISSUANCE_LEASE_MS),
  });
  return doc.toObject();
}

async function completeIssuance(cert, evidence) {
  try {
    const caseDoc = await Case.findById(cert.caseId).lean();
    const authority = authorityPublicKey();
    const bodyHash = certificateBodyHash(cert);

    const pdf = await renderCertificatePdf({
      certificate: { ...cert, bodyHash, authorityFingerprint: authority.fingerprint },
      caseDoc,
      evidence,
    });
    const stored = await storeCertificatePdf(cert, pdf);

    const certificateHash = computeCertificateHash({
      bodyHash,
      pdfSha256: stored.pdfSha256,
      keyFingerprint: authority.fingerprint,
    });
    const systemSignature = {
      signerLabel: SYSTEM_SIGNER_LABEL,
      algorithm: SYSTEM_SIGNATURE_ALGORITHM,
      keyFingerprint: authority.fingerprint,
      publicKeyJwk: authority.publicKeyJwk,
      signedPayloadHash: certificateHash,
      signature: systemSign(certificateHash),
      signedAt: new Date(),
    };

    await Certificate.updateOne(
      { _id: cert._id },
      { $set: { pdfKey: stored.pdfKey, pdfSha256: stored.pdfSha256, certificateHash, systemSignature } }
    );

    // A crash after the ledger write but before `issuanceLedgerSeq` was saved must not
    // produce a second record of issue for the same content.
    let entry = await Ledger.findOne({
      subjectId: cert._id,
      eventType: LEDGER_EVENT.CERTIFICATE_GENERATED,
      'payload.certificateHash': certificateHash,
    }).lean();
    if (!entry) {
      entry = await appendEvent({
        eventType: LEDGER_EVENT.CERTIFICATE_GENERATED,
        caseId: cert.caseId,
        subjectId: cert._id,
        subjectType: SUBJECT_TYPE.CERTIFICATE,
        actorUserId: null,
        actorRole: SYSTEM_ACTOR_ROLE,
        payload: {
          certificateId: String(cert._id),
          evidenceId: String(cert.evidenceId),
          exhibitCode: cert.exhibitCode ?? null,
          templateVersion: cert.templateVersion,
          issuedBy: SYSTEM_SIGNER_LABEL,
          issuedOnBehalfOfAuthorityId: cert.issuedOnBehalfOf?.authorityId ?? null,
          hashValue: cert.partA?.hashValue ?? null,
          hashAlgorithm: 'SHA-256',
          bodyHash,
          pdfSha256: stored.pdfSha256,
          certificateHash,
          systemSignature: systemSignature.signature,
          authorityKeyFingerprint: authority.fingerprint,
        },
      });
    }

    await Certificate.updateOne(
      { _id: cert._id },
      { $set: { issuanceLedgerSeq: entry.seq, issuedAt: systemSignature.signedAt, issuanceLockedUntil: null } }
    );
    return Certificate.findById(cert._id).lean();
  } catch (err) {
    await Certificate.updateOne({ _id: cert._id }, { $set: { issuanceLockedUntil: null } }).catch(() => {});
    throw err;
  }
}

async function ensureInner(evidenceId) {
  const outcome = { certificate: null, created: false, completed: false, supersededLegacy: 0, skipped: null };

  let active = await Certificate.findOne({ evidenceId, status: CERTIFICATE_STATUS.ACTIVE }).lean();
  if (isIssued(active)) return { ...outcome, certificate: active };

  const evidence = await Evidence.findById(evidenceId).lean();
  if (!evidence) return { ...outcome, skipped: 'EVIDENCE_NOT_FOUND' };
  if (!evidence.sha256Server || !evidence.caseId) return { ...outcome, skipped: 'EVIDENCE_HAS_NO_HASH' };

  // ---- a legacy certificate is kept, marked, and replaced ----
  let legacy = null;
  if (active && !isSystemCertificate(active)) {
    const released = await Certificate.updateOne(
      { _id: active._id, status: CERTIFICATE_STATUS.ACTIVE },
      {
        $set: {
          status: CERTIFICATE_STATUS.SUPERSEDED,
          supersededAt: new Date(),
          supersededReason: REPLACED_BY_SYSTEM_CERTIFICATE,
        },
      }
    );
    if (released.modifiedCount) legacy = active;
    active = null;
  }

  if (!active) {
    try {
      active = await createSystemCertificate(evidence);
      outcome.created = true;
    } catch (err) {
      if (err?.code !== 11000) {
        if (legacy) {
          await Certificate.updateOne(
            { _id: legacy._id },
            { $set: { status: CERTIFICATE_STATUS.ACTIVE, supersededAt: null, supersededReason: null } }
          ).catch(() => {});
        }
        throw err;
      }
      // Lost the race: the partial unique index held. Adopt the winner's certificate.
      active = await Certificate.findOne({ evidenceId: evidence._id, status: CERTIFICATE_STATUS.ACTIVE }).lean();
      if (!active) throw err;
    }
  }

  if (isSystemCertificate(active) && !isIssued(active)) {
    let mayComplete = outcome.created;
    if (!mayComplete) {
      const now = new Date();
      const claim = await Certificate.updateOne(
        {
          _id: active._id,
          issuanceLedgerSeq: null,
          $or: [{ issuanceLockedUntil: null }, { issuanceLockedUntil: { $lt: now } }],
        },
        { $set: { issuanceLockedUntil: new Date(now.getTime() + ISSUANCE_LEASE_MS) } }
      );
      mayComplete = claim.modifiedCount === 1;
    }
    if (mayComplete) {
      active = await completeIssuance(active, evidence);
      outcome.completed = !outcome.created;
    }
  }

  if (legacy && isSystemCertificate(active)) {
    await Certificate.updateOne({ _id: legacy._id }, { $set: { supersededById: active._id } });
    await appendEvent({
      eventType: LEDGER_EVENT.CERTIFICATE_SUPERSEDED,
      caseId: legacy.caseId,
      subjectId: legacy._id,
      subjectType: SUBJECT_TYPE.CERTIFICATE,
      actorUserId: null,
      actorRole: SYSTEM_ACTOR_ROLE,
      payload: {
        certificateId: String(legacy._id),
        supersededById: String(active._id),
        exhibitCode: evidence.exhibitCode ?? null,
        reason: REPLACED_BY_SYSTEM_CERTIFICATE,
      },
    });
    outcome.supersededLegacy = 1;
  }

  return { ...outcome, certificate: active };
}

const inflight = new Map();

/**
 * Make sure the exhibit has its one ACTIVE, system-signed certificate. Idempotent and
 * safe to call concurrently (in-process calls share one run; across processes the
 * unique index and the issuance lease decide).
 *
 * @returns {Promise<{certificate:object|null, created:boolean, completed:boolean, supersededLegacy:number, skipped:string|null}>}
 */
export function ensureSystemCertificate(evidenceId) {
  const key = String(evidenceId);
  const running = inflight.get(key);
  if (running) return running;
  const run = ensureInner(evidenceId).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/** Same, but never throws: for read paths that repair a missing certificate on the way. */
export async function ensureSystemCertificateQuietly(evidenceId) {
  try {
    return await ensureSystemCertificate(evidenceId);
  } catch (err) {
    log.error({ evidenceId: String(evidenceId), err: err.message }, 'automatic certificate issue failed');
    return null;
  }
}

/**
 * Boot migration: every exhibit without an ACTIVE, issued v3.0 certificate gets one.
 * Safe to run repeatedly — issued exhibits are excluded up front.
 */
export async function issueMissingSystemCertificates(logger = log) {
  const report = {
    systemCertificatesIssued: 0,
    systemCertificatesCompleted: 0,
    legacyCertificatesSuperseded: 0,
    systemCertificatesSkipped: 0,
    systemCertificateFailures: 0,
  };

  const issuedFor = await Certificate.distinct('evidenceId', {
    status: CERTIFICATE_STATUS.ACTIVE,
    templateVersion: SYSTEM_TEMPLATE_VERSION,
    'systemSignature.signature': { $type: 'string' },
    issuanceLedgerSeq: { $type: 'number' },
  });

  const cursor = Evidence.find({ _id: { $nin: issuedFor } }).select('_id').lean().cursor();
  for await (const { _id } of cursor) {
    try {
      const r = await ensureSystemCertificate(_id);
      if (r.skipped) report.systemCertificatesSkipped += 1;
      if (r.created) report.systemCertificatesIssued += 1;
      if (r.completed) report.systemCertificatesCompleted += 1;
      report.legacyCertificatesSuperseded += r.supersededLegacy;
      if (!r.skipped && !isIssued(r.certificate)) report.systemCertificateFailures += 1;
    } catch (err) {
      report.systemCertificateFailures += 1;
      logger.error?.({ evidenceId: String(_id), err: err.message }, 'system certificate migration failed for exhibit');
    }
  }
  return report;
}

export default {
  ensureSystemCertificate,
  ensureSystemCertificateQuietly,
  issueMissingSystemCertificates,
  certificateBodyHash,
  computeCertificateHash,
  isIssued,
  isSystemCertificate,
  SYSTEM_TEMPLATE_VERSION,
};
