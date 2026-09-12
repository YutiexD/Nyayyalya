import { Router } from 'express';
import * as fsl from '../controllers/fsl.js';
import * as certificate from '../controllers/certificate.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCollection, authorizeCreate } from '../middleware/authorize.js';
import { requireHealthyAudit } from '../middleware/audit.js';
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
/**
 * The examiner's review queue — every exhibit the laboratory may need to look at,
 * ordered by the review priority the system computed at ingest.
 *
 * Authorised as an EVIDENCE collection, not a REFERRAL one: the queue's whole point
 * is that it reaches beyond what has been formally referred, and the resolver's
 * evidence scope (referrals to this lab, plus the digital evidence registered in the
 * state it serves) is what decides its contents.
 */
router.get('/queue', authorizeCollection(RESOURCE_TYPE.EVIDENCE), fsl.reviewQueue);

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
  // Fails closed if the audit trail is broken: a forensic opinion is the strongest
  // evidentiary claim in the system and must not be filed unrecorded.
  requireHealthyAudit,
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.REFERRAL }),
  fsl.reportUpload,
  fsl.fileReport
);

/** Certificates for the referred exhibit — where the examiner signs Part B. */
router.get(
  '/referrals/:id/certificates',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.REFERRAL }),
  certificate.listForReferral
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

/**
 * The one-step forensic verdict: an examiner records an opinion on an exhibit in
 * their laboratory's scope, with no referral round trip first.
 *
 * One policy question, asked of the exhibit itself: may this session WRITE to it?
 * Only the FSL branch of the resolver ever answers yes to that for a laboratory, and
 * only for evidence referred to it or registered in the state it serves. The
 * controller then insists the session actually carries a lab scope, so a police or
 * court WRITE — which passes the same check for its own reasons — cannot reach here.
 */
evidenceFslRouter.post(
  '/:id/forensic-verdict',
  // An authenticity opinion is the strongest evidentiary claim in the system. It is
  // not permitted to happen unrecorded.
  requireHealthyAudit,
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.EVIDENCE }),
  fsl.verdictUpload,
  fsl.recordVerdict
);
