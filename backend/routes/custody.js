import { Router } from 'express';
import * as custody from '../controllers/custody.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCollection, authorizeCreate } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/**
 * Register an article. A WRITE to the case it belongs to: the context supplies the
 * case id, the resolver loads that case, and station scope, IO assignment and case
 * stage all apply.
 */
router.post(
  '/items',
  authorizeCreate(RESOURCE_TYPE.CUSTODY_ITEM, custody.createItemContext),
  custody.createItem
);

/**
 * A scan resolves a label to an item id and nothing more. `authorize` then runs on
 * that id exactly as it would for a typed-in id (ADR-011).
 */
router.get(
  '/scan/:qrToken',
  custody.resolveScannedItem,
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CUSTODY_ITEM, idFrom: 'scannedItemId' }),
  custody.scanItem
);

/** The custody register, scoped by the resolver. */
router.get('/items', authorizeCollection(RESOURCE_TYPE.CUSTODY_ITEM), custody.listItems);

/** Chain analysis for every article in scope. */
router.get('/gaps', authorizeCollection(RESOURCE_TYPE.CUSTODY_ITEM), custody.listGaps);

/**
 * Record one movement. WRITE on the article: police at its station, or the laboratory
 * or court the article is currently with. The controller checks the move is lawful.
 */
router.post(
  '/items/:id/move',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CUSTODY_ITEM }),
  custody.moveItem
);

router.get(
  '/items/:id/chain',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CUSTODY_ITEM }),
  custody.getChain
);

/**
 * The supervisor's decision on a frozen item. A WRITE on the item (station scope),
 * then the CUSTODY_RELEASE capability, which only an SHO holds.
 */
router.post(
  '/items/:id/lift-freeze',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CUSTODY_ITEM }),
  authorizeCreate(RESOURCE_TYPE.CUSTODY_RELEASE, custody.releaseContext),
  custody.liftFreeze
);

export default router;
