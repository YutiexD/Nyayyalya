/**
 * The realtime change feed.
 *
 * Mount:  app.use('/api/events', eventsRoutes)
 *
 *   GET /stream   text/event-stream; `Authorization: Bearer <access token>`
 *
 * Authentication is the ordinary session chain. There is no `authorize` step here
 * because the stream names no resource: every event on it is filtered, per connection,
 * through the access resolver in services/realtime.js before it is written.
 */
import { Router } from 'express';
import { requireSession } from '../middleware/authenticate.js';
import { openStream } from '../services/realtime.js';

const router = Router();

router.get('/stream', ...requireSession, openStream);

export default router;
