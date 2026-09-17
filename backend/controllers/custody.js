/**
 * Physical custody: register an article, record where it goes, detect gaps.
 *
 * # The journey, in the words a person uses
 *
 *   Evidence registered → Physical custody recorded → Movement recorded → (FSL
 *   examination, if required) → Status updated
 *
 * Registering an article books it on its case (and, where it is the source of a
 * digital exhibit, against that exhibit) and prints its QR label. Every movement after
 * that — into the station store, to the laboratory, to court, back, returned, destroyed
 * — is ONE act by an officer entitled to record it: a destination, a reason, who has it
 * now, and whether the seal is intact.
 *
 * What was removed, and why it was safe to remove: a two-scan handshake in which every
 * movement waited for a second person to redeem a short-lived token, and a rule that
 * every article pass back through the station store. Neither made the chain more
 * provable — the proof is the ledger entry, which is signed by the session that made
 * it, hash-chained and anchored — and both made the chain slower to record than the
 * paper register it replaces, so movements went unrecorded.
 *
 * # What still protects the chain
 *
 *   - Every movement and every registration is an `appendEvent`, so the history is the
 *     hash-chained ledger and nobody can quietly rewrite where an article has been.
 *   - Only lawful moves are accepted (CUSTODY_TRANSITIONS), and only by someone who may
 *     record them: police at the article's station; a laboratory or a court only for an
 *     article currently with it (resolver).
 *   - A broken seal freezes the article until the SHO records a decision.
 *   - Gap detection walks the LEDGER and reports missing events, state divergence and
 *     timestamp inversions.
 *
 * # A QR code is identification, never authorization (ADR-011)
 *
 * The HMAC on a label proves Lexx printed it. Every route runs the resolver on the
 * item the scan RESOLVED TO.
 */
import { z } from 'zod';
import mongoose from 'mongoose';

import env from '../config/env.js';
import { Case } from '../models/Case.js';
import { CustodyItem } from '../models/CustodyItem.js';
import { Evidence } from '../models/Evidence.js';
import { Ledger } from '../models/Ledger.js';
import { User } from '../models/User.js';
import {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  CUSTODY_STATUS,
  CUSTODY_LOCATION,
  CUSTODY_LOCATION_FOR_STATUS,
  CUSTODY_TRANSITIONS,
  RESOURCE_TYPE,
  ACTION,
  AUTHORITY,
  DECISION,
  DENY_REASON,
  ROLE,
  values,
} from '../models/enums.js';
import { appendEvent, getSubjectTimeline } from '../services/ledger.js';
import { materialiseScopeFilter } from '../services/accessResolver.js';
import { buildQrPayload, verifyQrPayload } from '../services/qr.js';
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
  /** Registered where it was seized, or booked straight into the station store. */
  initialStatus: z.enum([CUSTODY_STATUS.SEIZED, CUSTODY_STATUS.IN_STORE]).optional().default(CUSTODY_STATUS.SEIZED),
  /** Accepted for older clients and ignored: location is derived from status. */
  location: z.enum(values(CUSTODY_LOCATION)).optional(),
  locationDetail: z.string().trim().max(200).nullish(),
  custodian: z.string().trim().max(200).nullish(),
});

const moveSchema = z.object({
  toStatus: z.enum(values(CUSTODY_STATUS)),
  reason: z.string().trim().min(3, 'Say why the article is moving').max(500),
  /** Who has it now, as a person would write it in a register. */
  custodian: z.string().trim().max(200).nullish(),
  locationDetail: z.string().trim().max(200).nullish(),
  sealIntact: z.boolean(),
});

const liftFreezeSchema = z.object({
  /** The supervisor's recorded decision. Required: a freeze lifted without a reason is a gap. */
  note: z.string().trim().min(10, 'State the decision and its basis').max(1000),
  /** Re-sealed after inspection under a new seal, if it was. */
  newSealNumber: z.string().trim().min(1).max(120).optional(),
});

// ---------------------------------------------------------------- helpers ----

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Per-item event number, derived from the ledger itself. Recording it in the payload
 * is what makes a MISSING event detectable later.
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

/** The lawful one-hop-away states between `from` and `to`, for the gap report. */
function intermediateStates(from, to) {
  return (CUSTODY_TRANSITIONS[from] ?? []).filter((mid) => isLegalTransition(mid, to));
}

/** Who has the article after a move, when the recorder did not say. */
function defaultCustodian(toStatus, caseDoc, user) {
  switch (toStatus) {
    case CUSTODY_STATUS.IN_STORE:
      return `Station store, ${caseDoc?.stationCode ?? user.scope?.stationCode ?? ''}`.trim();
    case CUSTODY_STATUS.AT_FSL:
      return user.scope?.labId ? `Forensic laboratory ${user.scope.labId}` : 'Forensic Science Laboratory';
    case CUSTODY_STATUS.IN_COURT:
      return caseDoc?.courtName ?? 'Court';
    case CUSTODY_STATUS.RETURNED:
      return 'Returned to the rightful owner';
    case CUSTODY_STATUS.DESTROYED:
      return 'Destroyed under order';
    default:
      return user.name ?? null;
  }
}

/**
 * What this viewer could do next. A UI hint computed from state — NOT a decision.
 * Every action listed here is re-authorised by the resolver when it is attempted.
 */
function allowedActions(item, user) {
  const actions = ['VIEW_CHAIN'];
  if (item.frozen) {
    if (user.role === ROLE.SHO) actions.push('LIFT_FREEZE');
    return actions;
  }
  const canMoveHere =
    user.authority === AUTHORITY.POLICE
      ? user.role !== ROLE.DISTRICT_SP
      : user.authority === AUTHORITY.FSL
        ? item.status === CUSTODY_STATUS.AT_FSL
        : user.authority === AUTHORITY.COURT
          ? item.status === CUSTODY_STATUS.IN_COURT
          : false;
  if (canMoveHere && (CUSTODY_TRANSITIONS[item.status] ?? []).length) actions.push('RECORD_MOVEMENT');
  return actions;
}

/** Public projection. */
function itemView(item) {
  return {
    id: String(item._id),
    itemCode: item.itemCode,
    caseId: String(item.caseId),
    evidenceId: item.evidenceId ? String(item.evidenceId) : null,
    description: item.description,
    identifiers: item.identifiers ?? {},
    sealNumber: item.sealNumber,
    sealIntact: item.sealIntact,
    duplicateLegacy: Boolean(item.duplicateLegacy),
    stationCode: item.stationCode,
    districtCode: item.districtCode,
    currentHolderUserId: String(item.currentHolderUserId),
    custodian: item.custodian ?? null,
    currentLocation: item.currentLocation,
    currentLocationDetail: item.currentLocationDetail ?? null,
    status: item.status,
    lastMovedAt: item.lastMovedAt ?? item.createdAt ?? null,
    frozen: item.frozen,
    frozenReason: item.frozenReason ?? null,
    frozenAt: item.frozenAt ?? null,
    nextStates: item.frozen ? [] : CUSTODY_TRANSITIONS[item.status] ?? [],
    qrPayload: item.qrPayload,
    labelUrl: labelUrlFor(item.qrPayload),
    createdAt: item.createdAt,
  };
}

/** What the QR on a printed label encodes: the client's scan page, carrying the signed payload. */
function labelUrlFor(qrPayload) {
  return qrPayload ? `${env.PUBLIC_WEB_URL}/scan?label=${encodeURIComponent(qrPayload)}` : null;
}

/**
 * Items as a person reads them off a register: with the FIR and exhibit they belong
 * to, and the named officer who recorded the latest movement. Batched reads.
 */
async function decorateItems(items) {
  if (!items.length) return [];
  const [cases, users, exhibits] = await Promise.all([
    Case.find({ _id: { $in: [...new Set(items.map((i) => String(i.caseId)))] } })
      .select('_id firNumber cnrNumber stationCode title courtName')
      .lean(),
    User.find({
      _id: {
        $in: [
          ...new Set(items.flatMap((i) => [i.currentHolderUserId, i.createdBy]).filter(Boolean).map(String)),
        ],
      },
    })
      .select('_id name authorityId role')
      .lean(),
    Evidence.find({ _id: { $in: items.map((i) => i.evidenceId).filter(Boolean) } })
      .select('_id exhibitCode title')
      .lean(),
  ]);
  const caseById = new Map(cases.map((c) => [String(c._id), c]));
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const exhibitById = new Map(exhibits.map((e) => [String(e._id), e]));
  const person = (id) => {
    const u = id ? userById.get(String(id)) : null;
    return u ? { userId: String(u._id), name: u.name, authorityId: u.authorityId, role: u.role } : null;
  };

  return items.map((item) => {
    const c = caseById.get(String(item.caseId));
    const ex = item.evidenceId ? exhibitById.get(String(item.evidenceId)) : null;
    return {
      ...itemView(item),
      firNumber: c?.firNumber ?? null,
      cnrNumber: c?.cnrNumber ?? null,
      exhibitCode: ex?.exhibitCode ?? null,
      exhibitTitle: ex?.title ?? null,
      recordedBy: person(item.currentHolderUserId),
      bookedBy: person(item.createdBy),
    };
  });
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

// =============================================================== register ====

/**
 * Authorization context for registering an item: the case, loaded from the database
 * by its id. `resolveCreate` evaluates a WRITE to that case, so station scope, IO
 * assignment and case stage all apply.
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
 * Register a physical article on its case. Jurisdiction fields come from the case the
 * policy just authorised. A linked exhibit must belong to the same case and have no
 * other article; a seal number may be registered once per case.
 */
export async function createItem(req, res, next) {
  try {
    const caseDoc = req.custodyCase;
    const body = parse(createItemSchema, req.body);

    if (!sameId(body.caseId, caseDoc._id)) {
      throw BadRequest('CASE_MISMATCH', 'Case id does not match the authorised case');
    }

    let exhibit = null;
    if (body.evidenceId) {
      exhibit = await Evidence.findById(body.evidenceId).select('_id caseId exhibitCode').lean();
      if (!exhibit || !sameId(exhibit.caseId, caseDoc._id)) {
        throw BadRequest('EVIDENCE_NOT_IN_CASE', 'That exhibit does not belong to this case');
      }
      const linked = await CustodyItem.findOne({ evidenceId: exhibit._id }).select('itemCode').lean();
      if (linked) {
        throw Conflict('EXHIBIT_ALREADY_HAS_ARTICLE', `Exhibit ${exhibit.exhibitCode} is already linked to article ${linked.itemCode}`, {
          itemCode: linked.itemCode,
        });
      }
    }

    const sealTaken = await CustodyItem.findOne({
      caseId: caseDoc._id,
      sealNumber: body.sealNumber,
      duplicateLegacy: false,
    })
      .select('itemCode')
      .lean();
    if (sealTaken) {
      throw Conflict('DUPLICATE_SEAL', `Seal ${body.sealNumber} is already registered on this case as ${sealTaken.itemCode}`, {
        itemCode: sealTaken.itemCode,
      });
    }

    const itemCode = await nextItemCode(caseDoc);
    const qrPayload = buildQrPayload(itemCode);
    const status = body.initialStatus;
    const now = new Date();
    const custodian = body.custodian || (status === CUSTODY_STATUS.IN_STORE ? defaultCustodian(status, caseDoc, req.user) : req.user.name);

    let item;
    try {
      item = await CustodyItem.create({
        itemCode,
        caseId: caseDoc._id,
        evidenceId: exhibit?._id ?? null,
        description: body.description,
        identifiers: {
          imei: body.identifiers?.imei ?? null,
          serialNumber: body.identifiers?.serialNumber ?? null,
        },
        sealNumber: body.sealNumber,
        qrPayload,
        stationCode: caseDoc.stationCode,
        districtCode: caseDoc.districtCode,
        currentHolderUserId: req.user.userId,
        custodian,
        currentLocation: CUSTODY_LOCATION_FOR_STATUS[status],
        currentLocationDetail: body.locationDetail ?? null,
        lastMovedAt: now,
        status,
        createdBy: req.user.userId,
      });
    } catch (err) {
      if (err?.code === 11000) {
        throw Conflict('DUPLICATE_ARTICLE', 'This article is already registered (same seal on this case, or the exhibit already has an article).');
      }
      throw err;
    }

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
        evidenceId: exhibit ? String(exhibit._id) : null,
        exhibitCode: exhibit?.exhibitCode ?? null,
        sealNumber: body.sealNumber,
        description: body.description,
        fromStatus: null,
        toStatus: status,
        toLocation: CUSTODY_LOCATION_FOR_STATUS[status],
        custodian,
        holderAuthorityId: req.user.authorityId,
        stationCode: caseDoc.stationCode,
      },
    });

    return res.status(201).json({
      item: (await decorateItems([item.toObject()]))[0],
      qr: {
        payload: qrPayload,
        url: labelUrlFor(qrPayload),
        itemCode,
        printable: {
          itemCode,
          exhibit: body.description,
          exhibitCode: exhibit?.exhibitCode ?? null,
          sealNumber: body.sealNumber,
          identifiers: item.identifiers ?? {},
          firNumber: caseDoc.firNumber,
          stationCode: caseDoc.stationCode,
          seizedBy: `${req.user.name ?? ''} (${req.user.authorityId})`.trim(),
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
 * Middleware for GET /api/custody/scan/:qrToken. Turns a scanned payload into a
 * resource id and stops there; `authorize` runs next on that id.
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
      item: (await decorateItems([item]))[0],
      allowedActions: allowedActions(item, req.user),
      nextStates: item.frozen ? [] : CUSTODY_TRANSITIONS[item.status] ?? [],
      notice:
        'The label is authentic. Authenticity of the label is not authority over the item; every action is authorised separately.',
    });
  } catch (err) {
    return next(err);
  }
}

// =============================================================== movement ====

/**
 * POST /api/custody/items/:id/move   { toStatus, reason, sealIntact, custodian?, locationDetail? }
 *
 * Record one physical movement, in one step. The resolver has established that this
 * session may record a movement of this article (police at its station; a laboratory
 * or court only while the article is with them). This checks the move is lawful, that
 * the article is not frozen, writes the new state guarded on the old one, and appends
 * the ledger entry. A broken seal still records the move — the article is where it is
 * — and then freezes it for the SHO.
 */
export async function moveItem(req, res, next) {
  try {
    const item = req.resource;
    const caseDoc = req.caseDoc;
    const body = parse(moveSchema, req.body);

    if (item.frozen) {
      await auditDeny(req, item, DENY_REASON.CUSTODY_FROZEN);
      throw Forbidden(
        DENY_REASON.CUSTODY_FROZEN,
        'Custody of this item is frozen after a seal exception. The SHO must record a decision before it can move again.'
      );
    }

    if (!isLegalTransition(item.status, body.toStatus)) {
      throw Conflict(
        'ILLEGAL_CUSTODY_TRANSITION',
        `An article cannot move from ${item.status} to ${body.toStatus}`,
        { from: item.status, to: body.toStatus, permitted: CUSTODY_TRANSITIONS[item.status] ?? [] }
      );
    }

    const broken = body.sealIntact === false;
    const toLocation = CUSTODY_LOCATION_FOR_STATUS[body.toStatus];
    const custodian = body.custodian || defaultCustodian(body.toStatus, caseDoc, req.user);
    const now = new Date();

    const updated = await CustodyItem.findOneAndUpdate(
      { _id: item._id, status: item.status, frozen: false },
      {
        $set: {
          status: body.toStatus,
          currentLocation: toLocation,
          currentLocationDetail: body.locationDetail ?? null,
          custodian,
          currentHolderUserId: req.user.userId,
          lastMovedAt: now,
          sealIntact: !broken,
          ...(broken ? { frozen: true, frozenReason: 'SEAL_BROKEN_ON_MOVEMENT', frozenAt: now } : {}),
        },
      },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The article changed while this movement was being recorded. Try again.');

    const movement = await appendEvent({
      eventType: LEDGER_EVENT.CUSTODY_TRANSFERRED,
      caseId: item.caseId,
      subjectId: item._id,
      subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        custodySeq: await nextCustodySeq(item._id),
        itemCode: item.itemCode,
        evidenceId: item.evidenceId ? String(item.evidenceId) : null,
        fromStatus: item.status,
        toStatus: body.toStatus,
        toLocation,
        custodian,
        locationDetail: body.locationDetail ?? null,
        reason: body.reason,
        sealNumber: item.sealNumber,
        sealIntact: !broken,
        recordedByAuthorityId: req.user.authorityId,
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
          stage: 'CUSTODY_MOVEMENT',
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
      item: (await decorateItems([updated.toObject()]))[0],
      frozen: broken,
      integrityException: broken
        ? {
            reason: 'SEAL_BROKEN',
            ledgerSeq: exceptionEntry.seq,
            entryHash: exceptionEntry.entryHash,
            message:
              'The seal was reported broken. The movement is recorded, and the article is frozen until the SHO records a decision.',
          }
        : null,
      ledgerSeq: movement.seq,
      entryHash: movement.entryHash,
    });
  } catch (err) {
    return next(err);
  }
}

// ============================================================ freeze decision ====

/** Create-context for the release capability: the item's own case, from the database. */
export const releaseContext = (req) => ({
  caseId: req.resource?.caseId ?? null,
  stationCode: req.resource?.stationCode ?? null,
});

/**
 * POST /api/custody/items/:id/lift-freeze   (SHO)
 *
 * The supervisor's decision on a frozen article, written to the ledger with reasons.
 * The INTEGRITY_EXCEPTION it answers stays in the chain.
 */
export async function liftFreeze(req, res, next) {
  try {
    const item = req.resource;
    const body = parse(liftFreezeSchema, req.body);

    if (!item.frozen) {
      throw Conflict('CUSTODY_NOT_FROZEN', 'This item is not frozen; there is nothing to lift.');
    }

    const updated = await CustodyItem.findOneAndUpdate(
      { _id: item._id, frozen: true },
      {
        $set: {
          frozen: false,
          frozenReason: null,
          frozenAt: null,
          ...(body.newSealNumber ? { sealNumber: body.newSealNumber, sealIntact: true } : {}),
        },
      },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The item changed while lifting the freeze. Try again.');

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.CUSTODY_FREEZE_LIFTED,
      caseId: item.caseId,
      subjectId: item._id,
      subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        custodySeq: await nextCustodySeq(item._id),
        itemCode: item.itemCode,
        frozenReason: item.frozenReason ?? null,
        decision: body.note,
        previousSealNumber: item.sealNumber,
        newSealNumber: body.newSealNumber ?? null,
        decidedByAuthorityId: req.user.authorityId,
      },
    });

    return res.json({
      item: (await decorateItems([updated.toObject()]))[0],
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
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
      item: (await decorateItems([item]))[0],
      allowedActions: allowedActions(item, req.user),
      nextStates: item.frozen ? [] : CUSTODY_TRANSITIONS[item.status] ?? [],
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
 * Walk one item's ledger history and report what is wrong with it: missing genesis,
 * sequence gaps, timestamp inversions, unlawful jumps, and a record that disagrees
 * with its own history. Each finding names the event it was found at.
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
    add('MISSING_GENESIS_EVENT', 'The recorded history does not begin with the registration of this item.', entries[0]);
  }

  let previousAt = null;
  let expectedCustodySeq = 1;
  let state = null;

  for (const e of entries) {
    const at = new Date(e.occurredAt);
    if (previousAt && at < previousAt) {
      add(
        'TIMESTAMP_INVERSION',
        `This event is recorded at ${at.toISOString()}, before the event that precedes it in the chain.`,
        e
      );
    }
    previousAt = at;

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

    if (from && !isLegalTransition(from, to)) {
      const via = intermediateStates(from, to);
      add(
        'ILLEGAL_STATE_TRANSITION',
        `${from} → ${to} is not a lawful custody move.${
          via.length ? ` A lawful route would have passed through ${via.join(' or ')}.` : ''
        }`,
        e
      );
    }

    state = to;
  }

  if (state && state !== item.status) {
    add('STATE_DIVERGENCE', `The ledger's last recorded state is ${state}, but the item record says ${item.status}.`);
  }

  return summarise(item, findings, state);
}

function summarise(item, findings, ledgerState) {
  return {
    itemId: String(item._id),
    itemCode: item.itemCode,
    description: item.description,
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
 * Intersect the resolver's scope with a requested case — never replace it. A case
 * outside the scope simply yields nothing.
 */
function narrowToCase(filter, rawCaseId) {
  if (rawCaseId === undefined) return { ...filter };
  const caseId = new mongoose.Types.ObjectId(parse(objectId, rawCaseId));
  return { $and: [{ ...filter }, { caseId }] };
}

/**
 * GET /api/custody/items[?caseId=&status=&limit=]
 *
 * The custody register: what this user's scope actually contains. `null` scope means
 * "sees nothing", which is an empty result — never an unfiltered query.
 */
export async function listItems(req, res, next) {
  try {
    const filter = await materialiseScopeFilter(req.user, RESOURCE_TYPE.CUSTODY_ITEM);
    if (!filter) return res.json({ items: [], total: 0 });

    const query = narrowToCase(filter, req.query.caseId);
    if (req.query.status !== undefined) {
      query.status = parse(z.enum(Object.values(CUSTODY_STATUS)), req.query.status);
    }

    const items = await CustodyItem.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200))
      .lean();

    return res.json({ items: await decorateItems(items), total: items.length });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/custody/gaps?caseId= — chain analysis for every item in scope. */
export async function listGaps(req, res, next) {
  try {
    const filter = await materialiseScopeFilter(req.user, RESOURCE_TYPE.CUSTODY_ITEM);
    if (!filter) {
      return res.json({ items: [], total: 0, withFindings: 0, broken: [] });
    }

    const query = narrowToCase(filter, req.query.caseId);

    const items = await CustodyItem.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200))
      .lean();

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

    const reports = items.map((item) => analyseChain(item, bySubject.get(String(item._id)) ?? []));
    const withFindings = reports.filter((r) => !r.intact);
    return res.json({
      items: reports,
      total: reports.length,
      withFindings: withFindings.length,
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
  moveItem,
  getChain,
  liftFreeze,
  releaseContext,
  listItems,
  listGaps,
  analyseChain,
};
