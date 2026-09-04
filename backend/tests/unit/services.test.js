/**
 * Unit tests for the pure/leaf services: jurisdiction, QR, Merkle, envelope, triage.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { computeJurisdiction, selectCourt, forensicVisitRequired } from '../../services/jurisdiction.js';
import { buildQrPayload, verifyQrPayload, signItemCode } from '../../services/qr.js';
import { merkleRoot, merkleProof, verifyProof, leafOf, hashPair } from '../../services/merkle.js';
import { generateDek, wrapDek, unwrapDek, sealBuffer, openBuffer } from '../../services/envelope.js';
import { triageEvidence } from '../../services/triage.js';
import { verifyEcdsaP256, publicKeyFingerprint } from '../../config/crypto.js';
import { COURT_TYPE, SENSITIVITY_CLASS, TRIAGE_PRIORITY, TRIAGE_DISCLAIMER } from '../../models/enums.js';

// ============================================================ jurisdiction ====

describe('jurisdiction router', () => {
  it('routes a <7-year offence to a Magistrate with no committal', () => {
    const r = computeJurisdiction({ maxPunishmentYears: 3, sensitivityClass: SENSITIVITY_CLASS.ORDINARY });
    expect(r.courtType).toBe(COURT_TYPE.MAGISTRATE);
    expect(r.requiresCommittal).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/Magistrate/);
  });

  it('routes a >=7-year offence to Sessions and requires committal', () => {
    const r = computeJurisdiction({ maxPunishmentYears: 10 });
    expect(r.courtType).toBe(COURT_TYPE.SESSIONS);
    expect(r.requiresCommittal).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/Court of Session/);
    expect(r.reasons.join(' ')).toMatch(/Committal/);
  });

  it('escalates POCSO to a designated Special court', () => {
    const r = computeJurisdiction({
      maxPunishmentYears: 20,
      sensitivityClass: SENSITIVITY_CLASS.POCSO,
      isVictimProtected: true,
    });
    expect(r.courtType).toBe(COURT_TYPE.SPECIAL);
    expect(r.requiredDesignation).toBe('POCSO');
    expect(r.reasons.join(' ')).toMatch(/minor.*POCSO/i);
  });

  it('derives victimIsMinor rather than accepting it (ADR-014)', () => {
    // isVictimProtected alone must trigger the POCSO route even when the class is ORDINARY.
    const r = computeJurisdiction({ maxPunishmentYears: 4, isVictimProtected: true });
    expect(r.requiredDesignation).toBe('POCSO');
  });

  it('escalates NDPS and SC/ST to Special courts', () => {
    expect(
      computeJurisdiction({ maxPunishmentYears: 10, sensitivityClass: SENSITIVITY_CLASS.NDPS })
        .requiredDesignation
    ).toBe('NDPS');
    expect(
      computeJurisdiction({ maxPunishmentYears: 10, sensitivityClass: SENSITIVITY_CLASS.SC_ST })
        .requiredDesignation
    ).toBe('SC_ST');
  });

  it('always explains itself', () => {
    const r = computeJurisdiction({ maxPunishmentYears: 20, bnsSections: ['103(1)', '3(5)'] });
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.join(' ')).toContain('103(1)');
  });

  it('marks forensic visits required at the 7-year threshold (BNSS s.176(3))', () => {
    expect(forensicVisitRequired(6)).toBe(false);
    expect(forensicVisitRequired(7)).toBe(true);
    expect(forensicVisitRequired(20)).toBe(true);
  });

  it('returns null when no court holds the required designation', () => {
    const courts = [{ code: 'C1', courtType: 'SESSIONS', designations: [] }];
    // Falling back to an ordinary Sessions court here would be a legal error, so
    // "no match" must surface rather than be papered over.
    expect(selectCourt(courts, { courtType: 'SPECIAL', requiredDesignation: 'POCSO' })).toBeNull();
  });

  it('selects the designated court when one exists', () => {
    const courts = [
      { code: 'C1', courtType: 'SESSIONS', designations: [] },
      { code: 'C2', courtType: 'SESSIONS', designations: ['POCSO'] },
    ];
    expect(selectCourt(courts, { courtType: 'SPECIAL', requiredDesignation: 'POCSO' }).code).toBe('C2');
  });
});

// ==================================================================== QR ======

describe('QR custody tags', () => {
  const itemCode = 'IT-0123-2026-002';

  it('round-trips a genuine tag', () => {
    const r = verifyQrPayload(buildQrPayload(itemCode));
    expect(r.valid).toBe(true);
    expect(r.itemCode).toBe(itemCode);
  });

  it('rejects a forged HMAC', () => {
    const forged = `LEXX:v1:${itemCode}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const r = verifyQrPayload(forged);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('INVALID_OR_FORGED_TAG');
  });

  it('rejects a tag whose item code was swapped under a valid MAC', () => {
    // The MAC covers the item code, so lifting a real MAC onto another item fails.
    const mac = signItemCode(itemCode);
    const r = verifyQrPayload(`LEXX:v1:IT-9999-2026-001:${mac}`);
    expect(r.valid).toBe(false);
  });

  it('rejects malformed, foreign and wrong-version payloads', () => {
    expect(verifyQrPayload('').valid).toBe(false);
    expect(verifyQrPayload('nonsense').valid).toBe(false);
    expect(verifyQrPayload(`OTHER:v1:${itemCode}:x`).reason).toBe('NOT_A_LEXX_TAG');
    expect(verifyQrPayload(`LEXX:v2:${itemCode}:x`).reason).toBe('UNSUPPORTED_TAG_VERSION');
    expect(verifyQrPayload(null).valid).toBe(false);
    expect(verifyQrPayload('a'.repeat(600)).valid).toBe(false);
  });

  it('rejects an item code with path or injection characters', () => {
    expect(verifyQrPayload('LEXX:v1:../../etc/passwd:x').valid).toBe(false);
    expect(() => buildQrPayload('IT-../evil')).toThrow();
  });
});

// ================================================================ Merkle ======

describe('Merkle tree (must match LexxAnchor.sol)', () => {
  const h = (n) => crypto.createHash('sha256').update(String(n)).digest('hex');

  it('pre-hashes leaves — the raw entryHash is not the leaf', () => {
    // This is the single convention most likely to be got wrong at the boundary.
    const entryHash = h(1);
    expect(leafOf(entryHash)).not.toBe(`0x${entryHash}`);
    expect(leafOf(entryHash)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('accepts a hash with or without the 0x prefix identically', () => {
    expect(leafOf(h(1))).toBe(leafOf(`0x${h(1)}`));
  });

  it('hashes pairs in sorted order, so argument order does not matter', () => {
    const a = leafOf(h(1));
    const b = leafOf(h(2));
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });

  it('makes root === leaf for a single-entry batch, with an empty proof', () => {
    const entries = [h(1)];
    expect(merkleRoot(entries)).toBe(leafOf(h(1)));
    expect(merkleProof(entries, 0)).toEqual([]);
  });

  it('verifies an inclusion proof for every leaf, at several tree sizes', () => {
    for (const n of [1, 2, 3, 4, 5, 8, 9, 17]) {
      const entries = Array.from({ length: n }, (_, i) => h(i));
      const root = merkleRoot(entries);
      for (let i = 0; i < n; i += 1) {
        expect(verifyProof(entries[i], merkleProof(entries, i), root)).toBe(true);
      }
    }
  });

  it('rejects a forged leaf that was never in the batch', () => {
    const entries = [h(1), h(2), h(3), h(4)];
    const root = merkleRoot(entries);
    expect(verifyProof(h(999), merkleProof(entries, 0), root)).toBe(false);
  });

  it('rejects a real leaf with a tampered proof', () => {
    const entries = [h(1), h(2), h(3), h(4)];
    const root = merkleRoot(entries);
    const proof = merkleProof(entries, 1);
    proof[0] = leafOf(h(12345));
    expect(verifyProof(entries[1], proof, root)).toBe(false);
  });

  it('changes the root when any entry changes', () => {
    const a = merkleRoot([h(1), h(2), h(3)]);
    const b = merkleRoot([h(1), h(2), h(4)]);
    expect(a).not.toBe(b);
  });

  it('does NOT commit to leaf order within a sibling pair — by design', () => {
    // Sorted-pair hashing (the OpenZeppelin convention the contract uses) makes a
    // pair commutative, so swapping two siblings yields the same root. That is not a
    // weakness here: ordering is already committed by the ledger's own hash chain,
    // because each entryHash covers its own `seq` and its predecessor's hash. The
    // Merkle tree's job is membership proof, not ordering. Asserting the opposite
    // would be asserting a property this design deliberately does not have.
    expect(merkleRoot([h(1), h(2)])).toBe(merkleRoot([h(2), h(1)]));
  });

  it('commits to the leaf SET — any substitution changes the root', () => {
    const base = merkleRoot([h(1), h(2), h(3), h(4)]);
    expect(merkleRoot([h(1), h(2), h(3), h(99)])).not.toBe(base);
    expect(merkleRoot([h(1), h(2), h(3)])).not.toBe(base);
    expect(merkleRoot([h(1), h(2), h(3), h(4), h(5)])).not.toBe(base);
  });

  it('refuses an empty tree and an out-of-range index', () => {
    expect(() => merkleRoot([])).toThrow();
    expect(() => merkleProof([h(1)], 5)).toThrow();
  });

  it('rejects a malformed ledger hash', () => {
    expect(() => leafOf('not-a-hash')).toThrow();
    expect(() => leafOf('abc')).toThrow();
  });
});

// ============================================================== envelope ======

describe('envelope encryption', () => {
  const caseA = '507f1f77bcf86cd799439011';
  const caseB = '507f1f77bcf86cd799439012';

  it('wraps and unwraps a DEK for the same case', () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, caseA);
    expect(unwrapDek(wrapped, caseA).equals(dek)).toBe(true);
  });

  it('refuses to unwrap a DEK lifted into a different case', () => {
    // The case id is bound in as AAD, so a record moved between cases fails loudly
    // instead of quietly decrypting under the wrong key.
    const wrapped = wrapDek(generateDek(), caseA);
    expect(() => unwrapDek(wrapped, caseB)).toThrow(/unwrap/i);
  });

  it('round-trips a sealed buffer', () => {
    const plaintext = Buffer.from('witness statement, page 1');
    const { ciphertext, encryption } = sealBuffer(plaintext, caseA);
    expect(ciphertext.equals(plaintext)).toBe(false);
    expect(openBuffer(ciphertext, encryption, caseA).equals(plaintext)).toBe(true);
  });

  it('detects tampered ciphertext via the GCM auth tag', () => {
    const { ciphertext, encryption } = sealBuffer(Buffer.from('original'), caseA);
    ciphertext[0] ^= 0xff;
    expect(() => openBuffer(ciphertext, encryption, caseA)).toThrow();
  });

  it('detects a tampered IV', () => {
    const { ciphertext, encryption } = sealBuffer(Buffer.from('original'), caseA);
    const badIv = Buffer.from(encryption.iv, 'base64');
    badIv[0] ^= 0xff;
    expect(() =>
      openBuffer(ciphertext, { ...encryption, iv: badIv.toString('base64') }, caseA)
    ).toThrow();
  });

  it('uses a fresh IV per operation (GCM key+IV reuse is catastrophic)', () => {
    const ivs = new Set();
    for (let i = 0; i < 50; i += 1) ivs.add(sealBuffer(Buffer.from('same'), caseA).encryption.iv);
    expect(ivs.size).toBe(50);
  });

  it('produces different ciphertext for identical plaintext', () => {
    const a = sealBuffer(Buffer.from('same'), caseA).ciphertext.toString('base64');
    const b = sealBuffer(Buffer.from('same'), caseA).ciphertext.toString('base64');
    expect(a).not.toBe(b);
  });
});

// ================================================================ triage ======

describe('AI triage (review prioritisation only)', () => {
  it('returns LOW with no indicators for clean metadata', () => {
    const r = triageEvidence({
      mimeType: 'image/jpeg',
      sizeBytes: 2_400_000,
      metadata: { dateTimeOriginal: '2026-01-01T00:00:00Z', make: 'Samsung', model: 'A54', hasC2PA: true },
    });
    expect(r.priority).toBe(TRIAGE_PRIORITY.LOW);
    expect(r.indicators).toEqual([]);
  });

  it('raises priority as indicators accumulate', () => {
    const r = triageEvidence({ mimeType: 'image/jpeg', sizeBytes: 1000, metadata: {} });
    expect(r.priority).toBe(TRIAGE_PRIORITY.HIGH);
    expect(r.indicators.length).toBeGreaterThanOrEqual(3);
  });

  it('flags an editing software tag', () => {
    const r = triageEvidence({
      mimeType: 'image/jpeg',
      sizeBytes: 500_000,
      metadata: { dateTimeOriginal: 'x', make: 'A', model: 'B', hasC2PA: true, software: 'Adobe Photoshop 25.0' },
    });
    expect(r.indicators).toContain('Editing software tag present');
  });

  it('flags a container/stream duration mismatch', () => {
    const r = triageEvidence({
      mimeType: 'video/mp4',
      sizeBytes: 10_000_000,
      metadata: { dateTimeOriginal: 'x', make: 'A', model: 'B', hasC2PA: true, containerDurationSec: 30, streamDurationSec: 12 },
    });
    expect(r.indicators).toContain('Container and stream duration mismatch');
  });

  it('always carries the statutory disclaimer', () => {
    const r = triageEvidence({ mimeType: 'image/jpeg', sizeBytes: 1 });
    expect(r.disclaimer).toBe(TRIAGE_DISCLAIMER);
    expect(r.disclaimer).toMatch(/Not expert opinion/i);
  });

  it('NEVER emits a score, percentage, confidence or verdict', () => {
    // The compliance boundary, asserted mechanically rather than by convention.
    const r = triageEvidence({ mimeType: 'image/jpeg', sizeBytes: 1000, metadata: {} });
    const keys = Object.keys(r);
    expect(keys).not.toContain('score');
    expect(keys).not.toContain('confidence');
    expect(keys).not.toContain('percentage');
    expect(keys).not.toContain('opinion');
    expect(keys).not.toContain('authentic');

    const serialised = JSON.stringify(r).toUpperCase();
    expect(serialised).not.toMatch(/AUTHENTIC/);
    expect(serialised).not.toMatch(/MANIPULATED/);
    expect(serialised).not.toMatch(/VERIFIED/);
    // No bare percentage figures anywhere in the output.
    expect(serialised).not.toMatch(/\d+(\.\d+)?%/);
  });

  it('only ever returns HIGH, MEDIUM or LOW', () => {
    for (const n of [0, 1, 2, 3, 6]) {
      const meta = n === 0 ? { dateTimeOriginal: 'x', make: 'A', model: 'B', hasC2PA: true } : {};
      const r = triageEvidence({ mimeType: 'image/jpeg', sizeBytes: 500_000, metadata: meta });
      expect(Object.values(TRIAGE_PRIORITY)).toContain(r.priority);
    }
  });
});

// ======================================================== ECDSA verification ==

describe('ECDSA P-256 signature verification', () => {
  /** Mirrors what the browser's Web Crypto does: P1363 (r||s) over the hex string. */
  const makeKeyPair = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    return { jwk, privateKey };
  };
  const sign = (privateKey, message) =>
    crypto
      .sign('sha256', Buffer.from(message, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' })
      .toString('hex');

  it('accepts a genuine signature', () => {
    const { jwk, privateKey } = makeKeyPair();
    const hash = crypto.createHash('sha256').update('file bytes').digest('hex');
    expect(verifyEcdsaP256(jwk, sign(privateKey, hash), hash)).toBe(true);
  });

  it('rejects a signature over a different message', () => {
    const { jwk, privateKey } = makeKeyPair();
    expect(verifyEcdsaP256(jwk, sign(privateKey, 'hash-a'), 'hash-b')).toBe(false);
  });

  it("rejects another key's signature", () => {
    const a = makeKeyPair();
    const b = makeKeyPair();
    expect(verifyEcdsaP256(a.jwk, sign(b.privateKey, 'msg'), 'msg')).toBe(false);
  });

  it('rejects a DER-encoded signature where P1363 is required', () => {
    // Accepting both encodings is how signature-verification bypasses creep in.
    const { jwk, privateKey } = makeKeyPair();
    const der = crypto
      .sign('sha256', Buffer.from('msg', 'utf8'), { key: privateKey, dsaEncoding: 'der' })
      .toString('hex');
    expect(verifyEcdsaP256(jwk, der, 'msg')).toBe(false);
  });

  it('rejects malformed keys, wrong curves and junk signatures without throwing', () => {
    const { jwk } = makeKeyPair();
    expect(verifyEcdsaP256(null, 'aa', 'm')).toBe(false);
    expect(verifyEcdsaP256({ kty: 'RSA' }, 'aa', 'm')).toBe(false);
    expect(verifyEcdsaP256({ ...jwk, crv: 'P-384' }, 'aa', 'm')).toBe(false);
    expect(verifyEcdsaP256(jwk, 'not-hex!!', 'm')).toBe(false);
    expect(verifyEcdsaP256(jwk, '', 'm')).toBe(false);
    expect(verifyEcdsaP256(jwk, 'ab'.repeat(10), 'm')).toBe(false); // wrong length
  });

  it('fingerprints a public key stably', () => {
    const { jwk } = makeKeyPair();
    expect(publicKeyFingerprint(jwk)).toBe(publicKeyFingerprint({ ...jwk }));
    expect(publicKeyFingerprint(jwk)).toHaveLength(64);
  });
});
