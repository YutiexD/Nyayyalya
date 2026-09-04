/**
 * Certificate routes.
 *
 * Two routers, and the split is the whole point:
 *
 *   default        →  app.use('/api/certificates', certificateRoutes)
 *                     authenticated, every request through the access resolver.
 *
 *   publicVerifyRouter →  app.use('/public', publicVerifyRouter)
 *                     NO authentication, NO session, NO resolver. It must be mounted
 *                     OUTSIDE /api, before the authenticated routers, so nothing in
 *                     the authenticated stack can ever be reached through it. Its
 *                     only credential is the 32-byte verification token in the path,
 *                     and its response carries validity, never contents.
 */
import { Router } from 'express';
import * as certificate from '../controllers/certificate.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCreate } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/**
 * Generate. Two guards, as with disclosure preparation:
 *   authorize(READ, EVIDENCE)   — is this caller entitled to THIS exhibit at all?
 *                                 The evidence id is read from the body, but the
 *                                 resolver loads the record itself and derives the
 *                                 case from it, so nothing is asserted by the caller.
 *   authorizeCreate(CERTIFICATE)— may this role author a certificate? (IO, REGISTRAR)
 */
router.post(
  '/generate',
  certificate.validateGenerateBody,
  authorize({
    action: ACTION.READ,
    resourceType: RESOURCE_TYPE.EVIDENCE,
    idFrom: 'body.evidenceId',
  }),
  authorizeCreate(RESOURCE_TYPE.CERTIFICATE, (req) => ({
    caseId: req.caseDoc?._id ?? null,
    stationCode: req.caseDoc?.stationCode ?? null,
  })),
  certificate.generate
);

/** Metadata plus the canonical body hash a signer has to sign. */
router.get(
  '/:id',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CERTIFICATE }),
  certificate.getCertificate
);

/** Part A is signed by the deponent it names; the controller enforces that identity. */
router.post(
  '/:id/sign-part-a',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CERTIFICATE }),
  certificate.signPartA
);

/**
 * Part B is signed by the examiner who filed the report. The resolver's FSL branch
 * already limits a certificate to an examiner whose lab holds a referral for the
 * exhibit; the controller then requires that they are the reporting examiner.
 */
router.post(
  '/:id/sign-part-b',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CERTIFICATE }),
  certificate.signPartB
);

/** The document itself. DOWNLOAD, so it is audited as one. */
router.get(
  '/:id/pdf',
  authorize({ action: ACTION.DOWNLOAD, resourceType: RESOURCE_TYPE.CERTIFICATE }),
  certificate.getPdf
);

/**
 * The public verifier. Deliberately its own router with no `requireSession`: adding
 * one would break every QR ever printed, and removing one from the router above
 * would expose the register. Keeping them apart makes both mistakes hard to make.
 */
export const publicVerifyRouter = Router();
publicVerifyRouter.get('/verify/:token', certificate.publicVerify);

export default router;
