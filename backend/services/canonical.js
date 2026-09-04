/**
 * Deterministic JSON canonicalisation (ADR-007).
 *
 * The ledger hash chain is only as trustworthy as the determinism of this function.
 * Two structurally-equal payloads MUST canonicalise to byte-identical strings, on any
 * machine, in any key insertion order, forever.
 *
 * Rules:
 *  - Object keys sorted by UTF-16 code unit (JS default sort), recursively.
 *  - `undefined` and functions are omitted from objects; in arrays they become null,
 *    because array position is meaningful and must not silently shift.
 *  - Dates serialise as ISO-8601 with milliseconds (UTC).
 *  - Anything with a `toHexString` (Mongo ObjectId) or a Buffer serialises as a string.
 *  - Non-finite numbers are rejected: NaN/Infinity have no JSON representation and
 *    would silently become `null`, changing the hash of "the same" payload.
 *  - `-0` normalises to `0`.
 *  - Cycles are rejected rather than truncated.
 */
import crypto from 'node:crypto';

const isPlainish = (v) => typeof v === 'object' && v !== null;

function normalise(value, seen) {
  if (value === null) return null;

  const t = typeof value;

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJson: non-finite number cannot be canonicalised');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('canonicalJson: invalid Date cannot be canonicalised');
    }
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) return value.toString('hex');

  // Mongo ObjectId and anything else that defines a stable hex identity.
  if (typeof value.toHexString === 'function') return value.toHexString();

  if (isPlainish(value)) {
    if (seen.has(value)) throw new TypeError('canonicalJson: circular reference');
    seen.add(value);

    let out;
    if (Array.isArray(value)) {
      out = value.map((v) => {
        const n = normalise(v, seen);
        return n === undefined ? null : n;
      });
    } else {
      // Mongoose documents carry machinery we must not hash; take their plain object.
      const source =
        typeof value.toObject === 'function' ? value.toObject({ depopulate: true }) : value;

      out = {};
      for (const key of Object.keys(source).sort()) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const n = normalise(source[key], seen);
        if (n !== undefined) out[key] = n;
      }
    }

    seen.delete(value);
    return out;
  }

  return undefined;
}

/** Canonical JSON string. Stable, sorted, delimiter-safe. */
export function canonicalJson(value) {
  const normalised = normalise(value, new Set());
  return JSON.stringify(normalised === undefined ? null : normalised);
}

/** sha256 hex of the canonical form. */
export function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export default canonicalJson;
