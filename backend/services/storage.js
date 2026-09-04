/**
 * Encrypted object storage on the local filesystem.
 *
 * # Path safety
 *
 * Storage keys are derived from a SHA-256 hex digest plus an ObjectId — both are
 * generated server-side and validated against a strict pattern before they ever
 * touch the filesystem. No user-supplied filename reaches a path. The resolved
 * absolute path is then checked to be inside the vault, so even a future bug that
 * lets a bad key through cannot escape the directory.
 *
 * # Streaming
 *
 * Files up to MAX_UPLOAD_BYTES are handled without ever holding the whole file in
 * memory: hashing and encryption both run as streams. Buffering a 256 MB upload per
 * concurrent request is how a service falls over under a demo load.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import env from '../config/env.js';
import { CONTENT_CIPHER } from '../config/crypto.js';
import { BadRequest, Internal, NotFound } from '../utils/errors.js';

const VAULT = env.STORAGE_DIR;

/** `<64 hex>-<24 hex ObjectId>`. Nothing else is a valid key. */
const KEY_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{24}$/;

export const buildStorageKey = (sha256Hex, evidenceId) => `${sha256Hex}-${String(evidenceId)}`;

/**
 * Absolute path for a key, sharded two levels to keep directories small.
 * Throws on anything that is not a well-formed key.
 */
export function resolveObjectPath(storageKey) {
  if (typeof storageKey !== 'string' || !KEY_PATTERN.test(storageKey)) {
    throw BadRequest('INVALID_STORAGE_KEY', 'Malformed storage key');
  }
  const dir = path.join(VAULT, storageKey.slice(0, 2), storageKey.slice(2, 4));
  const full = path.join(dir, storageKey);

  // Belt and braces: the key pattern already forbids separators and dots, but a
  // path that resolves outside the vault must never be actionable.
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT) + path.sep)) {
    throw BadRequest('INVALID_STORAGE_KEY', 'Malformed storage key');
  }
  return resolved;
}

export const ensureVault = () => fsp.mkdir(VAULT, { recursive: true });

/**
 * Encrypt a plaintext file into the vault, streaming.
 *
 * @param {string} sourcePath  plaintext temp file
 * @param {string} storageKey  from buildStorageKey
 * @param {Buffer} dek         32-byte data encryption key
 * @returns {Promise<{iv:string, tag:string, sizeBytes:number}>}
 */
export async function putEncryptedFile(sourcePath, storageKey, dek) {
  const target = resolveObjectPath(storageKey);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CONTENT_CIPHER, dek, iv);

  // Write to a temp name and rename, so a crash mid-write cannot leave a truncated
  // object that would later read as "file modified" rather than "write failed".
  const tempTarget = `${target}.${crypto.randomBytes(6).toString('hex')}.part`;

  try {
    await pipeline(fs.createReadStream(sourcePath), cipher, fs.createWriteStream(tempTarget));
    await fsp.rename(tempTarget, target);
  } catch (err) {
    await fsp.rm(tempTarget, { force: true }).catch(() => {});
    throw Internal('STORAGE_WRITE_FAILED', `Could not store the object: ${err.message}`);
  }

  const { size } = await fsp.stat(target);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), sizeBytes: size };
}

/**
 * Decrypting read stream.
 *
 * GCM verifies the authentication tag at the END of the stream, so a consumer that
 * aborts early has NOT verified integrity. Callers that need an integrity guarantee
 * (the verify endpoint) must read to completion — `readDecryptedToHash` does.
 */
export function getDecryptedStream(storageKey, dek, { iv, tag }) {
  const target = resolveObjectPath(storageKey);
  if (!fs.existsSync(target)) {
    throw NotFound('OBJECT_NOT_FOUND', 'Stored object is missing');
  }
  const decipher = crypto.createDecipheriv(CONTENT_CIPHER, dek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return fs.createReadStream(target).pipe(decipher);
}

/**
 * Decrypt the stored object and return the SHA-256 of the recovered plaintext.
 * This is the core of the tamper demo: it re-derives the hash from what is actually
 * on disk, rather than trusting what the database says the hash was.
 *
 * @returns {Promise<{sha256:string|null, authTagValid:boolean, missing:boolean}>}
 */
export async function readDecryptedToHash(storageKey, dek, { iv, tag }) {
  let target;
  try {
    target = resolveObjectPath(storageKey);
  } catch {
    return { sha256: null, authTagValid: false, missing: true };
  }
  if (!fs.existsSync(target)) return { sha256: null, authTagValid: false, missing: true };

  const decipher = crypto.createDecipheriv(CONTENT_CIPHER, dek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const hash = crypto.createHash('sha256');

  try {
    await pipeline(fs.createReadStream(target), decipher, hash);
    return { sha256: hash.digest('hex'), authTagValid: true, missing: false };
  } catch {
    // A GCM tag failure means the ciphertext on disk was altered. That is a finding,
    // not an error: report it so the verify endpoint can render FILE_MODIFIED.
    return { sha256: null, authTagValid: false, missing: false };
  }
}

/** Raw ciphertext hash — lets us detect modification even when the tag check fails. */
export async function ciphertextDigest(storageKey) {
  let target;
  try {
    target = resolveObjectPath(storageKey);
  } catch {
    return null;
  }
  if (!fs.existsSync(target)) return null;
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(target), hash);
  return hash.digest('hex');
}

export const objectExists = (storageKey) => {
  try {
    return fs.existsSync(resolveObjectPath(storageKey));
  } catch {
    return false;
  }
};

export const objectSize = async (storageKey) => {
  try {
    const { size } = await fsp.stat(resolveObjectPath(storageKey));
    return size;
  } catch {
    return null;
  }
};

export default {
  buildStorageKey,
  resolveObjectPath,
  ensureVault,
  putEncryptedFile,
  getDecryptedStream,
  readDecryptedToHash,
  objectExists,
};
