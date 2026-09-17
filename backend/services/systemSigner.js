/**
 * The LEXX Certificate Authority: the server-held key that signs every s.63 certificate.
 *
 * # Where the key comes from
 *
 *   1. `CERTIFICATE_SIGNING_KEY`, when set — 64 hex characters (the raw P-256 private
 *      scalar) or a PKCS#8 PEM.
 *   2. Otherwise it is DERIVED from MASTER_KEK with HKDF-SHA256 under a fixed label, so
 *      every process of one deployment agrees on the same key without storing it.
 *
 * # What it signs, and how
 *
 * ECDSA P-256 over SHA-256, IEEE P1363 (r||s, 64 bytes) — exactly the scheme users'
 * browser keys use, verified by the same `verifyEcdsaP256`. The message is the hex
 * canonical hash of the certificate body, as a UTF-8 string. Anyone holding the public
 * JWK from GET /api/certificates/authority-key can re-verify a signature independently.
 */
import crypto from 'node:crypto';

import env from '../config/env.js';
import { publicKeyFingerprint, verifyEcdsaP256 } from '../config/crypto.js';

export const SYSTEM_SIGNER_LABEL = 'LEXX Certificate Authority';
export const SYSTEM_SIGNATURE_ALGORITHM = 'ECDSA-P256-SHA256 (IEEE P1363)';

const HKDF_SALT = 'lexx-certificate-authority';
const HKDF_INFO = 'lexx-certificate-signing-key:v1';

/** P-256 group order. A derived scalar must be in [1, n-1]. */
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Private scalar → JWK pair, using ECDH only to compute the public point. */
function jwkFromScalar(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey(null, 'uncompressed'); // 0x04 || X(32) || Y(32)
  const x = b64u(pub.subarray(1, 33));
  const y = b64u(pub.subarray(33, 65));
  return {
    privateJwk: { kty: 'EC', crv: 'P-256', d: b64u(d), x, y },
    publicJwk: { kty: 'EC', crv: 'P-256', x, y },
  };
}

function deriveScalar() {
  const master = Buffer.from(env.MASTER_KEK, 'hex');
  // A counter keeps derivation total: an out-of-range scalar (probability ~2^-32) is
  // re-derived rather than rejected, and the result stays deterministic.
  for (let i = 0; i < 16; i += 1) {
    const info = Buffer.from(i === 0 ? HKDF_INFO : `${HKDF_INFO}:${i}`, 'utf8');
    const d = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(HKDF_SALT, 'utf8'), info, 32));
    const n = BigInt(`0x${d.toString('hex')}`);
    if (n > 0n && n < P256_ORDER) return d;
  }
  throw new Error('systemSigner: could not derive a valid P-256 scalar');
}

function loadConfiguredKey(raw) {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const d = Buffer.from(value, 'hex');
    const n = BigInt(`0x${value}`);
    if (!(n > 0n && n < P256_ORDER)) {
      throw new Error('CERTIFICATE_SIGNING_KEY is not a valid P-256 private scalar');
    }
    return { ...jwkFromScalar(d), source: 'CERTIFICATE_SIGNING_KEY' };
  }
  const pem = value.replace(/\\n/g, '\n');
  let keyObject;
  try {
    keyObject = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('CERTIFICATE_SIGNING_KEY must be 64 hex characters or a PKCS#8 PEM private key');
  }
  const jwk = keyObject.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new Error('CERTIFICATE_SIGNING_KEY must be an ECDSA P-256 key');
  }
  return {
    privateJwk: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y },
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    source: 'CERTIFICATE_SIGNING_KEY',
  };
}

let cached = null;

function authority() {
  if (cached) return cached;
  const loaded = env.CERTIFICATE_SIGNING_KEY
    ? loadConfiguredKey(env.CERTIFICATE_SIGNING_KEY)
    : { ...jwkFromScalar(deriveScalar()), source: 'DERIVED_FROM_MASTER_KEK' };
  const privateKey = crypto.createPrivateKey({ key: loaded.privateJwk, format: 'jwk' });
  cached = Object.freeze({
    privateKey,
    publicJwk: Object.freeze(loaded.publicJwk),
    fingerprint: publicKeyFingerprint(loaded.publicJwk),
    source: loaded.source,
  });
  return cached;
}

/** Sign a message string (a hex hash). Returns 128 hex characters (P1363). */
export function systemSign(message) {
  return crypto
    .sign('sha256', Buffer.from(String(message), 'utf8'), {
      key: authority().privateKey,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('hex');
}

/** Verify against the CURRENT authority key. */
export const systemVerify = (signatureHex, message) =>
  verifyEcdsaP256(authority().publicJwk, signatureHex, String(message));

/** The public half, for the certificate record and the public endpoint. Never the private key. */
export function authorityPublicKey() {
  const a = authority();
  return {
    issuer: SYSTEM_SIGNER_LABEL,
    algorithm: SYSTEM_SIGNATURE_ALGORITHM,
    publicKeyJwk: { ...a.publicJwk },
    fingerprint: a.fingerprint,
    signedMessage: 'The UTF-8 hex string of the certificate body canonical SHA-256 hash (certificateHash).',
  };
}

/** Test-only: forget the cached key. */
export const __resetSystemSigner = () => {
  cached = null;
};

export default { systemSign, systemVerify, authorityPublicKey, SYSTEM_SIGNER_LABEL, SYSTEM_SIGNATURE_ALGORITHM };
