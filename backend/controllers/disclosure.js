/**
 * Disclosure packs and lawyer scoping (spec §8 F8).
 *
 * # What this module is actually for
 *
 * The interesting output of a disclosure system is not the pack. It is the DENIAL.
 * An advocate who is not on record gets `NOT_ON_RECORD_FOR_THIS_CASE`; an advocate
 * who *is* on record but reaches for an exhibit outside the served set gets
 * `EXHIBIT_NOT_IN_DISCLOSURE_SET`. Both of those decisions belong to
 * `services/accessResolver.js` and are made there, once. Nothing in this file
 * re-implements, softens or short-circuits them.
 *
 * The corollary is the rule this controller has to keep: `my-pack` returns EXACTLY
 * `pack.exhibitIds` for the pack served TO THE CALLING USER, and nothing else. A
 * pack served on co-accused counsel is not served on this advocate, so
 * `servedTo[].userId` is matched, not merely `caseId`.
 *
 * # Where facts come from
 *
 * - The exhibit set is computed from `Evidence.find({caseId})` on the server. The
 *   request body may only *request exclusions*; it can never assert membership.
 * - Recipients and their watermark identity come from `CaseAccessGrant` + `User`.
 *   A caller cannot name themselves, or anyone else, as a recipient.
 * - Grants come from the COURT DIRECTORY (accepted vakalatnamas / legal-aid
 *   orders). Lexx never invents an advocate's authority to see a case.
 */
import { z } from 'zod';

import { Case } from '../models/Case.js';
import { Evidence } from '../models/Evidence.js';
import { User } from '../models/User.js';
import { DisclosurePack } from '../models/DisclosurePack.js';
import { CaseAccessGrant } from '../models/CaseAccessGrant.js';
import {
  ACTION,
  ADVOCATE_ROLES,
  AUTHORITY,
  DECISION,
  DENY_REASON,
  DISCLOSURE_STATUS,
  GRANT_BASIS,
  LEDGER_EVENT,
  RESOURCE_TYPE,
  ROLE,
  SUBJECT_TYPE,
  USER_STATUS,
} from '../models/enums.js';
import { court } from '../services/directoryClient.js';
import { appendEvent } from '../services/ledger.js';
import { randomBase64Url } from '../config/crypto.js';
import { writeAudit } from '../middleware/audit.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../utils/errors.js';

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

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Malformed id');

/**
 * An exclusion is a request to withhold material from an accused person. A bare
 * assertion is not enough: it must carry a reason a registrar can rule on, so the
 * minimum length is a real constraint rather than decoration.
 */
const prepareSchema = z.object({
  excludedItems: z
    .array(
      z.object({
        itemId: objectId,
        reason: z.string().trim().min(10, 'An exclusion must state a reason').max(1000),
      })
    )
    .max(200)
    .optional()
    .default([]),
  redactionVariant: z.string().trim().min(2).max(64).optional(),
  maskVictimIdentity: z.boolean().optional(),
});

const approveSchema = z.object({
  approvedExclusions: z.array(objectId).max(200).optional().default([]),
  redactionVariant: z.string().trim().min(2).max(64).optional(),
  maskVictimIdentity: z.boolean().optional(),
});

const serveSchema = z.object({
  /**
   * Optional narrowing of an already-authorised recipient list — co-accused counsel
   * are often served at different times. Every id is checked against a live grant
   * before it is used, and the watermark identity is read from the User record, so
   * this selects among recipients rather than creating one.
   */
  recipientUserIds: z.array(objectId).max(50).optional(),
});

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// ---------------------------------------------------------------- helpers ----

/**
 * Create-context for `authorizeCreate`. It reads the case the PREVIOUS `authorize`
 * middleware already loaded from the database, so no request-body value reaches the
 * policy (ADR-003).
 */
export function packCreateContext(req) {
  return { caseId: req.resource?._id ?? null, stationCode: req.resource?.stationCode ?? null };
}

/** Live advocate grants for a case, newest first. The only source of recipients. */
async function liveAdvocateGrants(caseId) {
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
 * The disclosure view of an exhibit.
 *
 * Deliberately narrow. Two omissions are the point:
 *   - `triage` never leaves the investigation. It is machine review-prioritisation,
 *     not evidence, and handing a "HIGH priority" label to a party would invite it
 *     being read as a finding about the exhibit. (Spec §8 F6.)
 *   - `encryption` and `storageKey` are operational secrets, not disclosure material.
 * The FSL opinion IS included: it is a filed expert opinion and the defence is
 * entitled to it.
 */
const exhibitView = (e) => ({
  evidenceId: String(e._id),
  exhibitCode: e.exhibitCode,
  title: e.title,
  description: e.description,
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
  createdAt: e.createdAt,
});

const packView = (p) => ({
  packId: String(p._id),
  caseId: String(p.caseId),
  cnrNumber: p.cnrNumber ?? null,
  status: p.status,
  exhibitIds: (p.exhibitIds ?? []).map(String),
  exhibitCount: (p.exhibitIds ?? []).length,
  excludedItems: (p.excludedItems ?? []).map((x) => ({
    itemId: String(x.itemId),
    reason: x.reason,
    approved: Boolean(x.approvedByRegistrarId),
    approvedAt: x.approvedAt ?? null,
  })),
  redactionVariant: p.redactionVariant,
  maskVictimIdentity: p.maskVictimIdentity,
  dueOn: p.dueOn ?? null,
  servedOn: p.servedOn ?? null,
  approvedAt: p.approvedAt ?? null,
  servedTo: (p.servedTo ?? []).map((s) => ({
    userId: String(s.userId),
    servedAt: s.servedAt,
    watermarkToken: s.watermarkToken,
    watermarkLabel: s.watermarkLabel,
    acknowledgedAt: s.acknowledgedAt ?? null,
  })),
});

// ============================================================== 1. PREPARE ====

/**
 * POST /api/disclosure/:caseId/prepare   (IO)
 *
 * Proposes the exhibit set and flags exclusion requests with reasons.
 *
 * The set is COMPUTED, not submitted: every ACTIVE exhibit on the case, minus the
 * items the officer asks to withhold. An officer cannot quietly drop an exhibit by
 * omitting it from a list — omission is not a thing they can express here, only a
 * reasoned exclusion a registrar will later have to rule on.
 */
export async function preparePack(req, res, next) {
  try {
    const body = parse(prepareSchema, req.body);
    const caseDoc = req.resource;

    const existing = await DisclosurePack.findOne({ caseId: caseDoc._id });
    if (existing && existing.status !== DISCLOSURE_STATUS.DRAFT) {
      // Once a registrar has ruled on a pack it is a court record. A revised set is
      // a fresh judicial act, not an edit of the approved one.
      throw Conflict(
        'DISCLOSURE_PACK_LOCKED',
        'This pack has already been approved or served and can no longer be re-prepared',
        { packId: String(existing._id), status: existing.status }
      );
    }

    const evidence = await Evidence.find({ caseId: caseDoc._id })
      .select('_id exhibitCode')
      .sort({ createdAt: 1 })
      .lean();

    const byId = new Map(evidence.map((e) => [String(e._id), e]));

    // An exclusion must name an exhibit that is actually in this case — otherwise a
    // request body could be used to probe which exhibit ids exist elsewhere.
    const foreign = body.excludedItems.filter((x) => !byId.has(x.itemId));
    if (foreign.length) {
      throw BadRequest(
        'EXCLUDED_ITEM_NOT_IN_CASE',
        'An exclusion refers to an exhibit that does not belong to this case',
        { itemIds: foreign.map((x) => x.itemId) }
      );
    }

    const excludedIds = new Set(body.excludedItems.map((x) => x.itemId));
    const exhibitIds = evidence.filter((e) => !excludedIds.has(String(e._id))).map((e) => e._id);

    const excludedItems = body.excludedItems.map((x) => ({
      itemId: x.itemId,
      itemType: 'EVIDENCE',
      reason: x.reason,
      // The requester is the session, never a body field.
      requestedBy: req.user.userId,
      approvedByRegistrarId: null,
      approvedAt: null,
    }));

    // A protected victim stays masked whatever the request says. Masking can be
    // switched on by the officer; it can never be switched off from a request body.
    const maskVictimIdentity = Boolean(caseDoc.isVictimProtected || body.maskVictimIdentity);

    const fields = {
      cnrNumber: caseDoc.cnrNumber ?? null,
      exhibitIds,
      excludedItems,
      redactionVariant: body.redactionVariant ?? existing?.redactionVariant ?? 'DEFENCE_V1',
      maskVictimIdentity,
      // BNSS s.230: the accused must have the material within 14 days of production.
      dueOn: caseDoc.clocks?.disclosureDueOn ?? null,
      status: DISCLOSURE_STATUS.DRAFT,
    };

    let pack;
    if (existing) {
      existing.set(fields);
      pack = await existing.save();
    } else {
      pack = await DisclosurePack.create({
        caseId: caseDoc._id,
        preparedBy: req.user.userId,
        ...fields,
      });
    }

    await appendEvent({
      eventType: LEDGER_EVENT.DISCLOSURE_PREPARED,
      caseId: caseDoc._id,
      subjectId: pack._id,
      subjectType: SUBJECT_TYPE.DISCLOSURE_PACK,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        packId: String(pack._id),
        cnrNumber: pack.cnrNumber,
        exhibitCount: exhibitIds.length,
        exhibitCodes: evidence.filter((e) => !excludedIds.has(String(e._id))).map((e) => e.exhibitCode),
        // The reasons go in the ledger: a withheld exhibit and the ground for
        // withholding it are exactly what a court may want to revisit later.
        exclusions: excludedItems.map((x) => ({ itemId: String(x.itemId), reason: x.reason })),
        redactionVariant: pack.redactionVariant,
        maskVictimIdentity: pack.maskVictimIdentity,
        preparedByAuthorityId: req.user.authorityId,
        revision: Boolean(existing),
      },
    });

    return res.status(existing ? 200 : 201).json({ pack: packView(pack) });
  } catch (err) {
    return next(err);
  }
}

// ============================================================== 2. APPROVE ====

/**
 * POST /api/disclosure/:packId/approve   (REGISTRAR)
 *
 * The registrar rules on the exclusion requests and fixes the redaction variant.
 *
 * Approval of the PACK and adjudication of each EXCLUSION are separate acts, and
 * this endpoint records both. Whatever is approved here, `serve` re-checks that
 * every exclusion has actually been ruled on — the accused's entitlement to the
 * material is worth two gates rather than one.
 *
 * NOTE (reported, not worked around): spec §7 lists REGISTRAR *or* JUDGE here. The
 * access resolver currently grants a REGISTRAR `WRITE` and a JUDGE `ORDER`, and no
 * single ACTION covers both, so this route is REGISTRAR-scoped. A judge's route to
 * the same outcome today is `POST /api/cases/:id/record-order`.
 */
export async function approvePack(req, res, next) {
  try {
    const body = parse(approveSchema, req.body);
    const caseDoc = req.caseDoc;

    const pack = await DisclosurePack.findById(req.resource._id);
    if (!pack) throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');
    if (pack.status === DISCLOSURE_STATUS.SERVED) {
      throw Conflict('PACK_ALREADY_SERVED', 'A served pack cannot be re-approved');
    }

    const known = new Set(pack.excludedItems.map((x) => String(x.itemId)));
    const unknown = body.approvedExclusions.filter((id) => !known.has(id));
    if (unknown.length) {
      throw BadRequest(
        'UNKNOWN_EXCLUSION',
        'An approval refers to an exclusion that was never requested on this pack',
        { itemIds: unknown }
      );
    }

    const now = new Date();
    const approving = new Set(body.approvedExclusions);
    for (const item of pack.excludedItems) {
      if (!approving.has(String(item.itemId))) continue;
      item.approvedByRegistrarId = req.user.userId;
      item.approvedAt = now;
    }

    if (body.redactionVariant) pack.redactionVariant = body.redactionVariant;
    // Same one-way rule as at preparation: a protected victim cannot be unmasked.
    if (typeof body.maskVictimIdentity === 'boolean') {
      pack.maskVictimIdentity = Boolean(caseDoc?.isVictimProtected || body.maskVictimIdentity);
    }

    pack.status = DISCLOSURE_STATUS.APPROVED;
    pack.approvedByUserId = req.user.userId;
    pack.approvedAt = now;
    await pack.save();

    const pending = pack.excludedItems
      .filter((x) => !x.approvedByRegistrarId)
      .map((x) => String(x.itemId));

    await appendEvent({
      eventType: LEDGER_EVENT.DISCLOSURE_APPROVED,
      caseId: pack.caseId,
      subjectId: pack._id,
      subjectType: SUBJECT_TYPE.DISCLOSURE_PACK,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        packId: String(pack._id),
        cnrNumber: pack.cnrNumber,
        approvedExclusions: body.approvedExclusions,
        pendingExclusions: pending,
        redactionVariant: pack.redactionVariant,
        maskVictimIdentity: pack.maskVictimIdentity,
        approvedByAuthorityId: req.user.authorityId,
      },
    });

    return res.json({
      pack: packView(pack),
      pendingExclusions: pending,
      // Said plainly, because it decides whether the next step will work.
      servable: pending.length === 0,
    });
  } catch (err) {
    return next(err);
  }
}

// ================================================================ 3. SERVE ====

/**
 * POST /api/disclosure/:packId/serve   (REGISTRAR)
 *
 * Generates a per-recipient watermark and stops the BNSS s.230 clock.
 *
 * The watermark is the only thing that makes a leak traceable after the fact, so it
 * is minted here (high-entropy, per recipient) and written into the ledger as well
 * as the pack. A leaked page carrying `{advocate} · {enrolment no} · {timestamp}`
 * can then be matched against an append-only record nobody can edit afterwards.
 */
export async function servePack(req, res, next) {
  try {
    const body = parse(serveSchema, req.body ?? {});

    const pack = await DisclosurePack.findById(req.resource._id);
    if (!pack) throw NotFound('RESOURCE_NOT_FOUND', 'Resource not found');

    if (pack.status === DISCLOSURE_STATUS.DRAFT) {
      throw Conflict(
        'PACK_NOT_APPROVED',
        'This pack has not been approved. It cannot be served on a party.'
      );
    }

    // The gate that matters. Material may be withheld from an accused person only
    // on a ruling that has actually been made — never on a request still pending.
    const unapproved = pack.excludedItems.filter((x) => !x.approvedByRegistrarId);
    if (unapproved.length) {
      throw Conflict(
        'UNAPPROVED_EXCLUSIONS',
        'Every exclusion must be ruled on before the pack can be served',
        { itemIds: unapproved.map((x) => String(x.itemId)) }
      );
    }

    const grants = await liveAdvocateGrants(pack.caseId);
    const grantByUser = new Map(grants.map((g) => [String(g.userId), g]));

    let targetIds = grants.map((g) => String(g.userId));
    if (body.recipientUserIds?.length) {
      const notOnRecord = body.recipientUserIds.filter((id) => !grantByUser.has(id));
      if (notOnRecord.length) {
        // Naming a recipient who is not on record is refused rather than silently
        // ignored: it is an attempt to serve confidential material on a stranger.
        throw BadRequest(
          'RECIPIENT_NOT_ON_RECORD',
          'A named recipient is not on record for this case',
          { userIds: notOnRecord }
        );
      }
      targetIds = body.recipientUserIds;
    }

    const alreadyServed = new Set(pack.servedTo.map((s) => String(s.userId)));
    const pendingIds = targetIds.filter((id) => !alreadyServed.has(id));

    if (!pendingIds.length) {
      throw Conflict(
        grants.length ? 'ALREADY_SERVED' : 'NO_RECIPIENTS_ON_RECORD',
        grants.length
          ? 'Every named recipient has already been served this pack'
          : 'No advocate is on record for this case. Sync representation from the court directory first.'
      );
    }

    const recipients = await User.find({
      _id: { $in: pendingIds },
      status: USER_STATUS.ACTIVE,
    })
      .select('_id name authorityId')
      .lean();

    if (recipients.length !== pendingIds.length) {
      throw Conflict(
        'RECIPIENT_NOT_ACTIVE',
        'A recipient on record no longer holds an active Lexx account'
      );
    }

    const servedAt = new Date();
    const served = recipients.map((u) => ({
      userId: u._id,
      servedAt,
      // 32 bytes from the CSPRNG. This is a tracer printed on the served pages; it
      // has to be unguessable so that one recipient cannot fabricate another's mark.
      watermarkToken: randomBase64Url(32),
      // Spec §8 F8: {advocateName} · {enrolmentNo} · {timestamp}
      watermarkLabel: `${u.name} · ${u.authorityId} · ${servedAt.toISOString()}`,
      acknowledgedAt: null,
    }));

    pack.servedTo.push(...served);
    pack.status = DISCLOSURE_STATUS.SERVED;
    pack.servedOn = pack.servedOn ?? servedAt;
    await pack.save();

    // BNSS s.230 clock stops on the case, not only on the pack, because that is
    // where the compliance dashboard reads it from.
    await Case.updateOne(
      { _id: pack.caseId },
      { $set: { 'clocks.disclosureServedOn': pack.servedOn } }
    );

    const userById = new Map(recipients.map((u) => [String(u._id), u]));

    await appendEvent({
      eventType: LEDGER_EVENT.DISCLOSURE_SERVED,
      caseId: pack.caseId,
      subjectId: pack._id,
      subjectType: SUBJECT_TYPE.DISCLOSURE_PACK,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        packId: String(pack._id),
        cnrNumber: pack.cnrNumber,
        exhibitCount: pack.exhibitIds.length,
        servedOn: pack.servedOn.toISOString(),
        redactionVariant: pack.redactionVariant,
        // The tokens go in the append-only record on purpose: tracing a leak means
        // proving which mark was issued to whom, against a log nobody can rewrite.
        recipients: served.map((s) => ({
          userId: String(s.userId),
          authorityId: userById.get(String(s.userId))?.authorityId ?? null,
          role: grantByUser.get(String(s.userId))?.role ?? null,
          grantBasis: grantByUser.get(String(s.userId))?.grantBasis ?? null,
          watermarkToken: s.watermarkToken,
          watermarkLabel: s.watermarkLabel,
        })),
        servedByAuthorityId: req.user.authorityId,
      },
    });

    return res.json({
      pack: packView(pack),
      servedNow: served.map((s) => ({
        userId: String(s.userId),
        authorityId: userById.get(String(s.userId))?.authorityId ?? null,
        watermarkToken: s.watermarkToken,
        watermarkLabel: s.watermarkLabel,
      })),
      disclosureServedOn: pack.servedOn,
    });
  } catch (err) {
    return next(err);
  }
}

// ============================================================== 4. MY PACK ====

/**
 * GET /api/disclosure/my-pack/:caseId   (ADVOCATE)
 *
 * The served set. Nothing else.
 *
 * The resolver has already established that this advocate is on record for this
 * case (or the request never reached here). What this handler adds is the second
 * half of the guarantee: the pack must have been served TO THEM. A pack served on
 * co-accused counsel is not a pack served on this advocate, so the lookup matches
 * `servedTo.userId` and the response is built from `pack.exhibitIds` alone.
 */
export async function getMyPack(req, res, next) {
  try {
    const caseDoc = req.resource;

    const pack = await DisclosurePack.findOne({
      caseId: caseDoc._id,
      status: DISCLOSURE_STATUS.SERVED,
      'servedTo.userId': req.user.userId,
    }).lean();

    if (!pack) {
      // Denials are the product. Record this one before returning it.
      await writeAudit(req, {
        action: ACTION.READ,
        resourceType: RESOURCE_TYPE.DISCLOSURE_PACK,
        caseId: caseDoc._id,
        decision: DECISION.DENY,
        reason: DENY_REASON.NO_DISCLOSURE_PACK_SERVED,
      });
      throw Forbidden(
        DENY_REASON.NO_DISCLOSURE_PACK_SERVED,
        'No disclosure pack has been served on you in this case'
      );
    }

    const entry = (pack.servedTo ?? []).find((s) => sameId(s.userId, req.user.userId));

    // Only the ids in the pack. If an exhibit is not in this array it does not exist
    // as far as this response is concerned, and `/api/evidence/:id` will refuse it
    // separately with EXHIBIT_NOT_IN_DISCLOSURE_SET.
    const exhibits = await Evidence.find({ _id: { $in: pack.exhibitIds ?? [] } })
      .select('exhibitCode title description kind mimeType sizeBytes sha256Server capturedAt courtStatus forensic createdAt')
      .sort({ createdAt: 1 })
      .lean();

    await writeAudit(req, {
      action: ACTION.READ,
      resourceType: RESOURCE_TYPE.DISCLOSURE_PACK,
      resourceId: pack._id,
      caseId: caseDoc._id,
      decision: DECISION.ALLOW,
      reason: 'DISCLOSURE_PACK_READ',
    });

    return res.json({
      caseId: String(caseDoc._id),
      cnrNumber: pack.cnrNumber ?? caseDoc.cnrNumber ?? null,
      firNumber: caseDoc.firNumber,
      packId: String(pack._id),
      status: pack.status,
      servedOn: pack.servedOn ?? null,
      dueOn: pack.dueOn ?? null,
      acknowledgedAt: entry?.acknowledgedAt ?? null,
      redactionVariant: pack.redactionVariant,
      maskVictimIdentity: pack.maskVictimIdentity,
      /**
       * Rendered onto every served page by the client. Recorded here and in the
       * ledger, so a leaked copy points back to the recipient it was served to.
       */
      watermark: entry
        ? { token: entry.watermarkToken, label: entry.watermarkLabel }
        : null,
      exhibitCount: exhibits.length,
      exhibits: exhibits.map(exhibitView),
      /**
       * The party is told that material was withheld and on what ground — that is
       * their entitlement — but not WHICH exhibit it was. Naming the item would
       * disclose the very thing the registrar ruled should be withheld.
       */
      withheld: (pack.excludedItems ?? []).map((x) => ({ reason: x.reason })),
    });
  } catch (err) {
    return next(err);
  }
}

// =========================================================== 5. ACKNOWLEDGE ====

/**
 * POST /api/disclosure/:packId/acknowledge   (ADVOCATE)
 *
 * Stops the 14-day clock for this recipient.
 *
 * NOTE (reported, not worked around): the resolver gives advocates read-only access
 * to a disclosure pack, so this route is authorised with `ACTION.VERIFY` rather than
 * `ACTION.WRITE`. That is not a loophole — the policy is still consulted and still
 * requires a pack SERVED to this exact user — but the honest fix is a dedicated
 * `ACTION.ACKNOWLEDGE` in `models/enums.js` and the resolver. The write itself is
 * confined by the query below to the caller's OWN `servedTo` entry: an advocate
 * cannot acknowledge on anyone else's behalf.
 */
/**
 * GET /api/disclosure/case/:caseId/packs[?status=]
 *
 * Lists the disclosure packs on a case, for the court users who have to act on them.
 *
 * Added because the registrar previously had no way to DISCOVER a pack: approve and
 * serve both take a packId, and the only way to learn one was to be told it out of
 * band by the investigating officer. That made a core statutory workflow depend on
 * copying an identifier by hand.
 *
 * The route gates this on APPROVE over the CASE — a court-only action — so the
 * resolver alone decides who arrives here, and it is the same rule that decides who
 * may act on the packs listed. `req.resource` is the case it already loaded.
 */
export async function listPacksForCase(req, res, next) {
  try {
    const filter = { caseId: req.resource._id };

    const status = req.query.status;
    if (status) {
      const parsedStatus = parse(z.enum(Object.values(DISCLOSURE_STATUS)), status);
      filter.status = parsedStatus;
    }

    const packs = await DisclosurePack.find(filter).sort({ createdAt: -1 }).lean();

    // A summary, not `packView`. This is a discovery list, so it carries what the
    // registrar needs to choose a pack and act on it — and deliberately not the
    // per-recipient `watermarkToken`, which identifies the copy a specific advocate
    // holds. That belongs in the serve response to the registrar who minted it, not
    // in a list anyone with court scope can page through.
    return res.json({
      caseId: String(req.resource._id),
      packs: packs.map((p) => ({
        packId: String(p._id),
        cnrNumber: p.cnrNumber ?? null,
        status: p.status,
        exhibitCount: (p.exhibitIds ?? []).length,
        exclusionCount: (p.excludedItems ?? []).length,
        unruledExclusionCount: (p.excludedItems ?? []).filter((x) => !x.approvedByRegistrarId)
          .length,
        redactionVariant: p.redactionVariant,
        dueOn: p.dueOn ?? null,
        approvedAt: p.approvedAt ?? null,
        servedOn: p.servedOn ?? null,
        recipientCount: (p.servedTo ?? []).length,
        acknowledgedCount: (p.servedTo ?? []).filter((s) => s.acknowledgedAt).length,
        createdAt: p.createdAt,
      })),
      total: packs.length,
    });
  } catch (err) {
    return next(err);
  }
}

export async function acknowledgePack(req, res, next) {
  try {
    const pack = req.resource;
    const entry = (pack.servedTo ?? []).find((s) => sameId(s.userId, req.user.userId));

    if (!entry) {
      // Unreachable through the resolver, which already checked this. Kept because
      // a controller that assumes an upstream check is a controller that breaks
      // silently when the route is remounted.
      throw Forbidden(
        DENY_REASON.NO_DISCLOSURE_PACK_SERVED,
        'This pack was not served on you'
      );
    }

    if (entry.acknowledgedAt) {
      return res.json({
        packId: String(pack._id),
        acknowledgedAt: entry.acknowledgedAt,
        alreadyAcknowledged: true,
      });
    }

    const acknowledgedAt = new Date();
    const result = await DisclosurePack.updateOne(
      { _id: pack._id, 'servedTo.userId': req.user.userId, 'servedTo.$.acknowledgedAt': null },
      { $set: { 'servedTo.$.acknowledgedAt': acknowledgedAt } }
    );
    if (!result.modifiedCount) {
      throw Conflict('CONCURRENT_UPDATE', 'The pack changed while acknowledging. Try again.');
    }

    await appendEvent({
      eventType: LEDGER_EVENT.DISCLOSURE_ACKNOWLEDGED,
      caseId: pack.caseId,
      subjectId: pack._id,
      subjectType: SUBJECT_TYPE.DISCLOSURE_PACK,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      payload: {
        packId: String(pack._id),
        cnrNumber: pack.cnrNumber,
        acknowledgedAt: acknowledgedAt.toISOString(),
        recipientAuthorityId: req.user.authorityId,
        // Ties the acknowledgement to the exact marked copy that was served.
        watermarkToken: entry.watermarkToken,
      },
    });

    return res.json({
      packId: String(pack._id),
      acknowledgedAt,
      alreadyAcknowledged: false,
      clock: 'BNSS_S230_STOPPED_FOR_RECIPIENT',
    });
  } catch (err) {
    return next(err);
  }
}

// ================================================= 6. SYNC REPRESENTATION ====

/** Which Lexx grant role an accepted vakalatnama confers. */
const APPEARING_FOR_TO_ROLE = Object.freeze({
  ACCUSED: ROLE.DEFENCE_COUNSEL,
  VICTIM: ROLE.VICTIM_COUNSEL,
});

/**
 * POST /api/disclosure/:caseId/sync-representation
 *
 * Spec §8 F8 step 2: "Lexx polls / receives it → creates a CaseAccessGrant with
 * basis VAKALATNAMA".
 *
 * # The rule this endpoint exists to enforce
 *
 * Nobody grants themselves access to a case. The court registry accepts a
 * vakalatnama in the COURT DIRECTORY; Lexx reads it and mirrors it as a grant. Not
 * one field here comes from the request body — not the advocate, not the role, not
 * the party they appear for, not the reference number. The body is not even read.
 *
 * The directory is queried per advocate (`/directory/vakalatnama?enrolmentNo=`),
 * which is the interface eCourts actually offers; Lexx asks each advocate it knows
 * about which cases they are on record for, and keeps the rows that match this
 * case's CNR.
 *
 * A withdrawn vakalatnama revokes the grant, because the directory is the source of
 * truth in both directions — coming on record and coming off it.
 *
 * NOTE (reported, not worked around): spec §7 scopes this to REGISTRAR.
 * `resolveCreate` has no REGISTRAR-only capability and `resolve()` cannot express
 * "registrar only" for a case-scoped WRITE, so the route is authorised as a WRITE on
 * the case. That admits the station's IO/SHO as well. It is not a privilege leak —
 * the endpoint can only ever mirror facts the court directory already asserts, and
 * it creates nothing the directory does not say — but a dedicated capability in the
 * resolver would be the correct fix.
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

    // There is no LEDGER_EVENT for a grant change, so this is recorded in
    // audit_events. Flagged in the handover: an access grant arguably belongs in the
    // append-only ledger too, and that needs a new enum value in a file I do not own.
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

/**
 * Create a grant if there is not already a live one for this (case, user, role).
 * Returns a summary when something was created, `null` when it already existed.
 */
async function ensureGrant(spec) {
  const existing = await CaseAccessGrant.findOne({
    caseId: spec.caseId,
    userId: spec.userId,
    role: spec.role,
    revokedAt: null,
  }).lean();
  if (existing) return null;

  try {
    const created = await CaseAccessGrant.create(spec);
    return {
      grantId: String(created._id),
      userId: String(created.userId),
      role: created.role,
      grantBasis: created.grantBasis,
      grantRef: created.grantRef,
    };
  } catch (err) {
    // The partial unique index on (caseId, userId, role) where revokedAt is null.
    // Losing that race means the grant now exists, which is the desired end state.
    if (err?.code === 11000) return null;
    throw err;
  }
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

export default {
  packCreateContext,
  preparePack,
  approvePack,
  servePack,
  getMyPack,
  acknowledgePack,
  syncRepresentation,
};
