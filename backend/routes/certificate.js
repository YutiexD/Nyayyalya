/**
 * Certificate routes.
 *
 *   default            →  app.use('/api/certificates', certificateRoutes)
 *                         authenticated (except the authority key), every request
 *                         through the access resolver.
 *
 *   publicVerifyRouter →  app.use('/public', publicVerifyRouter)
 *                         NO authentication, NO session, NO resolver. Its only
 *                         credential is the 32-byte verification token in the path,
 *                         and its response carries validity, never contents.
 *
 * There is no route to create or sign a certificate: the system issues and signs one
 * per exhibit on upload (services/certificateIssuer.js).
 */
import { Router } from 'express';
import * as certificate from '../controllers/certificate.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';
import { limiter } from '../middleware/rateLimit.js';
import env from '../config/env.js';

const router = Router();

/** The authority's PUBLIC key. Declared before the session guard: it is public. */
router.get('/authority-key', certificate.authorityKey);

router.use(...requireSession);

/** Every certificate for one exhibit — no more visible than the exhibit itself. */
router.get(
  '/',
  certificate.validateEvidenceQuery,
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.EVIDENCE, idFrom: 'query.evidenceId' }),
  certificate.listForEvidence
);

router.get(
  '/:id',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CERTIFICATE }),
  certificate.getCertificate
);

/** One-click verification. POST is the action; GET is kept for existing clients. */
const verifyGuard = authorize({ action: ACTION.VERIFY, resourceType: RESOURCE_TYPE.CERTIFICATE });
router.post('/:id/verify', verifyGuard, certificate.verifyCertificate);
router.get('/:id/verify', verifyGuard, certificate.verifyCertificate);

/** The stored document itself. DOWNLOAD, so it is audited as one. */
router.get(
  '/:id/pdf',
  authorize({ action: ACTION.DOWNLOAD, resourceType: RESOURCE_TYPE.CERTIFICATE }),
  certificate.getPdf
);

/**
 * The public verifier. Deliberately its own router with no `requireSession`: adding
 * one would break every QR ever printed, and removing one from the router above
 * would expose the register.
 */
export const publicVerifyRouter = Router();
/**
 * Both public verifiers re-hash the stored evidence file on every call, so they share a
 * per-IP limit (RATE_LIMIT_LOOKUP per 15 minutes; see middleware/rateLimit.js for the
 * test and development-loopback exemptions).
 */
const publicLimiter = limiter(env.RATE_LIMIT_LOOKUP);
publicVerifyRouter.get('/verify/:token', publicLimiter, certificate.publicVerify);
/** The permanent QR label on a physical exhibit: verification, uploader, lifecycle. */
publicVerifyRouter.get('/evidence/:labelToken', publicLimiter, certificate.publicEvidence);
publicVerifyRouter.get('/certificate-authority-key', certificate.authorityKey);

export default router;
