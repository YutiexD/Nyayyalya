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
  /**
   * Origin of the WEB CLIENT, which is not necessarily the API's origin.
   *
   * The QR printed on a s.63 certificate is meant to be scanned off the page by
   * anyone — a judge, defence counsel, a journalist — so it has to lead somewhere a
   * person can read. It was pointing at `${PUBLIC_BASE_URL}/public/verify/:token`,
   * the raw JSON endpoint, which answers a scanner with a wall of JSON instead of the
   * verifier page built for exactly this purpose.
   *
   * Note that a `localhost` value here is unscannable from any other device. For a
   * demo where people scan the certificate with their own phones, set this to the
   * machine's LAN address or a tunnel URL.
   */
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
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
  /**
   * The LEXX Certificate Authority's ECDSA P-256 private key, which signs every s.63
   * certificate. Optional: 64 hex characters (the raw private scalar) or a PKCS#8 PEM
   * ("\n" escapes accepted). Unset, it is derived deterministically from MASTER_KEK —
   * see services/systemSigner.js. Parsed and validated there.
   */
  CERTIFICATE_SIGNING_KEY: optional(z.string().min(64, 'CERTIFICATE_SIGNING_KEY is malformed')),

  // ---- Token lifetimes ----
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900), // 15 min (spec)
  // 0 = a session never expires on its own: it ends only on sign-out, a directory
  // re-verification failure, or refresh-token reuse. Any other value is a lifetime in seconds.
  REFRESH_TTL_SEC: z.coerce
    .number()
    .int()
    .refine((v) => v === 0 || v >= 300, 'REFRESH_TTL_SEC must be 0 (never expires) or at least 300')
    .default(0),
  // Two requests racing to refresh with the same token (two tabs, a burst of 401s) are
  // not an attack. A consumed token presented again within this window gets a fresh
  // token in the same family instead of revoking the family. 0 disables the grace.
  REFRESH_REUSE_GRACE_SEC: z.coerce.number().int().min(0).max(600).default(60),
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
  /**
   * Whether to SUBMIT anchor transactions to the chain. Off by default because
   * submitting needs a funded key. This does NOT control whether roots are computed
   * — see ANCHOR_BATCHING_ENABLED.
   */
  ANCHOR_ENABLED: bool('false'),
  /**
   * Whether the periodic batcher runs at all.
   *
   * Split out from ANCHOR_ENABLED because the two were conflated, and the conflation
   * silently disabled the entire anchoring pipeline in the shipped configuration:
   * with ANCHOR_ENABLED=false the scheduler never started, so no batch was ever
   * created, no Merkle root was ever computed, and `GET /api/anchors/latest` answered
   * "No batch has been anchored yet" forever — while README.md and docs/DEMO_SCRIPT.md
   * both described a batcher running every five minutes in DRY_RUN.
   *
   * Batching is the part that has value without a chain: it computes the root and
   * proves the ledger has not been edited since. Submitting is what needs the key.
   * So batching defaults ON and submission defaults OFF, and `status` on the batch
   * (DRY_RUN vs CONFIRMED) says truthfully which of the two happened.
   */
  ANCHOR_BATCHING_ENABLED: bool('true'),
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

  // ---- Gemini: deepfake analysis and evidence triage ----
  /**
   * The AI layer's only credentials. Required for the API to start (see
   * `assertGeminiConfigured`, called by server.js); optional here so that scripts
   * which never analyse anything — reset, tamper, lookups — still run without one.
   * Read by services/ai/geminiClient.js and nothing else. Never sent to the client.
   */
  GEMINI_API_KEY: optional(z.string().min(10, 'GEMINI_API_KEY looks truncated')),
  /** Changing the model is an environment change; no code names a model. */
  GEMINI_MODEL: optional(
    z.string().regex(/^[A-Za-z0-9._\-/]+$/, 'GEMINI_MODEL must be a model id such as the one in .env.example')
  ),
  GEMINI_API_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(90_000),
  /** Extra attempts for retryable failures (timeouts, 429, 5xx, unparseable output). */
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  GEMINI_RETRY_BASE_MS: z.coerce.number().int().min(10).max(60_000).default(1500),
  /**
   * Largest file sent inline. Inline requests are capped at 20 MB and base64 grows the
   * bytes by a third, so the default leaves headroom. Larger files are marked
   * UNSUPPORTED rather than truncated or guessed at.
   */
  GEMINI_MAX_INLINE_BYTES: z.coerce.number().int().min(1024).max(15 * 1024 * 1024).default(14 * 1024 * 1024),
  /**
   * Analyses running at once. 1 by default: each is one request carrying a whole file,
   * and a free-tier key's per-minute quota is the usual limit, not throughput.
   * Boot-time resumption goes through the same queue.
   */
  AI_ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
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

/**
 * Refuse to start the API without Gemini configuration.
 *
 * Called once from server.js at boot, not at import, so a maintenance script that
 * never analyses evidence is not forced to hold an AI key. The API itself cannot do
 * its job without one: every exhibit is analysed on ingest, and a registry that
 * silently skipped that step would put exhibits in the laboratory queue with no
 * priority and no explanation of why.
 */
export function assertGeminiConfigured() {
  const missing = ['GEMINI_API_KEY', 'GEMINI_MODEL'].filter((k) => !env[k]);
  if (missing.length) {
    fail(
      `Gemini is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
      'Set them in .env (see .env.example). The key is read only by backend/services/ai/geminiClient.js and is never sent to the browser.'
    );
  }
}

export { env };
export default env;
