import { Router } from 'express';
import * as custody from '../controllers/custody.js';
import { requireSession } from '../middleware/authenticate.js';
import { authorize, authorizeCollection, authorizeCreate } from '../middleware/authorize.js';
import { ACTION, RESOURCE_TYPE } from '../models/enums.js';

const router = Router();
router.use(...requireSession);

/**
 * Seizing an item is a WRITE to the case it belongs to, and `resolveCreate` treats it
 * as exactly that: the context supplies the case id, the resolver loads that case from
 * the database, and station scope, IO assignment and case stage all apply. Holding the
 * IO role is not on its own enough to open an item on someone else's case.
 */
router.post(
  '/items',
  authorizeCreate(RESOURCE_TYPE.CUSTODY_ITEM, custody.createItemContext),
  custody.createItem
);

/**
 * A scan resolves a label to an item id and nothing more. `authorize` then runs on
 * that id exactly as it would for a typed-in id, so a genuine tag held by someone
 * with no entitlement to the item is refused (ADR-011).
 */
router.get(
  '/scan/:qrToken',
  custody.resolveScannedItem,
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CUSTODY_ITEM, idFrom: 'scannedItemId' }),
  custody.scanItem
);

// Gap detection is a supervisory read, so it is scoped by the collection filter
// (SHO: their station; District SP: their district) rather than by a role list here.
router.get('/gaps', authorizeCollection(RESOURCE_TYPE.CUSTODY_ITEM), custody.listGaps);

router.post(
  '/items/:id/initiate-transfer',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CUSTODY_ITEM }),
  custody.initiateTransfer
);

router.post(
  '/items/:id/accept-transfer',
  authorize({ action: ACTION.WRITE, resourceType: RESOURCE_TYPE.CUSTODY_ITEM }),
  custody.acceptTransfer
);

router.get(
  '/items/:id/chain',
  authorize({ action: ACTION.READ, resourceType: RESOURCE_TYPE.CUSTODY_ITEM }),
  custody.getChain
);

export default router;
