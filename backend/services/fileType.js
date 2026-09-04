/**
 * File type allowlist and magic-byte sniffing.
 *
 * A client-declared `Content-Type` is an assertion by the uploader, so it is checked
 * against the file's actual leading bytes. Trusting the declared type is how a
 * .exe arrives labelled `image/jpeg` — and how a stored "image" later gets served
 * back to a browser as something executable.
 *
 * Detection here is deliberately narrow: only formats a case file should contain.
 * Anything unrecognised is refused rather than accepted-with-a-warning.
 */
import fs from 'node:fs';

/** What a digital exhibit is permitted to be. */
export const ALLOWED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/tiff',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'audio/mpeg',
  'audio/wav',
  'application/pdf',
  'text/plain',
  'application/zip',
]);

/** [offset, magic bytes, mime] */
const SIGNATURES = [
  [0, [0xff, 0xd8, 0xff], 'image/jpeg'],
  [0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
  [0, [0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [0, [0x25, 0x50, 0x44, 0x46], 'application/pdf'],
  [0, [0x49, 0x49, 0x2a, 0x00], 'image/tiff'],
  [0, [0x4d, 0x4d, 0x00, 0x2a], 'image/tiff'],
  [0, [0x49, 0x44, 0x33], 'audio/mpeg'],
  [0, [0xff, 0xfb], 'audio/mpeg'],
  // ZIP-based containers (also .docx/.xlsx, which we do not allow through as zip).
  [0, [0x50, 0x4b, 0x03, 0x04], 'application/zip'],
  [0, [0x50, 0x4b, 0x05, 0x06], 'application/zip'],
];

/** Container formats whose magic sits at a fixed offset after a size field. */
const OFFSET_SIGNATURES = [
  [4, [0x66, 0x74, 0x79, 0x70], 'video/mp4'], // ftyp — mp4/mov family
  [0, [0x52, 0x49, 0x46, 0x46], 'riff'], // RIFF — wav or avi, disambiguated below
];

const startsWith = (buf, offset, bytes) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/**
 * Sniff the real type from the first bytes of a file.
 * @returns {string|null} a detected mime type, or null if unrecognised
 */
export function sniffMimeType(header) {
  for (const [offset, bytes, mime] of SIGNATURES) {
    if (startsWith(header, offset, bytes)) return mime;
  }

  for (const [offset, bytes, mime] of OFFSET_SIGNATURES) {
    if (!startsWith(header, offset, bytes)) continue;

    if (mime === 'riff') {
      // 'WAVE' or 'AVI ' at byte 8.
      const tag = header.subarray(8, 12).toString('ascii');
      if (tag === 'WAVE') return 'audio/wav';
      if (tag.startsWith('AVI')) return 'video/x-msvideo';
      return null;
    }

    if (mime === 'video/mp4') {
      const brand = header.subarray(8, 12).toString('ascii');
      // QuickTime uses the same ftyp box with a 'qt  ' brand.
      return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
    }
    return mime;
  }

  return null;
}

/** Read just enough of a file to identify it. */
export async function sniffFile(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    return sniffMimeType(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** Do the sniffed and declared types agree closely enough to accept? */
export function typesAgree(declared, sniffed) {
  if (!sniffed) return false;
  if (declared === sniffed) return true;
  // mp4 and quicktime share a container; either label is acceptable for either file.
  const mp4Family = new Set(['video/mp4', 'video/quicktime']);
  if (mp4Family.has(declared) && mp4Family.has(sniffed)) return true;
  return false;
}

/**
 * Validate an uploaded file against the allowlist AND its own bytes.
 * @returns {{ok:boolean, mimeType:string|null, reason:string|null}}
 */
export async function validateUpload(filePath, declaredMime) {
  if (!ALLOWED_MIME_TYPES.includes(declaredMime)) {
    return { ok: false, mimeType: null, reason: 'MIME_TYPE_NOT_ALLOWED' };
  }

  const sniffed = await sniffFile(filePath);

  // Plain text has no magic bytes; accept it only when nothing else matched, so a
  // binary cannot be smuggled in under a text/plain label.
  if (declaredMime === 'text/plain') {
    return sniffed === null
      ? { ok: true, mimeType: 'text/plain', reason: null }
      : { ok: false, mimeType: sniffed, reason: 'MIME_TYPE_MISMATCH' };
  }

  if (!typesAgree(declaredMime, sniffed)) {
    return { ok: false, mimeType: sniffed, reason: 'MIME_TYPE_MISMATCH' };
  }

  return { ok: true, mimeType: sniffed, reason: null };
}

export default { ALLOWED_MIME_TYPES, sniffMimeType, sniffFile, validateUpload, typesAgree };
