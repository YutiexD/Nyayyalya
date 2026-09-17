/**
 * Global test setup.
 *
 * Secrets are injected here BEFORE any module reads config, because
 * `backend/config/env.js` validates and freezes configuration at import time.
 * These are throwaway values for the test process only.
 */
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

process.env.JWT_SECRET ??= crypto.randomBytes(48).toString('base64url');
process.env.REFRESH_SECRET ??= crypto.randomBytes(48).toString('base64url');
process.env.QR_SECRET ??= crypto.randomBytes(48).toString('base64url');
process.env.MASTER_KEK ??= crypto.randomBytes(32).toString('hex');

// Tests exercise the real OTP path; echoing lets them read the code without an SMS gateway.
process.env.DEMO_ECHO_OTP = 'true';

// bcrypt at production cost dominates the suite (every test activates ~9 users).
// Cost is a tuning parameter, not a security property under test; production
// refuses anything below 12 (see config/env.js).
process.env.BCRYPT_ROUNDS = '4';

// The replay test presents a consumed refresh token immediately; with the concurrency
// grace on, that would be treated as a race. Tests that exercise the grace set it.
process.env.REFRESH_REUSE_GRACE_SEC = '0';

// Anchoring is off by default; the anchor suite enables it explicitly per-test.
process.env.ANCHOR_ENABLED = 'false';

// Gemini is never called for real from the suite. Integration tests that exercise the
// analysis pipeline start the stub in tests/fixtures/geminiStub.js on this port; every
// other test finds nothing listening there, so an analysis fails fast and is recorded
// as FAILED — which is also the behaviour under test for an unreachable Gemini.
const geminiPort = 30000 + (process.pid % 3000);
process.env.GEMINI_STUB_PORT = String(geminiPort);
process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${geminiPort}/v1beta`;
process.env.GEMINI_API_KEY = 'test-gemini-key-not-a-real-credential';
process.env.GEMINI_MODEL = 'gemini-test-model';
process.env.GEMINI_MAX_RETRIES = '0';
process.env.GEMINI_RETRY_BASE_MS = '10';
process.env.GEMINI_TIMEOUT_MS = '5000';

// Keep the vault out of the developer's real storage directory.
process.env.STORAGE_DIR = './.data/test-vault';

// Integration suites start the REAL directory services as child processes.
//
// Ports are derived from this process's PID rather than fixed, so two test runs on
// one machine — a developer running the suite while CI or another agent runs it —
// cannot collide. A collision would surface as DIRECTORY_UNAVAILABLE, which looks
// exactly like a product bug and is not one.
//
// These must be set BEFORE any module reads config: backend/config/env.js validates
// and freezes configuration at import time.
const portBase = 20000 + (process.pid % 3000) * 3;
process.env.DIRECTORY_TEST_PORT_BASE = String(portBase);
process.env.DIRECTORY_POLICE_URL = `http://127.0.0.1:${portBase}`;
process.env.DIRECTORY_COURT_URL = `http://127.0.0.1:${portBase + 1}`;
process.env.DIRECTORY_LEGAL_URL = `http://127.0.0.1:${portBase + 2}`;
process.env.DIRECTORY_TIMEOUT_MS = '5000';
