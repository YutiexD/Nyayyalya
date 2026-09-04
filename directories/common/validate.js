/**
 * Input validation for the directory services.
 *
 * Two jobs, in this order:
 *
 *   1. TYPE.  Anything that reaches a Mongo query filter must be a primitive string.
 *             Express's extended query parser turns `?enrolmentNo[$ne]=x` into the
 *             OBJECT `{ $ne: 'x' }` and `?a=1&a=2` into an ARRAY. Dropping either
 *             straight into `{ enrolmentNo: value }` hands the attacker a query
 *             operator. Every value is therefore type-checked here and rejected
 *             with 400 BEFORE it can be used in a filter.
 *
 *   2. SHAPE. Identifiers are matched against an explicit anchored pattern. A value
 *             that does not look like the identifier it claims to be is rejected
 *             with 400 without touching the database at all.
 *
 * Nothing in this module ever builds a query from unvalidated input.
 */
import { BadRequest } from './errors.js';

/** Anchored identifier patterns. Deliberately narrow. */
export const PATTERNS = {
  // UP-GZB-4471 · FSL-LKO-0091 · UP-JUD-2291 · UP-GZB-REG-01 · UP-GZB-SESS-02
  DASHED_CODE: /^[A-Z0-9]{2,10}(?:-[A-Z0-9]{1,10}){1,4}$/,
  // 0123/2026
  FIR_NUMBER: /^\d{1,7}\/\d{4}$/,
  // UP/1234/2015
  ENROLMENT_NO: /^[A-Z]{1,4}\/\d{1,7}\/\d{4}$/,
  // UPGB010012342026
  CNR_NUMBER: /^[A-Z]{2}[A-Z0-9]{2}\d{12}$/,
  // UP-GZB
  DISTRICT_CODE: /^[A-Z]{2}-[A-Z0-9]{2,6}$/,
  // Mongo ObjectId
  OBJECT_ID: /^[a-f0-9]{24}$/i,
  // GZB/POST/2026/1187 · PDJ/GZB/ROSTER/2026-27 · SC/GZB/341/2026/44 · MeitY/79A/2019/17
  ORDER_REF: /^[A-Za-z0-9][A-Za-z0-9/._-]{2,63}$/,
  // +919812345671
  PHONE: /^\+?[0-9]{10,15}$/,
};

const MAX_PARAM_LENGTH = 64;

/**
 * Narrow an incoming request value to a plain, bounded string.
 * This is the operator-injection guard: non-strings never get past this line.
 *
 * @param {unknown} value raw value from req.params / req.query / req.body
 * @param {string}  field field name, used in the error message only
 * @returns {string}
 */
export function scalarString(value, field) {
  if (typeof value !== 'string') {
    // Object (`?x[$ne]=y`), array (`?x=1&x=2`), number, null — all rejected.
    throw BadRequest(
      'INVALID_PARAMETER',
      `Parameter "${field}" must be a single string value.`
    );
  }
  if (value.length === 0 || value.length > MAX_PARAM_LENGTH) {
    throw BadRequest(
      'INVALID_PARAMETER',
      `Parameter "${field}" must be between 1 and ${MAX_PARAM_LENGTH} characters.`
    );
  }
  return value;
}

/**
 * Validate a required identifier: must be a string, must match the pattern.
 * Returns the uppercased, trimmed value — directories store identifiers uppercase.
 *
 * @param {unknown} value
 * @param {string}  field
 * @param {RegExp}  pattern
 * @param {{ upper?: boolean }} [opts]
 */
export function identifier(value, field, pattern, opts = {}) {
  const raw = scalarString(value, field).trim();
  const normalised = opts.upper === false ? raw : raw.toUpperCase();
  if (!pattern.test(normalised)) {
    throw BadRequest('INVALID_IDENTIFIER', `Parameter "${field}" is not a valid identifier.`);
  }
  return normalised;
}

/**
 * Validate an optional query identifier. Returns undefined when the key is absent.
 * An absent key is fine; a present-but-wrong-type key is still a 400.
 */
export function optionalIdentifier(value, field, pattern, opts = {}) {
  if (value === undefined) return undefined;
  return identifier(value, field, pattern, opts);
}

/** Bounded integer from a query string, with a default and a hard ceiling. */
export function boundedInt(value, field, { def, min = 1, max = 200 }) {
  if (value === undefined) return def;
  const raw = scalarString(value, field);
  if (!/^\d{1,6}$/.test(raw)) {
    throw BadRequest('INVALID_PARAMETER', `Parameter "${field}" must be a positive integer.`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw BadRequest('INVALID_PARAMETER', `Parameter "${field}" must be between ${min} and ${max}.`);
  }
  return n;
}

/** One of a fixed set of literals. */
export function enumValue(value, field, allowed) {
  const raw = scalarString(value, field).trim().toUpperCase();
  if (!allowed.includes(raw)) {
    throw BadRequest('INVALID_PARAMETER', `Parameter "${field}" must be one of: ${allowed.join(', ')}.`);
  }
  return raw;
}

export function optionalEnumValue(value, field, allowed) {
  if (value === undefined) return undefined;
  return enumValue(value, field, allowed);
}

/**
 * Free text from a request body (party names and the like). Strings only,
 * bounded, and never used as a query filter.
 */
export function freeText(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') {
    throw BadRequest('INVALID_PARAMETER', `Field "${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw BadRequest(
      'INVALID_PARAMETER',
      `Field "${field}" must be between ${min} and ${max} characters.`
    );
  }
  return trimmed;
}

/** Reject a request body that is not a plain JSON object. */
export function objectBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw BadRequest('INVALID_BODY', 'Request body must be a JSON object.');
  }
  return body;
}

/**
 * Reassemble an identifier that contains slashes and therefore arrives split
 * across path segments (FIR `0123/2026`, enrolment `UP/1234/2015`).
 *
 * Callers may also percent-encode the slashes and use the single-segment route;
 * both forms are supported and normalise to the same value.
 */
export function joinSegments(params, keys) {
  return keys.map((k) => scalarString(params[k], k)).join('/');
}
