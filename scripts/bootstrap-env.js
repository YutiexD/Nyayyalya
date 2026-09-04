#!/usr/bin/env node
/**
 * Generate a .env from .env.example with cryptographically random secrets.
 *
 * Refuses to overwrite an existing .env unless --force is passed, because
 * regenerating MASTER_KEK makes every previously-stored evidence file
 * undecryptable. That is a footgun worth one guard rail.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const TARGET = path.join(ROOT, '.env');
const force = process.argv.includes('--force');

if (!fs.existsSync(EXAMPLE)) {
  console.error('[bootstrap-env] .env.example not found');
  process.exit(1);
}

if (fs.existsSync(TARGET) && !force) {
  console.error('[bootstrap-env] .env already exists — refusing to overwrite.');
  console.error('[bootstrap-env]');
  console.error('[bootstrap-env] Regenerating MASTER_KEK would make every already-stored');
  console.error('[bootstrap-env] evidence file permanently undecryptable.');
  console.error('[bootstrap-env]');
  console.error('[bootstrap-env] Pass --force only if you accept that.');
  process.exit(1);
}

const secrets = {
  JWT_SECRET: crypto.randomBytes(48).toString('base64url'),
  REFRESH_SECRET: crypto.randomBytes(48).toString('base64url'),
  QR_SECRET: crypto.randomBytes(48).toString('base64url'),
  MASTER_KEK: crypto.randomBytes(32).toString('hex'),
};

let content = fs.readFileSync(EXAMPLE, 'utf8');
for (const [key, value] of Object.entries(secrets)) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (!re.test(content)) {
    console.error(`[bootstrap-env] key ${key} not present in .env.example`);
    process.exit(1);
  }
  content = content.replace(re, `${key}=${value}`);
}

// Local development convenience: the demo needs to read the OTP without an SMS gateway.
content = content.replace(/^DEMO_ECHO_OTP=.*$/m, 'DEMO_ECHO_OTP=true');

fs.writeFileSync(TARGET, content, { mode: 0o600 });

console.log('[bootstrap-env] wrote .env with fresh secrets (mode 600)');
console.log('[bootstrap-env]   JWT_SECRET, REFRESH_SECRET, QR_SECRET, MASTER_KEK generated');
console.log('[bootstrap-env]   DEMO_ECHO_OTP=true  (development only — refused in production)');
console.log('[bootstrap-env]');
console.log('[bootstrap-env] .env is gitignored. Do not commit it.');
