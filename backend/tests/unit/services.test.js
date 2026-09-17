/**
 * Unit tests for the pure/leaf services: jurisdiction, QR, Merkle, envelope, the Gemini
 * analysis validator and the case state machine.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { computeJurisdiction, selectCourt, forensicVisitRequired } from '../../services/jurisdiction.js';
import { buildQrPayload, verifyQrPayload, signItemCode } from '../../services/qr.js';
import { merkleRoot, merkleProof, verifyProof, leafOf, hashPair } from '../../services/merkle.js';
import { generateDek, wrapDek, unwrapDek, sealBuffer, openBuffer } from '../../services/envelope.js';
import { validateAnalysis, RESPONSE_SCHEMA } from '../../services/ai/analysisSchema.js';
import { seesAiAnalysis, aiAnalysisView, aiAnalysisFor } from '../../services/ai/visibility.js';
import { AI_ERROR, neutralText, parseRetryAfterMs } from '../../services/ai/geminiClient.js';
import { retryDelayMs, MAX_HONOURED_RETRY_AFTER_MS } from '../../services/ai/analysisService.js';
import { AI_DISCLAIMER, TRIAGE_UI_LABEL } from '../../models/enums.js';
import { evaluateTransition, workflowFor, requiresCommittal } from '../../services/caseWorkflow.js';
import { verifyEcdsaP256, publicKeyFingerprint } from '../../config/crypto.js';
import {
  COURT_TYPE,
  SENSITIVITY_CLASS,
  TRIAGE_PRIORITY_ORDER,
} from '../../models/enums.js';

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

// ================================================== Gemini analysis validation ====

const validAnalysis = () => ({
  deepfakeAssessment: 'LIKELY_MANIPULATED',
  deepfakeScore: 81,
  analysisDescription:
    'Lip movement drifts out of sync with the audio from 00:07, and the jawline blurs on each head turn.',
  detectedIndicators: ['Audio-visual desynchronisation from 00:07', 'Boundary blur along the jawline'],
  triagePriority: 'HIGH',
  priorityReason: 'Strong face-swap indicators on an exhibit in a grave case.',
  fslReviewRecommended: true,
  fslReviewReason: 'Frame-level examination is needed to confirm the splice.',
  evidenceSummary: 'A short handheld video of two people talking indoors.',
});

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code ?? 'THREW';
  }
};

describe('Gemini analysis validation — the backend accepts or refuses, and never derives', () => {
  it('accepts a well-formed, coherent analysis unchanged', () => {
    const a = validAnalysis();
    expect(validateAnalysis(a)).toEqual(a);
  });

  it('asks Gemini for exactly the controlled priority vocabulary', () => {
    expect(RESPONSE_SCHEMA.properties.triagePriority.enum).toEqual([...TRIAGE_PRIORITY_ORDER]);
  });

  it('refuses anything outside the schema', () => {
    for (const bad of [
      { triagePriority: 'URGENT' },
      { triagePriority: 'high' },
      { deepfakeScore: 150 },
      { deepfakeScore: -1 },
      { deepfakeScore: 55.5 },
      { deepfakeAssessment: 'FAKE' },
      { analysisDescription: '' },
      { analysisDescription: 'too short' },
      { detectedIndicators: 'one indicator' },
      { fslReviewRecommended: 'yes' },
      { priorityReason: undefined },
    ]) {
      expect(codeOf(() => validateAnalysis({ ...validAnalysis(), ...bad })), JSON.stringify(bad)).toBe(
        'AI_RESPONSE_SCHEMA_INVALID'
      );
    }
  });

  it('refuses an analysis that contradicts itself', () => {
    for (const bad of [
      { deepfakeAssessment: 'LIKELY_MANIPULATED', deepfakeScore: 20 },
      { deepfakeAssessment: 'LIKELY_AUTHENTIC', deepfakeScore: 90 },
      { deepfakeAssessment: 'LIKELY_MANIPULATED', detectedIndicators: [] },
      { fslReviewRecommended: true, fslReviewReason: '' },
    ]) {
      expect(codeOf(() => validateAnalysis({ ...validAnalysis(), ...bad })), JSON.stringify(bad)).toBe(
        'AI_RESPONSE_INCOHERENT'
      );
    }
  });

  it('never ties the priority to the score — a LOW priority on a high inconclusive score is accepted as given', () => {
    const a = { ...validAnalysis(), deepfakeAssessment: 'INCONCLUSIVE', deepfakeScore: 88, triagePriority: 'LOW' };
    expect(validateAnalysis(a).triagePriority).toBe('LOW');
    const b = { ...validAnalysis(), deepfakeScore: 51, triagePriority: 'CRITICAL' };
    expect(validateAnalysis(b).triagePriority).toBe('CRITICAL');
  });
});

// ============================================ rate limits: Retry-After, backoff ====

describe('a rate-limited analysis waits as asked, and backs off otherwise', () => {
  it('reads Retry-After as seconds, as an HTTP date, and from a RetryInfo detail', () => {
    expect(parseRetryAfterMs('7')).toBe(7000);
    const now = Date.parse('2026-09-13T10:00:00Z');
    expect(parseRetryAfterMs('Sun, 13 Sep 2026 10:00:30 GMT', null, now)).toBe(30_000);
    expect(
      parseRetryAfterMs(null, {
        error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.5s' }] },
      })
    ).toBe(12_500);
    expect(parseRetryAfterMs(null, { error: {} })).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });

  it('honours a Retry-After exactly, with only a little jitter on top', () => {
    const err = { code: AI_ERROR.RATE_LIMITED, retryAfterMs: 5000 };
    expect(retryDelayMs(err, 0, { random: () => 0 })).toBe(5000);
    const most = retryDelayMs(err, 3, { random: () => 0.999 });
    expect(most).toBeGreaterThanOrEqual(5000);
    expect(most).toBeLessThanOrEqual(5500);
  });

  it('does not wait out a Retry-After longer than it honours', () => {
    expect(retryDelayMs({ code: AI_ERROR.RATE_LIMITED, retryAfterMs: MAX_HONOURED_RETRY_AFTER_MS + 1 }, 0)).toBeNull();
  });

  it('otherwise backs off exponentially with jitter — from four times the base for a 429', () => {
    const base = 1000;
    const limited = { code: AI_ERROR.RATE_LIMITED };
    for (const n of [0, 1, 2]) {
      const step = base * 4 * 2 ** n;
      expect(retryDelayMs(limited, n, { base, random: () => 0 })).toBe(step / 2);
      const top = retryDelayMs(limited, n, { base, random: () => 0.9999 });
      expect(top).toBeGreaterThan(step / 2);
      expect(top).toBeLessThan(step);
    }
    expect(retryDelayMs({ code: AI_ERROR.UNAVAILABLE }, 0, { base, random: () => 0 })).toBe(500);
    expect(retryDelayMs(limited, 12, { base, random: () => 0.9999 })).toBeLessThanOrEqual(60_000);
  });
});

// ================================================= AI visibility and naming ====

describe('the AI analysis is the laboratory’s, and names no provider', () => {
  it('is visible to an FSL session only', () => {
    expect(seesAiAnalysis({ authority: 'FSL' })).toBe(true);
    for (const authority of ['POLICE', 'COURT', 'LEGAL']) expect(seesAiAnalysis({ authority })).toBe(false);
    expect(seesAiAnalysis(null)).toBe(false);
    expect(aiAnalysisFor({ authority: 'POLICE' }, { status: 'COMPLETED' })).toBeUndefined();
  });

  it('drops provider and model, and neutralises stored provider names and codes', () => {
    const view = aiAnalysisView({
      status: 'FAILED',
      provider: 'GEMINI',
      model: 'gemini-2.5-flash',
      disclaimer: 'Automated preliminary assessment generated by Gemini.',
      error: { code: 'GEMINI_RATE_LIMITED', message: 'Gemini answered HTTP 429', retryable: true, issues: [] },
      // A record written while the online-source check existed. It is not carried forward.
      onlineSource: { status: 'FOUND_ONLINE', summary: 'Found via Google Search.' },
    });
    expect(view).not.toHaveProperty('provider');
    expect(view).not.toHaveProperty('model');
    expect(view.error.code).toBe('AI_RATE_LIMITED');
    expect(view).not.toHaveProperty('onlineSource');
    expect(JSON.stringify(view)).not.toMatch(/gemini|google/i);
    expect(view.error.message).toBe('the AI service answered HTTP 429');
  });

  it('labels and disclaims without naming the provider, and uses AI_* codes', () => {
    expect(TRIAGE_UI_LABEL).toBe('Review priority (AI)');
    expect(AI_DISCLAIMER).not.toMatch(/gemini|google/i);
    expect(AI_DISCLAIMER).toMatch(/not expert opinion under BSA s\.39/);
    for (const code of Object.values(AI_ERROR)) expect(code).toMatch(/^AI_/);
    expect(neutralText('Gemini returned an analysis')).toBe('the AI service returned an analysis');
  });
});

// ======================================================== case state machine ====

const magistrateCase = (stage, extra = {}) => ({
  stage,
  bnsSections: ['303(2)'],
  maxPunishmentYears: 3,
  sensitivityClass: 'ORDINARY',
  districtCode: 'UP-GZB',
  courtId: 'UP-GZB-CJM-01',
  cnrNumber: 'UPGB010012362026',
  ...extra,
});
const sessionsCase = (stage, extra = {}) =>
  magistrateCase(stage, { maxPunishmentYears: 20, sensitivityClass: 'POCSO', courtId: 'UP-GZB-SESS-02', ...extra });

describe('case state machine', () => {
  it('knows which cases need committal from the FIR facts alone', () => {
    expect(requiresCommittal(magistrateCase('CHARGESHEET_FILED'))).toBe(false);
    expect(requiresCommittal(sessionsCase('CHARGESHEET_FILED'))).toBe(true);
  });

  it('lets the court take cognizance only of a filed chargesheet that is listed before it', () => {
    expect(evaluateTransition(magistrateCase('CHARGESHEET_FILED'), 'TAKE_COGNIZANCE').ok).toBe(true);
    expect(evaluateTransition(magistrateCase('UNDER_INVESTIGATION', { courtId: null, cnrNumber: null }), 'TAKE_COGNIZANCE').code).toBe(
      'INVALID_TRANSITION'
    );
    expect(evaluateTransition(magistrateCase('CHARGESHEET_FILED', { courtId: null }), 'TAKE_COGNIZANCE').code).toBe(
      'CASE_NOT_LISTED'
    );
  });

  it('applies committal only to Sessions-triable cases', () => {
    expect(evaluateTransition(magistrateCase('COGNIZANCE_TAKEN'), 'COMMIT_FOR_TRIAL').code).toBe('TRANSITION_NOT_APPLICABLE');
    expect(evaluateTransition(sessionsCase('COGNIZANCE_TAKEN'), 'COMMIT_FOR_TRIAL').ok).toBe(true);
  });

  it('begins trial after committal, or straight after cognizance when there is none', () => {
    expect(evaluateTransition(magistrateCase('COGNIZANCE_TAKEN'), 'BEGIN_TRIAL').ok).toBe(true);
    expect(evaluateTransition(sessionsCase('COGNIZANCE_TAKEN'), 'BEGIN_TRIAL').code).toBe('INVALID_TRANSITION');
    expect(evaluateTransition(sessionsCase('COMMITTED'), 'BEGIN_TRIAL').ok).toBe(true);
  });

  it('refuses to close a case the court has not taken up, or one already closed', () => {
    expect(evaluateTransition(magistrateCase('CHARGESHEET_FILED'), 'CLOSE_CASE').code).toBe('INVALID_TRANSITION');
    expect(evaluateTransition(magistrateCase('TRIAL'), 'CLOSE_CASE').ok).toBe(true);
    expect(evaluateTransition(magistrateCase('CLOSED'), 'CLOSE_CASE').code).toBe('CASE_IS_CLOSED');
  });

  it('requires a recorded reason for further investigation and for closure', () => {
    expect(evaluateTransition(magistrateCase('COGNIZANCE_TAKEN'), 'DIRECT_FURTHER_INVESTIGATION').requiresNote).toBe(true);
    expect(evaluateTransition(magistrateCase('TRIAL'), 'CLOSE_CASE').requiresNote).toBe(true);
    expect(evaluateTransition(magistrateCase('CHARGESHEET_FILED'), 'TAKE_COGNIZANCE').requiresNote).toBe(false);
  });

  it('names the next act and who performs it', () => {
    const open = workflowFor(magistrateCase('UNDER_INVESTIGATION', { courtId: null, cnrNumber: null }));
    expect(open.nextPoliceAction.action).toBe('FILE_CHARGESHEET');
    expect(open.nextCourtAction).toBeNull();
    expect(open.waitingOn).toBe('POLICE');

    const filed = workflowFor(magistrateCase('CHARGESHEET_FILED'));
    expect(filed.nextCourtAction.action).toBe('TAKE_COGNIZANCE');
    expect(filed.waitingOn).toBe('COURT');
    expect(filed.lifecycle.find((x) => x.stage === 'COMMITTED').state).toBe('not_applicable');

    const closed = workflowFor(magistrateCase('CLOSED'));
    expect(closed.nextCourtAction).toBeNull();
    expect(closed.waitingOn).toBeNull();
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
