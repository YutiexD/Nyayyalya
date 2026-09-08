/**
 * THE access resolver. One function. Every protected route calls it.
 * There are no ad-hoc role checks anywhere else in this codebase.
 *
 * # Two rules that make this file trustworthy
 *
 * 1. **It loads the resource itself.** Callers pass a resource TYPE and an ID, never
 *    a resource object. If a controller could hand this function something built
 *    from `req.body`, an attacker would simply post their own `stationCode` and
 *    every jurisdiction check in here would pass. (ADR-003)
 *
 * 2. **It reads authority from the database, not from the token.** The `user` passed
 *    in is loaded fresh per request by `resolveContext`. A JWT minted before a
 *    suspension, a transfer or a roster change carries stale authority, and we would
 *    otherwise honour it for the full token lifetime. (ADR-005)
 *
 * Default is deny. Every path returns an explicit decision; falling off the end
 * returns NO_MATCHING_POLICY rather than allowing anything.
 */
import {
  AUTHORITY,
  ROLE,
  ACTION,
  RESOURCE_TYPE,
  DENY_REASON,
  USER_STATUS,
  WRITABLE_CASE_STAGES,
  ADVOCATE_ROLES,
  DISCLOSURE_STATUS,
  REFERRAL_STATUS,
} from '../models/enums.js';
import { Case } from '../models/Case.js';
import { Evidence } from '../models/Evidence.js';
import { CustodyItem } from '../models/CustodyItem.js';
import { Referral } from '../models/Referral.js';
import { DisclosurePack } from '../models/DisclosurePack.js';
import { Certificate } from '../models/Certificate.js';
import { CaseAccessGrant } from '../models/CaseAccessGrant.js';

// ---------------------------------------------------------------- decisions ----

const READ_ACTIONS = new Set([ACTION.READ, ACTION.VERIFY, ACTION.DOWNLOAD]);

const allow = (scopeFilter = null) => ({ allow: true, reason: null, scopeFilter });
const deny = (reason) => ({ allow: false, reason, scopeFilter: null });

/** Read, verify and download only. Any mutation is refused. */
const allowReadOnly = (action) =>
  READ_ACTIONS.has(action) ? allow() : deny(DENY_REASON.READ_ONLY_ROLE);

/**
 * A judge reads a case, records orders on it, and rules on what others prepared —
 * but does not investigate it. WRITE (authorship) stays with the police.
 */
const allowReadPlusOrders = (action) =>
  READ_ACTIONS.has(action) || action === ACTION.ORDER || action === ACTION.APPROVE
    ? allow()
    : deny(DENY_REASON.READ_ONLY_ROLE);

/** Actions that belong to the court, never to the investigation. */
const COURT_ONLY_ACTIONS = new Set([ACTION.ORDER, ACTION.APPROVE]);

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// ---------------------------------------------------------------- loading ----

/**
 * Load the resource and the case it belongs to, straight from the database.
 *
 * Returns `{ resource, caseDoc }`. Everything the policy reads comes from here,
 * which is what makes the policy unforgeable from the request.
 */
async function loadResource(resourceType, resourceId) {
  switch (resourceType) {
    case RESOURCE_TYPE.CASE: {
      const caseDoc = await Case.findById(resourceId).lean();
      return { resource: caseDoc, caseDoc };
    }
    case RESOURCE_TYPE.EVIDENCE: {
      const evidence = await Evidence.findById(resourceId).lean();
      if (!evidence) return { resource: null, caseDoc: null };
      const caseDoc = await Case.findById(evidence.caseId).lean();
      return { resource: evidence, caseDoc };
    }
    case RESOURCE_TYPE.CUSTODY_ITEM: {
      const item = await CustodyItem.findById(resourceId).lean();
      if (!item) return { resource: null, caseDoc: null };
      const caseDoc = await Case.findById(item.caseId).lean();
      return { resource: item, caseDoc };
    }
    case RESOURCE_TYPE.REFERRAL: {
      const referral = await Referral.findById(resourceId).lean();
      if (!referral) return { resource: null, caseDoc: null };
      const caseDoc = await Case.findById(referral.caseId).lean();
      return { resource: referral, caseDoc };
    }
    case RESOURCE_TYPE.DISCLOSURE_PACK: {
      const pack = await DisclosurePack.findById(resourceId).lean();
      if (!pack) return { resource: null, caseDoc: null };
      const caseDoc = await Case.findById(pack.caseId).lean();
      return { resource: pack, caseDoc };
    }
    case RESOURCE_TYPE.CERTIFICATE: {
      const cert = await Certificate.findById(resourceId).lean();
      if (!cert) return { resource: null, caseDoc: null };
      const caseDoc = await Case.findById(cert.caseId).lean();
      return { resource: cert, caseDoc };
    }
    default:
      return { resource: null, caseDoc: null };
  }
}

/** Is this user on record for this case right now? */
async function liveGrantFor(userId, caseId, roles) {
  const now = new Date();
  const grant = await CaseAccessGrant.findOne({
    caseId,
    userId,
    ...(roles ? { role: { $in: roles } } : {}),
    revokedAt: null,
  }).lean();

  if (!grant) return { grant: null, reason: DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE };
  if (grant.validFrom && new Date(grant.validFrom) > now) {
    return { grant: null, reason: DENY_REASON.GRANT_NOT_YET_VALID };
  }
  if (grant.validTo && new Date(grant.validTo) < now) {
    return { grant: null, reason: DENY_REASON.GRANT_EXPIRED };
  }
  return { grant, reason: null };
}

// ---------------------------------------------------------------- policy ----

/**
 * @param {object} args
 * @param {object} args.user          session context, loaded from the DB this request
 * @param {string} args.action        ACTION value
 * @param {string} args.resourceType  RESOURCE_TYPE value
 * @param {string} [args.resourceId]  id of the resource being acted on
 * @returns {Promise<{allow:boolean, reason:string|null, resource?:object, caseDoc?:object, scopeFilter?:object|null}>}
 */
export async function resolve({ user, action, resourceType, resourceId }) {
  if (!user) return deny(DENY_REASON.NOT_AUTHENTICATED);
  if (user.status !== USER_STATUS.ACTIVE) return deny(DENY_REASON.USER_NOT_ACTIVE);

  // Collection-level requests (list, search) carry no id: answer with a scope filter.
  if (!resourceId) {
    return { ...allow(scopeFilterFor(user, resourceType)), resource: null, caseDoc: null };
  }

  const { resource, caseDoc } = await loadResource(resourceType, resourceId);
  if (!resource) return { ...deny(DENY_REASON.RESOURCE_NOT_FOUND), resource: null, caseDoc: null };

  const decision = await evaluate({ user, action, resourceType, resource, caseDoc });
  return { ...decision, resource, caseDoc };
}

async function evaluate({ user, action, resourceType, resource, caseDoc }) {
  const scope = user.scope ?? {};

  // ============================================================ POLICE ========
  if (user.authority === AUTHORITY.POLICE) {
    // Custody items are the custodian's world; handled before the general case rules
    // because a custodian has no case-level authority at all.
    if (user.role === ROLE.MALKHANA_CUSTODIAN) {
      if (resourceType !== RESOURCE_TYPE.CUSTODY_ITEM) return deny(DENY_REASON.CUSTODIAN_SCOPE);
      return resource.stationCode === scope.stationCode
        ? allow()
        : deny(DENY_REASON.CUSTODIAN_SCOPE);
    }

    // Everything else a police user touches hangs off a case.
    if (!caseDoc) return deny(DENY_REASON.RESOURCE_NOT_FOUND);

    if (user.role === ROLE.IO) {
      // Assignment first: an IO at the right station who is not on this case is
      // still not entitled to it.
      if (!sameId(caseDoc.ioUserId, user.userId)) return deny(DENY_REASON.NOT_ASSIGNED_IO);
      if (caseDoc.stationCode !== scope.stationCode) return deny(DENY_REASON.OUT_OF_JURISDICTION);
      if (action === ACTION.WRITE && !WRITABLE_CASE_STAGES.includes(caseDoc.stage)) {
        return deny(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
      }
      // Investigators investigate. Ruling on disclosure and issuing orders belong to
      // the court, and must not be reachable by falling through to allow().
      if (COURT_ONLY_ACTIONS.has(action)) return deny(DENY_REASON.READ_ONLY_ROLE);
      return allow();
    }

    if (user.role === ROLE.SHO) {
      if (caseDoc.stationCode !== scope.stationCode) return deny(DENY_REASON.OUT_OF_JURISDICTION);
      // The same stage lock the IO branch carries. Its absence here meant a case never
      // actually closed to investigative writes: once the chargesheet was filed the
      // assigned IO was correctly refused, but the station SHO — who supervises that
      // IO and holds station-wide scope — could still upload exhibits, open custody
      // items and mutate the case. "The record is fixed at the chargesheet" was true
      // of one role and false of the role above it.
      if (action === ACTION.WRITE && !WRITABLE_CASE_STAGES.includes(caseDoc.stage)) {
        return deny(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
      }
      if (COURT_ONLY_ACTIONS.has(action)) return deny(DENY_REASON.READ_ONLY_ROLE);
      return allow();
    }

    if (user.role === ROLE.DISTRICT_SP) {
      // Supervisory oversight across a district — visibility, not authorship.
      if (caseDoc.districtCode !== scope.districtCode) return deny(DENY_REASON.OUT_OF_JURISDICTION);
      return allowReadOnly(action);
    }

    return deny(DENY_REASON.NO_MATCHING_POLICY);
  }

  // ============================================================= COURT =======
  if (user.authority === AUTHORITY.COURT) {
    if (!caseDoc) return deny(DENY_REASON.RESOURCE_NOT_FOUND);

    if (user.role === ROLE.JUDGE) {
      // scope.courtId came from the ROSTER at login. Lexx never assigns it.
      // A case with no courtId is still under investigation and before no court —
      // denying it is legally correct, not a gap. (ADR-015)
      if (!caseDoc.courtId || !scope.courtId || caseDoc.courtId !== scope.courtId) {
        return deny(DENY_REASON.CASE_NOT_LISTED_IN_YOUR_COURT);
      }
      return allowReadPlusOrders(action);
    }

    if (user.role === ROLE.REGISTRAR || user.role === ROLE.EVIDENCE_CUSTODIAN) {
      if (!caseDoc.courtId || !scope.courtId || caseDoc.courtId !== scope.courtId) {
        return deny(DENY_REASON.OUT_OF_COURT_SCOPE);
      }
      // Registry staff run the court's process — including APPROVE — but a judicial
      // ORDER is the judge's alone.
      if (action === ACTION.ORDER) return deny(DENY_REASON.READ_ONLY_ROLE);
      return allow();
    }

    return deny(DENY_REASON.NO_MATCHING_POLICY);
  }

  // =============================================================== FSL ======
  if (user.authority === AUTHORITY.FSL) {
    if (!scope.labId) return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);

    // An examiner's world is defined entirely by referrals to THEIR lab.
    // Resource-type aware, rather than assuming every resource has an exhibitId. (ADR-013)
    if (resourceType === RESOURCE_TYPE.REFERRAL) {
      if (resource.labId !== scope.labId) return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
      if (COURT_ONLY_ACTIONS.has(action)) return deny(DENY_REASON.READ_ONLY_ROLE);
      return allow();
    }

    if (resourceType === RESOURCE_TYPE.EVIDENCE) {
      const referral = await Referral.findOne({
        evidenceId: resource._id,
        labId: scope.labId,
        status: { $in: [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED] },
      }).lean();
      if (!referral) return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
      return allow();
    }

    if (resourceType === RESOURCE_TYPE.CASE) {
      // Case context is readable only while the lab holds a live referral in it.
      const referral = await Referral.findOne({
        caseId: resource._id,
        labId: scope.labId,
        status: { $in: [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED] },
      }).lean();
      if (!referral) return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
      return allowReadOnly(action);
    }

    if (resourceType === RESOURCE_TYPE.CERTIFICATE) {
      // Part B is the examiner's own statement; they may read and sign it.
      const referral = await Referral.findOne({
        evidenceId: resource.evidenceId,
        labId: scope.labId,
      }).lean();
      if (!referral) return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
      return allow();
    }

    return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
  }

  // ============================================================= LEGAL ======
  // The important one. This is where confidentiality is either real or theatre.
  if (user.authority === AUTHORITY.LEGAL) {
    if (!caseDoc) return deny(DENY_REASON.RESOURCE_NOT_FOUND);

    const roles = ADVOCATE_ROLES.includes(user.role)
      ? [...ADVOCATE_ROLES, ROLE.PUBLIC_PROSECUTOR]
      : [ROLE.PUBLIC_PROSECUTOR];

    const { grant, reason } = await liveGrantFor(user.userId, caseDoc._id, roles);
    if (!grant) return deny(reason);

    // Being on record gets you the case. It does not get you every exhibit in it.
    if (resourceType === RESOURCE_TYPE.EVIDENCE) {
      const pack = await DisclosurePack.findOne({
        caseId: caseDoc._id,
        status: DISCLOSURE_STATUS.SERVED,
      }).lean();
      if (!pack) return deny(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);

      // Served to THIS advocate specifically — a pack served on co-accused counsel
      // is not served on them.
      const servedToUser = (pack.servedTo ?? []).some((s) => sameId(s.userId, user.userId));
      if (!servedToUser) return deny(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);

      const inSet = (pack.exhibitIds ?? []).some((id) => sameId(id, resource._id));
      if (!inSet) return deny(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);

      return allowReadOnly(action);
    }

    if (resourceType === RESOURCE_TYPE.DISCLOSURE_PACK) {
      if (resource.status !== DISCLOSURE_STATUS.SERVED) {
        return deny(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);
      }
      const servedToUser = (resource.servedTo ?? []).some((s) => sameId(s.userId, user.userId));
      if (!servedToUser) return deny(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);

      // Acknowledging receipt stops the BNSS s.230 clock. It is the one thing counsel
      // may change, it changes only their own entry, and it is deliberately NOT the
      // general WRITE that advocates must never hold.
      if (action === ACTION.ACKNOWLEDGE) return allow();

      return allowReadOnly(action);
    }

    // A certificate is a statement ABOUT an exhibit: it carries the exhibit code, the
    // evidence hash, the source device's make/model/serial/IMEI and the lab's opinion.
    // Handing one over for an exhibit that was deliberately withheld from this
    // advocate's pack would disclose exactly what the exclusion was meant to withhold.
    // So a certificate is scoped to the SAME served set as the evidence it describes,
    // not to the case grant alone.
    if (resourceType === RESOURCE_TYPE.CERTIFICATE) {
      const pack = await DisclosurePack.findOne({
        caseId: caseDoc._id,
        status: DISCLOSURE_STATUS.SERVED,
      }).lean();
      if (!pack) return deny(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);

      const servedToUser = (pack.servedTo ?? []).some((s) => sameId(s.userId, user.userId));
      if (!servedToUser) return deny(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);

      const inSet = (pack.exhibitIds ?? []).some((id) => sameId(id, resource.evidenceId));
      if (!inSet) return deny(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);

      return allowReadOnly(action);
    }

    if (resourceType === RESOURCE_TYPE.CUSTODY_ITEM) {
      // Physical custody is a police and court matter; counsel see it through
      // disclosure, not directly.
      return deny(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);
    }

    // Anything else a LEGAL user reaches is read-only at most. Note that every
    // resource type carrying exhibit-level detail is handled explicitly ABOVE this
    // line — a new such type must be added there, not left to fall through here.
    return allowReadOnly(action);
  }

  return deny(DENY_REASON.NO_MATCHING_POLICY);
}

// ---------------------------------------------------------------- creation ----

/**
 * Which roles may create which kind of resource. This is a capability check only —
 * it says nothing about WHICH case, which is handled separately below.
 */
const CREATE_CAPABILITY = Object.freeze({
  [RESOURCE_TYPE.EVIDENCE]: (u) =>
    u.authority === AUTHORITY.POLICE && (u.role === ROLE.IO || u.role === ROLE.SHO),
  [RESOURCE_TYPE.CUSTODY_ITEM]: (u) =>
    u.authority === AUTHORITY.POLICE && (u.role === ROLE.IO || u.role === ROLE.SHO),
  // Referral to a lab is a supervisory decision (spec §7: SHO).
  [RESOURCE_TYPE.REFERRAL]: (u) => u.authority === AUTHORITY.POLICE && u.role === ROLE.SHO,
  [RESOURCE_TYPE.DISCLOSURE_PACK]: (u) => u.authority === AUTHORITY.POLICE && u.role === ROLE.IO,
  [RESOURCE_TYPE.CERTIFICATE]: (u) =>
    (u.authority === AUTHORITY.POLICE && u.role === ROLE.IO) ||
    (u.authority === AUTHORITY.COURT && u.role === ROLE.REGISTRAR),
  /**
   * Putting an advocate on record mirrors a fact the COURT asserted (an accepted
   * vakalatnama or a legal-aid order), so it is a registry act. An investigating
   * officer must never be able to decide who represents the accused.
   */
  [RESOURCE_TYPE.CASE_ACCESS_GRANT]: (u) =>
    u.authority === AUTHORITY.COURT && u.role === ROLE.REGISTRAR,
});

/**
 * The case-level action each creation implies.
 *
 * Almost everything created under a case is authorship, so it needs WRITE — and is
 * therefore correctly refused once the case leaves investigation.
 *
 * A BSA s.63 certificate is the exception, and getting this wrong made the feature
 * unusable at exactly the moment it is needed. The certificate is prepared FOR court,
 * which in practice means at or after the chargesheet — precisely when the case has
 * closed to investigative writes. But a certificate does not alter the record: it
 * ATTESTS to a record already collected, and the deponent is the officer who
 * collected it. Requiring WRITE conflated "may amend the investigation" with "may
 * swear to what the investigation produced". It needs case READ access plus the
 * deponent capability above, and nothing more.
 */
const CREATE_IMPLIES_ACTION = Object.freeze({
  [RESOURCE_TYPE.CERTIFICATE]: ACTION.READ,
});

/**
 * Capability check for CREATE, where there is no resource to load yet.
 *
 * Creation genuinely cannot go through `resolve()` — there is nothing to fetch — but
 * it must not become an excuse to scatter `if (user.role === 'IO')` through the
 * controllers. So it lives here, next to the rest of the policy.
 *
 * # The bug this shape exists to prevent
 *
 * An earlier version checked only the caller's ROLE. That let any investigating
 * officer upload evidence into ANY case — including another station's, and including
 * cases they were not assigned to — because "is an IO" was the whole test. A
 * regression test now covers it (`evidence.test.js`: "rejects an upload to a case
 * the officer is not on").
 *
 * The fix is not another bespoke check. Creating something UNDER a case is a WRITE to
 * that case, so it is evaluated by exactly the same policy as any other write: load
 * the case from the database, and run `evaluate`. Station scope, IO assignment, case
 * stage and court binding then all apply for free, and cannot drift apart from the
 * read path.
 *
 * @returns {Promise<{allow:boolean, reason:string|null}>}
 */
export async function resolveCreate({ user, resourceType, context = {} }) {
  if (!user) return deny(DENY_REASON.NOT_AUTHENTICATED);
  if (user.status !== USER_STATUS.ACTIVE) return deny(DENY_REASON.USER_NOT_ACTIVE);

  const scope = user.scope ?? {};

  // A case is the one resource with no parent to check against: it is created FROM a
  // directory FIR, so the FIR's station (resolved server-side) is the only anchor.
  if (resourceType === RESOURCE_TYPE.CASE) {
    if (user.authority !== AUTHORITY.POLICE) return deny(DENY_REASON.NO_MATCHING_POLICY);
    if (user.role !== ROLE.IO && user.role !== ROLE.SHO) return deny(DENY_REASON.READ_ONLY_ROLE);
    if (context.stationCode && context.stationCode !== scope.stationCode) {
      return deny(DENY_REASON.OUT_OF_JURISDICTION);
    }
    return allow();
  }

  const capable = CREATE_CAPABILITY[resourceType];
  if (!capable) return deny(DENY_REASON.NO_MATCHING_POLICY);
  if (!capable(user)) return deny(DENY_REASON.READ_ONLY_ROLE);

  // Everything else is created under a case, so the caller must be entitled to write
  // that specific case — not merely hold a role that writes cases in general.
  if (!context.caseId) return deny(DENY_REASON.RESOURCE_NOT_FOUND);

  const caseDoc = await Case.findById(context.caseId).lean();
  if (!caseDoc) return deny(DENY_REASON.RESOURCE_NOT_FOUND);

  return evaluate({
    user,
    action: CREATE_IMPLIES_ACTION[resourceType] ?? ACTION.WRITE,
    resourceType: RESOURCE_TYPE.CASE,
    resource: caseDoc,
    caseDoc,
  });
}

// ---------------------------------------------------------------- scoping ----

/**
 * The Mongo filter that limits a LIST query to what this user may see.
 *
 * Every list and search endpoint intersects its query with this. Returning `null`
 * means "nothing" and is rendered as an empty result, never as "no filter".
 */
export function scopeFilterFor(user, resourceType = RESOURCE_TYPE.CASE) {
  const scope = user.scope ?? {};

  if (user.authority === AUTHORITY.POLICE) {
    // A custody item carries caseId, stationCode and districtCode — but NOT ioUserId,
    // which only a case has. Filtering custody items by `ioUserId` therefore produced
    // a query that could never match a document, so an investigating officer's own
    // custody listing and gap view were permanently, silently empty. Route the IO
    // through __caseScope, which materialiseScopeFilter turns into the case ids they
    // are actually on. Every other police role filters on a field the item really has.
    const custodyScoped = resourceType === RESOURCE_TYPE.CUSTODY_ITEM;

    switch (user.role) {
      case ROLE.IO:
        return custodyScoped
          ? { __caseScope: { ioUserId: user.userId, stationCode: scope.stationCode } }
          : { ioUserId: user.userId, stationCode: scope.stationCode };
      case ROLE.SHO:
        return { stationCode: scope.stationCode };
      case ROLE.DISTRICT_SP:
        return { districtCode: scope.districtCode };
      case ROLE.MALKHANA_CUSTODIAN:
        return custodyScoped ? { stationCode: scope.stationCode } : null;
      default:
        return null;
    }
  }

  if (user.authority === AUTHORITY.COURT) {
    return scope.courtId ? { courtId: scope.courtId } : null;
  }

  if (user.authority === AUTHORITY.FSL) {
    // Resolved asynchronously against live referrals — see scopedCaseIdsFor.
    return scope.labId ? { __fslLab: scope.labId } : null;
  }

  if (user.authority === AUTHORITY.LEGAL) {
    return { __legalGrants: String(user.userId) };
  }

  return null;
}

/**
 * Turn a scope filter into a concrete Mongo filter, resolving the two authorities
 * whose scope is a set of case ids rather than a jurisdiction field.
 */
export async function materialiseScopeFilter(user, resourceType = RESOURCE_TYPE.CASE) {
  const filter = scopeFilterFor(user, resourceType);
  if (!filter) return null;

  // Which field on THIS resource points at a case. Every sentinel below resolves to a
  // set of case ids, and the caller's collection decides how that set is expressed:
  // the cases collection matches on `_id`, everything hanging off a case on `caseId`.
  // Hard-coding `_id` here was wrong for any non-CASE listing.
  const caseKey = resourceType === RESOURCE_TYPE.CASE ? '_id' : 'caseId';
  const byCaseIds = (ids) => (ids.length ? { [caseKey]: { $in: ids } } : null);

  if (filter.__caseScope) {
    const caseIds = await Case.distinct('_id', filter.__caseScope);
    return byCaseIds(caseIds);
  }

  if (filter.__fslLab) {
    // An examiner listing EVIDENCE is limited to the exhibits actually referred to
    // their lab — not to every exhibit in a case that happens to contain one
    // referral. `resolve()` has always applied that rule to a single exhibit; the
    // list path applied only the coarse case rule, so one referral in a case exposed
    // the whole case's exhibits in `GET /api/evidence` and the triage queue.
    if (resourceType === RESOURCE_TYPE.EVIDENCE) {
      const evidenceIds = await Referral.distinct('evidenceId', {
        labId: filter.__fslLab,
        status: { $in: [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED] },
      });
      return evidenceIds.length ? { _id: { $in: evidenceIds } } : null;
    }

    const caseIds = await Referral.distinct('caseId', {
      labId: filter.__fslLab,
      status: { $in: [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED] },
    });
    return byCaseIds(caseIds);
  }

  if (filter.__legalGrants) {
    const now = new Date();
    const grants = await CaseAccessGrant.find({
      userId: filter.__legalGrants,
      revokedAt: null,
      $and: [
        { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
        { $or: [{ validTo: null }, { validTo: { $gte: now } }] },
      ],
    })
      .select('caseId')
      .lean();
    const caseIds = grants.map((g) => g.caseId);

    // Being on record gets counsel the CASE. It does not get them every exhibit in
    // it — that is the whole point of a disclosure pack, and `resolve()` enforces it
    // per exhibit. The list path did not, so an advocate correctly refused an
    // excluded exhibit at `GET /api/evidence/:id` could still enumerate it, with its
    // title, mime type, size and triage priority, from `GET /api/evidence` and
    // `GET /api/evidence/queue/triage`. Same served set, same rule, both paths.
    if (resourceType === RESOURCE_TYPE.EVIDENCE) {
      if (!caseIds.length) return null;
      const packs = await DisclosurePack.find({
        caseId: { $in: caseIds },
        status: DISCLOSURE_STATUS.SERVED,
        'servedTo.userId': filter.__legalGrants,
      })
        .select('exhibitIds')
        .lean();

      const exhibitIds = packs.flatMap((p) => p.exhibitIds ?? []);
      return exhibitIds.length ? { _id: { $in: exhibitIds } } : null;
    }

    return byCaseIds(caseIds);
  }

  return filter;
}

export default { resolve, resolveCreate, scopeFilterFor, materialiseScopeFilter };
