/**
 * Cryptographic primitives. One place, so the algorithm choices are auditable.
 *
 * Everything random here comes from `crypto.randomBytes` (CSPRNG). `Math.random` is
 * never used for anything security-relevant anywhere in this codebase.
 */
import crypto from 'node:crypto';
import env from './env.js';

export const HASH_ALGO = 'SHA-256';
export const CONTENT_CIPHER = 'aes-256-gcm';
export const SIGNATURE_CURVE = 'P-256';
export const KEK_DERIVATION_VERSION = 'kek-v1';

// ---------------------------------------------------------------- hashing ----

export const sha256Hex = (data) =>
  crypto
    .createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex');

/** Streaming hasher for large uploads — never buffers the whole file. */
export const createSha256Stream = () => crypto.createHash('sha256');

// ---------------------------------------------------------------- randomness ----

export const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const randomBase64Url = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomBytes = (n) => crypto.randomBytes(n);

/**
 * Uniform random integer in [0, max). Rejection sampling — modulo of a random
 * integer is biased, and a biased OTP is a weaker OTP.
 */
export function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 48) {
    throw new RangeError('randomInt: max out of range');
  }
  return crypto.randomInt(0, max);
}

/** Zero-padded numeric OTP from a CSPRNG. */
export function randomNumericCode(digits = 6) {
  const max = 10 ** digits;
  return String(randomInt(max)).padStart(digits, '0');
}

// ---------------------------------------------------------------- comparison ----

/**
 * Constant-time string comparison. Length is compared first via a hash so that
 * differing lengths do not throw and do not leak through timing.
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function timingSafeEqualBuf(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- HMAC ----

export const hmacSha256 = (key, message, encoding = 'base64url') =>
  crypto
    .createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : key)
    .update(message, 'utf8')
    .digest(encoding);

// ---------------------------------------------------------------- key derivation ----

const masterKey = () => Buffer.from(env.MASTER_KEK, 'hex');

/**
 * Per-case KEK (ADR-008). Derived, never stored.
 * Compromise of one case KEK does not expose any other case.
 */
export function deriveCaseKek(caseId, kekId = KEK_DERIVATION_VERSION) {
  const salt = Buffer.from(kekId, 'utf8');
  const info = Buffer.from(`lexx-case-kek:${String(caseId)}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', masterKey(), salt, info, 32));
}

// ---------------------------------------------------------------- AEAD ----

/**
 * AES-256-GCM encrypt. Fresh 96-bit IV every call — GCM IV reuse under the same key
 * is catastrophic, so the IV is never caller-supplied.
 * @returns {{ciphertext: Buffer, iv: string, tag: string}} iv/tag are base64
 */
export function aeadEncrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CONTENT_CIPHER, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/** AES-256-GCM decrypt. Throws if the tag does not verify (i.e. ciphertext tampered). */
export function aeadDecrypt(key, ciphertext, ivB64, tagB64, aad) {
  const decipher = crypto.createDecipheriv(CONTENT_CIPHER, key, Buffer.from(ivB64, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------- ECDSA verify ----

/**
 * Verify a browser-produced ECDSA P-256 signature over a hex hash string.
 *
 * The Web Crypto API produces IEEE P1363 (r||s, 64 bytes) signatures, while Node's
 * default verifier expects DER. Getting this wrong is the classic "signature always
 * fails" or, worse, "signature always passes" bug, so the format is stated explicitly.
 *
 * @param {object} publicKeyJwk registered public key (JWK, kty EC, crv P-256)
 * @param {string} signatureHex hex-encoded 64-byte r||s signature
 * @param {string} signedMessage the exact string the browser signed (the hex hash)
 */
export function verifyEcdsaP256(publicKeyJwk, signatureHex, signedMessage) {
  try {
    if (!publicKeyJwk || publicKeyJwk.kty !== 'EC' || publicKeyJwk.crv !== 'P-256') return false;
    if (typeof signatureHex !== 'string' || !/^[0-9a-fA-F]+$/.test(signatureHex)) return false;

    const sig = Buffer.from(signatureHex, 'hex');
    if (sig.length !== 64) return false; // P1363 for P-256 is exactly r(32)||s(32)

    const keyObject = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: publicKeyJwk.x, y: publicKeyJwk.y },
      format: 'jwk',
    });

    return crypto.verify(
      'sha256',
      Buffer.from(signedMessage, 'utf8'),
      { key: keyObject, dsaEncoding: 'ieee-p1363' },
      sig
    );
  } catch {
    // A malformed key or signature is a failed verification, not a server error.
    return false;
  }
}

/** Stable fingerprint of a registered public key, for display and for JWT binding. */
export function publicKeyFingerprint(jwk) {
  if (!jwk?.x || !jwk?.y) throw new TypeError('publicKeyFingerprint: invalid EC JWK');
  return sha256Hex(`${jwk.crv}:${jwk.x}:${jwk.y}`);
}

export default {
  sha256Hex,
  createSha256Stream,
  randomHex,
  randomBase64Url,
  randomNumericCode,
  timingSafeEqualStr,
  hmacSha256,
  deriveCaseKek,
  aeadEncrypt,
  aeadDecrypt,
  verifyEcdsaP256,
  publicKeyFingerprint,
};
