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
import { DisclosurePack } from '../models/DisclosurePack.js';
import { Evidence } from '../models/Evidence.js';
import { User } from '../models/User.js';
import { police, court } from '../services/directoryClient.js';
import { computeJurisdiction, forensicVisitRequired, selectCourt } from '../services/jurisdiction.js';
import { appendEvent, getCaseTimeline } from '../services/ledger.js';
import { materialiseScopeFilter, seesTriage } from '../services/accessResolver.js';
import {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  CASE_STAGE,
  CLOSED_CASE_STAGES,
  ROLE,
  ADVOCATE_ROLES,
  GRANT_BASIS,
  RESOURCE_TYPE,
  TRIAGE_PRIORITY_ORDER,
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
 * Placeholders an FIR uses when the accused has not been identified. A cause list
 * really does say "State v. Unknown", but as the headline of a row in a list of
 * cases it tells the reader nothing, so those cases fall back to the FIR and station.
 */
const UNNAMED = new Set(['unknown', 'unidentified', 'unnamed', 'not known', 'n/a', '-']);

/**
 * The case as a person would name it.
 *
 * This used to be "FIR 0123/2026 — Kavi Nagar Police Station", which repeated the FIR
 * number every screen already shows beside it and then named the station, which they
 * also show. A case list read as one identifier printed twice, and the line meant to
 * say WHICH case this is said nothing. The accused's name, from the FIR, is what
 * actually distinguishes one case from another.
 */
function caseTitle(fir, station) {
  const named = (fir.accusedNames ?? [])
    .map((n) => String(n ?? '').trim())
    .filter((n) => n && !UNNAMED.has(n.toLowerCase()));

  return named.length
    ? `State v. ${named.join(' & ')}`
    : `FIR ${fir.firNumber} — ${station.name ?? station.code}`;
}

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
      /**
       * The case as a person would name it.
       *
       * This used to be "FIR 0123/2026 — Kavi Nagar Police Station", which repeated
       * the FIR number that every screen already shows beside it and then said the
       * station, which they also show. So a case list read as one identifier printed
       * twice, and a reader learned nothing from the line that was supposed to tell
       * them which case this is. The accused's name, from the FIR, is what actually
       * distinguishes one case from another on a cause list.
       */
      title: caseTitle(fir, station),
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
    return res.json({ cases: await withSummaries(cases, req.user), total });
  } catch (err) {
    return next(err);
  }
}

/**
 * Attach a small per-case summary to a list of cases.
 *
 * Every dashboard in the product wants the same four facts about a case — how much
 * evidence is on it, how much of that is still waiting on a laboratory, how many
 * advocates are on record, and whether the file has been shared with them. Without
 * this, each screen fetched them one case at a time, which is why the old dashboards
 * showed figures for the single "working case" and nothing for the rest: the data to
 * show more was a request per row.
 *
 * Three aggregations for the whole page, and `highestPriority` is omitted for a party
 * — triage is investigative workload ordering and is never disclosed to one.
 */
async function withSummaries(cases, user) {
  if (!cases.length) return cases;
  const ids = cases.map((c) => c._id);

  const [evidence, grants, packs] = await Promise.all([
    Evidence.aggregate([
      { $match: { caseId: { $in: ids } } },
      {
        $group: {
          _id: '$caseId',
          exhibits: { $sum: 1 },
          withOpinion: { $sum: { $cond: [{ $ifNull: ['$forensic.opinion', false] }, 1, 0] } },
          priorities: { $addToSet: '$triage.priority' },
        },
      },
    ]),
    CaseAccessGrant.aggregate([
      { $match: { caseId: { $in: ids }, role: { $in: ADVOCATE_ROLES }, revokedAt: null } },
      { $group: { _id: '$caseId', counsel: { $sum: 1 } } },
    ]),
    DisclosurePack.find({ caseId: { $in: ids } }).select('caseId status servedOn').lean(),
  ]);

  const evidenceBy = new Map(evidence.map((r) => [String(r._id), r]));
  const counselBy = new Map(grants.map((r) => [String(r._id), r.counsel]));
  const packBy = new Map(packs.map((p) => [String(p.caseId), p]));

  return cases.map((c) => {
    const e = evidenceBy.get(String(c._id));
    const pack = packBy.get(String(c._id));
    const exhibits = e?.exhibits ?? 0;
    const withOpinion = e?.withOpinion ?? 0;

    const summary = {
      exhibits,
      forensicOpinions: withOpinion,
      awaitingForensics: Math.max(exhibits - withOpinion, 0),
      counselOnRecord: counselBy.get(String(c._id)) ?? 0,
      disclosure: pack ? { status: pack.status, servedOn: pack.servedOn ?? null } : null,
    };

    if (seesTriage(user)) {
      // The most urgent band present on the case, so a list can be ordered and
      // coloured by "where is the fire" without a second request per row.
      summary.highestPriority =
        TRIAGE_PRIORITY_ORDER.find((p) => (e?.priorities ?? []).includes(p)) ?? null;
    }

    return { ...c, summary };
  });
}

/** GET /api/cases/:id — the resolver already loaded and authorised it. */
/**
 * Middleware for GET /api/cases/by-cnr/:cnr — turns a CNR into a case id and stops.
 * It makes no access decision; `authorize` runs on the id next, exactly as for a
 * typed-in id. An unknown or malformed CNR answers 404, like an unknown id.
 */
export async function caseIdFromCnr(req, res, next) {
  try {
    const cnr = String(req.params.cnr ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{2}\d{12}$/.test(cnr)) {
      throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');
    }
    const found = await Case.findOne({ cnrNumber: cnr }).select('_id').lean();
    if (!found) throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');
    req.lookupCaseId = String(found._id);
    return next();
  } catch (err) {
    return next(err);
  }
}

export async function getCase(req, res, next) {
  try {
    // Whether a disclosure pack exists, and where it stands — status only. The officer
    // who prepared it could otherwise not tell after a reload (the court's pack list is
    // a court-only read), and would re-prepare or file the chargesheet not knowing.
    // Nothing here names an exhibit or an exclusion.
    const pack = await DisclosurePack.findOne({ caseId: req.resource._id })
      .select('_id status updatedAt servedOn')
      .lean();
    // The same summary the list carries, so a detail screen shows the same four
    // figures as the row it was opened from rather than counting them differently.
    const [withSummary] = await withSummaries([req.resource], req.user);
    return res.json({
      case: withSummary,
      disclosure: pack
        ? { packId: String(pack._id), status: pack.status, updatedAt: pack.updatedAt, servedOn: pack.servedOn ?? null }
        : null,
    });
  } catch (err) {
    return next(err);
  }
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

/** The router's answer for a case, from the case's own FIR-derived facts. */
const jurisdictionFor = (c) =>
  computeJurisdiction({
    bnsSections: c.bnsSections,
    maxPunishmentYears: c.maxPunishmentYears,
    sensitivityClass: c.sensitivityClass,
    isVictimProtected: c.isVictimProtected,
    districtCode: c.districtCode,
  });

/**
 * The court the router's answer points at, chosen from the district's courts as the
 * court directory lists them. `null` when none qualifies. A directory outage throws
 * (DirectoryUnavailableError) — it must never read as "no court required".
 */
async function matchCourt(c, computed) {
  const answer = await court.listCourts(c.districtCode);
  return selectCourt(answer?.courts ?? [], computed);
}

/**
 * POST /api/cases/:id/compute-jurisdiction
 * Returns the correct court AND the reasoning. The reasoning is the point.
 */
export async function computeCaseJurisdiction(req, res, next) {
  try {
    const c = req.resource;
    const computed = jurisdictionFor(c);

    // Ask the court directory which courts exist in this district, then pick.
    let matchedCourt = null;
    let courtLookupError = null;
    try {
      matchedCourt = await matchCourt(c, computed);
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
 * Register the chargesheet with the court the jurisdiction router picks, and return
 * the court's listing (with its CNR). The court comes from the court directory's own
 * list for the district, and the directory refuses a court it does not hold — so the
 * officer filing cannot steer the case anywhere.
 */
async function registerWithCourt(c) {
  const computed = jurisdictionFor(c);
  const target = await matchCourt(c, computed);
  if (!target) {
    throw Conflict(
      'NO_COURT_FOR_JURISDICTION',
      computed.requiredDesignation
        ? `No court in ${c.districtCode} holds the ${computed.requiredDesignation} designation this case requires. Escalate to the District Judge.`
        : `No ${computed.courtType.toLowerCase()} court is listed for ${c.districtCode}.`,
      { courtType: computed.courtType, requiredDesignation: computed.requiredDesignation, reasons: computed.reasons }
    );
  }

  const { status, data } = await court.registerListing({
    firNumber: c.firNumber,
    stationCode: c.stationCode,
    courtCode: target.code,
    caseCategory:
      computed.courtType === 'MAGISTRATE'
        ? 'MAGISTRATE_TRIAL'
        : computed.requiredDesignation
          ? `SPECIAL_${computed.requiredDesignation}`
          : 'SESSIONS_TRIAL',
  });
  if (status !== 200 && status !== 201) {
    throw Conflict(
      data?.error?.code ?? 'COURT_REGISTRATION_REFUSED',
      data?.error?.message ?? 'The court registry did not register this chargesheet.'
    );
  }
  return data;
}

/**
 * POST /api/cases/:id/file-chargesheet
 * Binds the case to a court, using the CNR from the court directory.
 *
 * If the court register already lists the FIR (the seeded demo case), that listing is
 * used. Otherwise the chargesheet is registered with the court the jurisdiction
 * router chooses, which allots the CNR — the step that used to be missing, and made
 * every FIR but one end in NO_COURT_LISTING.
 */
export async function fileChargesheet(req, res, next) {
  try {
    const c = req.resource;

    if (c.stage !== CASE_STAGE.UNDER_INVESTIGATION && c.stage !== CASE_STAGE.FURTHER_INVESTIGATION) {
      throw Conflict('INVALID_STAGE', 'A chargesheet can only be filed during investigation');
    }

    const listing = (await court.getListingByFir(c.firNumber)) ?? (await registerWithCourt(c));
    if (!listing?.cnrNumber) {
      throw NotFound(
        'NO_COURT_LISTING',
        'The court directory has no listing for this FIR, so the chargesheet cannot bind it to a court.'
      );
    }

    const courtRecord = listing.court ?? (listing.courtCode ? await court.getCourt(listing.courtCode) : null);

    const filedOn = new Date();
    const updated = await Case.findOneAndUpdate(
      { _id: c._id, stage: c.stage }, // optimistic guard against a concurrent filing
      {
        $set: {
          stage: CASE_STAGE.CHARGESHEET_FILED,
          cnrNumber: listing.cnrNumber,
          courtId: courtRecord?.code ?? listing.courtCode ?? null,
          courtName: courtRecord?.name ?? null,
          chargesheetFiledOn: filedOn,
          // BNSS s.230: the accused must have the police report and documents within
          // fourteen days. Filing starts that clock; service records when it stopped.
          // Nothing wrote this before, so counsel's s.230 countdown could never show.
          'clocks.disclosureDueOn': new Date(filedOn.getTime() + 14 * 86_400_000),
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

/**
 * POST /api/cases/:id/close   { reason }   (JUDGE)
 *
 * The court closes the case.
 *
 * ## What closing does
 * It sets the stage to CLOSED and writes a CASE_CLOSED entry to the ledger, naming
 * the judge, the court and the reason. From that moment the resolver refuses every
 * non-read action on the case, to every authority including the court itself.
 *
 * ## What closing does NOT do
 * It deletes nothing. Not an exhibit, not a custody record, not a forensic opinion,
 * not a certificate, not a ledger entry, not an anchor. There is no delete path
 * anywhere in this system and closing a case does not invent one: everything stays
 * exactly where it is, readable by everyone who could read it the day before, and
 * still verifiable against the anchored Merkle root. A closed case is a case whose
 * record has stopped moving — which is the only thing that makes it worth keeping.
 *
 * Re-opening is not an edit of this. It is a fresh listing on a fresh order.
 */
export async function closeCase(req, res, next) {
  try {
    const c = req.resource;
    const body = parse(
      z.object({ reason: z.string().trim().min(3, 'Say why the case is being closed').max(2000) }),
      req.body ?? {}
    );

    if (CLOSED_CASE_STAGES.includes(c.stage)) {
      throw Conflict('INVALID_STAGE', 'This case is already closed', { stage: c.stage });
    }
    if (!c.courtId || !c.cnrNumber) {
      // A case still with the police is before no court, so there is no court to
      // close it. This should be unreachable — the resolver refuses a judge a case
      // with no courtId — but the stage check belongs with the stage, not the policy.
      throw Conflict(
        'INVALID_STAGE',
        'This case is not before a court yet, so it cannot be closed by one',
        { stage: c.stage }
      );
    }

    const closedOn = new Date();
    const updated = await Case.findOneAndUpdate(
      { _id: c._id, stage: c.stage }, // optimistic guard against a concurrent close
      { $set: { stage: CASE_STAGE.CLOSED, closedOn, closedByUserId: req.user.userId } },
      { new: true }
    );
    if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The case changed while closing. Try again.');

    const entry = await appendEvent({
      eventType: LEDGER_EVENT.CASE_CLOSED,
      caseId: c._id,
      subjectId: c._id,
      subjectType: SUBJECT_TYPE.CASE,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        from: c.stage,
        to: CASE_STAGE.CLOSED,
        reason: body.reason,
        cnrNumber: c.cnrNumber,
        courtId: c.courtId,
        closedByAuthorityId: req.user.authorityId,
      },
    });

    return res.json({
      case: updated.toObject(),
      ledgerSeq: entry.seq,
      entryHash: entry.entryHash,
      note:
        'The case is closed. Every exhibit, custody record, forensic opinion, certificate and ledger entry is exactly where it was and stays readable — closing stops the record, it does not remove it.',
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
  closeCase,
};
