/**
 * Cases.
 *
 * A case is created ONLY from an FIR that already exists in the police directory.
 * There is no free-text case creation, so a case's jurisdictional facts — station,
 * district, state, sections, sensitivity, investigating officer — are directory
 * facts, not user assertions. Everything downstream (authorization, jurisdiction
 * routing, disclosure scope) inherits that.
 */
import { z } from 'zod';
import { Case } from '../models/Case.js';
import { CaseAccessGrant } from '../models/CaseAccessGrant.js';
import { User } from '../models/User.js';
import { police, court } from '../services/directoryClient.js';
import { computeJurisdiction, forensicVisitRequired, selectCourt } from '../services/jurisdiction.js';
import { appendEvent, getCaseTimeline } from '../services/ledger.js';
import { materialiseScopeFilter } from '../services/accessResolver.js';
import {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  CASE_STAGE,
  ROLE,
  GRANT_BASIS,
  RESOURCE_TYPE,
} from '../models/enums.js';
import { BadRequest, NotFound, Conflict } from '../utils/errors.js';

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw BadRequest('VALIDATION_FAILED', 'Request failed validation', {
      fields: r.error.issues.map((i) => i.path.join('.') || '(root)'),
    });
  }
  return r.data;
};

const firNumberSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9/-]+$/, 'Malformed FIR number');

/**
 * Fetch the FIR from the police directory. Used both by the create-authorization
 * context and by the handler, so the station checked by the policy is the same
 * station the case is written with.
 */
export async function firContext(req) {
  const firNumber = parse(firNumberSchema, req.body?.firNumber);
  const fir = await police.getFir(firNumber);
  if (!fir) throw NotFound('FIR_NOT_FOUND', 'No such FIR in the police directory');

  const station =
    fir.station ?? (fir.stationCode ? await police.getStation(fir.stationCode) : null);

  req.firRecord = fir;
  req.firStation = station;

  // Only server-resolved facts reach the policy.
  return { stationCode: station?.code ?? fir.stationCode ?? null, firNumber };
}

/**
 * POST /api/cases/from-fir  { firNumber }
 * IO or SHO, own station only.
 */
export async function createFromFir(req, res, next) {
  try {
    const fir = req.firRecord;
    const station = req.firStation;

    const existing = await Case.findOne({ firNumber: fir.firNumber, stationCode: station.code }).lean();
    if (existing) {
      throw Conflict('CASE_ALREADY_EXISTS', 'A case already exists for this FIR', {
        caseId: String(existing._id),
      });
    }

    // The IO is whoever the FIR says it is. If they have not activated a Lexx
    // account yet, the creating officer holds the case — but we never invent a user.
    let ioUser = null;
    const firIoPisId = fir.io?.pisId ?? null;
    if (firIoPisId) {
      ioUser = await User.findOne({ authorityId: firIoPisId }).lean();
    }
    const ioUserId = ioUser?._id ?? req.user.userId;
    const ioAuthorityId = ioUser?.authorityId ?? req.user.authorityId;

    const created = await Case.create({
      firNumber: fir.firNumber,
      firDate: fir.firDate ?? new Date(),
      title: `FIR ${fir.firNumber} — ${station.name ?? station.code}`,
      description: fir.description ?? '',

      // ---- jurisdiction facts, straight from the directory ----
      stationCode: station.code,
      districtCode: station.districtCode,
      stateCode: station.stateCode,
      bnsSections: fir.bnsSections ?? [],
      maxPunishmentYears: fir.maxPunishmentYears ?? 0,
      sensitivityClass: fir.sensitivityClass ?? 'ORDINARY',
      isVictimProtected: Boolean(fir.isVictimProtected),
      // ---------------------------------------------------------

      ioUserId,
      ioAuthorityId,
      stage: CASE_STAGE.UNDER_INVESTIGATION,
      clocks: {
        forensicVisitRequired: forensicVisitRequired(fir.maxPunishmentYears ?? 0),
      },
      createdBy: req.user.userId,
    });

    // The investigating officer is on record by virtue of the posting order.
    await CaseAccessGrant.create({
      caseId: created._id,
      userId: ioUserId,
      role: ROLE.IO,
      grantBasis: GRANT_BASIS.POSTING_ORDER,
      grantRef: fir.firNumber,
      grantedByUserId: req.user.userId,
    });

    await appendEvent({
      eventType: LEDGER_EVENT.CASE_CREATED,
      caseId: created._id,
      subjectId: created._id,
      subjectType: SUBJECT_TYPE.CASE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        firNumber: created.firNumber,
        stationCode: created.stationCode,
        districtCode: created.districtCode,
        bnsSections: created.bnsSections,
        maxPunishmentYears: created.maxPunishmentYears,
        sensitivityClass: created.sensitivityClass,
        createdByAuthorityId: req.user.authorityId,
      },
    });

    return res.status(201).json({ case: created.toObject() });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/cases — scope-filtered by the resolver. */
export async function listCases(req, res, next) {
  try {
    const filter = await materialiseScopeFilter(req.user, RESOURCE_TYPE.CASE);
    // A null filter means "this user can see nothing", which must render as an empty
    // list — never as an unfiltered query.
    if (!filter) return res.json({ cases: [], total: 0 });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const [cases, total] = await Promise.all([
      Case.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      Case.countDocuments(filter),
    ]);
    return res.json({ cases, total });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/cases/:id — the resolver already loaded and authorised it. */
export async function getCase(req, res) {
  return res.json({ case: req.resource });
}

/** GET /api/cases/:id/timeline — ledger events for this case. */
export async function getTimeline(req, res, next) {
  try {
    const entries = await getCaseTimeline(req.resource._id);
    return res.json({
      caseId: String(req.resource._id),
      events: entries.map((e) => ({
        seq: e.seq,
        eventType: e.eventType,
        actorRole: e.actorRole,
        occurredAt: e.occurredAt,
        payload: e.payload,
        entryHash: e.entryHash,
        prevHash: e.prevHash,
        anchorBatchId: e.anchorBatchId,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/cases/:id/compute-jurisdiction
 * Returns the correct court AND the reasoning. The reasoning is the point.
 */
export async function computeCaseJurisdiction(req, res, next) {
  try {
    const c = req.resource;

    const computed = computeJurisdiction({
      bnsSections: c.bnsSections,
      maxPunishmentYears: c.maxPunishmentYears,
      sensitivityClass: c.sensitivityClass,
      isVictimProtected: c.isVictimProtected,
      districtCode: c.districtCode,
    });

    // Ask the court directory which courts exist in this district, then pick.
    let matchedCourt = null;
    let courtLookupError = null;
    try {
      const listing = await court.getCourt(c.districtCode).catch(() => null);
      const candidates = Array.isArray(listing) ? listing : listing?.courts ?? (listing ? [listing] : []);
      matchedCourt = selectCourt(candidates, computed);
    } catch (err) {
      // A directory outage must not be reported as "no court required".
      courtLookupError = err.code ?? 'COURT_LOOKUP_FAILED';
    }

    await Case.updateOne(
      { _id: c._id },
      {
        $set: {
          jurisdictionComputed: {
            courtType: computed.courtType,
            requiredDesignation: computed.requiredDesignation,
            requiresCommittal: computed.requiresCommittal,
            reasons: computed.reasons,
            computedAt: new Date(),
          },
        },
      }
    );

    return res.json({
      jurisdiction: computed,
      court: matchedCourt
        ? { code: matchedCourt.code, name: matchedCourt.name, designations: matchedCourt.designations }
        : null,
      courtLookupError,
      note: matchedCourt
        ? null
        : 'No court in this district holds the required designation. Escalate to the District Judge.',
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/cases/:id/file-chargesheet
 * Binds the case to a court, using the CNR from the court directory.
 */
export async function fileChargesheet(req, res, next) {
  try {
    const c = req.resource;

    if (c.stage !== CASE_STAGE.UNDER_INVESTIGATION && c.stage !== CASE_STAGE.FURTHER_INVESTIGATION) {
      throw Conflict('INVALID_STAGE', 'A chargesheet can only be filed during investigation');
    }

    const listing = await court.getListingByFir(c.firNumber);
    if (!listing) {
      throw NotFound(
        'NO_COURT_LISTING',
        'The court directory has no listing for this FIR. The case must be listed before a chargesheet can be filed.'
      );
    }

    const courtRecord = listing.court ?? (listing.courtCode ? await court.getCourt(listing.courtCode) : null);

    const updated = await Case.findOneAndUpdate(
      { _id: c._id, stage: c.stage }, // optimistic guard against a concurrent filing
      {
        $set: {
          stage: CASE_STAGE.CHARGESHEET_FILED,
          cnrNumber: listing.cnrNumber,
          courtId: courtRecord?.code ?? listing.courtCode ?? null,
          courtName: courtRecord?.name ?? null,
          chargesheetFiledOn: new Date(),
        },
      },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The case changed while filing. Try again.');

    await appendEvent({
      eventType: LEDGER_EVENT.CASE_STAGE_CHANGED,
      caseId: c._id,
      subjectId: c._id,
      subjectType: SUBJECT_TYPE.CASE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        from: c.stage,
        to: CASE_STAGE.CHARGESHEET_FILED,
        cnrNumber: updated.cnrNumber,
        courtId: updated.courtId,
      },
    });

    return res.json({ case: updated.toObject() });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/cases/:id/record-order  { orderType, text, effectiveOn }
 * The judicial write path. It replaces every delete endpoint: nothing is removed,
 * an order is recorded and the status changes.
 */
export async function recordOrder(req, res, next) {
  try {
    const body = parse(
      z.object({
        orderType: z.string().trim().min(2).max(64),
        text: z.string().trim().min(1).max(5000),
        effectiveOn: z.coerce.date().optional(),
      }),
      req.body
    );

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.JUDICIAL_ORDER,
      caseId: req.resource._id,
      subjectId: req.resource._id,
      subjectType: SUBJECT_TYPE.CASE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        orderType: body.orderType,
        text: body.text,
        // Client-asserted time is evidence, never chain input (ADR-007).
        clientEffectiveOn: body.effectiveOn ? body.effectiveOn.toISOString() : null,
        courtId: req.resource.courtId,
        judgeAuthorityId: req.user.authorityId,
      },
    });

    return res.status(201).json({
      recorded: true,
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
    });
  } catch (err) {
    return next(err);
  }
}

export default {
  firContext,
  createFromFir,
  listCases,
  getCase,
  getTimeline,
  computeCaseJurisdiction,
  fileChargesheet,
  recordOrder,
};
