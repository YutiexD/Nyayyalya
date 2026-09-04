import { Router } from 'express';
import * as fsl from '../controllers/fsl.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCollection, authorizeCreate } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

// ------------------------------------------------------------ /api/fsl ------

const router = Router();
router.use(...requireSession);

/**
 * The examiner's queue. The resolver answers a collection request with a scope
 * filter, and the controller renders anything that is not a lab scope as an empty
 * list — so "only referrals to their own lab" is enforced by the policy, not by a
 * role check here.
 */
router.get('/referrals', authorizeCollection(RESOURCE_TYPE.REFERRAL), fsl.listReferrals);

router.post(
  '/referrals/:id/accept',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.REFERRAL }),
  fsl.acceptReferral
);

/**
 * Authorise first, buffer second: an upload from someone with no entitlement to the
 * referral is refused before its bytes are read.
 */
router.post(
  '/referrals/:id/report',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.REFERRAL }),
  fsl.reportUpload,
  fsl.fileReport
);

export default router;

// -------------------------------------------------------- /api/evidence ----

/**
 * `POST /api/evidence/:id/refer-fsl` belongs to the FSL feature but lives under the
 * evidence path, because the thing being referred is an exhibit. It is exported as
 * its own router so `app.js` can mount it at `/api/evidence` alongside the evidence
 * routes without either file having to know about the other.
 *
 * Two policy questions again: may this user write to THIS exhibit (loaded from the
 * path id by the resolver), and may this role create referrals at all — which the
 * resolver answers with "SHO only", per spec §7.
 */
export const evidenceFslRouter = Router();
evidenceFslRouter.use(...requireSession);

evidenceFslRouter.post(
  '/:id/refer-fsl',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.EVIDENCE }),
  authorizeCreate(RESOURCE_TYPE.REFERRAL, fsl.referralContext),
  fsl.referToFsl
);
