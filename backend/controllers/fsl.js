/**
 * Forensic science laboratory referrals and reports (F7).
 *
 * # The inter-departmental boundary
 *
 * An examiner's entire world is defined by referrals to THEIR lab. There is no
 * "FSL can see forensic cases" rule anywhere: visibility is derived, per exhibit,
 * from a live `Referral` row. That is why another lab's examiner is refused with
 * NO_OPEN_REFERRAL_TO_YOUR_LAB rather than with a role message — the refusal is about
 * the absence of a referral, which is the fact that actually matters.
 *
 * # Two claims that must never merge
 *
 * `evidence.triage` is machine review-prioritisation. `evidence.forensic` is the
 * authenticity opinion of a s.79A-notified laboratory. This file writes the second
 * and never reads or touches the first. AUTHENTIC / MANIPULATED / INCONCLUSIVE is the
 * only authenticity vocabulary in the system and only an examiner can produce it.
 *
 * # Lab identity comes from the directory
 *
 * `labId`, `labName` and `section79ARef` are read from the FSL directory, not from
 * the request. A referral whose s.79A reference was supplied by the referring officer
 * would prove nothing about the lab's notification status.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';

import { Referral } from '../models/Referral.js';
import { Evidence } from '../models/Evidence.js';
import { User } from '../models/User.js';
import {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  REFERRAL_STATUS,
  FORENSIC_STATUS,
  FORENSIC_OPINION,
  FSL_DISCIPLINE,
  RESOURCE_TYPE,
  ACTION,
  DECISION,
  DENY_REASON,
  values,
} from '../models/enums.js';
import { appendEvent } from '../services/ledger.js';
import { legal } from '../services/directoryClient.js';
import { sealBuffer } from '../services/envelope.js';
import { buildStorageKey, resolveObjectPath, ensureVault } from '../services/storage.js';
import { sniffMimeType } from '../services/fileType.js';
import { verifyEcdsaP256 } from '../config/crypto.js';
import { writeAudit } from '../middleware/audit.js';
import { BadRequest, NotFound, Forbidden, Conflict } from '../utils/errors.js';

// ---------------------------------------------------------------- schemas ----

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw BadRequest('VALIDATION_FAILED', 'Request failed validation', {
      fields: r.error.issues.map((i) => i.path.join('.') || '(root)'),
    });
  }
  return r.data;
};

const hex64 = z.string().regex(/^[0-9a-f]{64}$/i, 'Must be a SHA-256 hex digest');

const referSchema = z.object({
  /** A lookup key for the directory, not a fact we store as given. */
  labCode: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, 'Malformed lab code'),
  discipline: z.enum(values(FSL_DISCIPLINE)),
  questionsPosed: z.string().trim().max(2000).optional().default(''),
});

const reportSchema = z.object({
  opinion: z.enum(values(FORENSIC_OPINION)),
  examinationSummary: z.string().trim().min(1).max(5000),
  reportSha256: hex64,
  reportSignature: z.string().regex(/^[0-9a-f]{128}$/i, 'Signature must be 64 bytes of hex'),
});

// ---------------------------------------------------------------- upload IO ----

/** A forensic report is a document. 32 MB is generous for one and safe to buffer. */
const REPORT_MAX_BYTES = 32 * 1024 * 1024;

export const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: REPORT_MAX_BYTES, files: 1, fields: 12, fieldSize: 64 * 1024 },
}).single('report');

/**
 * Sealed-object container: magic | uint32BE header length | JSON envelope | ciphertext.
 *
 * `sealBuffer` returns the ciphertext and the envelope that unwraps it, and the
 * envelope has to live somewhere. Keeping it in the file's own header makes the
 * stored object self-describing, so a report remains readable from the vault alone.
 * The envelope contains only the WRAPPED key, which is useless without MASTER_KEK.
 */
const SEAL_MAGIC = Buffer.from('LEXXSEAL1', 'utf8');

async function storeSealedReport(plaintext, caseId, storageKey) {
  const sealed = sealBuffer(plaintext, caseId);
  const header = Buffer.from(JSON.stringify(sealed.encryption), 'utf8');
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length, 0);

  await ensureVault();
  const target = resolveObjectPath(storageKey);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, Buffer.concat([SEAL_MAGIC, headerLength, header, sealed.ciphertext]));
}

// ---------------------------------------------------------------- helpers ----

const referralView = (r) => ({
  id: String(r._id),
  caseId: String(r.caseId),
  evidenceId: String(r.evidenceId),
  exhibitCode: r.exhibitCode,
  labId: r.labId,
  labName: r.labName,
  section79ARef: r.section79ARef,
  discipline: r.discipline,
  questionsPosed: r.questionsPosed,
  status: r.status,
  referredAt: r.referredAt,
  acceptedAt: r.acceptedAt,
  reportedAt: r.reportedAt,
});

/**
 * The laboratory boundary, restated at the point of action.
 *
 * `authorize` has already run the resolver, which stops another lab's examiner. What
 * the resolver cannot express is that accepting a referral and filing an opinion are
 * acts OF a laboratory: the session must carry the referral's own lab scope. A police
 * supervisor is inside the case's jurisdiction and would otherwise pass the resolver
 * — they hold no lab scope at all, so they stop here. This compares scope, not roles;
 * no role literal appears, and there is no second policy to keep in step.
 */
async function assertActingLab(req, referral) {
  const labId = req.user.scope?.labId ?? null;
  if (!labId || labId !== referral.labId) {
    await writeAudit(req, {
      action: ACTION.WRITE,
      resourceType: RESOURCE_TYPE.REFERRAL,
      resourceId: referral._id,
      resourceLabel: referral.exhibitCode,
      caseId: referral.caseId,
      decision: DECISION.DENY,
      reason: DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB,
    });
    throw Forbidden(
      DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB,
      'This exhibit is not referred to your laboratory'
    );
  }
}

// ================================================================ referral ====

/**
 * Authorization context for creating a referral.
 *
 * `authorize` has already loaded the exhibit and ITS case from the database, so this
 * hands `resolveCreate` a server-resolved case id — never a body field. The policy
 * then evaluates a WRITE to that case, which is what a referral out of it really is.
 */
export function referralContext(req) {
  return {
    caseId: req.caseDoc?._id ?? null,
    stationCode: req.caseDoc?.stationCode ?? null,
  };
}

/**
 * POST /api/evidence/:id/refer-fsl   (SHO)
 *
 * The exhibit is loaded and authorised by the resolver from the path id. The only
 * thing the body contributes is which lab to ask — and even that is resolved against
 * the FSL directory before anything is written.
 */
export async function referToFsl(req, res, next) {
  try {
    const evidence = req.resource;
    const caseDoc = req.caseDoc;
    const body = parse(referSchema, req.body);

    // ---- the lab is a directory fact, or it does not exist ----
    const lab = await legal.getLab(body.labCode);
    if (!lab) {
      throw NotFound('LAB_NOT_FOUND', 'No such laboratory in the FSL directory');
    }

    // A lab that does not run this discipline cannot answer the question, and a
    // referral it cannot act on is a delay dressed up as progress.
    const disciplines = lab.disciplines ?? [];
    if (disciplines.length && !disciplines.includes(body.discipline)) {
      throw BadRequest('DISCIPLINE_NOT_OFFERED', 'That laboratory does not run this discipline', {
        labCode: lab.labCode,
        disciplines,
      });
    }

    let referral;
    try {
      referral = await Referral.create({
        caseId: evidence.caseId,
        evidenceId: evidence._id,
        exhibitCode: evidence.exhibitCode,

        // ---- straight from the directory, never from the request ----
        labId: lab.labCode,
        labName: lab.name,
        section79ARef: lab.section79ANotificationRef ?? null,
        // -------------------------------------------------------------

        discipline: body.discipline,
        questionsPosed: body.questionsPosed,
        referredByUserId: req.user.userId,
        status: REFERRAL_STATUS.OPEN,
      });
    } catch (err) {
      // `unique_live_referral` — one live referral per exhibit per lab. Re-referring
      // while one is open would fork the workflow and produce two "the" opinions.
      if (err?.code === 11000) {
        const live = await Referral.findOne({
          evidenceId: evidence._id,
          labId: lab.labCode,
          status: { $in: [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED] },
        }).lean();
        throw Conflict(
          'DUPLICATE_LIVE_REFERRAL',
          'This exhibit is already referred to that laboratory and the referral is still live',
          { referralId: live ? String(live._id) : null, status: live?.status ?? null }
        );
      }
      throw err;
    }

    // The forensic subdocument moves; `triage` is not read and not written here.
    await Evidence.updateOne(
      { _id: evidence._id },
      {
        $set: {
          'forensic.status': FORENSIC_STATUS.REFERRED,
          'forensic.labId': lab.labCode,
          'forensic.labName': lab.name,
          'forensic.section79ARef': lab.section79ANotificationRef ?? null,
        },
      }
    );

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.REFERRED_TO_FSL,
      caseId: evidence.caseId,
      subjectId: evidence._id,
      subjectType: SUBJECT_TYPE.EVIDENCE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        exhibitCode: evidence.exhibitCode,
        referralId: String(referral._id),
        labId: lab.labCode,
        labName: lab.name,
        section79ARef: lab.section79ANotificationRef ?? null,
        discipline: body.discipline,
        questionsPosed: body.questionsPosed,
        referredByAuthorityId: req.user.authorityId,
        firNumber: caseDoc?.firNumber ?? null,
      },
    });

    return res.status(201).json({
      referral: referralView(referral.toObject()),
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/fsl/referrals
 *
 * The collection filter is the whole access control. A session with no lab scope has
 * no referrals of its own, which renders as an empty list — never as everything.
 */
export async function listReferrals(req, res, next) {
  try {
    const labId = req.scopeFilter?.__fslLab ?? null;
    if (!labId) return res.json({ referrals: [], total: 0, labId: null });

    const query = { labId };
    if (req.query.status !== undefined) {
      query.status = parse(z.enum(values(REFERRAL_STATUS)), req.query.status);
    }

    const referrals = await Referral.find(query)
      .sort({ referredAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200))
      .lean();

    return res.json({
      labId,
      referrals: referrals.map(referralView),
      total: referrals.length,
    });
  } catch (err) {
    return next(err);
  }
}

/** POST /api/fsl/referrals/:id/accept — the lab takes the exhibit on. */
export async function acceptReferral(req, res, next) {
  try {
    const referral = req.resource;
    await assertActingLab(req, referral);

    if (referral.status !== REFERRAL_STATUS.OPEN) {
      throw Conflict('REFERRAL_NOT_OPEN', 'Only an open referral can be accepted', {
        status: referral.status,
      });
    }

    // Guarded on OPEN so two examiners in the same lab cannot both claim it.
    const updated = await Referral.findOneAndUpdate(
      { _id: referral._id, status: REFERRAL_STATUS.OPEN },
      {
        $set: {
          status: REFERRAL_STATUS.ACCEPTED,
          acceptedByUserId: req.user.userId,
          acceptedAt: new Date(),
        },
      },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The referral changed while accepting. Try again.');

    await Evidence.updateOne(
      { _id: referral.evidenceId },
      {
        $set: {
          'forensic.status': FORENSIC_STATUS.UNDER_EXAMINATION,
          'forensic.examinerUserId': req.user.userId,
          'forensic.examinerName': req.user.name,
        },
      }
    );

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.FSL_EXAMINATION_STARTED,
      caseId: referral.caseId,
      subjectId: referral.evidenceId,
      subjectType: SUBJECT_TYPE.EVIDENCE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        exhibitCode: referral.exhibitCode,
        referralId: String(referral._id),
        labId: referral.labId,
        discipline: referral.discipline,
        examinerAuthorityId: req.user.authorityId,
      },
    });

    return res.json({ referral: referralView(updated.toObject()), ledgerSeq: entry.seq });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/fsl/referrals/:id/report   (multipart: `report` + fields)
 *
 * The report is hashed, signature-checked against the examiner's registered key,
 * sealed and stored. An unverifiable signature means we do not know who wrote the
 * opinion, and an opinion of unknown authorship is worse than no opinion at all —
 * so it is refused rather than stored with a caveat.
 */
export async function fileReport(req, res, next) {
  try {
    const referral = req.resource;
    await assertActingLab(req, referral);

    if (!req.file) throw BadRequest('FILE_REQUIRED', 'A report file is required');
    const body = parse(reportSchema, req.body);

    if (referral.status !== REFERRAL_STATUS.ACCEPTED) {
      // Accept-then-report is the whole two-step: an opinion from a lab that never
      // took the exhibit on has no recorded point at which it received it.
      throw Conflict(
        'REFERRAL_NOT_ACCEPTED',
        'The referral must be accepted before a report can be filed',
        { status: referral.status }
      );
    }

    // ---- 1. it must actually be a report ----
    const sniffed = sniffMimeType(req.file.buffer.subarray(0, 32));
    if (sniffed !== 'application/pdf') {
      throw BadRequest('REPORT_MUST_BE_PDF', 'A forensic report must be filed as a PDF', {
        detected: sniffed,
      });
    }

    // ---- 2. the bytes must be the bytes that were hashed ----
    const serverSha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    if (serverSha !== body.reportSha256.toLowerCase()) {
      throw BadRequest(
        'REPORT_HASH_MISMATCH',
        'The uploaded report does not match the hash you signed',
        { declared: body.reportSha256.toLowerCase(), computed: serverSha }
      );
    }

    // ---- 3. the signature must come from this examiner's registered key ----
    const signer = await User.findById(req.user.userId).lean();
    if (!signer?.publicKeyJwk) {
      throw BadRequest('NO_REGISTERED_KEY', 'No signing key is registered for this account');
    }
    if (!verifyEcdsaP256(signer.publicKeyJwk, body.reportSignature, body.reportSha256)) {
      await appendEvent({
        eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION,
        caseId: referral.caseId,
        subjectId: referral.evidenceId,
        subjectType: SUBJECT_TYPE.EVIDENCE,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        payload: {
          stage: 'FSL_REPORT',
          reason: 'SIGNATURE_INVALID',
          exhibitCode: referral.exhibitCode,
          referralId: String(referral._id),
          reportSha256: serverSha,
          signerFingerprint: signer.publicKeyFingerprint,
        },
      });
      throw BadRequest(
        'SIGNATURE_INVALID',
        'The signature does not verify against your registered key. The report was rejected and the attempt logged.'
      );
    }

    // ---- 4. seal and store ----
    const storageKey = buildStorageKey(serverSha, referral._id);
    await storeSealedReport(req.file.buffer, referral.caseId, storageKey);

    const reportedAt = new Date();

    // ---- 5. the opinion ----
    // `triage` is untouched. The two claims are separate and stay separate.
    await Evidence.updateOne(
      { _id: referral.evidenceId },
      {
        $set: {
          'forensic.status': FORENSIC_STATUS.REPORT_FILED,
          'forensic.labId': referral.labId,
          'forensic.labName': referral.labName,
          'forensic.section79ARef': referral.section79ARef,
          'forensic.examinerUserId': req.user.userId,
          'forensic.examinerName': req.user.name,
          'forensic.reportFileKey': storageKey,
          'forensic.reportSha256': serverSha,
          'forensic.reportSignature': body.reportSignature.toLowerCase(),
          'forensic.opinion': body.opinion,
          'forensic.examinationSummary': body.examinationSummary,
          'forensic.reportedAt': reportedAt,
        },
      }
    );

    const updated = await Referral.findOneAndUpdate(
      { _id: referral._id, status: REFERRAL_STATUS.ACCEPTED },
      { $set: { status: REFERRAL_STATUS.REPORTED, reportedAt } },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The referral changed while filing. Try again.');

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.FSL_REPORT_FILED,
      caseId: referral.caseId,
      subjectId: referral.evidenceId,
      subjectType: SUBJECT_TYPE.EVIDENCE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      actorSignature: body.reportSignature.toLowerCase(),
      actorPubKeyFingerprint: signer.publicKeyFingerprint,
      payload: {
        exhibitCode: referral.exhibitCode,
        referralId: String(referral._id),
        labId: referral.labId,
        labName: referral.labName,
        section79ARef: referral.section79ARef,
        discipline: referral.discipline,
        examinerAuthorityId: req.user.authorityId,
        reportSha256: serverSha,
        // The only authenticity vocabulary in the system, produced by the only party
        // entitled to produce it.
        opinion: body.opinion,
      },
    });

    return res.status(201).json({
      referral: referralView(updated.toObject()),
      forensic: {
        opinion: body.opinion,
        examinationSummary: body.examinationSummary,
        labId: referral.labId,
        labName: referral.labName,
        section79ARef: referral.section79ARef,
        reportSha256: serverSha,
        reportedAt,
      },
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
      basisNote:
        'This opinion is the source for Part B of the BSA s.63 certificate. It is independent of automated triage.',
    });
  } catch (err) {
    return next(err);
  }
}

export default {
  reportUpload,
  referralContext,
  referToFsl,
  listReferrals,
  acceptReferral,
  fileReport,
};
