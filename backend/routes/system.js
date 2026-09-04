/**
 * Ledger, anchor, audit and search routes.
 *
 * Grouped because they are the read/verify surface of the system rather than a
 * workflow module, and because keeping the one PUBLIC route physically next to the
 * authenticated ones makes the boundary obvious to a reviewer.
 */
import { Router } from 'express';
import * as ledger from '../controllers/ledger.js';
import * as audit from '../controllers/audit.js';
import * as search from '../controllers/search.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

/** Authenticated: /api/ledger */
export const ledgerRouter = Router();
ledgerRouter.use(...requireSession);

ledgerRouter.get(
  '/case/:id',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CASE }),
  ledger.caseLedger
);
ledgerRouter.get('/verify-chain', ledger.verifyLedgerChain);
ledgerRouter.get('/entry/:seq/anchor-proof', ledger.entryAnchorProof);

/** Authenticated: /api/audit */
export const auditRouter = Router();
auditRouter.use(...requireSession);
auditRouter.get('/', audit.listAudit);
auditRouter.get('/security', audit.securityFeed);

/** Authenticated: /api/search */
export const searchRouter = Router();
searchRouter.use(...requireSession);
searchRouter.get('/', search.search);

/**
 * PUBLIC: /api/anchors
 * No authentication, deliberately. It returns roots and chain facts only — that is
 * what makes the anchoring claim independently checkable by someone who has no
 * account here.
 */
export const anchorRouter = Router();
anchorRouter.get('/latest', ledger.latestAnchorBatch);
