import { Router } from 'express';
import * as cases from '../controllers/cases.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCollection, authorizeCreate } from '../middleware/authorize.js';
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

export default router;
