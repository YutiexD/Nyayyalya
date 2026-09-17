/**
 * Vakalatnama e-filing: how an advocate comes on record.
 *
 * # The sequence, and why it runs in this order
 *
 *   1. The ADVOCATE files the signed vakalatnama through Lexx, against a CNR. The PDF
 *      is hashed and signed in their browser, exactly as evidence is, so the document
 *      the registry reads carries the advocate's own attestation of its digest.
 *      Filing grants NOTHING. The filer still cannot see the case.
 *   2. The REGISTRAR of the court the case is listed before reads the document and
 *      rules on it.
 *   3. On acceptance the appearance is recorded in the COURT REGISTER first — the
 *      court directory, which checks the registrar's staff code and the listing itself
 *      — and only then does Lexx mirror it as a CaseAccessGrant. That grant is the
 *      whole of counsel's access: from that moment they read the case and every exhibit
 *      in it, read-only. The court shares nothing by hand.
 *
 * Step 3's order is the whole trust model. Lexx never decides who represents whom: the
 * court register does, and Lexx follows it. That is also why `sync-representation`
 * keeps working unchanged — it reads the same register this writes to, so a
 * vakalatnama later withdrawn at the court still revokes access here.
 *
 * A refusal is recorded with a reason the advocate can read. Nothing is deleted.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import multer from 'multer';
import { z } from 'zod';

import { Case } from '../models/Case.js';
import { User } from '../models/User.js';
import { CaseAccessGrant } from '../models/CaseAccessGrant.js';
import { VakalatnamaFiling } from '../models/VakalatnamaFiling.js';
import {
  ACTION,
  ADVOCATE_ROLES,
  APPEARING_FOR,
  DECISION,
  GRANT_BASIS,
  LEDGER_EVENT,
  RESOURCE_TYPE,
  SUBJECT_TYPE,
  USER_STATUS,
  VAKALATNAMA_STATUS,
  values,
} from '../models/enums.js';
import { appendEvent } from '../services/ledger.js';
import { court } from '../services/directoryClient.js';
import { storeSealedDocument, readSealedDocument } from '../services/sealedDocument.js';
import { buildStorageKey } from '../services/storage.js';
import { sniffMimeType } from '../services/fileType.js';
import { verifyEcdsaP256 } from '../config/crypto.js';
import { writeAudit } from '../middleware/audit.js';
import { APPEARING_FOR_TO_ROLE, ensureGrant, liveAdvocateGrants } from './disclosure.js';
import { BadRequest, Conflict, NotFound } from '../utils/errors.js';

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

/** eCourts CNR: two-letter state, two-character establishment, twelve digits. */
const CNR = /^[A-Z]{2}[A-Z0-9]{2}\d{12}$/;

const fileSchema = z.object({
  cnrNumber: z.string().trim().toUpperCase().regex(CNR, 'Malformed CNR number'),
  appearingFor: z.enum(values(APPEARING_FOR)),
  partyName: z.string().trim().min(2).max(120),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be a SHA-256 hex digest'),
  documentSignature: z.string().regex(/^[0-9a-f]{128}$/i, 'Signature must be 64 bytes of hex'),
});

const rejectSchema = z.object({
  note: z.string().trim().min(10, 'A refusal must state a reason').max(1000),
});

/** A vakalatnama is a few pages. 10 MB is generous and safe to buffer. */
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1, fields: 10, fieldSize: 8 * 1024 },
}).single('document');

// ---------------------------------------------------------------- views ----

const filingView = (f, caseDoc = null) => ({
  id: String(f._id),
  caseId: String(f.caseId),
  cnrNumber: f.cnrNumber,
  firNumber: f.firNumber ?? caseDoc?.firNumber ?? null,
  courtId: f.courtId,
  advocateUserId: String(f.advocateUserId),
  advocateAuthorityId: f.advocateAuthorityId,
  advocateName: f.advocateName,
  appearingFor: f.appearingFor,
  partyName: f.partyName,
  documentSha256: f.documentSha256,
  documentSizeBytes: f.documentSizeBytes,
  signerPubKeyFingerprint: f.signerPubKeyFingerprint,
  filedAt: f.filedAt,
  status: f.status,
  decidedAt: f.decidedAt ?? null,
  decidedByAuthorityId: f.decidedByAuthorityId ?? null,
  decisionNote: f.decisionNote ?? null,
});

// ================================================================ 1. FILE ====

/**
 * Create-context: the case this filing is against, looked up by its CNR.
 *
 * The CNR is a public court identifier and a lookup key — not a fact the request is
 * trusted with. Whether the case is actually before a court is decided by the
 * resolver from the case document this loads.
 */
export async function filingContext(req) {
  const raw = typeof req.body?.cnrNumber === 'string' ? req.body.cnrNumber.trim().toUpperCase() : '';
  if (!CNR.test(raw)) {
    throw BadRequest('VALIDATION_FAILED', 'Request failed validation', { fields: ['cnrNumber'] });
  }
  const caseDoc = await Case.findOne({ cnrNumber: raw }).lean();
  if (!caseDoc) {
    throw NotFound('CNR_NOT_FOUND', 'No case before a court is registered in Lexx under that CNR number');
  }
  req.filingCase = caseDoc;
  return { caseId: caseDoc._id };
}

/** POST /api/vakalatnama   (multipart: `document` + fields)   — an advocate */
export async function fileVakalatnama(req, res, next) {
  try {
    const caseDoc = req.filingCase;
    const body = parse(fileSchema, req.body);
    if (!req.file) throw BadRequest('FILE_REQUIRED', 'The signed vakalatnama must be attached');

    // ---- 1. it must actually be a document ----
    const sniffed = sniffMimeType(req.file.buffer.subarray(0, 32));
    if (sniffed !== 'application/pdf') {
      throw BadRequest('DOCUMENT_MUST_BE_PDF', 'A vakalatnama must be filed as a PDF', { detected: sniffed });
    }

    // ---- 2. the bytes must be the bytes that were hashed ----
    const serverSha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    if (serverSha !== body.documentSha256.toLowerCase()) {
      throw BadRequest('DOCUMENT_HASH_MISMATCH', 'The uploaded document does not match the hash you signed', {
        declared: body.documentSha256.toLowerCase(),
        computed: serverSha,
      });
    }

    // ---- 3. and signed by this advocate's registered key ----
    const filer = await User.findById(req.user.userId).lean();
    if (!filer?.publicKeyJwk) {
      throw BadRequest('NO_REGISTERED_KEY', 'No signing key is registered for this account');
    }
    if (!verifyEcdsaP256(filer.publicKeyJwk, body.documentSignature, body.documentSha256)) {
      await writeAudit(req, {
        action: ACTION.WRITE,
        resourceType: RESOURCE_TYPE.VAKALATNAMA,
        caseId: caseDoc._id,
        decision: DECISION.DENY,
        reason: 'SIGNATURE_INVALID',
      });
      throw BadRequest(
        'SIGNATURE_INVALID',
        'The signature does not verify against your registered key. The filing was refused and the attempt logged.'
      );
    }

    // ---- 4. nothing to file if they are already on record for this side ----
    const role = APPEARING_FOR_TO_ROLE[body.appearingFor];
    const onRecord = await CaseAccessGrant.findOne({
      caseId: caseDoc._id,
      userId: req.user.userId,
      role,
      revokedAt: null,
    }).lean();
    if (onRecord) {
      throw Conflict('ALREADY_ON_RECORD', 'You are already on record for this party in this case');
    }

    const live = await VakalatnamaFiling.findOne({
      caseId: caseDoc._id,
      advocateUserId: req.user.userId,
      appearingFor: body.appearingFor,
      status: { $in: [VAKALATNAMA_STATUS.PENDING, VAKALATNAMA_STATUS.ACCEPTED] },
    }).lean();
    if (live) {
      throw Conflict('VAKALATNAMA_ALREADY_FILED', 'A filing for this appearance is already before the registry', {
        filingId: String(live._id),
        status: live.status,
      });
    }

    // ---- 5. seal the document, then record the filing ----
    const filingId = new mongoose.Types.ObjectId();
    const documentKey = buildStorageKey(serverSha, filingId);
    await storeSealedDocument(req.file.buffer, caseDoc._id, documentKey);

    let filing;
    try {
      filing = await VakalatnamaFiling.create({
        _id: filingId,
        caseId: caseDoc._id,
        cnrNumber: caseDoc.cnrNumber,
        firNumber: caseDoc.firNumber ?? null,
        courtId: caseDoc.courtId,
        advocateUserId: req.user.userId,
        advocateAuthorityId: filer.authorityId,
        advocateName: filer.name ?? null,
        appearingFor: body.appearingFor,
        partyName: body.partyName,
        documentKey,
        documentSha256: serverSha,
        documentSignature: body.documentSignature.toLowerCase(),
        documentSizeBytes: req.file.size,
        signerPubKeyFingerprint: filer.publicKeyFingerprint ?? null,
      });
    } catch (err) {
      // Lost a race against an identical filing: the partial unique index held.
      if (err?.code === 11000) {
        throw Conflict('VAKALATNAMA_ALREADY_FILED', 'A filing for this appearance is already before the registry');
      }
      throw err;
    }

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.VAKALATNAMA_FILED,
      caseId: caseDoc._id,
      subjectId: filing._id,
      subjectType: SUBJECT_TYPE.VAKALATNAMA,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      actorSignature: filing.documentSignature,
      actorPubKeyFingerprint: filing.signerPubKeyFingerprint,
      payload: {
        filingId: String(filing._id),
        cnrNumber: caseDoc.cnrNumber,
        advocateAuthorityId: filer.authorityId,
        appearingFor: body.appearingFor,
        documentSha256: serverSha,
      },
    });

    return res.status(201).json({
      filing: filingView(filing.toObject(), caseDoc),
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
      notice:
        'Filed with the court registry. You are NOT on record until the registrar accepts it; until then this case stays closed to you.',
    });
  } catch (err) {
    return next(err);
  }
}

// ============================================================== 2. READS ====

/**
 * GET /api/vakalatnama/mine — the caller's own filings and their status.
 *
 * Scoped by the query itself: `advocateUserId` is the session's user, so this can
 * only ever return the caller's own paper.
 */
export async function listMine(req, res, next) {
  try {
    const filings = await VakalatnamaFiling.find({ advocateUserId: req.user.userId })
      .sort({ filedAt: -1 })
      .limit(100)
      .lean();
    return res.json({ filings: filings.map((f) => filingView(f)), total: filings.length });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/vakalatnama/case/:caseId — the registry's view of representation.
 *
 * Gated on APPROVE over the case, a court-only gate: the court the case is listed in,
 * and nobody else. Returns the filings AND who is on record now — the advocates who
 * can read this case file.
 */
export async function listForCase(req, res, next) {
  try {
    const caseDoc = req.resource;
    const filings = await VakalatnamaFiling.find({ caseId: caseDoc._id }).sort({ filedAt: -1 }).lean();

    const grants = await liveAdvocateGrants(caseDoc._id);
    const users = await User.find({ _id: { $in: grants.map((g) => g.userId) } })
      .select('_id name authorityId status')
      .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    return res.json({
      caseId: String(caseDoc._id),
      cnrNumber: caseDoc.cnrNumber ?? null,
      filings: filings.map((f) => filingView(f, caseDoc)),
      pending: filings.filter((f) => f.status === VAKALATNAMA_STATUS.PENDING).length,
      onRecord: grants.map((g) => ({
        grantId: String(g._id),
        userId: String(g.userId),
        name: userById.get(String(g.userId))?.name ?? null,
        authorityId: userById.get(String(g.userId))?.authorityId ?? null,
        active: userById.get(String(g.userId))?.status === USER_STATUS.ACTIVE,
        role: g.role,
        grantBasis: g.grantBasis,
        grantRef: g.grantRef,
        validFrom: g.validFrom,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/vakalatnama/:id/document — the filed PDF, as an audited download. */
export async function getDocument(req, res, next) {
  try {
    const filing = req.resource;
    const bytes = await readSealedDocument(filing.documentKey, filing.caseId);
    if (!bytes) throw NotFound('OBJECT_NOT_FOUND', 'The filed document is missing from the vault');

    await writeAudit(req, {
      action: ACTION.DOWNLOAD,
      resourceType: RESOURCE_TYPE.VAKALATNAMA,
      resourceId: filing._id,
      resourceLabel: filing.cnrNumber,
      caseId: filing.caseId,
      decision: DECISION.ALLOW,
      reason: 'VAKALATNAMA_DOCUMENT_DOWNLOAD',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="vakalatnama-${filing.cnrNumber}-${filing._id}.pdf"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Lexx-Document-Sha256', filing.documentSha256);
    return res.send(bytes);
  } catch (err) {
    return next(err);
  }
}

// ========================================================== 3. THE RULING ====

/** Create-context for the registrar-only capability: the filing's own case. */
export const rulingContext = (req) => ({ caseId: req.caseDoc?._id ?? null });

/**
 * POST /api/vakalatnama/:id/accept   (REGISTRAR of the court the case is listed in)
 *
 * Court register first, grant second. If the court register refuses, nothing in Lexx
 * changes — the filing stays PENDING and the refusal is returned as it was given.
 */
export async function acceptFiling(req, res, next) {
  try {
    const filing = req.resource;
    const caseDoc = req.caseDoc;

    if (filing.status !== VAKALATNAMA_STATUS.PENDING) {
      throw Conflict('VAKALATNAMA_NOT_PENDING', 'Only a pending filing can be ruled on', {
        status: filing.status,
      });
    }

    const advocate = await User.findById(filing.advocateUserId).select('_id status role authority').lean();
    if (!advocate || advocate.status !== USER_STATUS.ACTIVE || !ADVOCATE_ROLES.includes(advocate.role)) {
      throw Conflict('ADVOCATE_NOT_ACTIVE', 'The filing advocate no longer holds an active account');
    }

    // ---- 1. the court records the appearance ----
    const recorded = await court.recordVakalatnama({
      cnrNumber: filing.cnrNumber,
      advocateEnrolmentNo: filing.advocateAuthorityId,
      appearingFor: filing.appearingFor,
      partyName: filing.partyName,
      acceptedBy: req.user.authorityId,
    });

    let courtRegister;
    if (recorded.status === 201) {
      courtRegister = 'RECORDED';
    } else if (recorded.status === 409 && recorded.data?.error?.code === 'VAKALATNAMA_ALREADY_ON_RECORD') {
      // The court already has this appearance on its register — the outcome we want.
      courtRegister = 'ALREADY_ON_RECORD';
    } else {
      throw Conflict(
        'COURT_REGISTER_REFUSED',
        recorded.data?.error?.message ?? 'The court register did not record this appearance',
        { courtCode: recorded.data?.error?.code ?? null, status: recorded.status }
      );
    }

    // ---- 2. the filing moves, guarded on the state we checked ----
    const decidedAt = new Date();
    const updated = await VakalatnamaFiling.findOneAndUpdate(
      { _id: filing._id, status: VAKALATNAMA_STATUS.PENDING },
      {
        $set: {
          status: VAKALATNAMA_STATUS.ACCEPTED,
          decidedAt,
          decidedByUserId: req.user.userId,
          decidedByAuthorityId: req.user.authorityId,
        },
      },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The filing changed while being accepted. Try again.');

    // ---- 3. and only now, Lexx mirrors the court's record as access ----
    const role = APPEARING_FOR_TO_ROLE[filing.appearingFor];
    const grantRef = `VAK/${filing.cnrNumber}/${filing.advocateAuthorityId}/${filing.appearingFor}`;
    await ensureGrant({
      caseId: filing.caseId,
      userId: filing.advocateUserId,
      role,
      grantBasis: GRANT_BASIS.VAKALATNAMA,
      grantRef,
      grantedByUserId: req.user.userId,
      validFrom: decidedAt,
    });
    const grant = await CaseAccessGrant.findOne({
      caseId: filing.caseId,
      userId: filing.advocateUserId,
      role,
      revokedAt: null,
    }).lean();
    if (grant) {
      await VakalatnamaFiling.updateOne({ _id: filing._id }, { $set: { grantId: grant._id } });
    }

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.VAKALATNAMA_ACCEPTED,
      caseId: filing.caseId,
      subjectId: filing._id,
      subjectType: SUBJECT_TYPE.VAKALATNAMA,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        filingId: String(filing._id),
        cnrNumber: filing.cnrNumber,
        advocateAuthorityId: filing.advocateAuthorityId,
        appearingFor: filing.appearingFor,
        grantRole: role,
        grantRef,
        documentSha256: filing.documentSha256,
        acceptedByAuthorityId: req.user.authorityId,
        courtRegister,
      },
    });

    return res.json({
      filing: filingView({ ...updated.toObject(), grantId: grant?._id ?? null }, caseDoc),
      grant: grant
        ? { grantId: String(grant._id), role: grant.role, grantBasis: grant.grantBasis, grantRef: grant.grantRef }
        : null,
      courtRegister,
      /** What being on record gives counsel, immediately and with no further step. */
      access: grant ? 'CASE_AND_EXHIBITS_READ_ONLY' : null,
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
    });
  } catch (err) {
    return next(err);
  }
}

/** POST /api/vakalatnama/:id/reject  { note }   (REGISTRAR) */
export async function rejectFiling(req, res, next) {
  try {
    const filing = req.resource;
    const body = parse(rejectSchema, req.body);

    if (filing.status !== VAKALATNAMA_STATUS.PENDING) {
      throw Conflict('VAKALATNAMA_NOT_PENDING', 'Only a pending filing can be ruled on', {
        status: filing.status,
      });
    }

    const updated = await VakalatnamaFiling.findOneAndUpdate(
      { _id: filing._id, status: VAKALATNAMA_STATUS.PENDING },
      {
        $set: {
          status: VAKALATNAMA_STATUS.REJECTED,
          decidedAt: new Date(),
          decidedByUserId: req.user.userId,
          decidedByAuthorityId: req.user.authorityId,
          decisionNote: body.note,
        },
      },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The filing changed while being ruled on. Try again.');

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.VAKALATNAMA_REJECTED,
      caseId: filing.caseId,
      subjectId: filing._id,
      subjectType: SUBJECT_TYPE.VAKALATNAMA,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        filingId: String(filing._id),
        cnrNumber: filing.cnrNumber,
        advocateAuthorityId: filing.advocateAuthorityId,
        appearingFor: filing.appearingFor,
        rejectedByAuthorityId: req.user.authorityId,
        note: body.note,
      },
    });

    return res.json({ filing: filingView(updated.toObject(), req.caseDoc), ledgerSeq: entry.seq });
  } catch (err) {
    return next(err);
  }
}

export default {
  documentUpload,
  filingContext,
  fileVakalatnama,
  listMine,
  listForCase,
  getDocument,
  rulingContext,
  acceptFiling,
  rejectFiling,
};
