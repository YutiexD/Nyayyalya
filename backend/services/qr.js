/**
 * QR payloads for physical custody labels.
 *
 * Format:  LEXX:v1:<itemCode>:<base64url HMAC-SHA256(itemCode, QR_SECRET)>
 *
 * # What a valid QR proves, and what it does not (ADR-011)
 *
 * A verifying HMAC proves the LABEL was issued by Lexx. It proves nothing about who
 * is holding it. The HMAC is static per item, so anyone who photographs a printed tag
 * can reproduce it indefinitely.
 *
 * Therefore a scan is IDENTIFICATION ONLY. Every custody action it leads to still
 * goes through `accessResolver`, and the UI says "this label is genuine" rather than
 * anything that could be read as "this person may move the item". Treating a scan as
 * authorization would make custody transfer forgeable by anyone who has seen the tag.
 */
import env from '../config/env.js';
import { hmacSha256, timingSafeEqualStr } from '../config/crypto.js';
import { BadRequest } from '../utils/errors.js';

const PREFIX = 'LEXX';
const VERSION = 'v1';

/** Item codes are server-generated; this is the shape they always take. */
const ITEM_CODE_PATTERN = /^IT-[A-Za-z0-9-]{1,48}$/;

export const signItemCode = (itemCode) => hmacSha256(env.QR_SECRET, itemCode, 'base64url');

/** Build the payload printed on a label. */
export function buildQrPayload(itemCode) {
  if (!ITEM_CODE_PATTERN.test(itemCode)) {
    throw BadRequest('INVALID_ITEM_CODE', 'Malformed item code');
  }
  return `${PREFIX}:${VERSION}:${itemCode}:${signItemCode(itemCode)}`;
}

/**
 * Parse and verify a scanned payload.
 *
 * @returns {{valid:boolean, itemCode:string|null, reason:string|null}}
 *   `valid` means the tag is authentic. It does NOT mean the scanner may act on it.
 */
export function verifyQrPayload(payload) {
  if (typeof payload !== 'string' || payload.length > 512) {
    return { valid: false, itemCode: null, reason: 'MALFORMED_PAYLOAD' };
  }

  const parts = payload.split(':');
  if (parts.length !== 4) return { valid: false, itemCode: null, reason: 'MALFORMED_PAYLOAD' };

  const [prefix, version, itemCode, mac] = parts;
  if (prefix !== PREFIX) return { valid: false, itemCode: null, reason: 'NOT_A_LEXX_TAG' };
  if (version !== VERSION) return { valid: false, itemCode: null, reason: 'UNSUPPORTED_TAG_VERSION' };
  if (!ITEM_CODE_PATTERN.test(itemCode)) {
    return { valid: false, itemCode: null, reason: 'MALFORMED_PAYLOAD' };
  }

  // Constant-time comparison: a byte-by-byte early exit would leak the expected MAC
  // to anyone willing to time enough requests.
  if (!timingSafeEqualStr(mac, signItemCode(itemCode))) {
    return { valid: false, itemCode: null, reason: 'INVALID_OR_FORGED_TAG' };
  }

  return { valid: true, itemCode, reason: null };
}

export default { buildQrPayload, verifyQrPayload, signItemCode };
