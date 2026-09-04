/**
 * Centralised, validated environment configuration.
 *
 * Rules enforced here:
 *  - No secret has a hardcoded default. A missing secret is a startup failure.
 *  - Production refuses dev-only affordances (e.g. OTP echo).
 *  - Every consumer imports `env` from here; nothing reads `process.env` directly.
 *
 * Run `node scripts/bootstrap-env.js` to generate a .env with CSPRNG secrets.
 */
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

// Load .env once, from the repo root, without clobbering real environment values.
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const bool = (def) =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

/**
 * dotenv turns `FOO=` into the empty string, not `undefined`, so a bare
 * `.optional()` would still run the validator against "". Treat blank as absent.
 */
const optional = (inner) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner.optional());

const hexKey = (bytes) =>
  z
    .string()
    .regex(
      new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`),
      `must be ${bytes * 2} hex characters (${bytes} bytes)`
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // ---- Core API ----
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5000'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  // ---- Database ----
  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017'),
  MONGO_DB_CORE: z.string().min(1).default('lexx_core'),
  MONGO_SERVER_SELECTION_MS: z.coerce.number().int().min(500).max(60000).default(5000),

  // ---- Authority directories (read-only to Lexx) ----
  DIRECTORY_POLICE_URL: z.string().url().default('http://localhost:6001'),
  DIRECTORY_COURT_URL: z.string().url().default('http://localhost:6002'),
  DIRECTORY_LEGAL_URL: z.string().url().default('http://localhost:6003'),
  DIRECTORY_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(2000),
  DIRECTORY_RETRIES: z.coerce.number().int().min(0).max(3).default(1),

  // ---- Secrets (no defaults, ever) ----
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  REFRESH_SECRET: z.string().min(32, 'REFRESH_SECRET must be at least 32 characters'),
  MASTER_KEK: hexKey(32),
  QR_SECRET: z.string().min(32, 'QR_SECRET must be at least 32 characters'),

  // ---- Token lifetimes ----
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900), // 15 min (spec)
  REFRESH_TTL_SEC: z.coerce.number().int().min(300).default(60 * 60 * 12),
  OTP_TTL_SEC: z.coerce.number().int().min(30).max(1800).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  /** bcrypt cost. Lowered only under test, where 9 logins per case is the bottleneck. */
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  TRANSFER_TOKEN_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(300), // 5 min (spec)
  STREAM_TOKEN_TTL_SEC: z.coerce.number().int().min(10).max(600).default(60), // 60 s (spec)

  // ---- Rate limits (per IP, per 15 minutes) ----
  RATE_LIMIT_OTP: z.coerce.number().int().min(1).max(1000).default(10),
  RATE_LIMIT_LOGIN: z.coerce.number().int().min(1).max(1000).default(20),
  RATE_LIMIT_LOOKUP: z.coerce.number().int().min(1).max(2000).default(60),

  // ---- Storage ----
  STORAGE_DIR: z.string().default('./vault'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(2 * 1024 * 1024 * 1024)
    .default(256 * 1024 * 1024),

  // ---- Blockchain: MONAD TESTNET ----
  ANCHOR_ENABLED: bool('false'),
  ANCHOR_NETWORK: z.literal('monad-testnet').default('monad-testnet'),
  ANCHOR_CHAIN_ID: z.coerce.number().int().default(10143),
  ANCHOR_RPC_URL: z.string().url().default('https://testnet-rpc.monad.xyz'),
  ANCHOR_EXPLORER_BASE: z.string().url().default('https://testnet.monadexplorer.com'),
  ANCHOR_CONTRACT_ADDRESS: optional(
    z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  ),
  /** Anchor signer key. Never hardcoded; absent means anchoring runs in DRY_RUN. */
  ANCHOR_PRIVATE_KEY: optional(
    z.preprocess(
      (v) => (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v.trim()) ? `0x${v.trim()}` : v),
      z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key')
    )
  ),
  ANCHOR_INTERVAL_MS: z.coerce.number().int().min(10_000).default(5 * 60 * 1000), // 5 min (spec)
  ANCHOR_BATCH_MAX: z.coerce.number().int().min(1).max(5000).default(1000),
  ANCHOR_CONFIRMATIONS: z.coerce.number().int().min(1).max(20).default(1),

  // ---- Demo affordances (refused in production) ----
  DEMO_ECHO_OTP: bool('false'),
});

function fail(message, details) {
  const err = new Error(message);
  err.details = details;
  // Startup failure: print clearly and exit rather than boot half-configured.
   
  console.error(`\n[lexx:env] ${message}\n${details ?? ''}\n`);
  throw err;
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  fail(
    'Invalid or missing environment configuration.',
    `${issues}\n\nFix: copy .env.example to .env, or run:\n  node scripts/bootstrap-env.js\n`
  );
}

const env = parsed.data;

// ---- Cross-field production guards -------------------------------------------------
if (env.NODE_ENV === 'production') {
  if (env.DEMO_ECHO_OTP) {
    fail('DEMO_ECHO_OTP=true is refused in production (ADR-004: it defeats the OTP factor).');
  }
  if (env.JWT_SECRET === env.REFRESH_SECRET) {
    fail('JWT_SECRET and REFRESH_SECRET must differ.');
  }
  if (env.BCRYPT_ROUNDS < 12) {
    fail('BCRYPT_ROUNDS below 12 is refused in production.');
  }
}

if (env.ANCHOR_ENABLED && !env.ANCHOR_CONTRACT_ADDRESS) {
  fail('ANCHOR_ENABLED=true requires ANCHOR_CONTRACT_ADDRESS (deploy the contract first).');
}

// Absolute storage path, resolved once.
env.STORAGE_DIR = path.isAbsolute(env.STORAGE_DIR)
  ? env.STORAGE_DIR
  : path.resolve(REPO_ROOT, env.STORAGE_DIR);

/** True when the anchor service can actually submit a transaction. */
export const anchorCanSubmit = Boolean(
  env.ANCHOR_ENABLED && env.ANCHOR_CONTRACT_ADDRESS && env.ANCHOR_PRIVATE_KEY
);

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export { env };
export default env;
