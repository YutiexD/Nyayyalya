/**
 * Cases.
 *
 * A case is created ONLY from an FIR that already exists in the police directory.
 * There is no free-text case creation, so a case's jurisdictional facts — station,
 * district, state, sections, sensitivity, investigating officer — are directory
 * facts, not user assertions. Everything downstream (authorization, jurisdiction
 * routing, disclosure scope) inherits that.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import { Case } from '../models/Case.js';
import { CaseAccessGrant } from '../models/CaseAccessGrant.js';
import { Evidence } from '../models/Evidence.js';
import { User } from '../models/User.js';
import { CustodyItem } from '../models/CustodyItem.js';
import { VakalatnamaFiling } from '../models/VakalatnamaFiling.js';
import { Ledger } from '../models/Ledger.js';
import { police, court } from '../services/directoryClient.js';
import { evaluateTransition, workflowFor } from '../services/caseWorkflow.js';
import { evidenceCards, pendingActionsFor, sortForViewer } from '../services/caseOverview.js';
import { seesAiAnalysis } from '../services/ai/visibility.js';
import { computeJurisdiction, forensicVisitRequired, selectCourt } from '../services/jurisdiction.js';
import { appendEvent, getCaseTimeline } from '../services/ledger.js';
import { materialiseScopeFilter, seesTriage } from '../services/accessResolver.js';
import { describeCaseLifecycle, closureView, LIFECYCLE_VARIANT } from '../services/lifecycleDetails.js';
import { emitChange } from '../services/realtime.js';
import { storeSealedDocument, readSealedDocument } from '../services/sealedDocument.js';
import { buildStorageKey } from '../services/storage.js';
import { sniffMimeType } from '../services/fileType.js';
import { verifyEcdsaP256 } from '../config/crypto.js';
import { writeAudit } from '../middleware/audit.js';
import {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  CASE_STAGE,
  ROLE,
  ADVOCATE_ROLES,
  GRANT_BASIS,
  RESOURCE_TYPE,
  TRIAGE_PRIORITY_ORDER,
  AUTHORITY,
  CASE_ACTION,
  AI_ANALYSIS_STATUS,
  CUSTODY_STATUS,
  VAKALATNAMA_STATUS,
  CLOSURE_DOCUMENT_KIND,
  REALTIME_EVENT,
  ACTION,
  DECISION,
  values,
} from '../models/enums.js';
import { BadRequest, NotFound, Conflict, Forbidden, PayloadTooLarge } from '../utils/errors.js';

// ================================================================ closure views ====

// `closureView` lives in services/lifecycleDetails.js; re-exported for callers of this module.
export { closureView };

/** A case as any response carries it: the stored document with its closure replaced by the view. */
const caseOut = (doc) => (doc ? { ...doc, closure: closureView(doc.closure) } : doc);

/** The workflow, with every lifecycle milestone described and its proofs attached. */
async function workflowWithDetails(caseDoc) {
  const workflow = workflowFor(caseDoc);
  workflow.lifecycle = await describeCaseLifecycle({
    caseDoc,
    lifecycle: workflow.lifecycle,
    variant: LIFECYCLE_VARIANT.AUTHENTICATED,
  });
  return workflow;
}

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
      stationName: station.name ?? null,
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

    return res.status(201).json({ case: caseOut(created.toObject()) });
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
 * Attach the per-case summary a case list needs.
 *
 * How much evidence there is, how much still waits on a laboratory, where the physical
 * articles are, who is on record, whether the file has been shared, and what the case
 * is waiting on next. Five aggregations for the whole page rather than a request per row.
 *
 * Nothing derived from the AI analysis — analysis counts, the highest recommended
 * priority, how many exhibits the model recommends for review — is computed for anyone
 * but a laboratory (FSL) viewer. Custody is omitted for a party.
 */
async function withSummaries(cases, user) {
  if (!cases.length) return cases;
  const ids = cases.map((c) => c._id);
  const party = !seesTriage(user);
  const ai = seesAiAnalysis(user);
  const isCourt = user.authority === AUTHORITY.COURT;
  const S = AI_ANALYSIS_STATUS;

  const evidenceGroup = {
    _id: '$caseId',
    exhibits: { $sum: 1 },
    withOpinion: { $sum: { $cond: [{ $ifNull: ['$forensic.opinion', false] }, 1, 0] } },
    lastEvidenceAt: { $max: '$createdAt' },
  };
  if (ai) {
    Object.assign(evidenceGroup, {
      priorities: { $addToSet: '$aiAnalysis.triagePriority' },
      aiCompleted: { $sum: { $cond: [{ $eq: ['$aiAnalysis.status', S.COMPLETED] }, 1, 0] } },
      aiPending: { $sum: { $cond: [{ $in: ['$aiAnalysis.status', [S.PENDING, S.PROCESSING]] }, 1, 0] } },
      aiFailed: { $sum: { $cond: [{ $eq: ['$aiAnalysis.status', S.FAILED] }, 1, 0] } },
      aiUnsupported: { $sum: { $cond: [{ $eq: ['$aiAnalysis.status', S.UNSUPPORTED] }, 1, 0] } },
      fslRecommendedOpen: {
        $sum: {
          $cond: [
            {
              $and: [
                { $eq: ['$aiAnalysis.fslReviewRecommended', true] },
                { $not: [{ $ifNull: ['$forensic.opinion', false] }] },
              ],
            },
            1,
            0,
          ],
        },
      },
    });
  }

  const [evidence, grants, custody, filings] = await Promise.all([
    Evidence.aggregate([{ $match: { caseId: { $in: ids } } }, { $group: evidenceGroup }]),
    CaseAccessGrant.aggregate([
      { $match: { caseId: { $in: ids }, role: { $in: ADVOCATE_ROLES }, revokedAt: null } },
      { $group: { _id: '$caseId', counsel: { $sum: 1 } } },
    ]),
    party
      ? []
      : CustodyItem.aggregate([
          { $match: { caseId: { $in: ids } } },
          {
            $group: {
              _id: '$caseId',
              items: { $sum: 1 },
              statuses: { $push: '$status' },
              frozen: { $sum: { $cond: ['$frozen', 1, 0] } },
              lastMovedAt: { $max: '$lastMovedAt' },
            },
          },
        ]),
    isCourt
      ? VakalatnamaFiling.aggregate([
          { $match: { caseId: { $in: ids }, status: VAKALATNAMA_STATUS.PENDING } },
          { $group: { _id: '$caseId', n: { $sum: 1 } } },
        ])
      : [],
  ]);

  const evidenceBy = new Map(evidence.map((r) => [String(r._id), r]));
  const counselBy = new Map(grants.map((r) => [String(r._id), r.counsel]));
  const custodyBy = new Map(custody.map((r) => [String(r._id), r]));
  const filingsBy = new Map(filings.map((r) => [String(r._id), r.n]));
  const actionView = (a) =>
    a ? { action: a.action, label: a.label, description: a.description, requiresNote: a.requiresNote } : null;

  return cases.map((c) => {
    const id = String(c._id);
    const e = evidenceBy.get(id);
    const cu = custodyBy.get(id);
    const exhibits = e?.exhibits ?? 0;
    const withOpinion = e?.withOpinion ?? 0;
    const workflow = workflowFor(c);
    const counselOnRecord = counselBy.get(id) ?? 0;

    const summary = {
      exhibits,
      forensicOpinions: withOpinion,
      awaitingForensics: Math.max(exhibits - withOpinion, 0),
      counselOnRecord,
      workflow: {
        stageLabel: workflow.stageLabel,
        requiresCommittal: workflow.requiresCommittal,
        waitingOn: workflow.waitingOn,
        nextCourtAction: actionView(workflow.nextCourtAction),
        nextPoliceAction: actionView(workflow.nextPoliceAction),
      },
      lastActivityAt:
        [c.updatedAt, e?.lastEvidenceAt, cu?.lastMovedAt]
          .filter(Boolean)
          .map((d) => new Date(d))
          .sort((a, b) => b - a)[0] ?? null,
    };

    // What needs someone's attention. Filing the chargesheet is the police's next act
    // on every open investigation, so it is shown as the next step but not counted
    // here — otherwise no station would ever read zero.
    // `fsl` is present for a laboratory viewer only: its count is AI-derived.
    const attention = ai ? { police: 0, court: 0, fsl: 0 } : { police: 0, court: 0 };
    if (workflow.nextCourtAction) attention.court += 1;

    if (!party) {
      const statuses = cu?.statuses ?? [];
      const count = (st) => statuses.filter((x) => x === st).length;
      summary.custody = {
        items: cu?.items ?? 0,
        seized: count(CUSTODY_STATUS.SEIZED),
        inStore: count(CUSTODY_STATUS.IN_STORE),
        atFsl: count(CUSTODY_STATUS.AT_FSL),
        inCourt: count(CUSTODY_STATUS.IN_COURT),
        finished: count(CUSTODY_STATUS.RETURNED) + count(CUSTODY_STATUS.DESTROYED),
        frozen: cu?.frozen ?? 0,
      };
      attention.police += summary.custody.frozen + summary.custody.seized;
    }
    if (ai) {
      summary.analysis = {
        completed: e?.aiCompleted ?? 0,
        pending: e?.aiPending ?? 0,
        failed: e?.aiFailed ?? 0,
        unsupported: e?.aiUnsupported ?? 0,
      };
      summary.fslReviewRecommended = e?.fslRecommendedOpen ?? 0;
      // The most urgent AI-recommended band on the case — for a laboratory's list only.
      summary.highestPriority =
        TRIAGE_PRIORITY_ORDER.find((p) => (e?.priorities ?? []).includes(p)) ?? null;
      attention.fsl += summary.fslReviewRecommended;
    }
    if (isCourt) {
      summary.pendingFilings = filingsBy.get(id) ?? 0;
      attention.court += summary.pendingFilings;
    }
    summary.attention = attention;

    return { ...caseOut(c), summary };
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
    // The same summary the list carries, so a detail screen shows the same figures as
    // the row it was opened from rather than counting them differently. Counsel on
    // record read the case file directly; there is no disclosure pack to report.
    const [[withSummary], workflow] = await Promise.all([
      withSummaries([req.resource], req.user),
      workflowWithDetails(req.resource),
    ]);
    return res.json({ case: withSummary, workflow });
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
    // No ledger entry for this write, so tell live viewers directly.
    emitChange({ type: REALTIME_EVENT.RECORD_UPDATED, caseId: c._id });

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

    const verdict = evaluateTransition(c, CASE_ACTION.FILE_CHARGESHEET);
    if (!verdict.ok) {
      throw Conflict('INVALID_STAGE', 'A chargesheet can only be filed during investigation', {
        stage: c.stage,
        reason: verdict.code,
      });
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
        action: CASE_ACTION.FILE_CHARGESHEET,
        from: c.stage,
        to: CASE_STAGE.CHARGESHEET_FILED,
        cnrNumber: updated.cnrNumber,
        courtId: updated.courtId,
        courtName: updated.courtName,
        filedByAuthorityId: req.user.authorityId,
      },
    });

    // The case is now before a court. Every court login in the district sees it, with
    // "Take cognizance" as the next judicial act.
    const doc = updated.toObject();
    return res.json({ case: caseOut(doc), workflow: await workflowWithDetails(doc) });
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

// ============================================================ judicial workflow ====

/** GET /api/cases/:id/workflow — where the case is, and every act that can move it. */
export async function getWorkflow(req, res, next) {
  try {
    return res.json({
      caseId: String(req.resource._id),
      closure: closureView(req.resource.closure),
      workflow: await workflowWithDetails(req.resource),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/cases/:id/overview
 *
 * One case, grouped: its exhibits (forensic status, physical article, certificate —
 * and the AI analysis for a laboratory viewer only), its custody register, what is
 * waiting and on whom, and its recent history. Evidence and custody are intersected
 * with the caller's own scope, so an advocate sees only the served set and a
 * laboratory only what it may examine. Exhibits are ordered by AI priority for a
 * laboratory and newest first for everyone else.
 */
export async function getOverview(req, res, next) {
  try {
    const c = req.resource;
    const [evScope, custodyScope] = await Promise.all([
      materialiseScopeFilter(req.user, RESOURCE_TYPE.EVIDENCE),
      materialiseScopeFilter(req.user, RESOURCE_TYPE.CUSTODY_ITEM),
    ]);
    const party = !seesTriage(req.user);
    const evidenceSelect = seesAiAnalysis(req.user) ? '-encryption' : '-encryption -aiAnalysis';

    const [evidence, custody, pendingFilings, recent] = await Promise.all([
      evScope ? Evidence.find({ $and: [evScope, { caseId: c._id }] }).select(evidenceSelect).lean() : [],
      custodyScope && !party
        ? CustodyItem.find({ $and: [custodyScope, { caseId: c._id }] }).sort({ createdAt: 1 }).lean()
        : [],
      req.user.authority === AUTHORITY.COURT
        ? VakalatnamaFiling.countDocuments({ caseId: c._id, status: VAKALATNAMA_STATUS.PENDING })
        : 0,
      party
        ? []
        : Ledger.find({ caseId: c._id, eventType: { $not: /^CUSTODY_/ } }).sort({ seq: -1 }).limit(10).select('seq eventType actorRole occurredAt payload').lean(),
    ]);

    const [cardsRaw, [withSummary], workflow] = await Promise.all([
      evidenceCards(evidence, req.user),
      withSummaries([c], req.user),
      workflowWithDetails(c),
    ]);
    const cards = sortForViewer(cardsRaw, req.user);

    return res.json({
      case: withSummary,
      workflow,
      evidence: cards,
      custody: custody.map((i) => ({
        itemId: String(i._id),
        itemCode: i.itemCode,
        description: i.description,
        evidenceId: i.evidenceId ? String(i.evidenceId) : null,
        exhibitCode: cards.find((x) => x._id === String(i.evidenceId))?.exhibitCode ?? null,
        status: i.status,
        location: i.currentLocation,
        custodian: i.custodian ?? null,
        sealNumber: i.sealNumber,
        sealIntact: i.sealIntact !== false,
        frozen: Boolean(i.frozen),
        duplicateLegacy: Boolean(i.duplicateLegacy),
        lastMovedAt: i.lastMovedAt ?? i.createdAt,
      })),
      pendingActions: party
        ? []
        : pendingActionsFor({
            user: req.user,
            caseDoc: c,
            cards,
            custody,
            workflow,
            pendingFilings,
          }),
      recentActivity: recent.map((e) => ({
        seq: e.seq,
        eventType: e.eventType,
        actorRole: e.actorRole,
        occurredAt: e.occurredAt,
        exhibitCode: e.payload?.exhibitCode ?? null,
        itemCode: e.payload?.itemCode ?? null,
        detail: e.payload?.action ?? e.payload?.toStatus ?? e.payload?.opinion ?? null,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

const COURT_ACTIONS = [
  CASE_ACTION.TAKE_COGNIZANCE,
  CASE_ACTION.COMMIT_FOR_TRIAL,
  CASE_ACTION.BEGIN_TRIAL,
  CASE_ACTION.DIRECT_FURTHER_INVESTIGATION,
  CASE_ACTION.CLOSE_CASE,
];

const STAGE_DATE_FIELD = Object.freeze({
  [CASE_ACTION.TAKE_COGNIZANCE]: 'cognizanceTakenOn',
  [CASE_ACTION.COMMIT_FOR_TRIAL]: 'committedOn',
  [CASE_ACTION.BEGIN_TRIAL]: 'trialStartedOn',
  [CASE_ACTION.CLOSE_CASE]: 'closedOn',
});

/**
 * Perform one judicial act. The resolver has already established ORDER on this case
 * (the court, in this district). The state machine decides whether the act is valid
 * now; the update is guarded on the stage it was validated against; the ledger records
 * the act, who ordered it and why.
 */
// ================================================ the closing document ====

/** A judgment runs to many pages. 20 MB is generous for one and safe to buffer. */
export const CLOSURE_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

const closureMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CLOSURE_DOCUMENT_MAX_BYTES, files: 1, fields: 12, fieldSize: 8 * 1024 },
}).single('document');

/**
 * Multipart parsing for the closing act, and only for a multipart request: a JSON
 * transition passes straight through. Runs AFTER `authorize`, so nobody without ORDER
 * on the case gets their bytes buffered.
 */
export function closureDocumentUpload(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  return closureMulter(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(
        PayloadTooLarge('CLOSURE_DOCUMENT_TOO_LARGE', 'The closing document may be at most 20 MB', {
          maxBytes: CLOSURE_DOCUMENT_MAX_BYTES,
        })
      );
    }
    if (err instanceof multer.MulterError) {
      return next(BadRequest('VALIDATION_FAILED', 'Malformed upload', { fields: [err.field ?? 'document'] }));
    }
    return next(err);
  });
}

/** A multipart form sends an untouched optional input as "". Treat that as absent. */
const blankAsAbsent = (inner) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const closureFields = {
  documentKind: blankAsAbsent(z.enum(values(CLOSURE_DOCUMENT_KIND)).optional()),
  documentSha256: blankAsAbsent(z.string().regex(/^[0-9a-f]{64}$/i, 'Must be a SHA-256 hex digest').optional()),
  documentSignature: blankAsAbsent(z.string().max(256).optional()),
};

/**
 * A browser P1363 signature, as 128 hex characters or base64/base64url of its 64
 * bytes. Returns lowercase hex, or null when it is neither.
 */
function normaliseSignature(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^[0-9a-f]{128}$/i.test(s)) return s.toLowerCase();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const bytes = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.length === 64 ? bytes.toString('hex') : null;
}

const safeFileName = (name, fallback) => {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .slice(0, 180)
    .trim();
  return base && base !== '.' && base !== '..' ? base : fallback;
};

/**
 * Check the attached document before anything is written: its kind, that it is a PDF by
 * its bytes, that the bytes are the bytes whose hash was signed, and that the judge's
 * registered device key made the signature. Refusals write nothing but an audit row.
 */
async function verifyClosureDocument(req, caseDoc, input) {
  const { file } = input;
  if (!input.documentKind) {
    throw BadRequest('CLOSURE_DOCUMENT_KIND_REQUIRED', 'Say whether the document is a final judgment, a declaration or an order', {
      fields: ['documentKind'],
      allowed: values(CLOSURE_DOCUMENT_KIND),
    });
  }
  if (file.size > CLOSURE_DOCUMENT_MAX_BYTES) {
    throw PayloadTooLarge('CLOSURE_DOCUMENT_TOO_LARGE', 'The closing document may be at most 20 MB', {
      maxBytes: CLOSURE_DOCUMENT_MAX_BYTES,
    });
  }
  const sniffed = sniffMimeType(file.buffer.subarray(0, 32));
  if (sniffed !== 'application/pdf') {
    throw BadRequest('CLOSURE_DOCUMENT_NOT_PDF', 'The closing document must be a PDF', { detected: sniffed });
  }
  if (!input.documentSha256 || !input.documentSignature) {
    throw BadRequest('VALIDATION_FAILED', 'The document hash and signature are required', {
      fields: [!input.documentSha256 && 'documentSha256', !input.documentSignature && 'documentSignature'].filter(Boolean),
    });
  }

  const serverSha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  if (serverSha !== input.documentSha256.toLowerCase()) {
    throw BadRequest('HASH_MISMATCH', 'The uploaded document does not match the hash you signed', {
      declared: input.documentSha256.toLowerCase(),
      computed: serverSha,
    });
  }

  const signer = await User.findById(req.user.userId).select('name role authorityId publicKeyJwk publicKeyFingerprint').lean();
  if (!signer?.publicKeyJwk) {
    throw BadRequest('NO_REGISTERED_KEY', 'No signing key is registered for this account');
  }
  const signatureHex = normaliseSignature(input.documentSignature);
  if (!signatureHex || !verifyEcdsaP256(signer.publicKeyJwk, signatureHex, input.documentSha256)) {
    await writeAudit(req, {
      action: ACTION.ORDER,
      resourceType: RESOURCE_TYPE.CASE,
      resourceId: caseDoc._id,
      resourceLabel: caseDoc.cnrNumber ?? caseDoc.firNumber,
      caseId: caseDoc._id,
      decision: DECISION.DENY,
      reason: 'SIGNATURE_INVALID',
    });
    throw BadRequest(
      'SIGNATURE_INVALID',
      'The signature does not verify against your registered key. The case was not closed and the attempt logged.'
    );
  }

  return { serverSha, signatureHex, signer };
}

async function performCourtTransition(req, res, action, note, closureInput = null) {
  const c = req.resource;
  const verdict = evaluateTransition(c, action);
  const closing = action === CASE_ACTION.CLOSE_CASE;

  if (verdict.authority !== AUTHORITY.COURT || req.user.authority !== AUTHORITY.COURT) {
    throw Forbidden('READ_ONLY_ROLE', 'Only the court performs this act');
  }
  if (!verdict.ok) {
    throw Conflict(verdict.code === 'CASE_IS_CLOSED' ? 'INVALID_STAGE' : verdict.code, verdict.message, {
      stage: c.stage,
      action,
    });
  }
  if (verdict.requiresNote && (!note || note.trim().length < 3)) {
    throw BadRequest('NOTE_REQUIRED', 'Record the reason for this order', { fields: ['note'] });
  }

  const file = closureInput?.file ?? null;
  if (file && !closing) {
    throw BadRequest('VALIDATION_FAILED', 'A document can only be attached when closing the case', { fields: ['document'] });
  }
  if (closing && !file && (closureInput?.documentSha256 || closureInput?.documentSignature)) {
    throw BadRequest('CLOSURE_DOCUMENT_MISSING', 'A hash and signature were sent, but no document was attached', {
      fields: ['document'],
    });
  }

  // ---- every check on the document happens before anything is written ----
  const checked = closing && file ? await verifyClosureDocument(req, c, { ...closureInput, file }) : null;

  const now = new Date();
  const set = { stage: verdict.to };
  if (STAGE_DATE_FIELD[action]) set[STAGE_DATE_FIELD[action]] = now;

  let closure = null;
  if (closing) {
    set.closedByUserId = req.user.userId;
    closure = {
      kind: checked ? closureInput.documentKind : null,
      note: note ?? null,
      signedBy: {
        userId: req.user.userId,
        name: checked?.signer.name ?? req.user.name ?? null,
        authorityId: req.user.authorityId ?? null,
        role: req.user.role ?? null,
      },
      uploadedAt: now,
      fileName: null,
      mimeType: null,
      sizeBytes: null,
      sha256: null,
      signature: null,
      signerKeyFingerprint: null,
      signerPublicKeyJwk: null,
      storageKey: null,
    };
    if (checked) {
      const storageKey = buildStorageKey(checked.serverSha, new mongoose.Types.ObjectId());
      await storeSealedDocument(file.buffer, c._id, storageKey);
      const jwk = checked.signer.publicKeyJwk;
      Object.assign(closure, {
        fileName: safeFileName(file.originalname, `closure-${c.cnrNumber ?? String(c._id)}.pdf`),
        mimeType: 'application/pdf',
        sizeBytes: file.size,
        sha256: checked.serverSha,
        signature: checked.signatureHex,
        signerKeyFingerprint: checked.signer.publicKeyFingerprint ?? null,
        signerPublicKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
        storageKey,
      });
    }
    set.closure = closure;
  }

  const updated = await Case.findOneAndUpdate(
    { _id: c._id, stage: c.stage }, // optimistic guard: the stage we validated against
    { $set: set },
    { new: true }
  );
  if (!updated) throw Conflict('CONCURRENT_UPDATE', 'The case changed while this order was being recorded. Try again.');

  const entry = await appendEvent({
    eventType: closing ? LEDGER_EVENT.CASE_CLOSED : LEDGER_EVENT.CASE_STAGE_CHANGED,
    caseId: c._id,
    subjectId: c._id,
    subjectType: SUBJECT_TYPE.CASE,
    actorUserId: req.user.userId,
    actorRole: req.user.role,
    ...(checked
      ? { actorSignature: checked.signatureHex, actorPubKeyFingerprint: checked.signer.publicKeyFingerprint ?? null }
      : {}),
    payload: {
      action,
      from: c.stage,
      to: verdict.to,
      ...(closing ? { reason: note } : { note: note ?? null }),
      cnrNumber: c.cnrNumber,
      courtId: c.courtId,
      orderedByAuthorityId: req.user.authorityId,
      ...(closing
        ? {
            closedByAuthorityId: req.user.authorityId,
            closureDocument: checked
              ? {
                  kind: closure.kind,
                  sha256: closure.sha256,
                  signerKeyFingerprint: closure.signerKeyFingerprint,
                }
              : null,
          }
        : {}),
    },
  });

  const doc = updated.toObject();
  return res.json({
    case: caseOut(doc),
    workflow: await workflowWithDetails(doc),
    ledgerSeq: entry.seq,
    entryHash: entry.entryHash,
    note: closing
      ? 'The case is closed. Every exhibit, custody record, forensic opinion, certificate and ledger entry is exactly where it was and stays readable — closing stops the record, it does not remove it.'
      : null,
  });
}

/**
 * POST /api/cases/:id/transition   { action, note? }   (COURT)
 *
 * The one route by which a case moves after the chargesheet. `action` is a
 * CASE_ACTION, never a stage: the client names the act, the state machine names the
 * stage it leads to.
 */
export async function transitionCase(req, res, next) {
  try {
    const body = parse(
      z.object({
        action: z.enum(COURT_ACTIONS),
        note: z.string().trim().max(2000).optional(),
        ...closureFields,
      }),
      req.body ?? {}
    );
    return await performCourtTransition(req, res, body.action, body.note, { ...body, file: req.file ?? null });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/cases/:id/closure-document   (READ on the case)
 *
 * The signed document the court attached when it closed the case, decrypted from the
 * vault, as an audited download. Court, police on the case and counsel on record.
 */
export async function getClosureDocument(req, res, next) {
  try {
    const c = await Case.findById(req.resource._id).select('+closure.storageKey').lean();
    const closure = c?.closure;
    if (!closure?.storageKey || !closure.sha256) {
      throw NotFound('NO_CLOSURE_DOCUMENT', 'No document was attached when this case was closed');
    }

    const bytes = await readSealedDocument(closure.storageKey, c._id);
    if (!bytes) throw NotFound('OBJECT_NOT_FOUND', 'The closing document is missing from the vault');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha !== closure.sha256) {
      throw Conflict('CLOSURE_DOCUMENT_ALTERED', 'The stored closing document no longer matches its recorded hash');
    }

    await writeAudit(req, {
      action: ACTION.DOWNLOAD,
      resourceType: RESOURCE_TYPE.CASE,
      resourceId: c._id,
      resourceLabel: c.cnrNumber ?? c.firNumber,
      caseId: c._id,
      decision: DECISION.ALLOW,
      reason: 'CLOSURE_DOCUMENT_DOWNLOAD',
    });

    const fileName = safeFileName(closure.fileName, `closure-${c.cnrNumber ?? String(c._id)}.pdf`).replace(/"/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Lexx-Sha256', closure.sha256);
    return res.send(bytes);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/cases/:id/close   { reason }   (COURT)
 *
 * Kept as its own route because closing is the end of the story. It is the CLOSE_CASE
 * transition: valid only once the court has taken the case up (cognizance, committal
 * or trial), never straight from a chargesheet the court has not looked at.
 *
 * It deletes nothing. Not an exhibit, not a custody record, not a forensic opinion,
 * not a certificate, not a ledger entry, not an anchor.
 */
export async function closeCase(req, res, next) {
  try {
    const body = parse(
      z.object({ reason: z.string().trim().min(3, 'Say why the case is being closed').max(2000), ...closureFields }),
      req.body ?? {}
    );
    return await performCourtTransition(req, res, CASE_ACTION.CLOSE_CASE, body.reason, {
      ...body,
      file: req.file ?? null,
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
  transitionCase,
  closureDocumentUpload,
  getClosureDocument,
  getWorkflow,
  getOverview,
  closureView,
};
