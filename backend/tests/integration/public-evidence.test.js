/**
 * The permanent QR label and the public lifecycle page.
 *
 * Every exhibit gets a label token at upload. Printed as a QR and stuck on the physical
 * article, it opens GET /public/evidence/:labelToken — no account needed — which answers:
 *
 *   1. does the record verify (the exhibit's active s.63 certificate, re-checked);
 *   2. who registered it, and where the case stands;
 *   3. whether a laboratory has examined it — never what the laboratory concluded;
 *   4. the lifecycle, milestone by milestone.
 *
 * And it discloses nothing private: no description, no party names, no AI analysis, no
 * forensic opinion, no device serials, no ledger or encryption internals. A sensitive
 * (POCSO / victim-protected) case also withholds the exhibit title.
 *
 * Run against the REAL directory services.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Certificate } from '../../models/Certificate.js';
import { Evidence } from '../../models/Evidence.js';
import { Ledger } from '../../models/Ledger.js';
import { createApp } from '../../app.js';
import env from '../../config/env.js';
import { resolveObjectPath } from '../../services/storage.js';
import { drainAnalyses } from '../../services/ai/analysisService.js';
import { asUser, sha256Hex } from '../helpers/client.js';
import { LEDGER_EVENT } from '../../models/enums.js';

let mongo;
let server;

const IO = 'UP-GZB-4471';
const MAGISTRATE = 'UP-JUD-1180';
const EXAMINER = 'FSL-LKO-0091';
const ADVOCATE = 'UP/1234/2015';

const ORDINARY_FIR = '0124/2026';
const POCSO_FIR = '0123/2026';

const PER_TEST_COLLECTIONS = [
  'cases',
  'evidence',
  'case_access_grants',
  'certificates',
  'referrals',
  'custody_items',
  'ledger',
  'counters',
  'audit_events',
  'anchor_batches',
  'stream_tokens',
  'vakalatnama_filings',
];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEVICE = Object.freeze({
  sourceType: 'MOBILE',
  make: 'Samsung',
  model: 'Galaxy A54',
  serialNumber: 'R58N90ABCDE',
  imeiOrUid: '351756051523999',
});
const TITLE = 'Photograph of the recovered handset';
const DESCRIPTION = 'Recovered from under the mattress in the second bedroom';
const VERDICT_SUMMARY = 'Frame-level examination found a splice consistent with an inserted segment.';

const KEYS = [
  'UPLOADED',
  'CERTIFICATE_ISSUED',
  'FORENSIC_EXAMINATION',
  'CHARGESHEET_FILED',
  'COGNIZANCE_TAKEN',
  'COMMITTED',
  'TRIAL',
  'CLOSED',
];

let io;
let magistrate;
let examiner;
let advocate;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_public_evidence', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();

  io = await asUser(server, IO);
  magistrate = await asUser(server, MAGISTRATE);
  examiner = await asUser(server, EXAMINER);
  advocate = await asUser(server, ADVOCATE);
}, 180_000);

afterAll(async () => {
  await drainAnalyses();
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await drainAnalyses();
  await Promise.all(
    PER_TEST_COLLECTIONS.map((name) => mongoose.connection.collection(name).deleteMany({}).catch(() => {}))
  );
});

// ---------------------------------------------------------------- helpers ----

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);
const scan = (token) => request(server).get(`/public/evidence/${token}`);
const statesOf = (body) => Object.fromEntries(body.lifecycle.map((m) => [m.key, m.state]));

async function fixture(firNumber = ORDINARY_FIR) {
  const created = await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const caseDoc = created.body.case;

  const bytes = Buffer.concat([PNG, Buffer.from(`${TITLE}:${crypto.randomUUID()}`.padEnd(96, '.'), 'utf8')]);
  const sha = sha256Hex(bytes);
  let req = as(io, request(server).post('/api/evidence/upload'))
    .field('caseId', String(caseDoc._id))
    .field('title', TITLE)
    .field('description', DESCRIPTION)
    .field('sha256Client', sha)
    .field('signature', io.keys.sign(sha));
  for (const [k, v] of Object.entries(DEVICE)) req = req.field(k, v);
  const res = await req.attach('file', bytes, { filename: 'handset.png', contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await drainAnalyses();
  return { caseDoc, evidence: res.body.evidence, upload: res.body, label: res.body.evidence.label };
}

async function recordVerdict(evidence, opinion = 'MANIPULATED') {
  const statement = ['LEXX-FSL-VERDICT', 'v1', evidence.exhibitCode, opinion, VERDICT_SUMMARY, '-'].join('|');
  const digest = sha256Hex(Buffer.from(statement, 'utf8'));
  const res = await as(examiner, request(server).post(`/api/evidence/${evidence._id}/forensic-verdict`))
    .field('opinion', opinion)
    .field('examinationSummary', VERDICT_SUMMARY)
    .field('verdictSha256', digest)
    .field('verdictSignature', examiner.keys.sign(digest));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function fileChargesheet(caseDoc) {
  const res = await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.case;
}

async function takeCognizance(caseDoc) {
  const res = await as(magistrate, request(server).post(`/api/cases/${caseDoc._id}/transition`)).send({
    action: 'TAKE_COGNIZANCE',
    note: 'Chargesheet and documents perused.',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function putCounselOnRecord(cnrNumber) {
  const doc = Buffer.from(`%PDF-1.4\n% vakalatnama ${ADVOCATE}\n${'.'.repeat(64)}\n%%EOF\n`, 'utf8');
  const sha = sha256Hex(doc);
  const filed = await as(advocate, request(server).post('/api/vakalatnama'))
    .field('cnrNumber', cnrNumber)
    .field('appearingFor', 'ACCUSED')
    .field('partyName', 'Unknown')
    .field('documentSha256', sha)
    .field('documentSignature', advocate.keys.sign(sha))
    .attach('document', doc, { filename: 'v.pdf', contentType: 'application/pdf' });
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const accepted = await as(magistrate, request(server).post(`/api/vakalatnama/${filed.body.filing.id}/accept`)).send({});
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
}

// ============================================ 1. the label on every surface ====

describe('every exhibit has a permanent QR label that its readers can print', () => {
  it('is issued at upload and points at the public lifecycle page', async () => {
    const { evidence, label } = await fixture();
    expect(label.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(label.url).toBe(`${env.PUBLIC_WEB_URL}/verify?label=${encodeURIComponent(label.token)}`);
    const stored = await Evidence.findById(evidence._id).lean();
    expect(stored.labelToken).toBe(label.token);
  });

  it('appears on the case overview cards, the laboratory’s cases and counsel’s case file', async () => {
    const { caseDoc, label } = await fixture();

    const overview = await as(io, request(server).get(`/api/cases/${caseDoc._id}/overview`));
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.evidence[0].label).toEqual(label);

    const lab = await as(examiner, request(server).get('/api/fsl/cases'));
    expect(lab.status, JSON.stringify(lab.body)).toBe(200);
    const group = lab.body.cases.find((g) => g.case.id === caseDoc._id);
    expect(group.evidence[0].label).toEqual(label);

    const filed = await fileChargesheet(caseDoc);
    await putCounselOnRecord(filed.cnrNumber);
    const caseFile = await as(advocate, request(server).get(`/api/disclosure/case-file/${caseDoc._id}`));
    expect(caseFile.status, JSON.stringify(caseFile.body)).toBe(200);
    expect(caseFile.body.exhibits[0].label).toEqual(label);

    const court = await as(magistrate, request(server).get(`/api/cases/${caseDoc._id}/overview`));
    expect(court.body.evidence[0].label).toEqual(label);
  });

  it('stays the same when the certificate is replaced, and keeps resolving', async () => {
    const { caseDoc, evidence, label, upload } = await fixture();
    const quiet = { info() {}, warn() {}, error() {} };
    const { runMigrations } = await import('../../services/migrations.js');

    // Put the exhibit back to a legacy certificate, which the boot migration supersedes.
    await Certificate.deleteMany({ evidenceId: evidence._id });
    await mongoose.connection.collection('certificates').insertOne({
      evidenceId: new mongoose.Types.ObjectId(evidence._id),
      caseId: new mongoose.Types.ObjectId(caseDoc._id),
      templateVersion: 'v2.0',
      status: 'ACTIVE',
      partA: { deponentName: io.user.name, hashValue: evidence.sha256Server },
      partB: {},
      signatures: [],
      pdfHistory: [],
      generatedAt: new Date(),
      verificationToken: 'L'.repeat(43),
    });
    await runMigrations(quiet);

    const active = await Certificate.findOne({ evidenceId: evidence._id, status: 'ACTIVE' }).lean();
    expect(active.verificationToken).not.toBe(upload.certificate.verificationToken);
    expect((await Evidence.findById(evidence._id).lean()).labelToken).toBe(label.token);

    const res = await scan(label.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toBe('VERIFIED');
    expect(res.body.certificate.certificateId).toBe(String(active._id));
    expect(res.body.certificate.verificationUrl).toContain(encodeURIComponent(active.verificationToken));
  });
});

// ============================================== 2. what a scan answers ========

describe('GET /public/evidence/:labelToken', () => {
  it('answers VERIFIED for a clean exhibit, with who uploaded it and where the case stands', async () => {
    const { caseDoc, evidence, label, upload } = await fixture();
    const res = await scan(label.token);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.result).toBe('VERIFIED');
    expect(res.body.checks.length).toBe(5);
    for (const c of res.body.checks) expect(c.ok, `${c.key}: ${c.detail}`).toBe(true);
    expect(res.body.verifiedAt).toBeTruthy();

    expect(res.body.evidence).toEqual({
      exhibitCode: evidence.exhibitCode,
      title: TITLE,
      titleWithheld: false,
      fileType: 'image/png',
      sizeBytes: evidence.sizeBytes,
      sha256: evidence.sha256Server,
      hashAlgorithm: 'SHA-256',
      registeredAt: evidence.createdAt,
      capturedAt: null,
      source: { sourceType: 'MOBILE', make: 'Samsung', model: 'Galaxy A54' },
      labelUrl: label.url,
    });
    expect(res.body.uploadedBy).toEqual({
      name: io.user.name,
      role: 'IO',
      roleLabel: 'Investigating Officer',
      authorityId: IO,
      unit: 'Kavi Nagar Police Station',
    });
    expect(res.body.case).toEqual({
      firNumber: ORDINARY_FIR,
      cnrNumber: null,
      stationCode: 'UP-GZB-KVN',
      stationName: 'Kavi Nagar Police Station',
      courtName: null,
      stage: 'UNDER_INVESTIGATION',
      stageLabel: 'Under investigation',
    });
    expect(res.body.certificate).toMatchObject({
      certificateId: upload.certificate.certificateId,
      status: 'ACTIVE',
      signedBy: 'LEXX Certificate Authority',
      verificationUrl: upload.certificate.verificationUrl,
      lastVerification: null,
    });
    expect(res.body.certificate.issuedAt).toBeTruthy();
    expect(res.body.forensic).toEqual({ status: 'NOT_EXAMINED', examinedAt: null, labName: null });

    expect(res.body.lifecycle.map((m) => m.key)).toEqual(KEYS);
    expect(statesOf(res.body)).toEqual({
      UPLOADED: 'done',
      CERTIFICATE_ISSUED: 'done',
      FORENSIC_EXAMINATION: 'current',
      CHARGESHEET_FILED: 'upcoming',
      COGNIZANCE_TAKEN: 'upcoming',
      // FIR 0124/2026 is triable by a Magistrate: no committal.
      COMMITTED: 'not_applicable',
      TRIAL: 'upcoming',
      CLOSED: 'upcoming',
    });
    const uploaded = res.body.lifecycle.find((m) => m.key === 'UPLOADED');
    expect(uploaded.label).toBe('Evidence uploaded');
    expect(uploaded.at).toBe(evidence.createdAt);
    expect(res.body.lifecycle.find((m) => m.key === 'CHARGESHEET_FILED').at).toBeNull();

    // Scanning records nothing, and needs no session.
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_VERIFIED })).toBe(0);
    expect(caseDoc._id).toBeTruthy();
  });

  it('answers FAILED, naming the failing check, after the stored file is tampered with', async () => {
    const { evidence, label } = await fixture();
    const stored = await Evidence.findById(evidence._id).lean();
    fs.appendFileSync(resolveObjectPath(stored.storageKey), 'x');

    const res = await scan(label.token);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('FAILED');
    expect(res.body.checks.find((c) => c.key === 'evidenceFileUnchanged').ok).toBe(false);
  });

  it('answers NO_CERTIFICATE when the exhibit has no active certificate, without issuing one', async () => {
    const { evidence, label } = await fixture();
    await Certificate.deleteMany({ evidenceId: evidence._id });

    const res = await scan(label.token);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('NO_CERTIFICATE');
    expect(res.body.checks).toEqual([]);
    expect(res.body.certificate).toBeNull();
    expect(statesOf(res.body).CERTIFICATE_ISSUED).toBe('current');
    expect(await Certificate.countDocuments({ evidenceId: evidence._id })).toBe(0);
  });

  it('answers an unknown or malformed token with 404 LABEL_NOT_FOUND, identically', async () => {
    await fixture();
    const unknown = await scan('A'.repeat(43));
    const malformed = await scan('not-a-label');
    expect(unknown.status).toBe(404);
    expect(unknown.body.reason).toBe('LABEL_NOT_FOUND');
    expect(unknown.body.error.code).toBe('LABEL_NOT_FOUND');
    expect(malformed.status).toBe(404);
    expect(malformed.body).toEqual(unknown.body);
  });

  it('withholds the exhibit title for a sensitive (POCSO, victim-protected) case', async () => {
    const { label } = await fixture(POCSO_FIR);
    const res = await scan(label.token);
    expect(res.status).toBe(200);
    expect(res.body.evidence.title).toBeNull();
    expect(res.body.evidence.titleWithheld).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(TITLE);
    // Still says who registered it; and a Sessions case does require committal.
    expect(res.body.uploadedBy.authorityId).toBe(IO);
    expect(statesOf(res.body).COMMITTED).toBe('upcoming');
  });

  it('never discloses the description, parties, AI analysis, forensic opinion or internals', async () => {
    const { evidence, label } = await fixture();
    await recordVerdict(evidence, 'MANIPULATED');
    await Evidence.updateOne(
      { _id: evidence._id },
      {
        $set: {
          'aiAnalysis.status': 'COMPLETED',
          'aiAnalysis.triagePriority': 'CRITICAL',
          'aiAnalysis.deepfakeAssessment': 'LIKELY_MANIPULATED',
          'aiAnalysis.analysisDescription': 'SECRET-AI-DESCRIPTION of the exhibit for the laboratory only',
        },
      }
    );

    const res = await scan(label.token);
    expect(res.status).toBe(200);
    // Examined — when and by which laboratory — but not what it concluded.
    expect(res.body.forensic.status).toBe('EXAMINED');
    expect(res.body.forensic.examinedAt).toBeTruthy();
    expect(res.body.forensic.labName).toBeTruthy();
    expect(Object.keys(res.body.forensic).sort()).toEqual(['examinedAt', 'labName', 'status']);
    expect(statesOf(res.body).FORENSIC_EXAMINATION).toBe('done');
    expect(statesOf(res.body).CHARGESHEET_FILED).toBe('current');

    const body = JSON.stringify(res.body);
    for (const secret of [
      DESCRIPTION,
      VERDICT_SUMMARY,
      'MANIPULATED',
      // The key, not the word: the disclosure sentence itself says "no forensic or AI opinion".
      '"opinion":',
      'SECRET-AI-DESCRIPTION',
      'CRITICAL',
      'aiAnalysis',
      'triagePriority',
      DEVICE.serialNumber,
      DEVICE.imeiOrUid,
      'Anil Verma',
      'storageKey',
      'wrappedDek',
      'encryption',
      'ledgerSeq',
      'signature"',
      'examinerName',
      examiner.user.name,
    ]) {
      expect(body, `public lifecycle leaked: ${secret}`).not.toContain(secret);
    }
  });
});

// ================================================== 3. the lifecycle moves ====

describe('the lifecycle follows the case', () => {
  it('marks the chargesheet done, then cognizance, with exactly one current milestone', async () => {
    const { caseDoc, label } = await fixture();

    await fileChargesheet(caseDoc);
    let res = await scan(label.token);
    expect(res.body.case.stage).toBe('CHARGESHEET_FILED');
    expect(res.body.case.stageLabel).toBe('Chargesheet filed');
    expect(res.body.case.cnrNumber).toBeTruthy();
    expect(res.body.case.courtName).toMatch(/Chief Judicial Magistrate/);
    expect(statesOf(res.body)).toEqual({
      UPLOADED: 'done',
      CERTIFICATE_ISSUED: 'done',
      // Never examined, but the case has moved past it: upcoming, not current.
      FORENSIC_EXAMINATION: 'upcoming',
      CHARGESHEET_FILED: 'done',
      COGNIZANCE_TAKEN: 'current',
      COMMITTED: 'not_applicable',
      TRIAL: 'upcoming',
      CLOSED: 'upcoming',
    });
    expect(res.body.lifecycle.find((m) => m.key === 'CHARGESHEET_FILED').at).toBeTruthy();

    await takeCognizance(caseDoc);
    res = await scan(label.token);
    expect(res.body.case.stage).toBe('COGNIZANCE_TAKEN');
    expect(statesOf(res.body)).toMatchObject({
      CHARGESHEET_FILED: 'done',
      COGNIZANCE_TAKEN: 'done',
      COMMITTED: 'not_applicable',
      TRIAL: 'current',
      CLOSED: 'upcoming',
    });
    expect(res.body.lifecycle.find((m) => m.key === 'COGNIZANCE_TAKEN').at).toBeTruthy();
    expect(res.body.lifecycle.filter((m) => m.state === 'current')).toHaveLength(1);
  });

  it('describes each milestone with its actor and ledger proofs, and never the court’s note', async () => {
    const { caseDoc, evidence, label } = await fixture();
    await recordVerdict(evidence, 'MANIPULATED');
    await fileChargesheet(caseDoc);
    await takeCognizance(caseDoc);

    const res = await scan(label.token);
    expect(res.status).toBe(200);
    for (const m of res.body.lifecycle) {
      expect(typeof m.description, m.key).toBe('string');
      expect(m, m.key).toHaveProperty('actor');
      expect(Array.isArray(m.proofs), m.key).toBe(true);
    }
    const by = Object.fromEntries(res.body.lifecycle.map((m) => [m.key, m]));

    const uploadEntry = await Ledger.findOne({ subjectId: evidence._id, eventType: LEDGER_EVENT.EVIDENCE_UPLOADED }).lean();
    expect(by.UPLOADED.actor).toEqual({ name: io.user.name, roleLabel: 'Investigating Officer', authorityId: IO });
    expect(by.UPLOADED.proofs).toEqual([
      { label: 'Evidence SHA-256', value: evidence.sha256Server, kind: 'hash' },
      { label: 'Uploader key fingerprint', value: evidence.signerPubKeyFingerprint, kind: 'key' },
      { label: `Ledger entry #${uploadEntry.seq}`, value: uploadEntry.entryHash, kind: 'ledger' },
      { label: 'Anchoring', value: 'Awaiting anchoring', kind: 'anchor' },
    ]);
    expect(by.CERTIFICATE_ISSUED.actor.name).toBe('LEXX Certificate Authority');
    expect(by.FORENSIC_EXAMINATION.description).toMatch(/by a forensic examiner\.$/);
    expect(by.CHARGESHEET_FILED.description).toMatch(/CNR [A-Z0-9]{16} allotted\.$/);
    expect(by.COGNIZANCE_TAKEN.description).toBe(`Recorded by ${magistrate.user.name} (Court).`);
    expect(by.COMMITTED.description).toMatch(/^Not applicable — this case is triable by a Magistrate/);
    expect(by.TRIAL.proofs).toEqual([]);

    const body = JSON.stringify(res.body);
    for (const secret of ['Chargesheet and documents perused.', 'MANIPULATED', VERDICT_SUMMARY, examiner.user.name, DESCRIPTION]) {
      expect(body, `public lifecycle leaked: ${secret}`).not.toContain(secret);
    }
  });

  it('gives the certificate verifier the same evidence, uploader and lifecycle blocks', async () => {
    const { caseDoc, label, upload } = await fixture();
    await fileChargesheet(caseDoc);

    const byLabel = await scan(label.token);
    const byCertificate = await request(server).get(`/public/verify/${upload.certificate.verificationToken}`);
    expect(byCertificate.status).toBe(200);
    for (const key of ['result', 'evidence', 'uploadedBy', 'case', 'forensic', 'lifecycle']) {
      expect(byCertificate.body[key], key).toEqual(byLabel.body[key]);
    }
    expect(byCertificate.body.valid).toBe(true);
    expect(byCertificate.body.certificate.certificateId).toBe(byLabel.body.certificate.certificateId);
  });
});
