import { Router } from 'express';
import * as evidence from '../controllers/evidence.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCollection, authorizeCreate } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/**
 * Upload order: parse multipart first (so `req.body.caseId` exists), then authorise
 * against the case loaded FROM THE DATABASE by that id. The uploaded bytes are
 * discarded by the controller's `finally` on every failure path, including denial.
 */
router.post(
  '/upload',
  evidence.uploadMiddleware,
  authorizeCreate(RESOURCE_TYPE.EVIDENCE, evidence.uploadCaseContext),
  evidence.uploadEvidence
);

router.get('/', authorizeCollection(RESOURCE_TYPE.EVIDENCE), evidence.listEvidence);

router.get(
  '/queue/triage',
  authorizeCollection(RESOURCE_TYPE.EVIDENCE),
  evidence.triageQueue
);

router.get(
  '/:id',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.EVIDENCE }),
  evidence.getEvidence
);

router.post(
  '/:id/verify',
  authorize({ action: ACTION.VERIFY, resourceType: RESOURCE_TYPE.EVIDENCE }),
  evidence.verifyEvidence
);

router.post(
  '/:id/stream-token',
  authorize({ action: ACTION.DOWNLOAD, resourceType: RESOURCE_TYPE.EVIDENCE }),
  evidence.createStreamToken
);

// The token is necessary but not sufficient: the resolver still runs.
router.get(
  '/:id/stream',
  authorize({ action: ACTION.DOWNLOAD, resourceType: RESOURCE_TYPE.EVIDENCE }),
  evidence.streamEvidence
);

export default router;
