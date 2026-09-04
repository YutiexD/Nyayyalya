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
 * `prepare` uses BOTH: `authorizeCreate(DISCLOSURE_PACK)` establishes that only an
 * investigating officer may author a pack at all, and `authorize(WRITE, CASE)`
 * establishes that it is *their* case, at their station, still open to writes. Either
 * one alone would be a hole.
 */
import { Router } from 'express';
import * as disclosure from '../controllers/disclosure.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCreate } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/**
 * The IO proposes the set. Case-scoped WRITE first, so an officer who is not on the
 * case is refused before we even ask whether their role may prepare packs.
 */
router.post(
  '/:caseId/prepare',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  authorizeCreate(RESOURCE_TYPE.DISCLOSURE_PACK, disclosure.packCreateContext),
  disclosure.preparePack
);

/**
 * Mirror accepted vakalatnamas from the COURT DIRECTORY into CaseAccessGrants
 * (spec §8 F8 step 2).
 *
 * Two gates, deliberately. READ on the case establishes court scope; the CREATE
 * capability then restricts this to a REGISTRAR. Deciding who is on record for the
 * accused is a registry act — an investigating officer must never be able to make it,
 * even for a case they own.
 */
router.post(
  '/:caseId/sync-representation',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  authorizeCreate(RESOURCE_TYPE.CASE_ACCESS_GRANT, (req) => ({ caseId: req.caseDoc._id })),
  disclosure.syncRepresentation
);

/**
 * The registrar OR the judge rules on the exclusions and fixes the redaction variant.
 *
 * APPROVE is its own action precisely so this pair can be expressed: WRITE would
 * exclude the judge (who does not author investigative records) and ORDER would
 * exclude the registrar (who does not issue judicial orders). Spec §7 gives approval
 * to both.
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

/** Registrar serves it, minting one watermark per recipient. */
router.post(
  '/:packId/serve',
  authorize({
    action: ACTION.WRITE,
    resourceType: RESOURCE_TYPE.DISCLOSURE_PACK,
    idFrom: 'params.packId',
  }),
  disclosure.servePack
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
