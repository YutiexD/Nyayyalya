#!/usr/bin/env node
/**
 * Reset to a clean state.
 *
 * You WILL need this between demo rehearsals — the tamper demo deliberately corrupts
 * a stored file, and the custody demo consumes one-shot transfer tokens.
 *
 * What it clears:
 *   - the `lexx_core` database (cases, evidence, ledger, users, audit, anchors)
 *   - the encrypted object vault
 *
 * What it does NOT clear, by default:
 *   - the three authority directories. They stand in for external government systems
 *     that Lexx cannot write to, so wiping them on every reset would misrepresent the
 *     architecture. Pass --directories to reseed them too.
 *
 *   node seed/reset.js [--directories] [--yes]
 */
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Import env AFTER establishing the root, so .env is loaded consistently.
const { default: env } = await import('../backend/config/env.js');

const args = new Set(process.argv.slice(2));
const resetDirectories = args.has('--directories');
const skipPrompt = args.has('--yes') || args.has('-y');

if (env.NODE_ENV === 'production') {
  console.error('[reset] Refusing to run with NODE_ENV=production.');
  process.exit(1);
}

console.log('[reset] This will DELETE:');
// Never print the connection string with its password in it — this runs on a
// projector during rehearsals. Show the host, which is what the operator needs
// to confirm they are about to drop the right database.
const safeUri = (uri) => {
  try {
    const u = new URL(uri);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return String(uri).replace(/\/\/[^/@]*@/, '//****@');
  }
};
console.log(`[reset]   database : ${env.MONGO_DB_CORE} at ${safeUri(env.MONGO_URI)}`);
console.log(`[reset]   vault    : ${env.STORAGE_DIR}`);
if (resetDirectories) console.log('[reset]   directories: dir_police, dir_court, dir_legal (reseeded)');

if (!skipPrompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('[reset] Type "reset" to continue: ');
  rl.close();
  if (answer.trim() !== 'reset') {
    console.log('[reset] Aborted.');
    process.exit(0);
  }
}

// ---- database -----------------------------------------------------------------
await mongoose.connect(env.MONGO_URI, {
  dbName: env.MONGO_DB_CORE,
  serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_MS,
});
await mongoose.connection.dropDatabase();
console.log(`[reset] dropped database ${env.MONGO_DB_CORE}`);

// Rebuild every declared index before disconnecting.
//
// dropDatabase() takes the indexes with it, and the API server — which is the only
// thing that ever called syncIndexes(), at its own boot — is STILL RUNNING. Nothing
// would recreate them until someone restarted it, and the documented procedure
// (docs/DEMO_SCRIPT.md) never says to. Every rehearsal therefore left the system with
// nothing but `_id_` on all 16 collections.
//
// That is not merely a performance problem. These indexes are load-bearing:
//   - the unique index on `ledger.seq` is the database-level backstop for the
//     append-only guarantee, and `anchor_batches` uniqueness is what stops a range
//     being anchored twice;
//   - the text indexes on cases and evidence are what `GET /api/search` runs on —
//     without them every search returns SEARCH_UNAVAILABLE;
//   - the TTL indexes on otp_challenges, refresh_tokens and stream_tokens are what
//     expire credentials, so without them nothing is ever reaped.
//
// backend/server.js says it plainly: "A process that accepts requests before its
// indexes exist would silently lose the unique constraints that the ledger's
// integrity depends on." Reset was putting the running process into exactly that state.
const { allModels } = await import('../backend/models/index.js');
let built = 0;
for (const model of allModels) {
  await model.createIndexes();
  built += 1;
}
console.log(`[reset] rebuilt indexes on ${built} collections`);

await mongoose.disconnect();

// ---- vault --------------------------------------------------------------------
if (fs.existsSync(env.STORAGE_DIR)) {
  fs.rmSync(env.STORAGE_DIR, { recursive: true, force: true });
  console.log(`[reset] cleared vault ${env.STORAGE_DIR}`);
}
fs.mkdirSync(env.STORAGE_DIR, { recursive: true });

// ---- directories (optional) ---------------------------------------------------
if (resetDirectories) {
  const seeds = ['directories/police/seed.js', 'directories/court/seed.js', 'directories/legal/seed.js'];
  for (const script of seeds) {
    await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
      p.on('error', reject);
    });
  }
  console.log('[reset] directories reseeded');
}

console.log('\n[reset] Clean. Next:  npm run seed\n');
process.exit(0);
