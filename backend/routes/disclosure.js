/**
 * Disclosure routes.
 *
 * Mount:  app.use('/api/disclosure', disclosureRoutes)
 *
 * Every route is authenticated and every one passes through `accessResolver` before
 * its controller runs. There is not a single role comparison in this file or in the
 * controller it points at — the two guards below are the whole authorization story:
 *
 *   authorize()        — "may this user take this ACTION on this RESOURCE?", with the
 *                        resource loaded from the database by the resolver itself.
 *   authorizeCreate()  — the capability check for a resource that does not exist yet.
 *
 * `share` and `prepare` use BOTH: `authorize(APPROVE, CASE)` establishes that this
 * is a court seized of this case — APPROVE is court-only, so the investigation cannot
 * reach disclosure at all — and `authorizeCreate(DISCLOSURE_PACK)` establishes that
 * it is the presiding judge rather than court staff generally. Either one alone would
 * be a hole.
 */
import { Router } from 'express';
import * as disclosure from '../controllers/disclosure.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCreate } from '../middleware/authorize.js';
import { requireHealthyAudit } from '../middleware/audit.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/**
 * THE disclosure route: the court gives the advocates on record the case file.
 *
 * Two gates. APPROVE on the case is a COURT_ONLY_ACTION, so every police role, the
 * laboratory and counsel are refused here by the resolver — the police have no route
 * to disclosure at all, which is the point. The create capability then limits pack
 * authorship to the presiding judge rather than to court staff generally.
 *
 * It fails closed if the audit trail is broken: serving disclosure is one of the two
 * acts that must never happen without a reliable record of who authorised it.
 */
router.post(
  '/:caseId/share',
  requireHealthyAudit,
  authorize({ action: ACTION.APPROVE, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  authorizeCreate(RESOURCE_TYPE.DISCLOSURE_PACK, disclosure.packCreateContext),
  disclosure.shareCaseFile
);

/**
 * Settle the set without serving it — the long form of the route above, kept for a
 * court that wants to fix the exhibit set first and rule on withholdings separately.
 *
 * APPROVE, not WRITE, and not READ: it is the court composing a court record about a
 * case it is seized of. READ would have admitted counsel; WRITE would have admitted
 * the investigation.
 */
router.post(
  '/:caseId/prepare',
  authorize({ action: ACTION.APPROVE, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  authorizeCreate(RESOURCE_TYPE.DISCLOSURE_PACK, disclosure.packCreateContext),
  disclosure.preparePack
);

/**
 * Mirror accepted vakalatnamas from the COURT DIRECTORY into CaseAccessGrants
 * (spec §8 F8 step 2).
 *
 * Two gates, deliberately. READ on the case establishes court scope; the CREATE
 * capability then restricts this to the presiding judge. Deciding who is on record
 * for the accused is the court's act — an investigating officer must never be able to
 * make it, even for a case they own.
 */
router.post(
  '/:caseId/sync-representation',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  authorizeCreate(RESOURCE_TYPE.CASE_ACCESS_GRANT, (req) => ({ caseId: req.caseDoc._id })),
  disclosure.syncRepresentation
);

/**
 * The court rules on each withholding and fixes the redaction variant.
 *
 * APPROVE is its own action so that ruling on what another party prepared stays
 * distinct from WRITE (authorship, which belongs to the investigation) and from ORDER
 * (a judicial order, which is a different act again).
 */
router.post(
  '/:packId/approve',
  authorize({
    action: ACTION.APPROVE,
    resourceType: RESOURCE_TYPE.DISCLOSURE_PACK,
    idFrom: 'params.packId',
  }),
  disclosure.approvePack
);

/** The court serves it, minting one unguessable watermark per recipient. */
router.post(
  '/:packId/serve',
  // Fails closed if the audit trail is broken: serving disclosure is one of the two
  // acts that must never happen without a reliable record of who authorised it.
  requireHealthyAudit,
  authorize({
    action: ACTION.WRITE,
    resourceType: RESOURCE_TYPE.DISCLOSURE_PACK,
    idFrom: 'params.packId',
  }),
  disclosure.servePack
);

/**
 * The court's list of packs on a case.
 *
 * This exists because `approve` and `serve` both take a packId and there was
 * previously no way for the court to LEARN one: pack ids travelled out of band, which
 * made a statutory step depend on someone copying a hex string by hand.
 *
 * Gated on APPROVE, not READ, and that is the whole point. APPROVE is a
 * COURT_ONLY_ACTION, so the resolver refuses it to every police role, to FSL, and to
 * counsel — while granting it to the judge whose court the case is listed in. A READ
 * gate would have handed the pack list, withholdings and all, to the advocate those
 * withholdings are against.
 */
router.get(
  '/case/:caseId/packs',
  authorize({
    action: ACTION.APPROVE,
    resourceType: RESOURCE_TYPE.CASE,
    idFrom: 'params.caseId',
  }),
  disclosure.listPacksForCase
);

/**
 * Trace a leaked copy back to the advocate it was served on.
 *
 * The token resolves to a pack and no further; APPROVE on that pack — court-only —
 * decides who may learn the answer. Declared before '/my-pack/:caseId' only for
 * readability; the paths do not overlap.
 */
router.get(
  '/trace/:token',
  disclosure.resolveWatermark,
  authorize({
    action: ACTION.APPROVE,
    resourceType: RESOURCE_TYPE.DISCLOSURE_PACK,
    idFrom: 'tracedPackId',
  }),
  disclosure.traceWatermark
);

/**
 * The advocate's view. READ on the CASE, so an advocate who is not on record is
 * refused by the resolver with NOT_ON_RECORD_FOR_THIS_CASE and the denial is
 * audited before this controller is ever reached.
 */
router.get(
  '/my-pack/:caseId',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  disclosure.getMyPack
);

/**
 * Acknowledgement stops the BNSS s.230 clock.
 *
 * ACKNOWLEDGE is its own action: counsel are read-only, so WRITE would be wrong, but
 * this genuinely mutates state and calling it VERIFY would have misdescribed it. The
 * resolver permits it only on a pack SERVED to this exact user, and only for their
 * own entry.
 */
router.post(
  '/:packId/acknowledge',
  authorize({
    action: ACTION.ACKNOWLEDGE,
    resourceType: RESOURCE_TYPE.DISCLOSURE_PACK,
    idFrom: 'params.packId',
  }),
  disclosure.acknowledgePack
);

export default router;
