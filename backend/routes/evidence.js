import { Router } from 'express';
import * as evidence from '../controllers/evidence.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCollection, authorizeCreate } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/**
 * Upload order: parse multipart first (so `req.body.caseId` exists), then authorise
 * against the case loaded FROM THE DATABASE by that id.
 *
 * `reapTempUpload` is what makes that ordering safe. An earlier version of this
 * comment claimed the controller's own `finally` discarded the bytes "on every
 * failure path, including denial" — it did not. On denial, `authorizeCreate` calls
 * `next(err)`, Express skips the controller entirely, and its `finally` never runs,
 * so every rejected upload left its temp file behind forever. The reaper hooks the
 * response lifecycle instead of the handler, so it fires whether the request was
 * served, denied, errored or aborted.
 */
router.post(
  '/upload',
  evidence.uploadMiddleware,
  evidence.reapTempUpload,
  authorizeCreate(RESOURCE_TYPE.EVIDENCE, evidence.uploadCaseContext),
  evidence.uploadEvidence
);

router.get('/', authorizeCollection(RESOURCE_TYPE.EVIDENCE), evidence.listEvidence);

router.get(
  '/queue/triage',
  authorizeCollection(RESOURCE_TYPE.EVIDENCE),
  evidence.triageQueue
);

/**
 * Open an exhibit by its register code (EX-…). The code only locates an id; the
 * resolver decides as for `/:id`, so counsel reaching for an exhibit outside the set
 * not on record is refused NOT_ON_RECORD_FOR_THIS_CASE — and the attempt is in the
 * audit feed. Declared before `/:id`.
 */
router.get(
  '/by-code/:code',
  evidence.evidenceIdFromCode,
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.EVIDENCE, idFrom: 'lookupEvidenceId' }),
  evidence.getEvidence
);

router.get(
  '/:id',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.EVIDENCE }),
  evidence.getEvidence
);

/**
 * The exhibit's lifecycle, every milestone with who did it and its proofs (hashes, key
 * fingerprints, ledger entries, anchoring). Same visibility as the exhibit itself.
 */
router.get(
  '/:id/lifecycle',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.EVIDENCE }),
  evidence.getEvidenceLifecycle
);

router.post(
  '/:id/verify',
  authorize({ action: ACTION.VERIFY, resourceType: RESOURCE_TYPE.EVIDENCE }),
  evidence.verifyEvidence
);

/**
 * Retry a failed AI analysis. VERIFY on the exhibit — reading-level access, since
 * re-asking changes nothing in the record — and the controller refuses a party.
 */
router.post(
  '/:id/ai-analysis/retry',
  authorize({ action: ACTION.VERIFY, resourceType: RESOURCE_TYPE.EVIDENCE }),
  evidence.retryAiAnalysis
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
