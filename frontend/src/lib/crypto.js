/**
 * Browser-side integrity primitives (spec §8 F3).
 *
 * The whole claim this system makes about evidence rests on two operations that
 * happen HERE, on the officer's machine, before a byte reaches the server:
 *
 *   1. the file is hashed with SHA-256;
 *   2. that hash — the lowercase hex STRING, not its bytes — is signed with an
 *      ECDSA P-256 key whose private half has never left this device.
 *
 * The server recomputes the hash from what it actually received and verifies the
 * signature against the public key registered at activation. If either check fails
 * the upload is refused and the refusal is written to the ledger.
 *
 * # The format contract
 *
 * `backend/config/crypto.js` -> `verifyEcdsaP256` accepts, and only accepts:
 *   - a JWK public key with `kty: "EC"`, `crv: "P-256"`;
 *   - a signature of exactly 64 bytes as 128 lowercase hex characters, in IEEE
 *     P1363 (r||s) encoding — which is precisely what Web Crypto produces;
 *   - a signed message that is the hex hash string, UTF-8 encoded.
 *
 * DER encoding is rejected there deliberately, so nothing in this file ever
 * re-encodes a signature. `frontend/lib/crypto.test.mjs` signs with this exact code
 * path and verifies with that exact function, so drift between the two fails loudly
 * rather than at the demo.
 *
 * # Why the private key is non-extractable
 *
 * `generateKey(..., false, ...)` marks the key non-extractable: `exportKey` on the
 * private half throws, and no amount of XSS or console access can lift it out of the
 * browser. IndexedDB stores CryptoKey objects by structured clone, which preserves
 * non-extractable keys — that is the only reason this can be both persistent and
 * unexportable.
 */

const DB_NAME = 'lexx';
const DB_VERSION = 1;
const STORE = 'keys';
const KEYPAIR_ID = 'lexx_keypair';

const ALGORITHM = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIGN_PARAMS = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });

/** Signature length the server requires: r(32) || s(32), hex-encoded. */
export const SIGNATURE_HEX_LENGTH = 128;

// ---------------------------------------------------------------- IndexedDB ----

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

function idbRequest(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        tx.oncomplete = () => db.close();
      })
  );
}

const idbGet = (key) => idbRequest('readonly', (store) => store.get(key));
const idbSet = (key, value) => idbRequest('readwrite', (store) => store.put(value, key));
const idbDelete = (key) => idbRequest('readwrite', (store) => store.delete(key));

// ---------------------------------------------------------------- encoding ----

/** ArrayBuffer -> lowercase hex. The only hash encoding this system uses. */
export function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// ------------------------------------------------------------- key material ----

/**
 * Generate a fresh signing keypair.
 *
 * `extractable: false` is the load-bearing argument: it is what makes "the private
 * key never leaves the device" a property of the platform rather than a promise.
 */
export function generateKeyPair() {
  return crypto.subtle.generateKey(ALGORITHM, false, ['sign', 'verify']);
}

/** The public half, in the exact JWK shape the server registers. */
export async function exportPublicJwk(publicKey) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  // Only the four fields the server's schema accepts. `key_ops`, `ext` and friends
  // are Web Crypto bookkeeping and would fail the strict zod object.
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** The stored keypair, or null. Never generates — activation is an explicit act. */
export async function loadKeyPair() {
  try {
    return (await idbGet(KEYPAIR_ID)) ?? null;
  } catch {
    // A browser with IndexedDB disabled cannot sign. That is a clear failure to
    // report at the point of use, not a silent fallback to an unsigned upload.
    return null;
  }
}

/**
 * The device's signing keypair, generating and persisting one on first use.
 * Called during activation and again, harmlessly, before any signing operation.
 */
export async function getOrCreateKeyPair() {
  const existing = await loadKeyPair();
  if (existing?.privateKey && existing?.publicKey) return existing;

  const keyPair = await generateKeyPair();
  await idbSet(KEYPAIR_ID, keyPair);
  return keyPair;
}

/** Removes the device key. Used when activating a different authority id. */
export async function clearKeyPair() {
  try {
    await idbDelete(KEYPAIR_ID);
  } catch {
    /* nothing to clear */
  }
}

/**
 * A short, human-comparable form of the public key, for showing next to a signature.
 * Computed the same way the server computes its fingerprint (SHA-256 over
 * `crv:x:y`), so the two can be eyeballed against each other on screen.
 */
export async function publicKeyFingerprint(publicKey) {
  const jwk = await exportPublicJwk(publicKey);
  return hashString(`${jwk.crv}:${jwk.x}:${jwk.y}`);
}

// ---------------------------------------------------------------- hashing ----

/** SHA-256 over raw bytes -> lowercase hex. */
export async function hashBytes(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

/** SHA-256 over a UTF-8 string -> lowercase hex. */
export async function hashString(text) {
  return hashBytes(new TextEncoder().encode(text));
}

/**
 * SHA-256 of a File or Blob -> lowercase hex.
 *
 * NOTE — memory ceiling: `arrayBuffer()` materialises the entire file in memory, so
 * a multi-hundred-megabyte exhibit will strain a modest machine and a multi-gigabyte
 * one will fail outright. The production fix is to hash the stream incrementally
 * (`file.stream()` fed through a chunked SHA-256 implementation, since Web Crypto's
 * `digest` has no update/finalise interface). Left as a buffered read for the MVP
 * because a wrong incremental hash is far worse than a bounded correct one.
 */
export async function hashFile(file) {
  return hashBytes(await file.arrayBuffer());
}

// ---------------------------------------------------------------- signing ----

/**
 * Sign a hex hash STRING with the device private key.
 *
 * The message signed is the hex text itself, UTF-8 encoded — not the 32 raw digest
 * bytes. The server verifies over exactly the same string, so this must not be
 * "optimised" into signing the bytes.
 *
 * @returns {Promise<string>} 128 lowercase hex characters (P1363 r||s)
 */
export async function signHashHex(hashHex, privateKey) {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) {
    throw new TypeError('signHashHex: expected a lowercase 64-character hex digest');
  }
  const signature = await crypto.subtle.sign(
    SIGN_PARAMS,
    privateKey,
    new TextEncoder().encode(hashHex)
  );
  const hex = toHex(signature);
  if (hex.length !== SIGNATURE_HEX_LENGTH) {
    // Web Crypto is specified to return P1363 for ECDSA. If a platform ever returned
    // DER the server would reject it, so fail here with a message that says why.
    throw new Error(
      `Signature is ${hex.length / 2} bytes; the server requires 64-byte IEEE P1363 (r||s).`
    );
  }
  return hex;
}

/** Convenience: hash a file and sign the hash in one step. */
export async function hashAndSignFile(file, privateKey) {
  const sha256 = await hashFile(file);
  const signature = await signHashHex(sha256, privateKey);
  return { sha256, signature };
}

/** Local self-check of a signature. The server's verdict is the one that counts. */
export async function verifyHashSignature(hashHex, signatureHex, publicKey) {
  const bytes = new Uint8Array(signatureHex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.verify(SIGN_PARAMS, publicKey, bytes, new TextEncoder().encode(hashHex));
}
