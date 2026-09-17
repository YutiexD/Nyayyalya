/**
 * Representation and counsel's case file.
 *
 * Mount:  app.use('/api/disclosure', disclosureRoutes)
 *
 * There is no share / prepare / approve / serve / acknowledge step any more. Counsel
 * on record read the case and its exhibits through the ordinary read endpoints the
 * moment the court puts them on record (see controllers/disclosure.js). What is left
 * here is the court's act of mirroring the court register, and counsel's one-call
 * view of a case file.
 *
 * Every route is authenticated and every one passes through `accessResolver` before
 * its controller runs.
 */
import { Router } from 'express';
import * as disclosure from '../controllers/disclosure.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCreate } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/**
 * Mirror accepted vakalatnamas and legal-aid orders from the COURT DIRECTORY into
 * CaseAccessGrants (spec §8 F8 step 2).
 *
 * Two gates, deliberately. READ on the case establishes scope; the CREATE capability
 * then restricts this to the Court. Deciding who is on record for a party is the
 * court's act — an investigating officer must never be able to make it.
 */
router.post(
  '/:caseId/sync-representation',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  authorizeCreate(RESOURCE_TYPE.CASE_ACCESS_GRANT, (req) => ({ caseId: req.caseDoc._id })),
  disclosure.syncRepresentation
);

/**
 * The case file: the case and every exhibit in it.
 *
 * READ on the CASE, so an advocate who is not on record is refused by the resolver
 * with NOT_ON_RECORD_FOR_THIS_CASE and the denial is audited before the controller is
 * reached.
 */
const caseFile = [
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE, idFrom: 'params.caseId' }),
  disclosure.getCaseFile,
];
router.get('/case-file/:caseId', ...caseFile);
/** Deprecated alias kept so an older client keeps working; same response. */
router.get('/my-pack/:caseId', ...caseFile);

export default router;
