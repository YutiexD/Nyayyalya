/**
 * Express application factory.
 *
 * Exported as a factory (rather than a module-level singleton) so tests can build an
 * app against their own database without starting a listener or a cron.
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { mongoReady } from '../shared/mongo.js';
import { directoryHealth } from './services/directoryClient.js';

import authRoutes from './routes/auth.js';
import caseRoutes from './routes/cases.js';
import evidenceRoutes from './routes/evidence.js';
import { ledgerRouter, auditRouter, searchRouter, anchorRouter } from './routes/system.js';
import custodyRoutes from './routes/custody.js';
import fslRoutes, { evidenceFslRouter } from './routes/fsl.js';
import disclosureRoutes from './routes/disclosure.js';
import certificateRoutes, { publicVerifyRouter } from './routes/certificate.js';

export function createApp() {
  const app = express();

  // Behind a reverse proxy in production; needed for correct client IPs in audit
  // rows and rate limits. Trusts one hop, not an arbitrary XFF chain.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", env.WEB_ORIGIN],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  app.use(
    cors({
      origin: env.WEB_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    })
  );

  // Small cap: this API takes JSON metadata, not payloads. File bytes arrive as
  // multipart and are bounded separately by MAX_UPLOAD_BYTES.
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  // ---------------------------------------------------------------- health ----

  /** Liveness: is the process up? Deliberately cheap and dependency-free. */
  app.get('/healthz', (req, res) => {
    res.json({
      status: 'ok',
      service: 'lexx-core',
      db: mongoReady() ? 'connected' : 'disconnected',
      anchorNetwork: env.ANCHOR_NETWORK,
      chainId: env.ANCHOR_CHAIN_ID,
    });
  });

  /** Readiness: can this instance actually serve? Checks real dependencies. */
  app.get('/readyz', async (req, res) => {
    const directories = await directoryHealth();
    const dbOk = mongoReady();
    const dirsOk = directories.police.ok && directories.court.ok && directories.legal.ok;
    res.status(dbOk && dirsOk ? 200 : 503).json({
      status: dbOk && dirsOk ? 'ready' : 'degraded',
      db: dbOk ? 'connected' : 'disconnected',
      directories,
    });
  });

  // ---------------------------------------------------------------- routes ----

  app.use('/api/auth', authRoutes);
  app.use('/api/cases', caseRoutes);
  app.use('/api/evidence', evidenceRoutes);
  // Referral lives under the evidence path because the thing referred is an exhibit.
  app.use('/api/evidence', evidenceFslRouter);
  app.use('/api/custody', custodyRoutes);
  app.use('/api/fsl', fslRoutes);
  app.use('/api/disclosure', disclosureRoutes);
  app.use('/api/certificates', certificateRoutes);
  app.use('/api/ledger', ledgerRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/search', searchRouter);

  // ---- PUBLIC, unauthenticated surface ----
  // Deliberately small and deliberately explicit. These two endpoints disclose that
  // something is committed to and that a certificate is valid — never what it says.
  app.use('/api/anchors', anchorRouter);
  app.use('/public', publicVerifyRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
