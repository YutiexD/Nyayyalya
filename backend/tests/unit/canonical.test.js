/**
 * Canonicalisation determinism.
 *
 * If this file goes red, every hash in the system is untrustworthy — the ledger
 * chain, the anchored Merkle roots and the certificate signatures all bottom out
 * in `canonicalJson`.
 */
import { describe, it, expect } from 'vitest';
import { canonicalJson, canonicalHash } from '../../services/canonical.js';

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    const a = { zebra: 1, alpha: 2, middle: 3 };
    const b = { middle: 3, alpha: 2, zebra: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('sorts keys recursively, not just at the top level', () => {
    const a = { outer: { z: 1, a: 2 }, list: [{ y: 1, b: 2 }] };
    const b = { list: [{ b: 2, y: 1 }], outer: { a: 2, z: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order, because position is meaningful', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('distinguishes null from a missing key', () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it('omits undefined in objects but preserves array positions as null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('serialises Dates as ISO-8601 UTC', () => {
    const d = new Date('2026-09-04T10:20:30.400Z');
    expect(canonicalJson({ at: d })).toBe('{"at":"2026-09-04T10:20:30.400Z"}');
  });

  it('normalises -0 to 0 so equal numbers hash equally', () => {
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });

  it('rejects non-finite numbers rather than silently emitting null', () => {
    // JSON.stringify turns NaN into null, which would make two different payloads
    // hash identically. That must be an error, not a silent coercion.
    expect(() => canonicalJson({ n: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Infinity })).toThrow(TypeError);
  });

  it('rejects an invalid Date', () => {
    expect(() => canonicalJson({ at: new Date('nonsense') })).toThrow(TypeError);
  });

  it('rejects circular structures instead of truncating them', () => {
    const o = { a: 1 };
    o.self = o;
    expect(() => canonicalJson(o)).toThrow(/circular/i);
  });

  it('ignores prototype-polluting keys', () => {
    const evil = JSON.parse('{"__proto__":{"admin":true},"a":1}');
    expect(canonicalJson(evil)).toBe('{"a":1}');
  });

  it('is stable across unicode and escaping', () => {
    const a = { name: 'Sh. A. K. Verma — नई दिल्ली' };
    expect(canonicalJson(a)).toBe(canonicalJson({ ...a }));
    expect(canonicalHash(a)).toHaveLength(64);
  });

  it('produces a different hash for structurally different payloads', () => {
    // The delimiter-collision case: two payloads that a naive concatenation
    // would map to the same string.
    expect(canonicalHash({ a: '1', b: '23' })).not.toBe(canonicalHash({ a: '12', b: '3' }));
  });

  it('hashes deterministically across repeated calls', () => {
    const payload = { exhibit: 'EX-1', tags: ['b', 'a'], meta: { z: 1, a: { q: null } } };
    const first = canonicalHash(payload);
    for (let i = 0; i < 50; i += 1) expect(canonicalHash(payload)).toBe(first);
  });
});
