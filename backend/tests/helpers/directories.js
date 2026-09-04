/**
 * Run the three authority directories for integration tests.
 *
 * They are started as REAL CHILD PROCESSES against the test MongoDB, not stubbed.
 *
 * Two reasons that is worth the extra seconds:
 *   1. Each directory owns its own mongoose default connection. Importing them into
 *      the test process would have four services fighting over one connection.
 *   2. The whole architectural claim is "Lexx verifies against external systems it
 *      does not control". A mocked directory would test the mock, and would not
 *      catch a URL, a shape, a timeout or a status-code mismatch — which is exactly
 *      where this integration actually breaks.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Ports are derived per test process in backend/tests/setup.js and passed through the
 * environment, so concurrent test runs on one machine cannot collide.
 */
const BASE = Number(process.env.DIRECTORY_TEST_PORT_BASE ?? 16001);
export const TEST_PORTS = { police: BASE, court: BASE + 1, legal: BASE + 2 };

const SERVICES = [
  { name: 'police', script: 'directories/police/server.js', portVar: 'DIRECTORY_POLICE_PORT', dbVar: 'MONGO_DB_DIR_POLICE', db: `test_dir_police_${process.pid}` },
  { name: 'court', script: 'directories/court/server.js', portVar: 'DIRECTORY_COURT_PORT', dbVar: 'MONGO_DB_DIR_COURT', db: `test_dir_court_${process.pid}` },
  { name: 'legal', script: 'directories/legal/server.js', portVar: 'DIRECTORY_LEGAL_PORT', dbVar: 'MONGO_DB_DIR_LEGAL', db: `test_dir_legal_${process.pid}` },
];

let children = [];

const waitFor = async (url, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`directory did not become healthy: ${url} (${lastErr?.message})`);
};

/**
 * Start all three directories against `mongoUri` and seed them.
 *
 * @returns {Promise<{police:string, court:string, legal:string}>} base URLs
 */
export async function startDirectories(mongoUri) {
  if (children.length) return urls();

  for (const svc of SERVICES) {
    const child = spawn(process.execPath, [path.join(ROOT, svc.script)], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        MONGO_URI: mongoUri,
        [svc.portVar]: String(TEST_PORTS[svc.name]),
        [svc.dbVar]: svc.db,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Keep stderr available for diagnosis without spamming test output.
    child.stderr.on('data', (d) => {
      const text = String(d);
      if (/error|Error|EADDRINUSE/.test(text)) {
         
        console.error(`[dir:${svc.name}] ${text.trim().slice(0, 400)}`);
      }
    });
    child.stdout.resume();

    children.push({ ...svc, child });
  }

  await Promise.all(
    SERVICES.map((s) => waitFor(`http://127.0.0.1:${TEST_PORTS[s.name]}/healthz`))
  );

  await seedDirectories(mongoUri);
  return urls();
}

/** Run each directory's own seed script as a child process (idempotent). */
export async function seedDirectories(mongoUri) {
  const seeds = [
    ['directories/police/seed.js', 'MONGO_DB_DIR_POLICE', `test_dir_police_${process.pid}`],
    ['directories/court/seed.js', 'MONGO_DB_DIR_COURT', `test_dir_court_${process.pid}`],
    ['directories/legal/seed.js', 'MONGO_DB_DIR_LEGAL', `test_dir_legal_${process.pid}`],
  ];

  for (const [script, dbVar, db] of seeds) {
    await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(ROOT, script)], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongoUri, [dbVar]: db },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      p.stderr.on('data', (d) => {
        stderr += d;
      });
      p.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${script} exited ${code}: ${stderr.slice(0, 500)}`))
      );
      p.on('error', reject);
    });
  }
}

export function urls() {
  return {
    police: `http://127.0.0.1:${TEST_PORTS.police}`,
    court: `http://127.0.0.1:${TEST_PORTS.court}`,
    legal: `http://127.0.0.1:${TEST_PORTS.legal}`,
  };
}

export async function stopDirectories() {
  for (const { child } of children) {
    try {
      child.kill('SIGKILL'); // Windows cannot deliver SIGTERM meaningfully
    } catch {
      /* already gone */
    }
  }
  children = [];
  await new Promise((r) => setTimeout(r, 150));
}
