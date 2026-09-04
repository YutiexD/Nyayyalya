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
console.log(`[reset]   database : ${env.MONGO_DB_CORE} at ${env.MONGO_URI}`);
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
