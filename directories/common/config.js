/**
 * Configuration for the three directory services.
 *
 * Everything comes from process.env with a working default, so `node
 * directories/police/server.js` runs on a clean checkout with no .env at all.
 * The repo-root .env is loaded if present (it is the same file the core API uses),
 * but it is never required.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * @param {object} opts
 * @param {string} opts.service   e.g. 'directory-police'
 * @param {string} opts.portVar   env var holding this service's port
 * @param {number} opts.portDefault
 * @param {string} opts.dbVar     env var holding this service's database name
 * @param {string} opts.dbDefault
 */
export function loadConfig({ service, portVar, portDefault, dbVar, dbDefault }) {
  return {
    service,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    port: num(process.env[portVar], portDefault),
    host: process.env.DIRECTORY_HOST ?? '127.0.0.1',
    mongoUri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017',
    dbName: process.env[dbVar] ?? dbDefault,
    serverSelectionMs: num(process.env.MONGO_SERVER_SELECTION_MS, 5000),
    bodyLimit: process.env.DIRECTORY_BODY_LIMIT ?? '100kb',
    /**
     * Whether the court directory's ONE write endpoint — POST /directory/vakalatnama —
     * is open.
     *
     * That endpoint is a stand-in for a registrar filing a vakalatnama in eCourts. It
     * is how the demo shows an advocate coming on record, and the grant it produces is
     * what later unlocks disclosure for that advocate in Lexx. In a real deployment
     * eCourts owns that act and this service would not exist; if this simulator were
     * ever exposed with a real dataset behind it, an unauthenticated caller could put
     * any advocate on record for any listed case.
     *
     * So it is off under NODE_ENV=production unless someone deliberately turns it back
     * on, and it says plainly in every response that it is simulated.
     */
    allowSimulatedFilings:
      process.env.DIRECTORY_ALLOW_SIMULATED_FILINGS === 'true' ||
      (process.env.NODE_ENV ?? 'development') !== 'production',
    /**
     * CORS is restricted to the local Lexx API origin. These services are consumed
     * server-to-server by backend/services/directoryClient.js — a browser has no
     * business talking to a government directory directly — so the allowlist is
     * short and the default is the core API's own origin.
     */
    corsOrigins: (
      process.env.DIRECTORY_CORS_ORIGIN ??
      process.env.PUBLIC_BASE_URL ??
      'http://localhost:5000'
    )
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
