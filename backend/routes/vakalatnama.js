/**
 * Vakalatnama routes.
 *
 * Mount:  app.use('/api/vakalatnama', vakalatnamaRoutes)
 *
 * As everywhere else, the resolver is the whole authorization story. Two points are
 * worth reading twice:
 *
 *   - FILING uses `authorizeCreate(VAKALATNAMA)`, which the resolver answers without
 *     a case WRITE — the filer is, by definition, not on record yet. It needs an
 *     advocate's capability and a case that is actually listed before a court.
 *   - RULING on a filing takes two gates, like `sync-representation`: APPROVE on the
 *     filing establishes court scope, and the CASE_ACCESS_GRANT capability restricts
 *     the act to the COURT role. Deciding who is on record is a registry act.
 */
import { Router } from 'express';
import * as vakalatnama from '../controllers/vakalatnama.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCreate } from '../middleware/authorize.js';
import { requireHealthyAudit } from '../middleware/audit.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/** The advocate files. Multipart first, so the CNR the context looks up exists. */
router.post(
  '/',
  vakalatnama.documentUpload,
  authorizeCreate(RESOURCE_TYPE.VAKALATNAMA, vakalatnama.filingContext),
  vakalatnama.fileVakalatnama
);

/** The caller's own filings. The query is scoped to the session's user. */
router.get('/mine', vakalatnama.listMine);

/** The court's view of representation on a case — a court-only gate, as for packs. */
router.get(
  '/case/:caseId',
  authorize({ action: ACTION.APPROVE, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  vakalatnama.listForCase
);

/** The filed document: the filing advocate, or the court the case is listed in. */
router.get(
  '/:id/document',
  authorize({ action: ACTION.DOWNLOAD, resourceType: RESOURCE_TYPE.VAKALATNAMA }),
  vakalatnama.getDocument
);

router.post(
  '/:id/accept',
  // Putting an advocate on record opens a case to them; it must not happen unrecorded.
  requireHealthyAudit,
  authorize({ action: ACTION.APPROVE, resourceType: RESOURCE_TYPE.VAKALATNAMA }),
  authorizeCreate(RESOURCE_TYPE.CASE_ACCESS_GRANT, vakalatnama.rulingContext),
  vakalatnama.acceptFiling
);

router.post(
  '/:id/reject',
  authorize({ action: ACTION.APPROVE, resourceType: RESOURCE_TYPE.VAKALATNAMA }),
  authorizeCreate(RESOURCE_TYPE.CASE_ACCESS_GRANT, vakalatnama.rulingContext),
  vakalatnama.rejectFiling
);

export default router;
