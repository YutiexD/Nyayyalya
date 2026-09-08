/**
 * Evidence: ingest, verification, streaming.
 *
 * # The ingest contract
 *
 * The browser hashes the file BEFORE upload and signs that hash with a private key
 * that never leaves the device. The server recomputes the hash from the bytes it
 * actually received and verifies the signature against the key registered at
 * activation.
 *
 * That gives three independent facts, and they are stored separately rather than
 * collapsed into one "verified" boolean:
 *   - `hashMatchedOnIngest`      — what arrived is what the officer hashed
 *   - `signatureValidOnIngest`   — the officer's device really signed it
 *   - `sha256Server`             — what the bytes on disk must always hash to
 *
 * # The verification contract
 *
 * `/verify` recomputes everything from scratch — the stored bytes, the signature, the
 * ledger chain, the anchored Merkle root — and reports four independent lights. The
 * nuance that matters: a modified FILE with an intact CHAIN correctly says "the file
 * was touched, not the log".
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { pipeline } from 'node:stream/promises';

import env from '../config/env.js';
import { Evidence } from '../models/Evidence.js';
import { Case } from '../models/Case.js';
import { AnchorBatch } from '../models/AnchorBatch.js';
import { Ledger } from '../models/Ledger.js';
import { StreamToken, STREAM_PURPOSE } from '../models/StreamToken.js';
import { User } from '../models/User.js';
import {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  EVIDENCE_KIND,
  SOURCE_TYPE,
  FILE_INTEGRITY,
  CHAIN_INTEGRITY,
  ANCHOR_INTEGRITY,
  ANCHOR_STATUS,
  RESOURCE_TYPE,
  ACTION,
  DECISION,
} from '../models/enums.js';
import { appendEvent, verifyChain } from '../services/ledger.js';
import { generateDek, wrapDek, unwrapDek } from '../services/envelope.js';
import {
  buildStorageKey,
  putEncryptedFile,
  readDecryptedToHash,
  getDecryptedStream,
  ensureVault,
  objectExists,
} from '../services/storage.js';
import { validateUpload } from '../services/fileType.js';
import { triageEvidence } from '../services/triage.js';
import { merkleRoot, merkleProof, verifyProof } from '../services/merkle.js';
import { verifyEcdsaP256, sha256Hex, randomBase64Url } from '../config/crypto.js';
import { materialiseScopeFilter } from '../services/accessResolver.js';
import { writeAudit } from '../middleware/audit.js';
import { BadRequest, NotFound, Forbidden } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('evidence');

// ---------------------------------------------------------------- upload IO ----

const TEMP_DIR = path.join(os.tmpdir(), 'lexx-uploads');
fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Uploads land on disk, never in memory. A 256 MB buffer per concurrent upload is
 * how a demo box runs out of RAM. Filenames are generated, never taken from the
 * client, so a crafted filename cannot influence a path.
 */
export const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
  }),
  limits: {
    fileSize: env.MAX_UPLOAD_BYTES,
    files: 1,
    fields: 24,
    fieldSize: 64 * 1024,
  },
}).single('file');

/**
 * Guarantee the temp file is removed however this request ends.
 *
 * Multer has already written the upload to disk by the time any authorization runs.
 * If the resolver denies, `next(err)` skips the controller and the controller's own
 * `finally` never executes — so cleanup cannot live there alone. Hooking `close` on
 * the response covers every exit: success, denial, thrown error, and client abort.
 *
 * `close` rather than `finish`: `finish` fires only when a response was fully sent,
 * which an aborted upload never does.
 */
export function reapTempUpload(req, res, next) {
  const tempPath = req.file?.path;
  if (tempPath) {
    res.on('close', () => {
      fsp.rm(tempPath, { force: true }).catch((err) =>
        log.warn({ err: err.message }, 'failed to remove temp upload')
      );
    });
  }
  next();
}

const cleanup = (p) => {
  if (p) fsp.rm(p, { force: true }).catch(() => {});
};

async function hashFileStreaming(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

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

const uploadSchema = z.object({
  caseId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Malformed case id'),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).optional().default(''),
  sha256Client: hex64,
  signature: z.string().regex(/^[0-9a-f]{128}$/i, 'Signature must be 64 bytes of hex'),
  sourceType: z.enum(Object.values(SOURCE_TYPE)),
  make: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  colour: z.string().max(60).optional(),
  serialNumber: z.string().max(120).optional(),
  imeiOrUid: z.string().max(120).optional(),
  macAddress: z.string().max(64).optional(),
  capturedAt: z.coerce.date().optional(),
  metadata: z.string().max(8000).optional(),
});

/** Sequential, human-readable exhibit code: EX-<fir>-<nnn>. */
async function nextExhibitCode(caseDoc) {
  const firPart = String(caseDoc.firNumber).replace(/[^0-9]/g, '') || '0000';
  const count = await Evidence.countDocuments({ caseId: caseDoc._id });
  return `EX-${firPart}-${String(count + 1).padStart(3, '0')}`;
}

/** Authorization context for upload: the case, loaded from the DB by its id. */
export async function uploadCaseContext(req) {
  const caseId = req.body?.caseId;
  if (!caseId || !/^[0-9a-fA-F]{24}$/.test(caseId)) {
    throw BadRequest('VALIDATION_FAILED', 'Malformed case id');
  }
  const caseDoc = await Case.findById(caseId).lean();
  if (!caseDoc) throw NotFound('CASE_NOT_FOUND', 'No such case');
  req.uploadCase = caseDoc;
  return { caseId: caseDoc._id, stationCode: caseDoc.stationCode };
}

// ================================================================== upload ====

/**
 * POST /api/evidence/upload  (multipart)
 *
 * Order of operations is deliberate: cheap rejections first, expensive crypto last,
 * and the temp file is removed on every path including failure.
 */
export async function uploadEvidence(req, res, next) {
  const tempPath = req.file?.path;
  try {
    if (!req.file) throw BadRequest('FILE_REQUIRED', 'A file is required');

    const body = parse(uploadSchema, req.body);
    const caseDoc = req.uploadCase;

    // The resolver already confirmed this user may write to this case, but the case
    // must also still be open to writes.
    if (String(body.caseId) !== String(caseDoc._id)) {
      throw BadRequest('CASE_MISMATCH', 'Case id does not match the authorised case');
    }

    // ---- 1. the bytes must be a type we accept, by content and not by label ----
    const typeCheck = await validateUpload(tempPath, req.file.mimetype);
    if (!typeCheck.ok) {
      throw BadRequest(
        typeCheck.reason === 'MIME_TYPE_NOT_ALLOWED' ? 'MIME_TYPE_NOT_ALLOWED' : 'MIME_TYPE_MISMATCH',
        typeCheck.reason === 'MIME_TYPE_NOT_ALLOWED'
          ? 'That file type is not accepted as evidence'
          : 'The file contents do not match the declared type',
        { declared: req.file.mimetype, detected: typeCheck.mimeType }
      );
    }

    // ---- 2. recompute the hash from what actually arrived ----
    const sha256Server = await hashFileStreaming(tempPath);
    const hashMatched = sha256Server.toLowerCase() === body.sha256Client.toLowerCase();

    if (!hashMatched) {
      // The file changed between the browser hashing it and the server receiving it.
      // That is a finding, and it goes in the ledger permanently.
      await appendEvent({
        eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION,
        caseId: caseDoc._id,
        subjectType: SUBJECT_TYPE.EVIDENCE,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        payload: {
          stage: 'INGEST',
          reason: 'CLIENT_SERVER_HASH_MISMATCH',
          sha256Client: body.sha256Client,
          sha256Server,
          declaredMimeType: req.file.mimetype,
          sizeBytes: req.file.size,
          title: body.title,
        },
      });
      await writeAudit(req, {
        action: ACTION.WRITE,
        resourceType: RESOURCE_TYPE.EVIDENCE,
        caseId: caseDoc._id,
        decision: DECISION.DENY,
        reason: 'CLIENT_SERVER_HASH_MISMATCH',
      });
      throw BadRequest(
        'HASH_MISMATCH',
        'The uploaded file does not match the hash computed in your browser. Upload rejected and logged.',
        { sha256Client: body.sha256Client, sha256Server }
      );
    }

    // ---- 3. the signature must come from this user's registered key ----
    const signer = await User.findById(req.user.userId).lean();
    if (!signer?.publicKeyJwk) {
      throw BadRequest('NO_REGISTERED_KEY', 'No signing key is registered for this account');
    }
    const signatureValid = verifyEcdsaP256(signer.publicKeyJwk, body.signature, body.sha256Client);

    if (!signatureValid) {
      await appendEvent({
        eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION,
        caseId: caseDoc._id,
        subjectType: SUBJECT_TYPE.EVIDENCE,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        payload: {
          stage: 'INGEST',
          reason: 'SIGNATURE_INVALID',
          sha256Client: body.sha256Client,
          signerFingerprint: signer.publicKeyFingerprint,
        },
      });
      throw BadRequest(
        'SIGNATURE_INVALID',
        'The signature does not verify against your registered key. Upload rejected and logged.'
      );
    }

    // ---- 4. encrypt and store ----
    await ensureVault();
    const evidenceId = new (await import('mongoose')).default.Types.ObjectId();
    const storageKey = buildStorageKey(sha256Server, evidenceId);

    const dek = generateDek();
    let stored;
    try {
      stored = await putEncryptedFile(tempPath, storageKey, dek);
    } finally {
      // Key material lives no longer than it must.
      // (wrapDek runs before this in the happy path — see below.)
    }
    const wrapped = wrapDek(dek, caseDoc._id);
    dek.fill(0);

    // ---- 5. triage: review priority only, never a verdict ----
    let parsedMetadata = {};
    if (body.metadata) {
      try {
        parsedMetadata = JSON.parse(body.metadata);
        if (typeof parsedMetadata !== 'object' || parsedMetadata === null) parsedMetadata = {};
      } catch {
        parsedMetadata = {}; // malformed client metadata is ignored, never fatal
      }
    }
    const triage = triageEvidence({
      mimeType: typeCheck.mimeType,
      sizeBytes: req.file.size,
      metadata: parsedMetadata,
      originalFilename: req.file.originalname,
      capturedAt: body.capturedAt ?? null,
    });

    // ---- 6. the immutable record ----
    const exhibitCode = await nextExhibitCode(caseDoc);
    const evidence = await Evidence.create({
      _id: evidenceId,
      exhibitCode,
      caseId: caseDoc._id,
      title: body.title,
      description: body.description,
      kind: EVIDENCE_KIND.DIGITAL,

      sha256Client: body.sha256Client.toLowerCase(),
      sha256Server,
      signature: body.signature.toLowerCase(),
      signerUserId: req.user.userId,
      signerPubKeyFingerprint: signer.publicKeyFingerprint,
      // Pinned at ingest so this signature stays verifiable across key rotation.
      signerPublicKeyJwk: signer.publicKeyJwk,
      hashMatchedOnIngest: true,
      signatureValidOnIngest: true,

      storageKey,
      sizeBytes: stored.sizeBytes,
      mimeType: typeCheck.mimeType,
      originalFilename: req.file.originalname?.slice(0, 255) ?? null,
      encryption: {
        algo: 'AES-256-GCM',
        iv: stored.iv,
        tag: stored.tag,
        wrappedDek: wrapped.wrappedDek,
        wrapIv: wrapped.wrapIv,
        wrapTag: wrapped.wrapTag,
        kekId: wrapped.kekId,
      },

      sourceDevice: {
        sourceType: body.sourceType,
        make: body.make ?? null,
        model: body.model ?? null,
        colour: body.colour ?? null,
        serialNumber: body.serialNumber ?? null,
        imeiOrUid: body.imeiOrUid ?? null,
        macAddress: body.macAddress ?? null,
      },
      capturedAt: body.capturedAt ?? null,
      capturedByUserId: req.user.userId,

      triage,
      uploadedByUserId: req.user.userId,
    });

    // ---- 7. the ledger entry ----
    const entry = await appendEvent({
      eventType: LEDGER_EVENT.EVIDENCE_UPLOADED,
      caseId: caseDoc._id,
      subjectId: evidence._id,
      subjectType: SUBJECT_TYPE.EVIDENCE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      actorSignature: body.signature.toLowerCase(),
      actorPubKeyFingerprint: signer.publicKeyFingerprint,
      payload: {
        exhibitCode,
        sha256: sha256Server,
        sizeBytes: stored.sizeBytes,
        mimeType: typeCheck.mimeType,
        sourceType: body.sourceType,
        signerFingerprint: signer.publicKeyFingerprint,
        // Triage priority is recorded as investigative context. It is not a verdict,
        // and no score or percentage is ever written here or on chain.
        triagePriority: triage.priority,
      },
    });

    await Evidence.updateOne({ _id: evidence._id }, { $set: { ledgerSeq: entry.seq } });

    // ---- 8. the officer's independent receipt ----
    // Their own copy is a check on this entire system: it lets them prove later what
    // they handed over, without relying on us.
    const receipt = {
      exhibitCode,
      evidenceId: String(evidence._id),
      caseId: String(caseDoc._id),
      firNumber: caseDoc.firNumber,
      sha256: sha256Server,
      hashAlgorithm: 'SHA-256',
      signerAuthorityId: req.user.authorityId,
      signerPubKeyFingerprint: signer.publicKeyFingerprint,
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
      prevHash: entry.prevHash,
      signedAt: entry.occurredAt.toISOString(),
      issuer: 'LEXX',
      anchorNetwork: env.ANCHOR_NETWORK,
    };
    receipt.receiptHash = sha256Hex(JSON.stringify(receipt));

    return res.status(201).json({
      evidence: {
        ...evidence.toObject(),
        // The document was serialised before the ledger sequence was written back to
        // it, so `toObject()` still carries the null it was created with. Carry the
        // real value: a client showing "—" for a record that IS in the ledger reads
        // as a failure of the thing this endpoint exists to guarantee.
        ledgerSeq: entry.seq,
        encryption: undefined, // key material never leaves the server
      },
      receipt,
    });
  } catch (err) {
    return next(err);
  } finally {
    cleanup(tempPath);
  }
}

// ================================================================== reads ====

/** GET /api/evidence/:id — metadata only. */
export async function getEvidence(req, res) {
  const e = { ...req.resource };
  delete e.encryption; // never expose wrapped keys or IVs
  return res.json({ evidence: e });
}

/** GET /api/evidence?caseId= — scope-filtered list. */
export async function listEvidence(req, res, next) {
  try {
    // EVIDENCE, not CASE. Asking for the case-level filter and listing everything
    // inside those cases is what let an advocate enumerate exhibits withheld from
    // their disclosure pack, and an examiner see exhibits never referred to them —
    // both of which `GET /api/evidence/:id` correctly refuses. The resolver now
    // answers the per-exhibit question for the list path too.
    const scope = await materialiseScopeFilter(req.user, RESOURCE_TYPE.EVIDENCE);
    if (!scope) return res.json({ evidence: [], total: 0 });

    const query = { ...scope };
    if (req.query.caseId && /^[0-9a-fA-F]{24}$/.test(req.query.caseId)) {
      // Intersect, never replace: a caseId outside the scope yields nothing, and a
      // requested case can only ever narrow what the resolver already allowed.
      query.caseId = query.caseId
        ? { $in: (query.caseId.$in ?? []).filter((id) => String(id) === req.query.caseId) }
        : req.query.caseId;
    }

    const items = await Evidence.find(query)
      .select('-encryption')
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200))
      .lean();

    return res.json({ evidence: items, total: items.length });
  } catch (err) {
    return next(err);
  }
}

// ============================================================ verification ====

/**
 * POST /api/evidence/:id/verify
 *
 * Four independent lights. Each is computed from first principles, not read back
 * from a stored flag — a stored "verified: true" would prove nothing.
 */
export async function verifyEvidence(req, res, next) {
  try {
    const e = req.resource;
    const verifiedAt = new Date();

    // ---- light 1: the stored file ----
    let fileIntegrity = FILE_INTEGRITY.FILE_MISSING;
    let recomputedSha = null;

    if (objectExists(e.storageKey)) {
      const dek = unwrapDek(e.encryption, e.caseId);
      try {
        const result = await readDecryptedToHash(e.storageKey, dek, e.encryption);
        if (result.missing) {
          fileIntegrity = FILE_INTEGRITY.FILE_MISSING;
        } else if (!result.authTagValid) {
          // The AES-GCM tag failed: the ciphertext on disk was altered. We cannot
          // recover a plaintext hash, but we know for certain the file was touched.
          fileIntegrity = FILE_INTEGRITY.FILE_MODIFIED;
        } else {
          recomputedSha = result.sha256;
          fileIntegrity =
            result.sha256 === e.sha256Server
              ? FILE_INTEGRITY.FILE_INTACT
              : FILE_INTEGRITY.FILE_MODIFIED;
        }
      } finally {
        dek.fill(0);
      }
    }

    // ---- light 2: the officer's signature over the original hash ----
    // Verify against the key that MADE the signature, not the signer's current key.
    // Falling back to the current key is only for records written before the snapshot
    // existed; for those, a rotation would legitimately show as unverifiable.
    let verifyingKey = e.signerPublicKeyJwk ?? null;
    if (!verifyingKey) {
      const signer = await User.findById(e.signerUserId).lean();
      verifyingKey = signer?.publicKeyJwk ?? null;
    }
    const signatureValid = verifyingKey
      ? verifyEcdsaP256(verifyingKey, e.signature, e.sha256Client)
      : false;

    // ---- light 3: the ledger chain ----
    //
    // Bounded to the UNANCHORED TAIL, not the whole ledger.
    //
    // This used to be a bare `verifyChain()`, which walks from seq 1 and re-hashes
    // every entry in the system on every click of Verify. That is O(entire ledger)
    // per request on a collection that only ever grows, and the demo alone clicks it
    // repeatedly — so it gets slower for the rest of the presentation each time.
    //
    // The work is also redundant, and light 4 is why. `verifyAnchorForEvidence`
    // recomputes this exhibit's batch Merkle root from the ledger AS IT STANDS NOW
    // and compares it against the root recorded when the batch was sealed: any edit
    // to an anchored entry changes the recomputed root and shows up there. So
    // re-walking anchored history here proves nothing light 4 has not already proved.
    //
    // What the anchor does NOT cover is everything written since the last batch, and
    // that is exactly what this now checks. The two lights together still cover the
    // whole chain; the range checked is reported so the claim stays precise rather
    // than implied.
    const lastBatch = await AnchorBatch.findOne({
      status: { $in: [ANCHOR_STATUS.CONFIRMED, ANCHOR_STATUS.DRY_RUN] },
    })
      .sort({ toSeq: -1 })
      .select('toSeq')
      .lean();

    // Start AT the last anchored entry, not after it, so the first link verified is
    // the one joining anchored history to the tail.
    const chainFrom = lastBatch?.toSeq ? Math.max(1, lastBatch.toSeq) : 1;
    const chain = await verifyChain({ from: chainFrom });
    const chainIntegrity = chain.intact ? CHAIN_INTEGRITY.CHAIN_INTACT : CHAIN_INTEGRITY.CHAIN_BROKEN;

    // ---- light 4: the anchored Merkle root ----
    const anchorResult = await verifyAnchorForEvidence(e);

    await writeAudit(req, {
      action: ACTION.VERIFY,
      resourceType: RESOURCE_TYPE.EVIDENCE,
      resourceId: e._id,
      resourceLabel: e.exhibitCode,
      caseId: e.caseId,
      decision: DECISION.ALLOW,
      reason: fileIntegrity,
    });

    return res.json({
      exhibitCode: e.exhibitCode,
      fileIntegrity,
      signatureValid,
      chainIntegrity,
      anchorIntegrity: anchorResult.status,
      brokenAtSeq: chain.brokenAtSeq,
      chainBreakReason: chain.reason,
      entriesChecked: chain.checked,
      expectedSha256: e.sha256Server,
      recomputedSha256: recomputedSha,
      publishedRoot: anchorResult.publishedRoot,
      computedRoot: anchorResult.computedRoot,
      anchorTxHash: anchorResult.txHash,
      anchorNetwork: env.ANCHOR_NETWORK,
      anchorExplorerUrl: anchorResult.explorerUrl,
      // Whether the root was ever SENT, stated separately from whether it matches.
      // A viewer must be able to tell corroboration from self-consistency without
      // having to know that `ANCHOR_LOCAL_ONLY` means the latter.
      anchorSubmitted: anchorResult.submitted,
      anchorBatchStatus: anchorResult.batchStatus,
      // Exactly which entries light 3 walked. Anything before `chainCheckedFrom` is
      // covered by the anchored Merkle root that light 4 recomputes, not by this walk.
      chainCheckedFrom: chainFrom,
      chainCheckedTo: chain.lastSeq,
      verifiedAt,
      // The nuance worth stating plainly: these lights are independent.
      interpretation: buildInterpretation(fileIntegrity, chainIntegrity, signatureValid),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * The sentence a human should read. A modified file with an intact chain is not a
 * broken system — it is the system working, and saying so precisely matters.
 */
function buildInterpretation(fileIntegrity, chainIntegrity, signatureValid) {
  if (fileIntegrity === FILE_INTEGRITY.FILE_INTACT && chainIntegrity === CHAIN_INTEGRITY.CHAIN_INTACT) {
    return signatureValid
      ? 'The stored file matches its recorded hash, the signature verifies, and the ledger chain is unbroken.'
      : 'The file and ledger are intact, but the uploader signature does not verify. Investigate the signing key.';
  }
  if (fileIntegrity === FILE_INTEGRITY.FILE_MODIFIED && chainIntegrity === CHAIN_INTEGRITY.CHAIN_INTACT) {
    return 'The stored file has been modified since it was recorded. The ledger is intact — so the FILE was touched, not the log. The original hash remains provable.';
  }
  if (fileIntegrity === FILE_INTEGRITY.FILE_MISSING) {
    return 'The stored object is missing. The ledger still holds its hash and history.';
  }
  return 'The ledger chain does not verify. Treat every record after the break as unproven and escalate immediately.';
}

/** Recompute the Merkle root for this evidence's anchor batch and compare. */
async function verifyAnchorForEvidence(e) {
  const empty = {
    status: ANCHOR_INTEGRITY.NOT_ANCHORED,
    publishedRoot: null,
    computedRoot: null,
    txHash: null,
    explorerUrl: null,
    submitted: false,
    batchStatus: null,
  };
  if (!e.ledgerSeq) return empty;

  const entry = await Ledger.findOne({ seq: e.ledgerSeq }).lean();
  if (!entry?.anchorBatchId) return empty;

  const batch = await AnchorBatch.findOne({ batchId: entry.anchorBatchId }).lean();
  if (!batch) return { ...empty, status: ANCHOR_INTEGRITY.ANCHOR_UNAVAILABLE };

  // Recompute from the ledger as it stands NOW. If any entry in the batch changed,
  // the recomputed root diverges from the published one.
  const entries = await Ledger.find({ anchorBatchId: batch.batchId }).sort({ seq: 1 }).lean();
  let computedRoot = null;
  try {
    computedRoot = merkleRoot(entries.map((x) => x.entryHash));
  } catch {
    computedRoot = null;
  }

  const matches = computedRoot && computedRoot.toLowerCase() === batch.merkleRoot.toLowerCase();

  // Also prove this specific entry is a member of the published root.
  let inclusionProven = false;
  if (matches) {
    const idx = entries.findIndex((x) => x.seq === e.ledgerSeq);
    if (idx >= 0) {
      const proof = merkleProof(entries.map((x) => x.entryHash), idx);
      inclusionProven = verifyProof(entry.entryHash, proof, batch.merkleRoot);
    }
  }

  // A batch with no transaction hash was computed and stored HERE and nowhere else.
  // Comparing our recomputed root against our own stored root proves internal
  // consistency and nothing more, so it must not be reported as ANCHOR_MATCH — that
  // state asserts agreement with a root we cannot rewrite, which is the entire point.
  const submitted = Boolean(batch.txHash);

  let status;
  if (!matches || !inclusionProven) status = ANCHOR_INTEGRITY.ANCHOR_MISMATCH;
  else if (!submitted) status = ANCHOR_INTEGRITY.ANCHOR_LOCAL_ONLY;
  else status = ANCHOR_INTEGRITY.ANCHOR_MATCH;

  return {
    status,
    publishedRoot: batch.merkleRoot,
    computedRoot,
    txHash: batch.txHash,
    explorerUrl: submitted ? `${env.ANCHOR_EXPLORER_BASE}/tx/${batch.txHash}` : null,
    submitted,
    batchStatus: batch.status,
  };
}

// ============================================================== streaming ====

/**
 * POST /api/evidence/:id/stream-token
 * Mints a single-use, user-bound download token (ADR-010).
 */
export async function createStreamToken(req, res, next) {
  try {
    const token = randomBase64Url(32);
    await StreamToken.create({
      tokenHash: sha256Hex(token),
      userId: req.user.userId,
      resourceId: req.resource._id,
      purpose: STREAM_PURPOSE.EVIDENCE,
      caseId: req.resource.caseId,
      expiresAt: new Date(Date.now() + env.STREAM_TOKEN_TTL_SEC * 1000),
      issuedIp: req.ip,
    });
    return res.json({ token, expiresInSec: env.STREAM_TOKEN_TTL_SEC });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/evidence/:id/stream?token=
 * Consumes the token atomically, then streams the decrypted bytes.
 */
export async function streamEvidence(req, res, next) {
  try {
    const token = req.query.token;
    if (typeof token !== 'string' || !token) {
      throw Forbidden('STREAM_TOKEN_REQUIRED', 'A download token is required');
    }

    // Atomic consume: a replayed token finds nothing to claim.
    const record = await StreamToken.findOneAndUpdate(
      {
        tokenHash: sha256Hex(token),
        consumedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { consumedAt: new Date() } },
      { new: true }
    );

    if (!record) throw Forbidden('STREAM_TOKEN_INVALID', 'This download link is no longer valid');

    // The token is bound to a user and a resource; both must match this request.
    if (String(record.userId) !== String(req.user.userId)) {
      throw Forbidden('STREAM_TOKEN_WRONG_USER', 'This download link was issued to another user');
    }
    if (String(record.resourceId) !== String(req.resource._id)) {
      throw Forbidden('STREAM_TOKEN_WRONG_RESOURCE', 'This download link is for a different item');
    }

    const e = req.resource;
    if (!objectExists(e.storageKey)) throw NotFound('OBJECT_NOT_FOUND', 'Stored object is missing');

    await writeAudit(req, {
      action: ACTION.DOWNLOAD,
      resourceType: RESOURCE_TYPE.EVIDENCE,
      resourceId: e._id,
      resourceLabel: e.exhibitCode,
      caseId: e.caseId,
      decision: DECISION.ALLOW,
      reason: 'EVIDENCE_DOWNLOAD',
    });

    const dek = unwrapDek(e.encryption, e.caseId);
    const stream = getDecryptedStream(e.storageKey, dek, e.encryption);

    res.setHeader('Content-Type', e.mimeType);
    // `attachment` and nosniff together stop a stored file being rendered as active
    // content in the reviewer's browser.
    res.setHeader('Content-Disposition', `attachment; filename="${e.exhibitCode}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    stream.on('error', (err) => {
      log.error({ err: err.message, exhibitCode: e.exhibitCode }, 'evidence stream failed');
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.on('close', () => dek.fill(0));

    return stream.pipe(res);
  } catch (err) {
    return next(err);
  }
}

// ================================================================= triage ====

/** GET /api/evidence/queue/triage — sorted by review priority. */
export async function triageQueue(req, res, next) {
  try {
    // Same per-exhibit scope as the list. The triage queue additionally exposes
    // `triage.priority`, which `exhibitView` deliberately withholds from an
    // advocate's disclosure pack — so a case-level filter here leaked the one field
    // the disclosure view is careful never to show them.
    const scope = await materialiseScopeFilter(req.user, RESOURCE_TYPE.EVIDENCE);
    if (!scope) return res.json({ queue: [], disclaimer: null });

    // Rank, sort and bound in the database.
    //
    // This was an unbounded find() followed by an in-JavaScript sort, which fetched
    // every exhibit in scope on every request. It cannot simply become
    // `.sort({'triage.priority': 1}).limit(n)` — the values are strings, so a Mongo
    // sort orders them HIGH, LOW, MEDIUM and a limit would then drop MEDIUM before
    // LOW. The rank has to be computed before the sort, which is what this does.
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const items = await Evidence.aggregate([
      { $match: { ...scope, 'triage.priority': { $ne: null } } },
      {
        $addFields: {
          __rank: {
            $switch: {
              branches: [
                { case: { $eq: ['$triage.priority', 'HIGH'] }, then: 0 },
                { case: { $eq: ['$triage.priority', 'MEDIUM'] }, then: 1 },
                { case: { $eq: ['$triage.priority', 'LOW'] }, then: 2 },
              ],
              default: 9,
            },
          },
        },
      },
      { $sort: { __rank: 1, createdAt: -1 } },
      { $limit: limit },
      {
        $project: {
          exhibitCode: 1, title: 1, caseId: 1, triage: 1,
          forensic: 1, mimeType: 1, createdAt: 1,
        },
      },
    ]);

    return res.json({
      queue: items,
      // The label and the disclaimer travel with the data, so no client can render
      // this as anything other than what it is.
      uiLabel: 'Review Priority',
      disclaimer: items[0]?.triage?.disclaimer ?? null,
    });
  } catch (err) {
    return next(err);
  }
}

export default {
  uploadMiddleware,
  uploadCaseContext,
  uploadEvidence,
  getEvidence,
  listEvidence,
  verifyEvidence,
  createStreamToken,
  streamEvidence,
  triageQueue,
};
