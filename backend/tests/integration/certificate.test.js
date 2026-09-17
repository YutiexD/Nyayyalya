/**
 * BSA s.63 certificates — issued, signed and verified by the system.
 *
 * The claims under test:
 *
 *   1. Uploading evidence is all the police do. The certificate is issued and signed by
 *      the LEXX Certificate Authority automatically — exactly one per exhibit — even
 *      when no device particulars were recorded.
 *   2. There is no way to generate or sign a certificate by hand.
 *   3. One click verifies everything server-side and answers VERIFIED or FAILED with
 *      plain-language checks, and the failing check is the right one after tampering.
 *   4. Verification is independent of any forensic verdict.
 *   5. The public verifier returns the same result and never discloses contents.
 *   6. Existing exhibits are brought over by the boot migration, idempotently.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Certificate } from '../../models/Certificate.js';
import { Evidence } from '../../models/Evidence.js';
import { Referral } from '../../models/Referral.js';
import { Ledger } from '../../models/Ledger.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { createApp } from '../../app.js';
import { readCertificatePdf } from '../../services/certificatePdf.js';
import { resolveObjectPath } from '../../services/storage.js';
import { ensureSystemCertificate } from '../../services/certificateIssuer.js';
import { runMigrations } from '../../services/migrations.js';
import { sha256Hex as hashOf } from '../../config/crypto.js';
import { asUser, sha256Hex } from '../helpers/client.js';
import {
  DECISION,
  DENY_REASON,
  FORENSIC_OPINION,
  FORENSIC_STATUS,
  FSL_DISCIPLINE,
  LEDGER_EVENT,
  REFERRAL_STATUS,
} from '../../models/enums.js';

let mongo;
let server;

const IO = 'UP-GZB-4471';
const JUDGE = 'UP-JUD-2291';
const SHO = 'UP-GZB-4402';
const EXAMINER = 'FSL-LKO-0091';
const ADVOCATE_NOT_ON_RECORD = 'UP/9876/2019';

const FIR = '0123/2026';
const LAB = 'UP-FSL-LKO';

const PER_TEST_COLLECTIONS = [
  'cases',
  'evidence',
  'disclosure_packs',
  'case_access_grants',
  'certificates',
  'referrals',
  'custody_items',
  'ledger',
  'counters',
  'audit_events',
  'anchor_batches',
  'stream_tokens',
];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const quiet = { info() {}, warn() {}, error() {} };

const FULL_DEVICE = Object.freeze({
  sourceType: 'MOBILE',
  make: 'Samsung',
  model: 'Galaxy A54',
  colour: 'Black',
  serialNumber: 'R58N90ABCDE',
  imeiOrUid: '351756051523999',
});

const CHECK_KEYS = [
  'documentUnchanged',
  'systemSignatureValid',
  'evidenceFileUnchanged',
  'activeCertificate',
  'ledgerRecordIntact',
];

let io;
let judge;
let sho;
let examiner;
let stranger;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_certificate', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();

  io = await asUser(server, IO);
  judge = await asUser(server, JUDGE);
  sho = await asUser(server, SHO);
  examiner = await asUser(server, EXAMINER);
  stranger = await asUser(server, ADVOCATE_NOT_ON_RECORD);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(
    PER_TEST_COLLECTIONS.map((name) => mongoose.connection.collection(name).deleteMany({}).catch(() => {}))
  );
});

// ---------------------------------------------------------------- helpers ----

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function createCase() {
  const res = await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber: FIR });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.case;
}

/** Upload as the browser does: only what is given is sent. File + title is enough. */
async function uploadExhibit(caseId, title, fields = {}) {
  const bytes = Buffer.concat([PNG, Buffer.from(`${title}:${crypto.randomUUID()}`.padEnd(96, '.'), 'utf8')]);
  const sha = sha256Hex(bytes);
  let req = as(io, request(server).post('/api/evidence/upload'))
    .field('caseId', String(caseId))
    .field('title', title)
    .field('sha256Client', sha)
    .field('signature', io.keys.sign(sha));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) req = req.field(key, String(value));
  }
  const res = await req.attach('file', bytes, { filename: 'exhibit.png', contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function fixture(fields = {}) {
  const caseDoc = await createCase();
  const upload = await uploadExhibit(caseDoc._id, 'Seized phone photo', fields);
  return { caseDoc, evidence: upload.evidence, upload, certificateId: upload.certificate?.certificateId };
}

const verify = (session, certificateId, method = 'post') =>
  as(session, request(server)[method](`/api/certificates/${certificateId}/verify`));

const checkOf = (body, key) => body.checks.find((c) => c.key === key);

async function tamperVaultObject(evidenceId) {
  const stored = await Evidence.findById(evidenceId).lean();
  fs.appendFileSync(resolveObjectPath(stored.storageKey), 'x');
}

async function tamperStoredPdf(certificateId) {
  const stored = await Certificate.findById(certificateId).lean();
  fs.appendFileSync(resolveObjectPath(stored.pdfKey), 'x');
}

/** A laboratory verdict recorded against the exhibit, written directly. */
async function recordForensicVerdict(caseDoc, evidence, opinion) {
  await Referral.create({
    caseId: caseDoc._id,
    evidenceId: evidence._id,
    exhibitCode: evidence.exhibitCode,
    labId: LAB,
    labName: 'State FSL, Lucknow',
    section79ARef: 'MeitY/79A/2019/17',
    discipline: FSL_DISCIPLINE.MEDIA_FORENSICS,
    questionsPosed: 'Is the recording an unaltered original?',
    referredByUserId: sho.user.userId,
    status: REFERRAL_STATUS.REPORTED,
  });
  await Evidence.updateOne(
    { _id: evidence._id },
    {
      $set: {
        forensic: {
          status: FORENSIC_STATUS.REPORT_FILED,
          labId: LAB,
          labName: 'State FSL, Lucknow',
          section79ARef: 'MeitY/79A/2019/17',
          examinerUserId: examiner.user.userId,
          examinerName: examiner.user.name,
          reportSha256: hashOf('fsl-report-bytes'),
          opinion,
          examinationSummary: 'Frame-level examination found a splice at 00:12.',
          reportedAt: new Date(),
        },
      },
    }
  );
}

// ================================================= 1. AUTOMATIC ISSUE ========

describe('the certificate is issued automatically on upload', () => {
  it('creates exactly one signed certificate even when no device particulars were recorded', async () => {
    const { evidence, upload } = await fixture(); // file + title only

    expect(upload.certificate).toBeTruthy();
    expect(upload.certificate.status).toBe('ACTIVE');
    expect(upload.certificate.state).toBe('ISSUED');
    expect(upload.certificate.issuedAt).toBeTruthy();
    expect(upload.certificate.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(upload.certificate.verificationUrl).pathname).toBe('/verify');

    const all = await Certificate.find({ evidenceId: evidence._id }).lean();
    expect(all).toHaveLength(1);
    const [cert] = all;
    expect(String(cert._id)).toBe(upload.certificate.certificateId);
    expect(cert.templateVersion).toBe('v3.0');
    expect(cert.systemSignature.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(cert.systemSignature.signerLabel).toBe('LEXX Certificate Authority');

    const generated = await Ledger.find({ eventType: LEDGER_EVENT.CERTIFICATE_GENERATED }).lean();
    expect(generated).toHaveLength(1);
    expect(generated[0].seq).toBe(cert.issuanceLedgerSeq);
    expect(generated[0].payload.certificateHash).toBe(cert.certificateHash);
    expect(generated[0].seq).toBe(upload.receipt.ledgerSeq + 1);
  });

  it('fills Part A from the record and the uploading officer, rendering unrecorded particulars as absent', async () => {
    const { evidence, certificateId } = await fixture();
    const cert = await Certificate.findById(certificateId).lean();

    expect(cert.issuedOnBehalfOf).toMatchObject({
      name: io.user.name,
      authorityId: IO,
      role: 'IO',
      designation: 'Investigating Officer, UP-GZB-KVN',
    });
    expect(cert.partA.sourceType).toBe('OTHER');
    for (const k of ['make', 'model', 'colour', 'serialNumber', 'imeiOrUid']) expect(cert.partA[k]).toBeNull();
    expect(cert.partA.hashValue).toBe(evidence.sha256Server);
    expect(cert.partA.mannerOfProduction).toContain(evidence.exhibitCode);
    expect(cert.partA.mannerOfProduction).toMatch(/ledger at sequence \d+/);
    expect(cert.partA.conditionsStatement).toMatch(/not recorded at upload/);

    const decrypted = await readCertificatePdf(cert);
    expect(decrypted.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(hashOf(decrypted)).toBe(cert.pdfSha256);
  });

  it('records the device particulars when they were supplied', async () => {
    const { certificateId } = await fixture(FULL_DEVICE);
    const cert = await Certificate.findById(certificateId).lean();
    expect(cert.partA).toMatchObject(FULL_DEVICE);
  });

  it('puts the ingest hashes in Part B, attested by the system, with no forensic verdict', async () => {
    const { evidence, certificateId } = await fixture();
    const { partB } = await Certificate.findById(certificateId).lean();
    expect(partB.attestedBy).toBe('LEXX Certificate Authority');
    expect(partB.hashAlgorithm).toBe('SHA-256');
    expect(partB.sha256Client).toBe(evidence.sha256Client);
    expect(partB.sha256Server).toBe(evidence.sha256Server);
    expect(partB.hashesMatch).toBe(true);
    expect(partB.hashComputedAt).toBeTruthy();
    expect(partB.expertOpinion).toBeNull();
    expect(partB.expertName).toBeNull();
  });

  it('still accepts the upload when issuing fails, and issues the certificate on the next read', async () => {
    const caseDoc = await createCase();
    const spy = vi.spyOn(Certificate, 'create').mockRejectedValueOnce(new Error('simulated outage'));
    let upload;
    try {
      upload = await uploadExhibit(caseDoc._id, 'Uploaded during an outage');
    } finally {
      spy.mockRestore();
    }
    expect(upload.certificate).toBeNull();
    expect(await Certificate.countDocuments({ evidenceId: upload.evidence._id })).toBe(0);

    const list = await as(io, request(server).get('/api/certificates').query({ evidenceId: upload.evidence._id }));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.active.signedBy).toBe('LEXX Certificate Authority');
  });
});

// ================================================ 2. NO MANUAL FLOW ==========

describe('a second certificate cannot be made', () => {
  it('has no route to generate or sign a certificate', async () => {
    const { evidence, certificateId } = await fixture();
    const generate = await as(io, request(server).post('/api/certificates/generate')).send({ evidenceId: evidence._id });
    expect(generate.status).toBe(404);
    for (const part of ['sign-part-a', 'sign-part-b']) {
      const res = await as(io, request(server).post(`/api/certificates/${certificateId}/${part}`)).send({
        signature: 'a'.repeat(128),
      });
      expect(res.status).toBe(404);
    }
    expect(await Certificate.countDocuments()).toBe(1);
  });

  it('is idempotent: issuing again, even concurrently, returns the same certificate', async () => {
    const { evidence, certificateId } = await fixture();
    const results = await Promise.all([1, 2, 3].map(() => ensureSystemCertificate(evidence._id)));
    for (const r of results) {
      expect(r.created).toBe(false);
      expect(String(r.certificate._id)).toBe(certificateId);
    }
    expect(await Certificate.countDocuments({ evidenceId: evidence._id })).toBe(1);
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_GENERATED })).toBe(1);
  });

  it('is enforced by the database, not only by the issuer', async () => {
    const { evidence, caseDoc } = await fixture();
    await expect(
      Certificate.create({
        evidenceId: evidence._id,
        caseId: caseDoc._id,
        partA: { deponentName: 'Written around the issuer' },
        verificationToken: 'z'.repeat(43),
      })
    ).rejects.toMatchObject({ code: 11000 });
  });
});

// ============================================== 3. ONE-CLICK VERIFY ==========

describe('one-click verification', () => {
  it('returns VERIFIED with every check passing for a clean exhibit, and records it', async () => {
    const { certificateId } = await fixture();
    const res = await verify(io, certificateId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toBe('VERIFIED');
    expect(res.body.verifiedAt).toBeTruthy();
    expect(res.body.checks.map((c) => c.key)).toEqual(CHECK_KEYS);
    for (const c of res.body.checks) {
      expect(c.ok, `${c.key}: ${c.detail}`).toBe(true);
      expect(typeof c.label).toBe('string');
      expect(typeof c.detail).toBe('string');
    }

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.CERTIFICATE_VERIFIED }).lean();
    expect(entry.payload.result).toBe('VERIFIED');
    expect(entry.payload.certificateId).toBe(certificateId);
    expect(entry.actorRole).toBe('IO');

    const view = await as(io, request(server).get(`/api/certificates/${certificateId}`));
    expect(view.body.certificate.lastVerification).toMatchObject({ result: 'VERIFIED', byRole: 'IO' });

    const audit = await AuditEvent.findOne({ reason: 'CERTIFICATE_VERIFIED' }).lean();
    expect(audit.decision).toBe(DECISION.ALLOW);
  });

  it('keeps GET working too', async () => {
    const { certificateId } = await fixture();
    const res = await verify(io, certificateId, 'get');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('VERIFIED');
  });

  it('FAILS on the evidence check when the vault object is tampered with', async () => {
    const { evidence, certificateId } = await fixture();
    await tamperVaultObject(evidence._id);

    const res = await verify(io, certificateId);
    expect(res.body.result).toBe('FAILED');
    expect(checkOf(res.body, 'evidenceFileUnchanged').ok).toBe(false);
    for (const key of CHECK_KEYS.filter((k) => k !== 'evidenceFileUnchanged')) {
      expect(checkOf(res.body, key).ok, key).toBe(true);
    }
    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.CERTIFICATE_VERIFIED }).lean();
    expect(entry.payload.result).toBe('FAILED');
    expect(entry.payload.failedChecks).toEqual(['evidenceFileUnchanged']);
  });

  it('FAILS on the document check when the stored PDF is tampered with', async () => {
    const { certificateId } = await fixture();
    await tamperStoredPdf(certificateId);

    const res = await verify(io, certificateId);
    expect(res.body.result).toBe('FAILED');
    expect(checkOf(res.body, 'documentUnchanged').ok).toBe(false);
    expect(checkOf(res.body, 'evidenceFileUnchanged').ok).toBe(true);
    expect(checkOf(res.body, 'systemSignatureValid').ok).toBe(true);

    const pdf = await as(io, request(server).get(`/api/certificates/${certificateId}/pdf`));
    expect(pdf.status).toBe(409);
    expect(pdf.body.error.code).toBe('CERTIFICATE_DOCUMENT_UNAVAILABLE');
  });

  it('FAILS on the signature check when the certificate record is edited in the database', async () => {
    const { certificateId } = await fixture();
    await mongoose.connection
      .collection('certificates')
      .updateOne({ _id: new mongoose.Types.ObjectId(certificateId) }, { $set: { 'partA.make': 'Nokia' } });

    const res = await verify(io, certificateId);
    expect(res.body.result).toBe('FAILED');
    expect(checkOf(res.body, 'systemSignatureValid').ok).toBe(false);
    expect(checkOf(res.body, 'documentUnchanged').ok).toBe(true);
  });

  it('FAILS on the ledger check when the record of issue is edited', async () => {
    const { certificateId } = await fixture();
    const cert = await Certificate.findById(certificateId).lean();
    await mongoose.connection
      .collection('ledger')
      .updateOne({ seq: cert.issuanceLedgerSeq }, { $set: { 'payload.pdfSha256': 'f'.repeat(64) } });

    const res = await verify(io, certificateId);
    expect(res.body.result).toBe('FAILED');
    expect(checkOf(res.body, 'ledgerRecordIntact').ok).toBe(false);
  });

  it('is independent of the forensic verdict — a MANIPULATED finding does not affect it', async () => {
    const { caseDoc, evidence, certificateId } = await fixture();
    await recordForensicVerdict(caseDoc, evidence, FORENSIC_OPINION.MANIPULATED);

    // The examiner clicks Verify Certificate. Nothing to upload, no verdict mismatch.
    const res = await verify(examiner, certificateId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toBe('VERIFIED');
    expect(JSON.stringify(res.body)).not.toMatch(/verdict|MANIPULATED|opinion/i);

    // And the certificate itself was not touched by the verdict.
    const cert = await Certificate.findById(certificateId).lean();
    expect(cert.partB.expertOpinion).toBeNull();
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_PART_B_ATTACHED })).toBe(0);
  });

  it('is available to the court once the case is before it', async () => {
    const { caseDoc, certificateId } = await fixture();
    const filed = await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const res = await verify(judge, certificateId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toBe('VERIFIED');
  });

  it('is refused to a user who may not read the exhibit', async () => {
    const { certificateId } = await fixture();
    const res = await verify(stranger, certificateId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_VERIFIED })).toBe(0);
  });
});

// ============================================ 4. THE PUBLIC VERIFIER ========

describe('the public verifier: one call, validity never contents', () => {
  it('needs no authentication and returns the same result and checks', async () => {
    const { caseDoc, evidence, upload, certificateId } = await fixture(FULL_DEVICE);
    const res = await request(server).get(`/public/verify/${upload.certificate.verificationToken}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toBe('VERIFIED');
    expect(res.body.checks.map((c) => c.key)).toEqual(CHECK_KEYS);
    expect(res.body.valid).toBe(true);
    expect(res.body.certificate.certificateId).toBe(certificateId);
    expect(res.body.certificate.evidenceHash).toBe(evidence.sha256Server);
    expect(res.body.certificate.exhibitCode).toBe(evidence.exhibitCode);
    expect(res.body.certificate.firNumber).toBe(caseDoc.firNumber);
    expect(res.body.certificate.pdfIntegrity).toBe('PDF_INTACT');
    expect(res.body.certificate.signedBy).toBe('LEXX Certificate Authority');
    // Public verification leaves no ledger entry to spam.
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_VERIFIED })).toBe(0);
  });

  it('names the registering official and the case stage, but leaks no party detail, particulars or content', async () => {
    const { upload } = await fixture(FULL_DEVICE);
    const res = await request(server).get(`/public/verify/${upload.certificate.verificationToken}`);
    const body = JSON.stringify(res.body);
    for (const secret of [
      'R58N90ABCDE',
      '351756051523999',
      // FIR 0123/2026 is a POCSO case: the exhibit title is withheld.
      'Seized phone photo',
      'Ramesh Singh',
      'Kamla Devi',
      'regular use in the ordinary course',
      'append-only ledger at sequence',
      'wrappedDek',
      'storageKey',
      'aiAnalysis',
    ]) {
      expect(body, `public verifier leaked: ${secret}`).not.toContain(secret);
    }
    // Who uploaded it, as the user asked the verifier to show.
    expect(res.body.uploadedBy).toMatchObject({
      name: io.user.name,
      role: 'IO',
      roleLabel: 'Investigating Officer',
      authorityId: IO,
      unit: 'Kavi Nagar Police Station',
    });
    expect(res.body.evidence).toMatchObject({ title: null, titleWithheld: true, labelUrl: upload.evidence.label.url });
    expect(res.body.evidence.source).toEqual({ sourceType: 'MOBILE', make: 'Samsung', model: 'Galaxy A54' });
    expect(res.body.case).toMatchObject({ firNumber: FIR, stationCode: 'UP-GZB-KVN', stage: 'UNDER_INVESTIGATION' });
    expect(res.body.forensic).toEqual({ status: 'NOT_EXAMINED', examinedAt: null, labName: null });
    expect(res.body.lifecycle.map((m) => m.key)).toEqual([
      'UPLOADED',
      'CERTIFICATE_ISSUED',
      'FORENSIC_EXAMINATION',
      'CHARGESHEET_FILED',
      'COGNIZANCE_TAKEN',
      'COMMITTED',
      'TRIAL',
      'CLOSED',
    ]);
    expect(Object.keys(res.body.certificate).sort()).toEqual(
      [
        'authorityKeyFingerprint',
        'certificateId',
        'cnrNumber',
        'evidenceHash',
        'exhibitCode',
        'firNumber',
        'hashAlgorithm',
        'issuedAt',
        'lastVerification',
        'pdfIntegrity',
        'pdfSha256',
        'signedBy',
        'status',
        'statute',
        'templateVersion',
        'verificationUrl',
      ].sort()
    );
    expect(res.body.disclosure).toMatch(/discloses no case narrative/);
  });

  it('returns FAILED with the failing check after the evidence is tampered with', async () => {
    const { evidence, upload } = await fixture();
    await tamperVaultObject(evidence._id);
    const res = await request(server).get(`/public/verify/${upload.certificate.verificationToken}`);
    expect(res.body.result).toBe('FAILED');
    expect(checkOf(res.body, 'evidenceFileUnchanged').ok).toBe(false);
  });

  it('answers a forged or malformed token as not found, identically', async () => {
    await fixture();
    const forged = await request(server).get(`/public/verify/${'A'.repeat(43)}`);
    const malformed = await request(server).get('/public/verify/short');
    expect(forged.status).toBe(404);
    expect(forged.body).toEqual({ valid: false, reason: 'CERTIFICATE_NOT_FOUND' });
    expect(malformed.body).toEqual(forged.body);
  });

  it('checks a copy in hand by its digest', async () => {
    const { upload, certificateId } = await fixture();
    const pdf = await as(io, request(server).get(`/api/certificates/${certificateId}/pdf`)).buffer().parse(binaryParser);
    const token = upload.certificate.verificationToken;

    const current = await request(server).get(`/public/verify/${token}?copy=${hashOf(pdf.body)}`);
    expect(current.body.copy.match).toBe('CURRENT');
    const altered = await request(server).get(`/public/verify/${token}?copy=${hashOf(Buffer.concat([pdf.body, Buffer.from('\n')]))}`);
    expect(altered.body.copy.match).toBe('NO_MATCH');
  });
});

// ============================================== 5. THE AUTHORITY KEY ========

describe('the authority public key makes the signature independently checkable', () => {
  it('is public, carries no private material, and verifies the stored signature', async () => {
    const { certificateId } = await fixture();

    const res = await request(server).get('/api/certificates/authority-key');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issuer).toBe('LEXX Certificate Authority');
    expect(res.body.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(res.body.publicKeyJwk.d).toBeUndefined();
    expect(res.body.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const alt = await request(server).get('/public/certificate-authority-key');
    expect(alt.body.fingerprint).toBe(res.body.fingerprint);

    const cert = await Certificate.findById(certificateId).lean();
    expect(cert.systemSignature.keyFingerprint).toBe(res.body.fingerprint);
    const key = crypto.createPublicKey({ key: res.body.publicKeyJwk, format: 'jwk' });
    const ok = crypto.verify(
      'sha256',
      Buffer.from(cert.certificateHash, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(cert.systemSignature.signature, 'hex')
    );
    expect(ok).toBe(true);
  });
});

// ============================================ 6. VIEWS, LIST, PDF ============

describe('certificate views', () => {
  const VIEW_KEYS = [
    'certificateId',
    'evidenceId',
    'exhibitCode',
    'issuedAt',
    'issuedOnBehalfOf',
    'lastVerification',
    'pdfUrl',
    'signedBy',
    'status',
    'templateVersion',
    'verificationToken',
    'verificationUrl',
  ].sort();

  it('lists the one certificate in the small view, with no signing payloads', async () => {
    const { evidence, certificateId } = await fixture();
    const res = await as(io, request(server).get('/api/certificates').query({ evidenceId: evidence._id }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.active.certificateId).toBe(certificateId);
    const [view] = res.body.certificates;
    expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    expect(view).toMatchObject({
      exhibitCode: evidence.exhibitCode,
      status: 'ACTIVE',
      templateVersion: 'v3.0',
      signedBy: 'LEXX Certificate Authority',
      issuedOnBehalfOf: { name: io.user.name, authorityId: IO, role: 'IO' },
      pdfUrl: `/api/certificates/${certificateId}/pdf`,
      lastVerification: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/signingPayloads|partB|signatures/);
  });

  it('repairs a missing certificate lazily when the exhibit is read', async () => {
    const { evidence } = await fixture();
    await Certificate.deleteMany({ evidenceId: evidence._id });
    const res = await as(io, request(server).get(`/api/evidence/${evidence._id}`));
    expect(res.status).toBe(200);
    expect(await Certificate.countDocuments({ evidenceId: evidence._id, status: 'ACTIVE' })).toBe(1);
    expect(res.body.evidence.certificate?.state).toBe('ISSUED');
  });

  it('refuses the list to an advocate who may not read the exhibit, and validates the id', async () => {
    const { evidence } = await fixture();
    const denied = await as(stranger, request(server).get('/api/certificates').query({ evidenceId: evidence._id }));
    expect(denied.status).toBe(403);
    const malformed = await as(io, request(server).get('/api/certificates').query({ evidenceId: 'nope' }));
    expect(malformed.status).toBe(400);
  });

  it('reaches the examiner through their referral', async () => {
    const { caseDoc, evidence, certificateId } = await fixture();
    await recordForensicVerdict(caseDoc, evidence, FORENSIC_OPINION.AUTHENTIC);
    const referral = await Referral.findOne({ evidenceId: evidence._id }).lean();
    const res = await as(examiner, request(server).get(`/api/fsl/referrals/${referral._id}/certificates`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.certificates[0].certificateId).toBe(certificateId);
  });

  it('serves the stored PDF whose hash is the recorded one, audited, and refuses a stranger', async () => {
    const { certificateId } = await fixture();
    const res = await as(io, request(server).get(`/api/certificates/${certificateId}/pdf`)).buffer().parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    const stored = await Certificate.findById(certificateId).lean();
    expect(hashOf(res.body)).toBe(stored.pdfSha256);
    expect(res.headers['x-lexx-pdf-sha256']).toBe(stored.pdfSha256);
    expect(res.body.toString('latin1').match(/lexx-verify:([A-Za-z0-9_-]{43})/)?.[1]).toBe(stored.verificationToken);

    const row = await AuditEvent.findOne({ reason: 'CERTIFICATE_PDF_DOWNLOAD' }).lean();
    expect(row.authorityId).toBe(IO);

    const denied = await as(stranger, request(server).get(`/api/certificates/${certificateId}/pdf`));
    expect(denied.status).toBe(403);
  });
});

// ============================================= 7. EXISTING DATA ==============

describe('boot migration: existing exhibits get a system certificate', () => {
  it('supersedes a legacy ACTIVE certificate, issues the system one, and is idempotent', async () => {
    const { caseDoc, evidence, upload } = await fixture();
    const labelBefore = (await Evidence.findById(evidence._id).lean()).labelToken;
    // Put the exhibit back in its pre-v3 state: a legacy, still-ACTIVE, unsigned certificate.
    await Certificate.deleteMany({ evidenceId: evidence._id });
    const legacyId = new mongoose.Types.ObjectId();
    const legacyToken = 'L'.repeat(43);
    await mongoose.connection.collection('certificates').insertOne({
      _id: legacyId,
      evidenceId: new mongoose.Types.ObjectId(evidence._id),
      caseId: new mongoose.Types.ObjectId(caseDoc._id),
      templateVersion: 'v2.0',
      status: 'ACTIVE',
      partA: { deponentName: io.user.name, hashValue: evidence.sha256Server },
      partB: {},
      signatures: [],
      pdfHistory: [],
      generatedAt: new Date(),
      verificationToken: legacyToken,
      partAComplete: true,
      partBComplete: false,
    });

    const report = await runMigrations(quiet);
    expect(report.legacyCertificatesSuperseded).toBe(1);
    expect(report.systemCertificatesIssued).toBe(1);
    expect(report.systemCertificateFailures).toBe(0);

    const legacy = await Certificate.findById(legacyId).lean();
    expect(legacy.status).toBe('SUPERSEDED');
    expect(legacy.supersededReason).toBe('REPLACED_BY_SYSTEM_CERTIFICATE');
    const active = await Certificate.findOne({ evidenceId: evidence._id, status: 'ACTIVE' }).lean();
    expect(String(legacy.supersededById)).toBe(String(active._id));
    expect(active.templateVersion).toBe('v3.0');
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_SUPERSEDED, subjectId: legacyId })).toBe(1);

    expect((await verify(io, String(active._id))).body.result).toBe('VERIFIED');
    const old = await request(server).get(`/public/verify/${legacyToken}`);
    expect(old.body.result).toBe('FAILED');
    expect(checkOf(old.body, 'activeCertificate').ok).toBe(false);

    // The certificate token changed; the printed QR label did not, and still resolves.
    expect((await Evidence.findById(evidence._id).lean()).labelToken).toBe(labelBefore);
    expect(old.body.evidence.labelUrl).toBe(upload.evidence.label.url);
    const scanned = await request(server).get(`/public/evidence/${labelBefore}`);
    expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
    expect(scanned.body.result).toBe('VERIFIED');
    expect(scanned.body.certificate.certificateId).toBe(String(active._id));

    const again = await runMigrations(quiet);
    expect(again.legacyCertificatesSuperseded).toBe(0);
    expect(again.systemCertificatesIssued).toBe(0);
    expect(await Certificate.countDocuments({ evidenceId: evidence._id })).toBe(2);
  });
});
