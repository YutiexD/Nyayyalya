#!/usr/bin/env node
/**
 * Corrupt one stored exhibit, on purpose, for the tamper demonstration.
 *
 * Beat 6 of the presentation shows the file-integrity light going red while the ledger
 * light stays green — the distinction the whole product rests on. To show that, the
 * stored object has to actually change, from OUTSIDE the application, the way someone
 * with server access would do it.
 *
 * This exists so a presenter does not have to construct a vault path by hand thirty
 * seconds before showing it to judges. The vault fans out by the first four characters
 * of the storage key (`vault/ab/cd/abcd…`), which is easy to get wrong under pressure
 * and produces a confusing "file missing" instead of the "file modified" the beat needs.
 *
 *   node scripts/tamper-demo.js <exhibitCode|storageKey>
 *   node scripts/tamper-demo.js --restore <exhibitCode|storageKey>
 *
 * `--restore` is not an undo of the corruption — the original bytes are gone. It
 * re-runs the seed's advice: reset and re-seed. It exists only to say so clearly.
 */
import fs from 'node:fs';
import path from 'node:path';

// env loads .env relative to itself, so this works from any working directory.
const { default: env } = await import('../backend/config/env.js');

if (env.NODE_ENV === 'production') {
  console.error('[tamper] Refusing to run with NODE_ENV=production.');
  process.exit(1);
}

const args = process.argv.slice(2);
const restore = args.includes('--restore');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('[tamper] Usage: node scripts/tamper-demo.js <exhibitCode|storageKey>');
  console.error('[tamper] The seed prints the tamper target and its storage key.');
  process.exit(1);
}

if (restore) {
  console.log('[tamper] Corruption cannot be undone — the original bytes are not kept.');
  console.log('[tamper] Restore the whole demo instead:');
  console.log('[tamper]   npm run reset -- --yes && npm run seed');
  process.exit(0);
}

const mongoose = (await import('mongoose')).default;
const { connectMongo } = await import('../shared/mongo.js');
const { Evidence } = await import('../backend/models/Evidence.js');

await connectMongo({
  uri: env.MONGO_URI,
  dbName: env.MONGO_DB_CORE,
  logger: { info() {}, warn() {}, error: console.error },
});

// Accept either identifier: the exhibit code is what is on screen, the storage key is
// what the seed prints. Under pressure, whichever is to hand should work.
const evidence = await Evidence.findOne({
  $or: [{ exhibitCode: target }, { storageKey: target }],
})
  .select('exhibitCode storageKey title sha256Server')
  .lean();

if (!evidence) {
  console.error(`[tamper] No exhibit matches "${target}".`);
  console.error('[tamper] Pass the exhibit code (EX-…) or the storage key the seed printed.');
  await mongoose.disconnect();
  process.exit(1);
}

// Same fan-out the vault uses: vault/<key[0:2]>/<key[2:4]>/<key>
const key = evidence.storageKey;
const file = path.join(env.STORAGE_DIR, key.slice(0, 2), key.slice(2, 4), key);

if (!fs.existsSync(file)) {
  console.error(`[tamper] The stored object is missing: ${file}`);
  console.error('[tamper] Re-seed before demonstrating.');
  await mongoose.disconnect();
  process.exit(1);
}

const before = fs.statSync(file).size;
fs.appendFileSync(file, 'x');
const after = fs.statSync(file).size;

console.log('');
console.log(`[tamper] ${evidence.exhibitCode} — ${evidence.title}`);
console.log(`[tamper] ${before} bytes -> ${after} bytes`);
console.log('');
console.log('[tamper] The stored object has been altered from outside the application.');
console.log('[tamper] Now open that exhibit and press Verify. Expect:');
console.log('[tamper]   Stored file   FILE MODIFIED   (red)');
console.log('[tamper]   Ledger chain  CHAIN INTACT    (green)');
console.log('');
console.log('[tamper] The file was touched; the log was not. That is the beat.');
console.log('');

await mongoose.disconnect();
process.exit(0);
