/**
 * Envelope encryption (ADR-008).
 *
 *   master key (env; a KMS/HSM in production)
 *     └─ HKDF ─> per-case KEK          (derived, never stored)
 *          └─ AES-256-GCM wrap ─> per-evidence DEK (stored wrapped)
 *               └─ AES-256-GCM ─> the evidence bytes
 *
 * Compromising one case's KEK exposes that case and nothing else. The stored
 * `wrappedDek` is useless without the master key, so a database dump alone does not
 * yield a single plaintext byte.
 */
import crypto from 'node:crypto';
import {
  deriveCaseKek,
  aeadEncrypt,
  aeadDecrypt,
  KEK_DERIVATION_VERSION,
} from '../config/crypto.js';
import { Internal } from '../utils/errors.js';

/** Fresh 256-bit data encryption key. */
export const generateDek = () => crypto.randomBytes(32);

/**
 * Wrap a DEK under the case KEK.
 *
 * The case id is bound in as additional authenticated data, so a wrapped DEK lifted
 * from one case's record and pasted into another's will fail to unwrap rather than
 * silently decrypting under the wrong key.
 */
export function wrapDek(dek, caseId) {
  const kekId = KEK_DERIVATION_VERSION;
  const kek = deriveCaseKek(caseId, kekId);
  const { ciphertext, iv, tag } = aeadEncrypt(kek, dek, `dek:${String(caseId)}`);
  kek.fill(0); // do not leave key material lying in the heap longer than needed
  return {
    wrappedDek: ciphertext.toString('base64'),
    wrapIv: iv,
    wrapTag: tag,
    kekId,
  };
}

/** Unwrap a DEK. Throws if the record was moved between cases or tampered with. */
export function unwrapDek({ wrappedDek, wrapIv, wrapTag, kekId }, caseId) {
  const kek = deriveCaseKek(caseId, kekId ?? KEK_DERIVATION_VERSION);
  try {
    return aeadDecrypt(kek, Buffer.from(wrappedDek, 'base64'), wrapIv, wrapTag, `dek:${String(caseId)}`);
  } catch {
    throw Internal('DEK_UNWRAP_FAILED', 'Evidence key could not be unwrapped');
  } finally {
    kek.fill(0);
  }
}

/** Encrypt a buffer under a fresh DEK. Used for small artefacts (reports, PDFs). */
export function sealBuffer(plaintext, caseId) {
  const dek = generateDek();
  try {
    const { ciphertext, iv, tag } = aeadEncrypt(dek, plaintext);
    return { ciphertext, encryption: { algo: 'AES-256-GCM', iv, tag, ...wrapDek(dek, caseId) } };
  } finally {
    dek.fill(0);
  }
}

/** Decrypt a buffer sealed by `sealBuffer`. */
export function openBuffer(ciphertext, encryption, caseId) {
  const dek = unwrapDek(encryption, caseId);
  try {
    return aeadDecrypt(dek, ciphertext, encryption.iv, encryption.tag);
  } finally {
    dek.fill(0);
  }
}

export default { generateDek, wrapDek, unwrapDek, sealBuffer, openBuffer };
