/**
 * Sealed documents in the vault: a filed forensic report, a filed vakalatnama.
 *
 * Container: magic | uint32BE header length | JSON envelope | ciphertext.
 *
 * `sealBuffer` returns the ciphertext and the envelope that unwraps it, and the
 * envelope has to live somewhere. Keeping it in the object's own header makes the
 * stored file self-describing, so a document remains readable from the vault alone.
 * The envelope carries only the WRAPPED key, which is useless without MASTER_KEK.
 *
 * Documents are small (a report, a filing) and are buffered; evidence, which can be
 * gigabytes, goes through the streaming path in storage.js instead.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { sealBuffer, openBuffer } from './envelope.js';
import { resolveObjectPath, ensureVault } from './storage.js';
import { Internal } from '../utils/errors.js';

const SEAL_MAGIC = Buffer.from('LEXXSEAL1', 'utf8');

/** Encrypt `plaintext` under the case's key and write it at `storageKey`. */
export async function storeSealedDocument(plaintext, caseId, storageKey) {
  const sealed = sealBuffer(plaintext, caseId);
  const header = Buffer.from(JSON.stringify(sealed.encryption), 'utf8');
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length, 0);

  await ensureVault();
  const target = resolveObjectPath(storageKey);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  // Write-then-rename, so a crash mid-write cannot leave a truncated object that
  // would later read as "this document was altered".
  const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.part`;
  try {
    await fsp.writeFile(temp, Buffer.concat([SEAL_MAGIC, headerLength, header, sealed.ciphertext]));
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw Internal('DOCUMENT_WRITE_FAILED', `Could not store the document: ${err.message}`);
  }
}

/**
 * Read a sealed document back.
 * @returns {Promise<Buffer|null>} null when the object is missing. A GCM tag failure
 *   throws rather than returning altered bytes.
 */
export async function readSealedDocument(storageKey, caseId) {
  let raw;
  try {
    raw = await fsp.readFile(resolveObjectPath(storageKey));
  } catch {
    return null;
  }

  if (raw.length < SEAL_MAGIC.length + 4 || !raw.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) {
    throw Internal('DOCUMENT_CORRUPT', 'Stored object is not a sealed Lexx document');
  }
  const headerLength = raw.readUInt32BE(SEAL_MAGIC.length);
  const headerStart = SEAL_MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > raw.length) throw Internal('DOCUMENT_CORRUPT', 'Stored document is truncated');

  const encryption = JSON.parse(raw.subarray(headerStart, headerEnd).toString('utf8'));
  return openBuffer(raw.subarray(headerEnd), encryption, caseId);
}

export default { storeSealedDocument, readSealedDocument };
