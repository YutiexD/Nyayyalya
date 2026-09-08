/**
 * Physical custody: QR labels, the two-scan transfer handshake, and gap detection.
 *
 * # A QR code is identification, never authorization (ADR-011)
 *
 * The HMAC on a label proves Lexx printed it. It is static per item, so anyone who
 * photographs a printed tag can reproduce it forever. Every route below therefore
 * runs `accessResolver` on the item the scan RESOLVED TO — the scan only supplies an
 * id. A genuine tag in the wrong hands opens nothing.
 *
 * # Custody history lives in the ledger, not in this document
 *
 * `CustodyItem` holds current state and the in-flight handshake only. Every movement
 * is an `appendEvent`, so the chain hash covers it and nobody — including this file —
 * can quietly rewrite where an exhibit has been. That is also why gap detection walks
 * the LEDGER rather than a convenient array on the item: a history that could be
 * edited would not be worth checking.
 *
 * # Why the handshake has two scans
 *
 * A one-sided "I handed it over" record is a claim by the person who no longer has
 * the item. Requiring the receiver to present a short-lived token that only they were
 * issued makes both ends of the transfer attested, and makes the record refuse to
 * advance when a physical handover did not actually happen.
 */
import { z } from 'zod';
import mongoose from 'mongoose';

import env from '../config/env.js';
import { Case } from '../models/Case.js';
import { CustodyItem } from '../models/CustodyItem.js';
import { Ledger } from '../models/Ledger.js';
import { User } from '../models/User.js';
import {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  CUSTODY_STATUS,
  CUSTODY_LOCATION,
  CUSTODY_TRANSITIONS,
  RESOURCE_TYPE,
  ACTION,
  DECISION,
  DENY_REASON,
  USER_STATUS,
  values,
} from '../models/enums.js';
import { appendEvent, getSubjectTimeline } from '../services/ledger.js';
import { materialiseScopeFilter } from '../services/accessResolver.js';
import { buildQrPayload, verifyQrPayload } from '../services/qr.js';
import { sha256Hex, randomBase64Url, timingSafeEqualStr } from '../config/crypto.js';
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

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Malformed identifier');

const createItemSchema = z.object({
  // Present so the shape is validated here too; the CASE this binds to was loaded
  // from the database by the resolver, never from this field.
  caseId: objectId,
  evidenceId: objectId.nullish(),
  description: z.string().trim().min(1).max(1000),
  sealNumber: z.string().trim().min(1).max(120),
  identifiers: z
    .object({
      imei: z.string().trim().max(64).nullish(),
      serialNumber: z.string().trim().max(120).nullish(),
    })
    .optional()
    .default({}),
  location: z.enum(values(CUSTODY_LOCATION)).optional().default(CUSTODY_LOCATION.FIELD),
  locationDetail: z.string().trim().max(200).nullish(),
});

const initiateSchema = z.object({
  toUserId: objectId,
  reason: z.string().trim().min(1).max(500),
  toStatus: z.enum(values(CUSTODY_STATUS)),
  toLocation: z.enum(values(CUSTODY_LOCATION)),
});

const acceptSchema = z.object({
  transferToken: z.string().min(16).max(256),
  sealIntact: z.boolean(),
});

// ---------------------------------------------------------------- helpers ----

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Per-item event number, derived from the ledger itself.
 *
 * Recording it in the payload is what makes a MISSING event detectable later: the
 * global `seq` is shared with every other subject, so a hole in this item's story
 * leaves no trace in it. Counting at write time under the ledger's own append lock
 * keeps the numbers dense.
 */
const nextCustodySeq = async (itemId) =>
  (await Ledger.countDocuments({ subjectId: itemId })) + 1;

/** Sequential, human-readable item code: IT-<fir digits>-<nnn>. */
async function nextItemCode(caseDoc) {
  const firPart = String(caseDoc.firNumber).replace(/[^0-9]/g, '') || '0000';
  const count = await CustodyItem.countDocuments({ caseId: caseDoc._id });
  return `IT-${firPart}-${String(count + 1).padStart(3, '0')}`;
}

/** Is `to` reachable from `from` in one lawful move? */
const isLegalTransition = (from, to) => (CUSTODY_TRANSITIONS[from] ?? []).includes(to);

/**
 * The lawful one-hop-away states between `from` and `to`, for the gap report.
 * Everything routes through IN_STORE, so this almost always names the malkhana —
 * which is precisely the point being made.
 */
function intermediateStates(from, to) {
  return (CUSTODY_TRANSITIONS[from] ?? []).filter((mid) => isLegalTransition(mid, to));
}

/**
 * What this viewer could do next. A UI hint computed from state — NOT a decision.
 * Every action listed here is re-authorised by the resolver when it is attempted.
 */
function allowedActions(item, user) {
  const actions = ['VIEW_CHAIN'];
  if (item.frozen) return actions;
  if (sameId(item.currentHolderUserId, user.userId) && (CUSTODY_TRANSITIONS[item.status] ?? []).length) {
    actions.push('INITIATE_TRANSFER');
  }
  if (item.pendingTransfer && sameId(item.pendingTransfer.toUserId, user.userId)) {
    actions.push('ACCEPT_TRANSFER');
  }
  return actions;
}

/** Public projection. The stored token hash never leaves the server. */
function itemView(item) {
  const pending = item.pendingTransfer
    ? {
        toUserId: String(item.pendingTransfer.toUserId),
        fromUserId: String(item.pendingTransfer.fromUserId),
        toStatus: item.pendingTransfer.toStatus,
        toLocation: item.pendingTransfer.toLocation,
        reason: item.pendingTransfer.reason,
        initiatedAt: item.pendingTransfer.initiatedAt,
        expiresAt: item.pendingTransfer.expiresAt,
      }
    : null;

  return {
    id: String(item._id),
    itemCode: item.itemCode,
    caseId: String(item.caseId),
    evidenceId: item.evidenceId ? String(item.evidenceId) : null,
    description: item.description,
    identifiers: item.identifiers ?? {},
    sealNumber: item.sealNumber,
    sealIntact: item.sealIntact,
    stationCode: item.stationCode,
    districtCode: item.districtCode,
    currentHolderUserId: String(item.currentHolderUserId),
    currentLocation: item.currentLocation,
    currentLocationDetail: item.currentLocationDetail ?? null,
    status: item.status,
    frozen: item.frozen,
    frozenReason: item.frozenReason ?? null,
    frozenAt: item.frozenAt ?? null,
    pendingTransfer: pending,
    qrPayload: item.qrPayload,
    createdAt: item.createdAt,
  };
}

/** Record a custody-specific refusal. The resolver audits its own decisions. */
const auditDeny = (req, item, reason) =>
  writeAudit(req, {
    action: ACTION.WRITE,
    resourceType: RESOURCE_TYPE.CUSTODY_ITEM,
    resourceId: item?._id ?? null,
    resourceLabel: item?.itemCode ?? null,
    caseId: item?.caseId ?? null,
    decision: DECISION.DENY,
    reason,
  });

// ================================================================= create ====

/**
 * Authorization context for creating an item: the case, loaded from the database by
 * its id. `resolveCreate` evaluates a WRITE to that case, so station scope, IO
 * assignment and case stage all apply — and the body cannot contribute a
 * `stationCode`, because the only thing it contributes is which case to load.
 */
export async function createItemContext(req) {
  const caseId = req.body?.caseId;
  if (!caseId || !/^[0-9a-fA-F]{24}$/.test(caseId)) {
    throw BadRequest('VALIDATION_FAILED', 'Malformed case id');
  }
  const caseDoc = await Case.findById(caseId).lean();
  if (!caseDoc) throw NotFound('CASE_NOT_FOUND', 'No such case');
  req.custodyCase = caseDoc;
  return { caseId: caseDoc._id, stationCode: caseDoc.stationCode };
}

/**
 * POST /api/custody/items
 *
 * Jurisdiction fields are copied from the case document the policy just authorised,
 * not from the request.
 */
export async function createItem(req, res, next) {
  try {
    const caseDoc = req.custodyCase;
    const body = parse(createItemSchema, req.body);

    if (!sameId(body.caseId, caseDoc._id)) {
      throw BadRequest('CASE_MISMATCH', 'Case id does not match the authorised case');
    }

    const itemCode = await nextItemCode(caseDoc);
    const qrPayload = buildQrPayload(itemCode);

    const item = await CustodyItem.create({
      itemCode,
      caseId: caseDoc._id,
      evidenceId: body.evidenceId ?? null,
      description: body.description,
      identifiers: {
        imei: body.identifiers?.imei ?? null,
        serialNumber: body.identifiers?.serialNumber ?? null,
      },
      sealNumber: body.sealNumber,
      qrPayload,

      // Jurisdiction is inherited from the case, which came from the FIR.
      stationCode: caseDoc.stationCode,
      districtCode: caseDoc.districtCode,

      // Seizure starts in the seizing officer's own hands, in the field.
      currentHolderUserId: req.user.userId,
      currentLocation: body.location,
      currentLocationDetail: body.locationDetail ?? null,
      status: CUSTODY_STATUS.SEIZED,

      createdBy: req.user.userId,
    });

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.CUSTODY_ITEM_CREATED,
      caseId: caseDoc._id,
      subjectId: item._id,
      subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        custodySeq: await nextCustodySeq(item._id),
        itemCode,
        sealNumber: body.sealNumber,
        description: body.description,
        fromStatus: null,
        toStatus: CUSTODY_STATUS.SEIZED,
        toLocation: body.location,
        holderAuthorityId: req.user.authorityId,
        stationCode: caseDoc.stationCode,
      },
    });

    return res.status(201).json({
      item: itemView(item.toObject()),
      // Everything the label printer needs, and nothing that could be mistaken for
      // an authority to move the item.
      qr: {
        payload: qrPayload,
        itemCode,
        printable: {
          itemCode,
          exhibit: body.description,
          sealNumber: body.sealNumber,
          firNumber: caseDoc.firNumber,
          stationCode: caseDoc.stationCode,
          issuedAt: entry.occurredAt,
          notice: 'This label identifies the item. It grants no authority to move it.',
        },
      },
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
    });
  } catch (err) {
    return next(err);
  }
}

// =================================================================== scan ====

/**
 * Middleware for GET /api/custody/scan/:qrToken.
 *
 * Turns a scanned payload into a resource id and stops there. It deliberately makes
 * no access decision: `authorize` runs immediately after it, on the id resolved here.
 */
export async function resolveScannedItem(req, res, next) {
  try {
    const check = verifyQrPayload(req.params.qrToken);
    if (!check.valid) {
      await writeAudit(req, {
        action: ACTION.READ,
        resourceType: RESOURCE_TYPE.CUSTODY_ITEM,
        decision: DECISION.DENY,
        reason: check.reason,
      });
      throw BadRequest('INVALID_OR_FORGED_TAG', 'Invalid or forged tag', { reason: check.reason });
    }

    const item = await CustodyItem.findOne({ itemCode: check.itemCode }).select('_id').lean();
    if (!item) throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');

    req.scannedItemId = String(item._id);
    return next();
  } catch (err) {
    return next(err);
  }
}

/** GET /api/custody/scan/:qrToken — the resolver already authorised this item. */
export async function scanItem(req, res, next) {
  try {
    const item = req.resource;
    return res.json({
      tag: { authentic: true, itemCode: item.itemCode },
      item: itemView(item),
      allowedActions: allowedActions(item, req.user),
      nextStates: item.frozen ? [] : CUSTODY_TRANSITIONS[item.status] ?? [],
      // Stated in the payload so no client can render a scan as permission.
      notice:
        'The label is authentic. Authenticity of the label is not authority over the item; every action is authorised separately.',
    });
  } catch (err) {
    return next(err);
  }
}

// =============================================================== transfer ====

/**
 * The malkhana rule.
 *
 * An investigating officer may seize and may hand over, but may not be the store
 * keeper for evidence in their own case: the person who benefits from the exhibit
 * cannot also be the only person who can account for it. `caseDoc.ioUserId` is the
 * database's record of who the IO is, not a claim in the request.
 */
function violatesIoCustodyRule(caseDoc, recipientUserId, toStatus) {
  return toStatus === CUSTODY_STATUS.IN_STORE && sameId(caseDoc?.ioUserId, recipientUserId);
}

/**
 * POST /api/custody/items/:id/initiate-transfer
 * Scan one of two. Returns a token whose SHA-256 is all we keep.
 */
export async function initiateTransfer(req, res, next) {
  try {
    const item = req.resource;
    const caseDoc = req.caseDoc;
    const body = parse(initiateSchema, req.body);

    if (item.frozen) {
      await auditDeny(req, item, DENY_REASON.CUSTODY_FROZEN);
      throw Forbidden(
        DENY_REASON.CUSTODY_FROZEN,
        'Custody of this item is frozen after an integrity exception. An SHO must act before it can move again.'
      );
    }

    // Only the person actually holding the item can hand it on. The resolver proved
    // this user may touch the item; it does not know who is carrying it.
    if (!sameId(item.currentHolderUserId, req.user.userId)) {
      await auditDeny(req, item, DENY_REASON.NOT_CURRENT_HOLDER);
      throw Forbidden(DENY_REASON.NOT_CURRENT_HOLDER, 'Only the current holder can transfer this item');
    }

    if (!isLegalTransition(item.status, body.toStatus)) {
      throw Conflict(
        'ILLEGAL_CUSTODY_TRANSITION',
        `An item cannot move from ${item.status} to ${body.toStatus}`,
        {
          from: item.status,
          to: body.toStatus,
          permitted: CUSTODY_TRANSITIONS[item.status] ?? [],
          via: intermediateStates(item.status, body.toStatus),
        }
      );
    }

    const recipient = await User.findById(body.toUserId).lean();
    if (!recipient || recipient.status !== USER_STATUS.ACTIVE) {
      throw BadRequest('RECIPIENT_NOT_AVAILABLE', 'That recipient cannot take custody');
    }

    if (violatesIoCustodyRule(caseDoc, recipient._id, body.toStatus)) {
      await auditDeny(req, item, DENY_REASON.IO_CANNOT_HOLD_OWN_CASE_EVIDENCE);
      throw Forbidden(
        DENY_REASON.IO_CANNOT_HOLD_OWN_CASE_EVIDENCE,
        'The investigating officer on a case cannot be the store keeper for its own evidence'
      );
    }

    // One handshake at a time. An unexpired pending transfer is a handover already in
    // progress, and silently replacing it would strand whoever holds the live token.
    const now = new Date();
    if (item.pendingTransfer && new Date(item.pendingTransfer.expiresAt) > now) {
      throw Conflict('TRANSFER_ALREADY_PENDING', 'A transfer of this item is already awaiting acceptance', {
        expiresAt: item.pendingTransfer.expiresAt,
      });
    }

    const token = randomBase64Url(32);
    const expiresAt = new Date(now.getTime() + env.TRANSFER_TOKEN_TTL_SEC * 1000);

    // Guarded on the state we validated against, so a concurrent transfer cannot slip
    // in between the checks above and this write.
    const updated = await CustodyItem.findOneAndUpdate(
      {
        _id: item._id,
        status: item.status,
        frozen: false,
        currentHolderUserId: req.user.userId,
      },
      {
        $set: {
          pendingTransfer: {
            tokenHash: sha256Hex(token),
            toUserId: recipient._id,
            fromUserId: req.user.userId,
            toStatus: body.toStatus,
            toLocation: body.toLocation,
            reason: body.reason,
            initiatedAt: now,
            expiresAt,
          },
        },
      },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The item changed while initiating. Try again.');

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.CUSTODY_TRANSFER_INITIATED,
      caseId: item.caseId,
      subjectId: item._id,
      subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        custodySeq: await nextCustodySeq(item._id),
        itemCode: item.itemCode,
        // The token itself is never written anywhere, including here.
        fromAuthorityId: req.user.authorityId,
        toAuthorityId: recipient.authorityId,
        proposedStatus: body.toStatus,
        proposedLocation: body.toLocation,
        reason: body.reason,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return res.status(201).json({
      // Shown once. We keep only its hash, so a database dump cannot complete a handover.
      transferToken: token,
      expiresAt,
      expiresInSec: env.TRANSFER_TOKEN_TTL_SEC,
      item: itemView(updated.toObject()),
      ledgerSeq: entry.seq,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/custody/items/:id/accept-transfer
 * Scan two of two. The token is consumed atomically, so it works exactly once.
 */
export async function acceptTransfer(req, res, next) {
  try {
    const item = req.resource;
    const caseDoc = req.caseDoc;
    const body = parse(acceptSchema, req.body);
    const now = new Date();

    const pending = item.pendingTransfer ?? null;

    // "No transfer pending" and "wrong token" answer identically: a replayed token
    // must not reveal whether a fresh handover is in flight.
    if (!pending || !timingSafeEqualStr(pending.tokenHash, sha256Hex(body.transferToken))) {
      await auditDeny(req, item, 'TRANSFER_TOKEN_INVALID');
      throw Forbidden('TRANSFER_TOKEN_INVALID', 'This transfer token is not valid');
    }

    if (new Date(pending.expiresAt) <= now) {
      await auditDeny(req, item, 'TRANSFER_TOKEN_EXPIRED');
      throw Forbidden(
        'TRANSFER_TOKEN_EXPIRED',
        'This transfer token has expired. The holder must initiate the handover again.'
      );
    }

    // Holding the token is not enough: it was issued TO someone.
    if (!sameId(pending.toUserId, req.user.userId)) {
      await auditDeny(req, item, 'TRANSFER_WRONG_RECIPIENT');
      throw Forbidden('TRANSFER_WRONG_RECIPIENT', 'This transfer was not addressed to you');
    }

    if (item.frozen) {
      await auditDeny(req, item, DENY_REASON.CUSTODY_FROZEN);
      throw Forbidden(DENY_REASON.CUSTODY_FROZEN, 'Custody of this item is frozen');
    }

    // Re-checked at acceptance, not only at initiation: the case may have been
    // reassigned in between, and the rule is about who ends up holding the item.
    if (violatesIoCustodyRule(caseDoc, req.user.userId, pending.toStatus)) {
      await auditDeny(req, item, DENY_REASON.IO_CANNOT_HOLD_OWN_CASE_EVIDENCE);
      throw Forbidden(
        DENY_REASON.IO_CANNOT_HOLD_OWN_CASE_EVIDENCE,
        'The investigating officer on a case cannot be the store keeper for its own evidence'
      );
    }

    if (!isLegalTransition(item.status, pending.toStatus)) {
      throw Conflict(
        'ILLEGAL_CUSTODY_TRANSITION',
        `An item cannot move from ${item.status} to ${pending.toStatus}`,
        { from: item.status, to: pending.toStatus, via: intermediateStates(item.status, pending.toStatus) }
      );
    }

    /**
     * A broken seal does not undo the handover — the item is physically in the
     * receiver's hands and the record must say so. What it does is freeze the item:
     * the state moves once more and then stops, until an SHO records a decision.
     * Recording the move and refusing to pretend it did not happen is the honest
     * reading of a broken seal.
     */
    const broken = body.sealIntact === false;

    const consumed = await CustodyItem.findOneAndUpdate(
      {
        _id: item._id,
        status: item.status,
        frozen: false,
        // The atomic consume. A replay finds no document with this token hash.
        'pendingTransfer.tokenHash': pending.tokenHash,
        'pendingTransfer.toUserId': req.user.userId,
        'pendingTransfer.expiresAt': { $gt: now },
      },
      {
        $set: {
          currentHolderUserId: req.user.userId,
          status: pending.toStatus,
          currentLocation: pending.toLocation,
          sealIntact: !broken,
          pendingTransfer: null,
          ...(broken
            ? { frozen: true, frozenReason: 'SEAL_BROKEN_ON_ACCEPTANCE', frozenAt: now }
            : {}),
        },
      },
      { new: true }
    );

    if (!consumed) {
      // Lost the race, or the token was consumed a moment ago. Same answer either way.
      await auditDeny(req, item, 'TRANSFER_TOKEN_INVALID');
      throw Forbidden('TRANSFER_TOKEN_INVALID', 'This transfer token is not valid');
    }

    const transferEntry = await appendEvent({
      eventType: LEDGER_EVENT.CUSTODY_TRANSFERRED,
      caseId: item.caseId,
      subjectId: item._id,
      subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        custodySeq: await nextCustodySeq(item._id),
        itemCode: item.itemCode,
        fromStatus: item.status,
        toStatus: pending.toStatus,
        toLocation: pending.toLocation,
        fromUserId: String(pending.fromUserId),
        toAuthorityId: req.user.authorityId,
        reason: pending.reason,
        sealNumber: item.sealNumber,
        sealIntact: !broken,
      },
    });

    let exceptionEntry = null;
    if (broken) {
      exceptionEntry = await appendEvent({
        eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION,
        caseId: item.caseId,
        subjectId: item._id,
        subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        payload: {
          custodySeq: await nextCustodySeq(item._id),
          stage: 'CUSTODY_ACCEPTANCE',
          reason: 'SEAL_BROKEN',
          itemCode: item.itemCode,
          sealNumber: item.sealNumber,
          reportedByAuthorityId: req.user.authorityId,
          frozen: true,
        },
      });

      await writeAudit(req, {
        action: ACTION.WRITE,
        resourceType: RESOURCE_TYPE.CUSTODY_ITEM,
        resourceId: item._id,
        resourceLabel: item.itemCode,
        caseId: item.caseId,
        decision: DECISION.ALLOW,
        reason: 'INTEGRITY_EXCEPTION_SEAL_BROKEN',
      });
    }

    return res.json({
      item: itemView(consumed.toObject()),
      frozen: broken,
      integrityException: broken
        ? {
            reason: 'SEAL_BROKEN',
            ledgerSeq: exceptionEntry.seq,
            entryHash: exceptionEntry.entryHash,
            message:
              'The seal was reported broken on acceptance. Custody is frozen and no further transfer is permitted until an SHO records a decision.',
          }
        : null,
      ledgerSeq: transferEntry.seq,
      entryHash: transferEntry.entryHash,
    });
  } catch (err) {
    return next(err);
  }
}

// ================================================================== chain ====

/** GET /api/custody/items/:id/chain — the full timeline, straight from the ledger. */
export async function getChain(req, res, next) {
  try {
    const item = req.resource;
    const entries = await getSubjectTimeline(item._id);
    const analysis = analyseChain(item, entries);

    return res.json({
      item: itemView(item),
      events: entries.map((e) => ({
        seq: e.seq,
        custodySeq: e.payload?.custodySeq ?? null,
        eventType: e.eventType,
        actorRole: e.actorRole,
        occurredAt: e.occurredAt,
        payload: e.payload,
        entryHash: e.entryHash,
        prevHash: e.prevHash,
        anchorBatchId: e.anchorBatchId,
      })),
      analysis,
    });
  } catch (err) {
    return next(err);
  }
}

// =========================================================== gap detection ====

/** Events that move an item from one custody state to another. */
const STATE_CHANGING = new Set([LEDGER_EVENT.CUSTODY_ITEM_CREATED, LEDGER_EVENT.CUSTODY_TRANSFERRED]);

/**
 * Walk one item's ledger history and report what is wrong with it.
 *
 * Structured findings rather than a boolean, because "this chain is broken" is not
 * actionable and "SEIZED to AT_FSL at seq 41 with no IN_STORE in between" is. Each
 * finding names the event it was found at, so a supervisor can go and ask about that
 * specific movement.
 */
export function analyseChain(item, entries) {
  const findings = [];
  const add = (code, detail, entry = null) =>
    findings.push({
      code,
      detail,
      ledgerSeq: entry?.seq ?? null,
      custodySeq: entry?.payload?.custodySeq ?? null,
      occurredAt: entry?.occurredAt ?? null,
    });

  if (entries.length === 0) {
    add('NO_LEDGER_HISTORY', 'This item has no custody events in the ledger at all.');
    return summarise(item, findings, null);
  }

  if (entries[0].eventType !== LEDGER_EVENT.CUSTODY_ITEM_CREATED) {
    add('MISSING_GENESIS_EVENT', 'The recorded history does not begin with the seizure of this item.', entries[0]);
  }

  let previousAt = null;
  let expectedCustodySeq = 1;
  let state = null;

  for (const e of entries) {
    // ---- timestamp inversions ----
    const at = new Date(e.occurredAt);
    if (previousAt && at < previousAt) {
      add(
        'TIMESTAMP_INVERSION',
        `This event is recorded at ${at.toISOString()}, before the event that precedes it in the chain.`,
        e
      );
    }
    previousAt = at;

    // ---- sequence discontinuities ----
    const cs = e.payload?.custodySeq;
    if (!Number.isInteger(cs)) {
      add('UNSEQUENCED_EVENT', 'This event carries no custody sequence number, so a gap around it cannot be excluded.', e);
    } else if (cs !== expectedCustodySeq) {
      add(
        'SEQUENCE_DISCONTINUITY',
        `Expected custody event ${expectedCustodySeq} for this item, found ${cs}. ${
          cs > expectedCustodySeq ? `${cs - expectedCustodySeq} event(s) are missing.` : 'An event is out of order.'
        }`,
        e
      );
      expectedCustodySeq = cs;
    }
    expectedCustodySeq += 1;

    if (e.eventType === LEDGER_EVENT.INTEGRITY_EXCEPTION) {
      add('INTEGRITY_EXCEPTION_RECORDED', `An integrity exception is recorded against this item: ${e.payload?.reason ?? 'unspecified'}.`, e);
    }

    if (!STATE_CHANGING.has(e.eventType)) continue;

    // ---- illegal state jumps ----
    const from = e.payload?.fromStatus ?? null;
    const to = e.payload?.toStatus ?? null;

    if (!to) {
      add('UNRECORDED_STATE', 'A movement was recorded without the state it moved to.', e);
      continue;
    }

    if (state !== null && from !== state) {
      add(
        'STATE_DISCONTINUITY',
        `This event records a move from ${from ?? 'no recorded state'}, but the item was last recorded as ${state}.`,
        e
      );
    }

    if (from) {
      if (!isLegalTransition(from, to)) {
        const via = intermediateStates(from, to);
        add(
          'ILLEGAL_STATE_TRANSITION',
          `${from} → ${to} is not a lawful custody move.${
            via.length ? ` A lawful route would have passed through ${via.join(' or ')}.` : ''
          }`,
          e
        );
      }
    }

    state = to;
  }

  // The record and its own history must agree.
  if (state && state !== item.status) {
    add('STATE_DIVERGENCE', `The ledger's last recorded state is ${state}, but the item record says ${item.status}.`);
  }

  return summarise(item, findings, state);
}

function summarise(item, findings, ledgerState) {
  return {
    itemId: String(item._id),
    itemCode: item.itemCode,
    caseId: String(item.caseId),
    recordedStatus: item.status,
    ledgerStatus: ledgerState,
    frozen: Boolean(item.frozen),
    sealIntact: item.sealIntact !== false,
    intact: findings.length === 0,
    findingCount: findings.length,
    findings,
  };
}

/**
 * GET /api/custody/gaps?caseId=
 *
 * Supervisory view. The scope filter comes from the resolver and is intersected,
 * never replaced — a caseId the caller cannot see yields nothing rather than an
 * unfiltered scan.
 */
/**
 * GET /api/custody/items[?caseId=&status=&limit=]
 *
 * The custody register: what this user's scope actually contains.
 *
 * Added because there was no way to SEE a custody item. Every other custody route
 * addresses one item — by id, or by scanning its QR label — so a malkhana custodian
 * could accept a transfer for an item someone handed them, and could not answer
 * "what am I holding?" at all. `/gaps` was the only listing, and it returns only the
 * chains with findings, which is the exceptions, not the register.
 *
 * The scope filter comes from the resolver and is intersected, never replaced, so a
 * custodian sees their station, an SHO their station, a District SP their district —
 * and counsel and examiners, who hold no custody scope, see nothing.
 */
export async function listItems(req, res, next) {
  try {
    // Materialise: the raw filter can carry a sentinel that only the resolver knows
    // how to turn into a real query, and for a custody item that resolution is what
    // maps case-shaped scope onto `caseId`. `null` means "sees nothing", which is an
    // empty result — never an unfiltered query.
    const filter = await materialiseScopeFilter(req.user, RESOURCE_TYPE.CUSTODY_ITEM);
    if (!filter) return res.json({ items: [], total: 0 });

    const query = { ...filter };
    if (req.query.caseId !== undefined) {
      const caseId = parse(objectId, req.query.caseId);
      query.caseId = new mongoose.Types.ObjectId(caseId);
    }
    if (req.query.status !== undefined) {
      query.status = parse(z.enum(Object.values(CUSTODY_STATUS)), req.query.status);
    }

    const items = await CustodyItem.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200))
      .lean();

    return res.json({ items: items.map(itemView), total: items.length });
  } catch (err) {
    return next(err);
  }
}

export async function listGaps(req, res, next) {
  try {
    // A null filter means "this user sees nothing", which renders as an empty result
    // rather than an unfiltered query. An examiner and an advocate hold no custody
    // scope at all, so the resolver returns null for them and they land here.
    const filter = await materialiseScopeFilter(req.user, RESOURCE_TYPE.CUSTODY_ITEM);
    if (!filter) {
      return res.json({ items: [], total: 0, withFindings: 0, broken: [] });
    }

    const query = { ...filter };
    if (req.query.caseId !== undefined) {
      const caseId = parse(objectId, req.query.caseId);
      query.caseId = new mongoose.Types.ObjectId(caseId);
    }

    const items = await CustodyItem.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200))
      .lean();

    // One grouped read, not one per item. This was `for (const item of items)
    // { ... await getSubjectTimeline(item._id) }`, which serialised up to 200 round
    // trips — each hitting the same {subjectId, seq} index that a single $in covers.
    const entries = await Ledger.find({ subjectId: { $in: items.map((i) => i._id) } })
      .sort({ seq: 1 })
      .lean();

    const bySubject = new Map();
    for (const entry of entries) {
      const key = String(entry.subjectId);
      const bucket = bySubject.get(key);
      if (bucket) bucket.push(entry);
      else bySubject.set(key, [entry]);
    }

    // analyseChain is synchronous, so nothing else here needs to await.
    const reports = items.map((item) => analyseChain(item, bySubject.get(String(item._id)) ?? []));

    const withFindings = reports.filter((r) => !r.intact);
    return res.json({
      items: reports,
      total: reports.length,
      withFindings: withFindings.length,
      // The list a supervisor actually wants to look at first.
      broken: withFindings.map((r) => r.itemCode),
    });
  } catch (err) {
    return next(err);
  }
}

export default {
  createItemContext,
  createItem,
  resolveScannedItem,
  scanItem,
  initiateTransfer,
  acceptTransfer,
  getChain,
  listGaps,
  analyseChain,
};
