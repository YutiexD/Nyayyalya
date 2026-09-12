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
  CLOSED_CASE_STAGES,
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
import { VakalatnamaFiling } from '../models/VakalatnamaFiling.js';

// ---------------------------------------------------------------- decisions ----

const READ_ACTIONS = new Set([ACTION.READ, ACTION.VERIFY, ACTION.DOWNLOAD]);

const allow = (scopeFilter = null) => ({ allow: true, reason: null, scopeFilter });
const deny = (reason) => ({ allow: false, reason, scopeFilter: null });

/** Read, verify and download only. Any mutation is refused. */
const allowReadOnly = (action) =>
  READ_ACTIONS.has(action) ? allow() : deny(DENY_REASON.READ_ONLY_ROLE);

/** Actions that belong to the court, never to the investigation. */
const COURT_ONLY_ACTIONS = new Set([ACTION.ORDER, ACTION.APPROVE]);

/**
 * The records a court may WRITE.
 *
 * Not the case, and not an exhibit: those are the investigation's, and a court that
 * could edit them would be a party to the case rather than the tribunal over it. What
 * the court writes are its own records — the disclosure it serves, the certificates
 * it issues, the representation it records, and the articles its evidence room takes
 * in. Everything else it does to a case it does with ORDER or APPROVE.
 */
const COURT_WRITABLE = new Set([
  RESOURCE_TYPE.DISCLOSURE_PACK,
  RESOURCE_TYPE.CERTIFICATE,
  RESOURCE_TYPE.VAKALATNAMA,
  RESOURCE_TYPE.CUSTODY_ITEM,
  RESOURCE_TYPE.CASE_ACCESS_GRANT,
]);

/**
 * Writes the chargesheet does NOT close.
 *
 * Moving an existing sealed article — to the court's evidence room, back to the store,
 * to a laboratory — is custody, not investigation. The record of WHAT was seized is
 * fixed at the chargesheet (booking a new item is still refused: that is a create
 * against the case, evaluated as a case WRITE); the physical article still has to
 * travel afterwards, and each move is a two-scan, ledgered handover. Locking these
 * stranded every item the police still held at filing, with no way to produce it.
 */
const CUSTODIAL_WRITES = new Set([RESOURCE_TYPE.CUSTODY_ITEM]);

/** Referral states in which a laboratory may still act on the case's physical articles. */
const LAB_CUSTODY_REFERRAL_STATUSES = [
  REFERRAL_STATUS.OPEN,
  REFERRAL_STATUS.ACCEPTED,
  REFERRAL_STATUS.REPORTED,
];

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
    case RESOURCE_TYPE.VAKALATNAMA: {
      const filing = await VakalatnamaFiling.findById(resourceId).lean();
      if (!filing) return { resource: null, caseDoc: null };
      const caseDoc = await Case.findById(filing.caseId).lean();
      return { resource: filing, caseDoc };
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

  // Who represents whom is between an advocate and the court. The investigation has
  // no business reading a filing — least of all the police, whose case it is against
  // — and a laboratory has no reason to. Refused before any authority branch runs.
  if (
    resourceType === RESOURCE_TYPE.VAKALATNAMA &&
    user.authority !== AUTHORITY.COURT &&
    user.authority !== AUTHORITY.LEGAL
  ) {
    return deny(DENY_REASON.NO_MATCHING_POLICY);
  }

  // ============================================================ POLICE ========
  if (user.authority === AUTHORITY.POLICE) {
    // Everything a police user touches hangs off a case.
    if (!caseDoc) return deny(DENY_REASON.RESOURCE_NOT_FOUND);

    // A closed case is readable forever and writable by nobody. This sits above the
    // role branches because it is true of all of them: the point of closing a case is
    // that the record stops moving, and a rule that only the assigned officer obeyed
    // would not be that.
    //
    // Custodial writes are exempt for the same reason they survive the chargesheet: a
    // sealed article still has to be returned or destroyed after the case ends, and
    // each of those moves is a two-scan, ledgered handover rather than an edit of the
    // record. Locking them would strand every article the police still held.
    if (
      CLOSED_CASE_STAGES.includes(caseDoc.stage) &&
      !READ_ACTIONS.has(action) &&
      !CUSTODIAL_WRITES.has(resourceType)
    ) {
      return deny(DENY_REASON.CASE_IS_CLOSED);
    }

    /**
     * Physical custody is STATION-scoped, not case-scoped.
     *
     * This is what is left of the malkhana custodian, and it is the part that was
     * actually load-bearing. An article in the station store is kept by the station,
     * so any officer posted there can receive it, hold it and hand it on — being the
     * investigating officer on some other case is neither here nor there.
     *
     * Making this case-scoped instead would recreate the problem the custodian role
     * was invented to solve and then remove the role that solved it: the only person
     * who could take an article into the store would be the very officer whose case
     * it belongs to, which is the one thing IO_CANNOT_HOLD_OWN_CASE_EVIDENCE forbids.
     * That rule is enforced per handover in the custody controller, against whoever
     * would actually end up holding the article.
     */
    if (resourceType === RESOURCE_TYPE.CUSTODY_ITEM) {
      if (COURT_ONLY_ACTIONS.has(action)) return deny(DENY_REASON.READ_ONLY_ROLE);

      if (user.role === ROLE.DISTRICT_SP) {
        return resource.districtCode === scope.districtCode
          ? allowReadOnly(action)
          : deny(DENY_REASON.OUT_OF_JURISDICTION);
      }
      return resource.stationCode === scope.stationCode
        ? allow()
        : deny(DENY_REASON.OUT_OF_JURISDICTION);
    }

    if (user.role === ROLE.IO) {
      // Assignment first: an IO at the right station who is not on this case is
      // still not entitled to it.
      if (!sameId(caseDoc.ioUserId, user.userId)) return deny(DENY_REASON.NOT_ASSIGNED_IO);
      if (caseDoc.stationCode !== scope.stationCode) return deny(DENY_REASON.OUT_OF_JURISDICTION);
      if (
        action === ACTION.WRITE &&
        !CUSTODIAL_WRITES.has(resourceType) &&
        !WRITABLE_CASE_STAGES.includes(caseDoc.stage)
      ) {
        return deny(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
      }
      // Investigators investigate. Ruling on disclosure and issuing orders belong to
      // the court, and must not be reachable by falling through to allow().
      if (COURT_ONLY_ACTIONS.has(action)) return deny(DENY_REASON.READ_ONLY_ROLE);
      return allow();
    }

    /**
     * The station house officer: supervision, not a gate.
     *
     * An SHO sees everything at their station and may act where a supervisor
     * genuinely must — lifting a custody freeze, moving an article, adding to a case
     * that is still open. What they are deliberately NOT is a step: no other role's
     * work waits on an SHO approval anywhere in this system, because an approval hop
     * that adds no decision adds only delay.
     */
    if (user.role === ROLE.SHO) {
      if (caseDoc.stationCode !== scope.stationCode) return deny(DENY_REASON.OUT_OF_JURISDICTION);
      // The same stage lock the IO branch carries. Its absence here meant a case never
      // actually closed to investigative writes: once the chargesheet was filed the
      // assigned IO was correctly refused, but the station SHO — who supervises that
      // IO and holds station-wide scope — could still upload exhibits, open custody
      // items and mutate the case. "The record is fixed at the chargesheet" was true
      // of one role and false of the role above it.
      if (
        action === ACTION.WRITE &&
        !CUSTODIAL_WRITES.has(resourceType) &&
        !WRITABLE_CASE_STAGES.includes(caseDoc.stage)
      ) {
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

    /**
     * The presiding judge holds the whole of the court's authority.
     *
     * There used to be a REGISTRAR between the judge and the case: the judge ruled,
     * the registrar served, and neither could do the other's half. On paper that is a
     * separation of duties; in this product it was a second login that had to be
     * performed before an advocate could see a single page, and every demo and every
     * real user hit it as an unexplained dead end. The court is one authority here,
     * and it acts.
     *
     * The judge therefore holds ORDER (which is theirs alone), APPROVE (ruling on
     * what the investigation prepared) and WRITE against the court's own records —
     * service, representation, certificates. What they do not hold is authorship of
     * the investigation: writes to a case still with the police are refused, because
     * a court that could add to the police file is not a court.
     */
    if (user.role === ROLE.JUDGE) {
      // scope.courtId came from the ROSTER at login. Lexx never assigns it.
      // A case with no courtId is still under investigation and before no court —
      // denying it is legally correct, not a gap. (ADR-015)
      if (!caseDoc.courtId || !scope.courtId || caseDoc.courtId !== scope.courtId) {
        return deny(DENY_REASON.CASE_NOT_LISTED_IN_YOUR_COURT);
      }
      // A closed case is read-only for the court too, including for the judge who
      // closed it. Re-opening is a fresh order on a fresh listing, not an edit.
      if (CLOSED_CASE_STAGES.includes(caseDoc.stage) && !READ_ACTIONS.has(action)) {
        return deny(DENY_REASON.CASE_IS_CLOSED);
      }
      // A judge does not investigate. WRITE is authorship, and against a CASE or an
      // EVIDENCE record authorship belongs to the police — a court that could
      // recompute a case's jurisdiction or alter an exhibit's record would not be a
      // court. What the judge writes is the COURT's own records: the disclosure it
      // serves, the certificates it issues, the representation it records, and the
      // articles its evidence room receives.
      if (action === ACTION.WRITE && !COURT_WRITABLE.has(resourceType)) {
        return deny(DENY_REASON.READ_ONLY_ROLE);
      }
      return allow();
    }

    /**
     * The court's evidence room. It receives and holds physical articles produced in
     * court, and reads the case it holds them for. It rules on nothing.
     */
    if (user.role === ROLE.EVIDENCE_CUSTODIAN) {
      if (!caseDoc.courtId || !scope.courtId || caseDoc.courtId !== scope.courtId) {
        return deny(DENY_REASON.OUT_OF_COURT_SCOPE);
      }
      if (COURT_ONLY_ACTIONS.has(action)) return deny(DENY_REASON.READ_ONLY_ROLE);
      // Its writes are custodial — the two-scan handshake on an article it receives.
      if (action === ACTION.WRITE && !CUSTODIAL_WRITES.has(resourceType)) {
        return deny(DENY_REASON.READ_ONLY_ROLE);
      }
      return allow();
    }

    return deny(DENY_REASON.NO_MATCHING_POLICY);
  }

  // =============================================================== FSL ======
  /**
   * The laboratory.
   *
   * The rule here used to be: an examiner sees an exhibit only while a referral to
   * their lab is live against it. That is a defensible rule and it is still the one
   * that governs the formal referral pipeline — but as the ONLY rule it produced a
   * laboratory that could not see the work it existed to do. Nothing reached an
   * examiner until a police supervisor remembered to refer it, so the exhibits most
   * likely to be manipulated sat in a station queue, unseen, and the automatic review
   * priority computed for them had no audience.
   *
   * So there are two ways in now, and they are different in kind:
   *
   *   REFERRAL   — a named question put to this lab about one exhibit. Carries the
   *                custody of the physical article and the duty to report.
   *   JURISDICTION — the digital evidence registered in the state this laboratory
   *                serves, readable so the lab can triage it and record a verdict on
   *                what needs one. `stateCode` comes from the lab's own directory
   *                record at sign-in; a session with no state sees nothing.
   *
   * Both are audited identically, and neither reaches a case's disclosure, custody
   * or representation — a laboratory examines exhibits, it does not read case files.
   */
  if (user.authority === AUTHORITY.FSL) {
    if (!scope.labId) return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);

    /** Is this exhibit's case in the state this laboratory serves? */
    const inLabState = (doc) =>
      Boolean(scope.stateCode) && doc?.stateCode === scope.stateCode;

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
      if (referral) return allow();

      // No referral: the jurisdiction route. Read it, and record a forensic verdict
      // on it — which is the one WRITE a laboratory has ever had. Everything else a
      // WRITE could mean against an exhibit (its title, its device record, its
      // custody) belongs to the investigation and is refused by the controller, which
      // exposes no route to any of them for this authority.
      if (!inLabState(caseDoc)) return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
      if (COURT_ONLY_ACTIONS.has(action)) return deny(DENY_REASON.READ_ONLY_ROLE);
      return allow();
    }

    if (resourceType === RESOURCE_TYPE.CASE) {
      // Case context is readable while the lab holds a live referral in it, or while
      // the case is in the state the lab serves — the exhibit has to say which case
      // it belongs to or an examiner cannot tell two CCTV stills apart.
      const referral = await Referral.findOne({
        caseId: resource._id,
        labId: scope.labId,
        status: { $in: [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED] },
      }).lean();
      if (!referral && !inLabState(resource)) {
        return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
      }
      return allowReadOnly(action);
    }

    if (resourceType === RESOURCE_TYPE.CUSTODY_ITEM) {
      // A sealed article sent for examination has to be RECEIVED by the laboratory,
      // and the two-scan handshake needs the receiver to act on the item. Same rule as
      // the case: only while this lab holds a live referral in the item's case. WRITE
      // here is the handshake alone — the controller still requires the examiner to
      // be the named recipient or the current holder before anything moves.
      //
      // REPORTED counts too: a laboratory that has filed its report still holds the
      // article and has to hand it back. Stopping at ACCEPTED left the examiner as the
      // holder of an item they could no longer even open, so it sat AT_FSL for good.
      const referral = await Referral.findOne({
        caseId: resource.caseId,
        labId: scope.labId,
        status: { $in: LAB_CUSTODY_REFERRAL_STATUSES },
      }).lean();
      if (!referral) return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
      if (COURT_ONLY_ACTIONS.has(action)) return deny(DENY_REASON.READ_ONLY_ROLE);
      return allow();
    }

    if (resourceType === RESOURCE_TYPE.CERTIFICATE) {
      // Part B is the examiner's own statement; they may read and sign it. Reachable
      // through a referral, or — since a verdict can now be recorded without one —
      // through the same jurisdiction rule the exhibit itself follows.
      const referral = await Referral.findOne({
        evidenceId: resource.evidenceId,
        labId: scope.labId,
      }).lean();
      if (!referral && !inLabState(caseDoc)) {
        return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
      }
      return allow();
    }

    return deny(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
  }

  // ============================================================= LEGAL ======
  // The important one. This is where confidentiality is either real or theatre.
  if (user.authority === AUTHORITY.LEGAL) {
    if (!caseDoc) return deny(DENY_REASON.RESOURCE_NOT_FOUND);

    // A filing is the advocate's own paper, and they are by definition NOT on record
    // yet — so this sits above the grant check. It opens that one document and
    // nothing about the case it was filed in.
    if (resourceType === RESOURCE_TYPE.VAKALATNAMA) {
      if (!sameId(resource.advocateUserId, user.userId)) {
        return deny(DENY_REASON.NO_MATCHING_POLICY);
      }
      return allowReadOnly(action);
    }

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
  /**
   * Referring an exhibit to a named laboratory, with questions. A supervisory
   * decision, so the station's SHO — but note that a referral is no longer how
   * forensic work STARTS: a laboratory sees the evidence in its own state and
   * prioritises it without waiting to be asked. This is the route for "examine this
   * one, and answer these questions", which is a different act.
   */
  [RESOURCE_TYPE.REFERRAL]: (u) => u.authority === AUTHORITY.POLICE && u.role === ROLE.SHO,
  /**
   * Disclosure is the COURT's act, start to finish.
   *
   * It used to begin with the investigating officer proposing a set and asking to
   * withhold parts of it. That put the police on both sides of a question they are a
   * party to, and it made the defence's access wait on a form the investigation had
   * to remember to fill in. The court holds the case file once the chargesheet is
   * filed; deciding what the defence gets from it is the court's to decide, and the
   * police have no route to it at all.
   */
  [RESOURCE_TYPE.DISCLOSURE_PACK]: (u) =>
    u.authority === AUTHORITY.COURT && u.role === ROLE.JUDGE,
  [RESOURCE_TYPE.CERTIFICATE]: (u) =>
    (u.authority === AUTHORITY.POLICE && u.role === ROLE.IO) ||
    (u.authority === AUTHORITY.COURT && u.role === ROLE.JUDGE),
  /**
   * Putting an advocate on record mirrors a fact the COURT asserted (an accepted
   * vakalatnama or a legal-aid order). An investigating officer must never be able to
   * decide who represents the accused.
   */
  [RESOURCE_TYPE.CASE_ACCESS_GRANT]: (u) =>
    u.authority === AUTHORITY.COURT && u.role === ROLE.JUDGE,
  /**
   * Lifting a freeze after a broken seal is the station supervisor's call — the person
   * who does not hold the article and answers for the chain. Nobody else can unfreeze.
   */
  [RESOURCE_TYPE.CUSTODY_RELEASE]: (u) => u.authority === AUTHORITY.POLICE && u.role === ROLE.SHO,
  /** Any advocate at the bar may put a vakalatnama before the court. A prosecutor may not. */
  [RESOURCE_TYPE.VAKALATNAMA]: (u) =>
    u.authority === AUTHORITY.LEGAL && ADVOCATE_ROLES.includes(u.role),
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
  /**
   * Composing a disclosure pack and putting an advocate on record are both the court
   * RULING on a case it is seized of — APPROVE, not WRITE.
   *
   * WRITE would be wrong twice over. It is authorship, which against a case belongs
   * to the police and to nobody else; and it is refused once the case leaves
   * investigation, which is precisely when disclosure and representation happen. Both
   * of these must still work after the chargesheet, because that is the only time
   * they ever occur.
   */
  [RESOURCE_TYPE.DISCLOSURE_PACK]: ACTION.APPROVE,
  [RESOURCE_TYPE.CASE_ACCESS_GRANT]: ACTION.APPROVE,
  // A freeze decision is custodial, like the handovers it re-opens: it must be
  // available after the chargesheet, when articles are still travelling to court.
  [RESOURCE_TYPE.CUSTODY_RELEASE]: ACTION.READ,
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

  // Filing a vakalatnama is a request TO the court, not an act ON the case: the
  // advocate is not on record yet, which is the whole reason they are filing. So it
  // cannot be evaluated as a case WRITE (that would refuse every filer). What it
  // needs instead is a case that is actually before a court — a filing against an
  // investigation still with the police has no registry to go to.
  if (resourceType === RESOURCE_TYPE.VAKALATNAMA) {
    if (!context.caseId) return deny(DENY_REASON.RESOURCE_NOT_FOUND);
    const listed = await Case.findById(context.caseId).select('courtId cnrNumber').lean();
    if (!listed?.courtId || !listed.cnrNumber) return deny(DENY_REASON.RESOURCE_NOT_FOUND);
    return allow();
  }

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

// ------------------------------------------------------------- disclosure ----

/**
 * Whether this user may see machine triage (Review Priority) on an exhibit.
 *
 * Triage is investigative workload ordering, not evidence and not a finding, so it is
 * never disclosed to a party: the disclosure view already omitted it, but the plain
 * evidence reads (one exhibit, the list, the triage queue, search) handed it to
 * counsel for every exhibit served on them. One rule, here, for all of those paths.
 */
export const seesTriage = (user) => Boolean(user) && user.authority !== AUTHORITY.LEGAL;

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
    /**
     * A custody item carries stationCode and districtCode but NOT ioUserId, which only
     * a case has — and the register is station-wide by design (see the CUSTODY_ITEM
     * branch of `evaluate`). So an officer's custody listing is their station's
     * register, matching what they are actually permitted to open, while their CASE
     * listing stays narrowed to the cases they are on.
     */
    const custodyScoped = resourceType === RESOURCE_TYPE.CUSTODY_ITEM;

    switch (user.role) {
      case ROLE.IO:
        return custodyScoped
          ? { stationCode: scope.stationCode }
          : { ioUserId: user.userId, stationCode: scope.stationCode };
      case ROLE.SHO:
        return { stationCode: scope.stationCode };
      case ROLE.DISTRICT_SP:
        return { districtCode: scope.districtCode };
      default:
        return null;
    }
  }

  if (user.authority === AUTHORITY.COURT) {
    return scope.courtId ? { courtId: scope.courtId } : null;
  }

  if (user.authority === AUTHORITY.FSL) {
    // Resolved asynchronously against live referrals and the lab's own state — see
    // materialiseScopeFilter. Carrying the state here (rather than only the lab code)
    // is what lets an examiner's review queue exist at all.
    return scope.labId
      ? { __fslLab: scope.labId, __fslState: scope.stateCode ?? null }
      : null;
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

  // A police or court scope is JURISDICTION-shaped — ioUserId, stationCode,
  // districtCode, courtId — and those are fields of a case. An exhibit carries none
  // of them, only `caseId`. Applying the raw filter to `evidence` therefore did two
  // different wrong things depending on the query path: an aggregation matched
  // nothing (an SHO's review queue silently emptied), and a find() under strictQuery
  // dropped the unknown keys and matched everything (an officer listing without a
  // caseId saw every exhibit in the system). Resolve to case ids first, always.
  const JURISDICTION_KEYS = ['ioUserId', 'stationCode', 'districtCode', 'courtId'];
  if (
    resourceType === RESOURCE_TYPE.EVIDENCE &&
    JURISDICTION_KEYS.some((k) => k in filter)
  ) {
    const caseIds = await Case.distinct('_id', filter);
    return byCaseIds(caseIds);
  }

  // The same trap for a custody item, which carries stationCode and districtCode but
  // NOT courtId. A court user's `{ courtId }` filter was dropped by strictQuery, so the
  // evidence room of one court listed every custody item in every court.
  if (resourceType === RESOURCE_TYPE.CUSTODY_ITEM && 'courtId' in filter) {
    const caseIds = await Case.distinct('_id', filter);
    return byCaseIds(caseIds);
  }

  if (filter.__caseScope) {
    const caseIds = await Case.distinct('_id', filter.__caseScope);
    return byCaseIds(caseIds);
  }

  if (filter.__fslLab) {
    /**
     * An examiner's EVIDENCE list is the union of two sets, and they answer two
     * different questions:
     *
     *   referred to this lab   — "what have I been asked about?"
     *   registered in my state — "what is there to look at?"
     *
     * The second is what makes the laboratory's review queue possible. It is bounded
     * by the lab's own state code, read from the FSL directory at sign-in; a session
     * with no state falls back to referrals alone rather than to everything, which is
     * the direction a scoping bug has to fail in.
     */
    if (resourceType === RESOURCE_TYPE.EVIDENCE) {
      const evidenceIds = await Referral.distinct('evidenceId', {
        labId: filter.__fslLab,
        status: { $in: [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED] },
      });

      if (!filter.__fslState) {
        return evidenceIds.length ? { _id: { $in: evidenceIds } } : null;
      }

      const stateCaseIds = await Case.distinct('_id', { stateCode: filter.__fslState });
      const clauses = [];
      if (stateCaseIds.length) clauses.push({ caseId: { $in: stateCaseIds } });
      if (evidenceIds.length) clauses.push({ _id: { $in: evidenceIds } });
      if (!clauses.length) return null;
      return clauses.length === 1 ? clauses[0] : { $or: clauses };
    }

    // Custody and cases stay referral-bound. A laboratory has no business reading the
    // case files of a state, and no business handling an article nobody sent it — the
    // widened rule above is about EXHIBITS to examine and nothing else.
    const caseIds = await Referral.distinct('caseId', {
      labId: filter.__fslLab,
      // The custody register follows the per-item rule: a lab that has reported may
      // still hold the article it has to return.
      status: {
        $in:
          resourceType === RESOURCE_TYPE.CUSTODY_ITEM
            ? LAB_CUSTODY_REFERRAL_STATUSES
            : [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED],
      },
    });

    // A case list, though, follows the exhibits: an examiner has to be able to say
    // which case the still in front of them came out of.
    if (resourceType === RESOURCE_TYPE.CASE && filter.__fslState) {
      const stateCaseIds = await Case.distinct('_id', { stateCode: filter.__fslState });
      const all = [...new Set([...caseIds, ...stateCaseIds].map(String))];
      return all.length ? { _id: { $in: all } } : null;
    }

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

export default { resolve, resolveCreate, scopeFilterFor, materialiseScopeFilter, seesTriage };
