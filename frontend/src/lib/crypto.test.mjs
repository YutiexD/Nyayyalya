/**
 * Crypto round-trip: browser code path in, server verifier out.
 *
 * This is the single most load-bearing interface in the client. If the browser's
 * signature format drifts from what `backend/config/crypto.js` accepts, every
 * evidence upload fails with SIGNATURE_INVALID and the failure looks like an
 * authorization bug rather than an encoding one.
 *
 * So this script does not reimplement anything. It imports the REAL browser module
 * (`./crypto.js`, which runs unmodified on Node 22 because it touches IndexedDB only
 * inside functions the browser calls) and the REAL server verifier, and puts one
 * through the other.
 *
 *   node frontend/lib/crypto.test.mjs        # from the repo root
 */
import assert from 'node:assert/strict';
import { verifyEcdsaP256, publicKeyFingerprint as serverFingerprint } from '../../../backend/config/crypto.js';
import {
  generateKeyPair,
  exportPublicJwk,
  hashBytes,
  signHashHex,
  verifyHashSignature,
  publicKeyFingerprint,
  SIGNATURE_HEX_LENGTH,
} from './crypto.js';

let failures = 0;

/** Await every check, so an async assertion cannot report PASS before it resolves. */
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
};

console.log('Nyayyalya browser crypto <-> server verifier round trip\n');

// ---- the exact browser code path -------------------------------------------
const keyPair = await generateKeyPair();
const publicKeyJwk = await exportPublicJwk(keyPair.publicKey);

const fileBytes = new TextEncoder().encode('CCTV clip bytes for exhibit EX-0123-2026-004');
const hashHex = await hashBytes(fileBytes);
const signatureHex = await signHashHex(hashHex, keyPair.privateKey);

console.log(`  hash       ${hashHex}`);
console.log(`  signature  ${signatureHex.slice(0, 32)}... (${signatureHex.length} hex chars)`);
console.log(`  public key kty=${publicKeyJwk.kty} crv=${publicKeyJwk.crv}\n`);

// ---- the contract ----------------------------------------------------------
await check('private key is non-extractable', () => {
  assert.equal(keyPair.privateKey.extractable, false);
});

await check('exportKey on the private half is refused by the platform', async () => {
  await assert.rejects(() => crypto.subtle.exportKey('jwk', keyPair.privateKey));
});

await check('public JWK carries exactly the four fields the server registers', () => {
  assert.deepEqual(Object.keys(publicKeyJwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(publicKeyJwk.kty, 'EC');
  assert.equal(publicKeyJwk.crv, 'P-256');
});

await check('hash is 64 lowercase hex characters', () => {
  assert.match(hashHex, /^[0-9a-f]{64}$/);
});

await check('signature is 128 lowercase hex characters (P1363 r||s, not DER)', () => {
  assert.equal(signatureHex.length, SIGNATURE_HEX_LENGTH);
  assert.match(signatureHex, /^[0-9a-f]{128}$/);
  // A DER-encoded ECDSA signature starts with 0x30. P1363 is raw r||s, so a leading
  // 0x30 here would mean the encoding drifted to the format the server rejects.
  assert.notEqual(signatureHex.slice(0, 2), '30');
});

await check('SERVER verifyEcdsaP256 accepts the browser signature', () => {
  assert.equal(verifyEcdsaP256(publicKeyJwk, signatureHex, hashHex), true);
});

await check('browser verify agrees with the server', async () => {
  assert.equal(await verifyHashSignature(hashHex, signatureHex, keyPair.publicKey), true);
});

await check('server rejects the signature over a DIFFERENT hash (tamper case)', () => {
  const otherHash = 'a'.repeat(64);
  assert.equal(verifyEcdsaP256(publicKeyJwk, signatureHex, otherHash), false);
});

await check('server rejects a signature from a different key', async () => {
  const other = await generateKeyPair();
  const otherJwk = await exportPublicJwk(other.publicKey);
  assert.equal(verifyEcdsaP256(otherJwk, signatureHex, hashHex), false);
});

await check('server rejects a flipped byte in the signature', () => {
  const flipped = (signatureHex[0] === '0' ? '1' : '0') + signatureHex.slice(1);
  assert.equal(verifyEcdsaP256(publicKeyJwk, flipped, hashHex), false);
});

await check('client and server compute the same public key fingerprint', async () => {
  assert.equal(await publicKeyFingerprint(keyPair.publicKey), serverFingerprint(publicKeyJwk));
});

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
