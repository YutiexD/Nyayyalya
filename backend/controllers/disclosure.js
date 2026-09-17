/**
 * Representation and counsel's case file (spec §8 F8).
 *
 * # The rule, in one sentence
 *
 * Counsel on record for a case can read that case and every exhibit in it — read-only
 * — from the moment the court puts them on record. There is no separate "share" act.
 *
 * Being on record is decided by the COURT: an accepted vakalatnama, a legal-aid order,
 * or the court register mirrored by `sync-representation`. Every one of those paths
 * ends in `ensureGrant` below, and the access resolver reads that grant directly. The
 * disclosure pack, its withholding rulings and its per-recipient service no longer
 * stand between counsel and the material: a court that had already accepted a lawyer
 * onto a case had to remember a second, manual step before that lawyer could see
 * anything, and in practice that step is where the accused's entitlement got lost.
 *
 * What did NOT change is the denial. An advocate who is not on record is refused with
 * `NOT_ON_RECORD_FOR_THIS_CASE` by `services/accessResolver.js`, and the refusal is
 * audited. Counsel are still read-only, still case-scoped, and never see machine
 * analysis of an exhibit.
 *
 * # Where facts come from
 *
 * - Grants come from the COURT DIRECTORY (accepted vakalatnamas / legal-aid orders).
 *   Lexx never invents an advocate's authority to see a case.
 * - The exhibit list is `Evidence.find({caseId})` intersected with the caller's own
 *   resolver scope, so the endpoint cannot return more than the plain evidence reads.
 */
import { Case } from '../models/Case.js';
import { Evidence } from '../models/Evidence.js';
import { User } from '../models/User.js';
import { Certificate } from '../models/Certificate.js';
import { CaseAccessGrant } from '../models/CaseAccessGrant.js';
import {
  ACTION,
  ADVOCATE_ROLES,
  AUTHORITY,
  CERTIFICATE_STATUS,
  DECISION,
  GRANT_BASIS,
  RESOURCE_TYPE,
  ROLE,
  USER_STATUS,
} from '../models/enums.js';
import { court } from '../services/directoryClient.js';
import { materialiseScopeFilter } from '../services/accessResolver.js';
import { labelFor } from '../services/evidenceLabel.js';
import { closureView } from '../services/lifecycleDetails.js';
import { emitChange } from '../services/realtime.js';
import { writeAudit } from '../middleware/audit.js';
import { Conflict } from '../utils/errors.js';

// ---------------------------------------------------------------- grants ----

/** Which Lexx grant role an accepted vakalatnama confers. */
export const APPEARING_FOR_TO_ROLE = Object.freeze({
  ACCUSED: ROLE.DEFENCE_COUNSEL,
  VICTIM: ROLE.VICTIM_COUNSEL,
});

/** Live advocate grants for a case, oldest first. */
export async function liveAdvocateGrants(caseId) {
  const now = new Date();
  return CaseAccessGrant.find({
    caseId,
    role: { $in: ADVOCATE_ROLES },
    revokedAt: null,
    $and: [
      { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
      { $or: [{ validTo: null }, { validTo: { $gte: now } }] },
    ],
  })
    .sort({ createdAt: 1 })
    .lean();
}

/**
 * Create a grant if there is not already a live one for this (case, user, role).
 * Returns a summary when something was created, `null` when it already existed.
 *
 * This is the single point at which counsel come on record, so it is also where the
 * BNSS s.230 "made available" date is stamped on the case — the first time any
 * advocate is put on record, the case file is available to them. The stamp is a
 * record for the compliance view; it gates nothing.
 */
export async function ensureGrant(spec) {
  const existing = await CaseAccessGrant.findOne({
    caseId: spec.caseId,
    userId: spec.userId,
    role: spec.role,
    revokedAt: null,
  }).lean();
  if (existing) return null;

  let created;
  try {
    created = await CaseAccessGrant.create(spec);
  } catch (err) {
    // The partial unique index on (caseId, userId, role) where revokedAt is null.
    // Losing that race means the grant now exists, which is the desired end state.
    if (err?.code === 11000) return null;
    throw err;
  }

  if (ADVOCATE_ROLES.includes(created.role)) {
    const now = new Date();
    const availableOn = created.validFrom && created.validFrom > now ? created.validFrom : now;
    await Case.updateOne(
      { _id: created.caseId, 'clocks.disclosureServedOn': null },
      { $set: { 'clocks.disclosureServedOn': availableOn } }
    );
  }

  return {
    grantId: String(created._id),
    userId: String(created.userId),
    role: created.role,
    grantBasis: created.grantBasis,
    grantRef: created.grantRef,
  };
}

/** Revoke a live grant. Revocation is a timestamp, never a delete. */
async function revokeGrant(caseId, userId, role, reason) {
  const result = await CaseAccessGrant.findOneAndUpdate(
    { caseId, userId, role, revokedAt: null },
    { $set: { revokedAt: new Date(), revocationReason: reason } },
    { new: true }
  ).lean();
  if (!result) return null;
  return { grantId: String(result._id), userId: String(result.userId), role, reason };
}

// ================================================= 1. SYNC REPRESENTATION ====

/**
 * POST /api/disclosure/:caseId/sync-representation   (COURT)
 *
 * Spec §8 F8 step 2: "Lexx polls / receives it → creates a CaseAccessGrant with
 * basis VAKALATNAMA".
 *
 * Nobody grants themselves access to a case. The court registry accepts a vakalatnama
 * in the COURT DIRECTORY; Lexx reads it and mirrors it as a grant. Not one field here
 * comes from the request body — not the advocate, not the role, not the party they
 * appear for, not the reference number. The body is not even read.
 *
 * A grant created here opens the case and its exhibits to that advocate immediately.
 * A withdrawn vakalatnama or a closed legal-aid assignment revokes the grant, and the
 * access goes with it, because the directory is the source of truth both ways.
 */
export async function syncRepresentation(req, res, next) {
  try {
    const caseDoc = req.resource;

    if (!caseDoc.cnrNumber) {
      throw Conflict(
        'CASE_NOT_LISTED',
        'This case has no CNR number yet. Representation is filed before a court, so there is nothing to sync until the case is listed.'
      );
    }

    // Only Lexx's own advocate accounts are candidates. An advocate with no Lexx
    // account is still on record in the court's own registry — they simply have no
    // Lexx session to grant anything to.
    const advocates = await User.find({ authority: AUTHORITY.LEGAL, status: USER_STATUS.ACTIVE })
      .select('_id name authorityId role')
      .lean();

    const granted = [];
    const revoked = [];
    const now = new Date();

    for (const advocate of advocates) {
      // A directory outage throws DirectoryUnavailableError and this whole request
      // fails closed with 503. We never fall back to a cached or assumed answer:
      // a stale "yes" here would hand case material to someone who came off record.
      const [vakResponse, aidResponse] = await Promise.all([
        court.getVakalatnamas(advocate.authorityId),
        court.getLegalAidAssignments(advocate.authorityId),
      ]);

      const vakalatnamas = (vakResponse?.vakalatnamas ?? []).filter(
        (v) => v.cnrNumber === caseDoc.cnrNumber
      );
      const legalAid = (aidResponse?.assignments ?? aidResponse?.legalAid ?? []).filter(
        (a) => a.cnrNumber === caseDoc.cnrNumber
      );

      for (const v of vakalatnamas) {
        const role = APPEARING_FOR_TO_ROLE[v.appearingFor];
        if (!role) continue; // an appearance type Lexx does not model is not a grant

        if (v.status === 'ACCEPTED') {
          const outcome = await ensureGrant({
            caseId: caseDoc._id,
            userId: advocate._id,
            role,
            grantBasis: GRANT_BASIS.VAKALATNAMA,
            // The external document this grant traces back to.
            grantRef: `VAK/${v.cnrNumber}/${advocate.authorityId}/${v.appearingFor}`,
            grantedByUserId: req.user.userId,
            validFrom: v.acceptedOn ? new Date(v.acceptedOn) : now,
          });
          if (outcome) granted.push({ ...outcome, authorityId: advocate.authorityId });
        } else {
          const gone = await revokeGrant(caseDoc._id, advocate._id, role, 'VAKALATNAMA_WITHDRAWN');
          if (gone) revoked.push({ ...gone, authorityId: advocate.authorityId });
        }
      }

      for (const a of legalAid) {
        if (a.status !== 'ACTIVE') {
          const gone = await revokeGrant(
            caseDoc._id,
            advocate._id,
            ROLE.LEGAL_AID_COUNSEL,
            'LEGAL_AID_ASSIGNMENT_CLOSED'
          );
          if (gone) revoked.push({ ...gone, authorityId: advocate.authorityId });
          continue;
        }
        const outcome = await ensureGrant({
          caseId: caseDoc._id,
          userId: advocate._id,
          role: ROLE.LEGAL_AID_COUNSEL,
          grantBasis: GRANT_BASIS.LEGAL_AID_ORDER,
          grantRef: a.courtOrderRef ?? `AID/${a.cnrNumber}/${advocate.authorityId}`,
          grantedByUserId: req.user.userId,
          validFrom: a.assignedOn ? new Date(a.assignedOn) : now,
        });
        if (outcome) granted.push({ ...outcome, authorityId: advocate.authorityId });
      }
    }

    // Grants change outside the ledger; tell open pages (and reset cached access).
    if (granted.length || revoked.length) {
      emitChange({ type: 'CASE_ACCESS_CHANGED', caseId: caseDoc._id });
    }

    await writeAudit(req, {
      action: ACTION.WRITE,
      resourceType: RESOURCE_TYPE.CASE,
      resourceId: caseDoc._id,
      resourceLabel: caseDoc.firNumber,
      caseId: caseDoc._id,
      decision: DECISION.ALLOW,
      reason: 'REPRESENTATION_SYNCED',
    });

    return res.json({
      caseId: String(caseDoc._id),
      cnrNumber: caseDoc.cnrNumber,
      advocatesChecked: advocates.length,
      granted,
      revoked,
      source: 'COURT_DIRECTORY',
    });
  } catch (err) {
    return next(err);
  }
}

// ======================================================== 2. THE CASE FILE ====

/**
 * The exhibit view counsel read.
 *
 * Deliberately narrow. `aiAnalysis` (machine review priority and manipulation
 * assessment) never leaves the investigation and the laboratory; `encryption` and
 * `storageKey` are operational secrets. The FSL opinion IS included: it is a filed
 * expert opinion and the parties are entitled to it.
 */
const EXHIBIT_FIELDS =
  '_id exhibitCode labelToken title description kind mimeType sizeBytes sha256Server capturedAt courtStatus forensic createdAt';

const exhibitView = (e, certificate) => ({
  evidenceId: String(e._id),
  exhibitCode: e.exhibitCode,
  title: e.title,
  description: e.description ?? null,
  kind: e.kind,
  mimeType: e.mimeType,
  sizeBytes: e.sizeBytes,
  sha256: e.sha256Server,
  hashAlgorithm: 'SHA-256',
  capturedAt: e.capturedAt ?? null,
  courtStatus: e.courtStatus,
  forensic: e.forensic?.status
    ? {
        status: e.forensic.status,
        opinion: e.forensic.opinion ?? null,
        labName: e.forensic.labName ?? null,
        section79ARef: e.forensic.section79ARef ?? null,
        reportedAt: e.forensic.reportedAt ?? null,
      }
    : null,
  certificateId: certificate?.certificateId ?? null,
  certificate: certificate ?? null,
  // The exhibit's permanent QR label; counsel may print it like any other reader.
  label: labelFor(e),
  createdAt: e.createdAt,
});

/**
 * GET /api/disclosure/case-file/:caseId   (counsel on record; anyone who may read the case)
 * GET /api/disclosure/my-pack/:caseId     (deprecated alias, same response)
 *
 * The case and every exhibit in it, as counsel see them.
 *
 * READ on the CASE is the gate, so an advocate who is not on record is refused by the
 * resolver with NOT_ON_RECORD_FOR_THIS_CASE, and audited, before this runs. The
 * exhibit query is then intersected with the caller's own evidence scope — the same
 * filter `GET /api/evidence` applies — so this can never show more than the plain
 * reads would.
 */
export async function getCaseFile(req, res, next) {
  try {
    const caseDoc = req.resource;
    const evScope = await materialiseScopeFilter(req.user, RESOURCE_TYPE.EVIDENCE);

    const [grants, exhibits] = await Promise.all([
      CaseAccessGrant.find({ caseId: caseDoc._id, userId: req.user.userId, revokedAt: null })
        .select('role grantBasis grantRef validFrom')
        .sort({ createdAt: 1 })
        .lean(),
      evScope
        ? Evidence.find({ $and: [evScope, { caseId: caseDoc._id }] })
            .select(EXHIBIT_FIELDS)
            .sort({ createdAt: 1 })
            .lean()
        : [],
    ]);

    const certificates = exhibits.length
      ? await Certificate.find({
          evidenceId: { $in: exhibits.map((e) => e._id) },
          status: CERTIFICATE_STATUS.ACTIVE,
        })
          .select('_id evidenceId status issuedAt generatedAt lastVerification')
          .lean()
      : [];
    const certByEvidence = new Map(
      certificates.map((c) => [
        String(c.evidenceId),
        {
          certificateId: String(c._id),
          status: c.status,
          issuedAt: c.issuedAt ?? c.generatedAt ?? null,
          lastVerification: c.lastVerification
            ? { result: c.lastVerification.result, at: c.lastVerification.at, byRole: c.lastVerification.byRole ?? null }
            : null,
        },
      ])
    );

    return res.json({
      caseId: String(caseDoc._id),
      cnrNumber: caseDoc.cnrNumber ?? null,
      firNumber: caseDoc.firNumber,
      title: caseDoc.title ?? null,
      stage: caseDoc.stage,
      courtId: caseDoc.courtId ?? null,
      /** How the court closed the case, and the signed document it attached, if any. */
      closure: closureView(caseDoc.closure),
      onRecord: grants.map((g) => ({
        role: g.role,
        grantBasis: g.grantBasis,
        grantRef: g.grantRef,
        validFrom: g.validFrom,
      })),
      /** BNSS s.230 dates, for display. Neither of them gates access. */
      clocks: {
        disclosureDueOn: caseDoc.clocks?.disclosureDueOn ?? null,
        disclosureServedOn: caseDoc.clocks?.disclosureServedOn ?? null,
      },
      exhibitCount: exhibits.length,
      exhibits: exhibits.map((e) => exhibitView(e, certByEvidence.get(String(e._id)))),
    });
  } catch (err) {
    return next(err);
  }
}

export default {
  APPEARING_FOR_TO_ROLE,
  liveAdvocateGrants,
  ensureGrant,
  syncRepresentation,
  getCaseFile,
};
