import { Router } from 'express';
import * as cases from '../controllers/cases.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCollection, authorizeCreate } from '../middleware/authorize.js';
import { requireHealthyAudit } from '../middleware/audit.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();

// Every route below is authenticated, and every one passes through the single
// policy point before its controller runs.
router.use(...requireSession);

router.post(
  '/from-fir',
  authorizeCreate(RESOURCE_TYPE.CASE, cases.firContext),
  cases.createFromFir
);

router.get('/', authorizeCollection(RESOURCE_TYPE.CASE), cases.listCases);

/**
 * Open a case by its CNR — the public court number an advocate actually has. The CNR
 * only locates a case id; the resolver then decides exactly as for `/:id`, so an
 * advocate who is not on record is refused NOT_ON_RECORD_FOR_THIS_CASE and the refusal
 * is audited. Declared before `/:id` so `by-cnr` is never read as an id.
 */
router.get(
  '/by-cnr/:cnr',
  cases.caseIdFromCnr,
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE, idFrom: 'lookupCaseId' }),
  cases.getCase
);

router.get(
  '/:id',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE }),
  cases.getCase
);

router.get(
  '/:id/timeline',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE }),
  cases.getTimeline
);

router.post(
  '/:id/compute-jurisdiction',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CASE }),
  cases.computeCaseJurisdiction
);

router.post(
  '/:id/file-chargesheet',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CASE }),
  cases.fileChargesheet
);

// ORDER is its own action: only a judge holds it, and it is not a general WRITE.
router.post(
  '/:id/record-order',
  authorize({ action: ACTION.ORDER, resourceType: RESOURCE_TYPE.CASE }),
  cases.recordOrder
);

/**
 * Closing the case. ORDER, because that is what it is: the court's final act on a
 * case it is seized of, and the resolver grants ORDER to the presiding judge alone.
 *
 * Fails closed if the audit trail is broken. Closing is the one act whose whole
 * meaning is that the record stopped here, and a record of it that might not exist
 * would defeat that.
 */
router.post(
  '/:id/close',
  requireHealthyAudit,
  authorize({ action: ACTION.ORDER, resourceType: RESOURCE_TYPE.CASE }),
  cases.closeCase
);

export default router;
