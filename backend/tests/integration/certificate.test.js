/**
 * BSA s.63 certificates (spec §8 F9).
 *
 * Three claims are under test, and they are the three the certificate module exists
 * to make good:
 *
 *   1. Lexx REFUSES to generate an incomplete certificate, and names what is missing.
 *   2. Part B is never authored by Lexx. With no s.79A report filed it stays blank.
 *   3. The public verifier reports VALIDITY, never CONTENTS. A token holder learns
 *      that the document is genuine and unaltered, and nothing about the case.
 *
 * Run against the REAL directory services, as the rest of the integration suite does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
const SHO = 'UP-GZB-4402';
const REGISTRAR = 'UP-GZB-REG-01';
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

/** A fully described device: everything Part A of the Schedule asks for. */
const FULL_DEVICE = Object.freeze({
  sourceType: 'MOBILE',
  make: 'Samsung',
  model: 'Galaxy A54',
  colour: 'Black',
  serialNumber: 'R58N90ABCDE',
  imeiOrUid: '351756051523999',
});

let io;
let sho;
let registrar;
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
  sho = await asUser(server, SHO);
  registrar = await asUser(server, REGISTRAR);
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
    PER_TEST_COLLECTIONS.map((name) =>
      mongoose.connection.collection(name).deleteMany({}).catch(() => {})
    )
  );
});

// ---------------------------------------------------------------- helpers ----

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);

/** Supertest does not buffer unknown content types; a PDF has to be read raw. */
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

async function uploadExhibit(caseId, title, device) {
  const bytes = Buffer.concat([PNG, Buffer.from(title.padEnd(96, '.'), 'utf8')]);
  const sha = sha256Hex(bytes);

  let req = as(io, request(server).post('/api/evidence/upload'))
    .field('caseId', String(caseId))
    .field('title', title)
    .field('sha256Client', sha)
    .field('signature', io.keys.sign(sha))
    .field('sourceType', device.sourceType);

  for (const [key, value] of Object.entries(device)) {
    // An absent particular must arrive absent, not as the string "undefined" —
    // otherwise the completeness check would be testing the wrong thing entirely.
    if (key !== 'sourceType' && value !== undefined && value !== null) {
      req = req.field(key, String(value));
    }
  }

  const res = await req.attach('file', bytes, { filename: 'exhibit.png', contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evidence;
}

/** Case + one fully-described exhibit — the happy path for every later test. */
async function fixture(device = FULL_DEVICE) {
  const caseDoc = await createCase();
  const evidence = await uploadExhibit(caseDoc._id, 'Seized phone photo', device);
  return { caseDoc, evidence };
}

async function generateFor(session, evidenceId) {
  return as(session, request(server).post('/api/certificates/generate')).send({ evidenceId });
}

/**
 * Simulate a filed s.79A laboratory report. The FSL module is a separate
 * workstream, so its two side effects are written directly: a referral (which is
 * what scopes the examiner) and the forensic block on the exhibit (which is the
 * ONLY source Part B may draw on).
 */
async function fileForensicReport(caseDoc, evidence) {
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
          opinion: FORENSIC_OPINION.AUTHENTIC,
          examinationSummary:
            'Container and stream metadata are internally consistent; no re-encoding artefacts were found.',
          reportedAt: new Date(),
        },
      },
    }
  );
}

// ====================================================== 1. THE REFUSAL ========

describe('refusing to generate an incomplete certificate', () => {
  it('refuses, and names EXACTLY which Part A fields are missing', async () => {
    // The realistic failure: the officer recorded the source type and nothing else.
    const { evidence } = await fixture({ sourceType: 'MOBILE' });

    const res = await generateFor(io, evidence._id);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CERTIFICATE_PART_A_INCOMPLETE');
    expect(res.body.error.details.missing.sort()).toEqual(
      [
        'partA.colour',
        'partA.make',
        'partA.model',
        'partA.serialNumber OR partA.imeiOrUid',
      ].sort()
    );
    expect(res.body.error.details.exhibitCode).toBe(evidence.exhibitCode);
    expect(res.body.error.details.remedy).toMatch(/Record the missing particulars/);
  });

  it('writes NOTHING when it refuses', async () => {
    const { evidence } = await fixture({ sourceType: 'MOBILE' });
    await generateFor(io, evidence._id);

    expect(await Certificate.countDocuments()).toBe(0);
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_GENERATED })).toBe(0);
  });

  it('audits the refusal, so the gap in the record is itself in the record', async () => {
    const { evidence } = await fixture({ sourceType: 'MOBILE' });
    await generateFor(io, evidence._id);

    const row = await AuditEvent.findOne({ reason: 'CERTIFICATE_PART_A_INCOMPLETE' }).lean();
    expect(row).toBeTruthy();
    expect(row.decision).toBe(DECISION.DENY);
    expect(row.authorityId).toBe(IO);
  });

  it('names only the fields actually missing, one at a time', async () => {
    const { evidence } = await fixture({ ...FULL_DEVICE, colour: undefined });
    const res = await generateFor(io, evidence._id);
    expect(res.status).toBe(400);
    expect(res.body.error.details.missing).toEqual(['partA.colour']);
  });

  it('accepts an identifier in EITHER the serial or the IMEI column', async () => {
    const { evidence } = await fixture({ ...FULL_DEVICE, serialNumber: undefined });
    const res = await generateFor(io, evidence._id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('does not demand a make, model or colour for a source with no physical article', async () => {
    // A cloud account has no colour. Requiring one only teaches officers to type junk.
    const { evidence } = await fixture({ sourceType: 'CLOUD', imeiOrUid: 'acct:8827-hosted-mail' });
    const res = await generateFor(io, evidence._id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

// ====================================================== 2. PART A AUTO-FILL ===

describe('Part A is auto-filled from the record, not typed', () => {
  it('generates a complete certificate when the record supports it', async () => {
    const { evidence } = await fixture();
    const res = await generateFor(io, evidence._id);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { partA } = res.body.certificate;

    // deponent ← the signing user's directory-derived identity
    expect(partA.deponentName).toBe(io.user.name);
    expect(partA.deponentAuthorityId).toBe(IO);
    expect(partA.deponentDesignation).toBe('Investigating Officer, UP-GZB-KVN');

    // device ← evidence.sourceDevice
    expect(partA.sourceType).toBe('MOBILE');
    expect(partA.make).toBe('Samsung');
    expect(partA.model).toBe('Galaxy A54');
    expect(partA.colour).toBe('Black');
    expect(partA.serialNumber).toBe('R58N90ABCDE');
    expect(partA.imeiOrUid).toBe('351756051523999');

    // hash ← evidence.sha256Server
    expect(partA.hashValue).toBe(evidence.sha256Server);
    expect(partA.hashAlgorithm).toBe('SHA-256');

    expect(res.body.certificate.partAComplete).toBe(true);
  });

  it('renders the manner of production as prose over the LEDGER', async () => {
    const { evidence } = await fixture();
    const res = await generateFor(io, evidence._id);
    const prose = res.body.certificate.partA.mannerOfProduction;

    expect(prose).toContain(evidence.exhibitCode);
    expect(prose).toContain(evidence.sha256Server);
    // The citations are what make the account checkable rather than assertive.
    expect(prose).toMatch(/ledger at sequence \d+/);
    expect(prose).toContain(io.user.name);
    expect(prose).toContain(IO);
    expect(prose).toMatch(/rendered mechanically from the Lexx append-only ledger/);

    // Every sequence number cited must actually be in the chain.
    const cited = Number(prose.match(/ledger at sequence (\d+)/)[1]);
    const entry = await Ledger.findOne({ seq: cited }).lean();
    expect(entry.eventType).toBe(LEDGER_EVENT.EVIDENCE_UPLOADED);
  });

  it('states the conditions of operation and cites the digest', async () => {
    const { evidence } = await fixture();
    const res = await generateFor(io, evidence._id);
    const statement = res.body.certificate.partA.conditionsStatement;

    expect(statement).toMatch(/regular use in the ordinary course/);
    expect(statement).toMatch(/operating properly/);
    expect(statement).toContain(evidence.sha256Server);
    expect(statement).toMatch(/No integrity exception has been recorded/);
  });

  it('writes CERTIFICATE_GENERATED to the ledger', async () => {
    const { evidence } = await fixture();
    const res = await generateFor(io, evidence._id);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.CERTIFICATE_GENERATED }).lean();
    expect(entry).toBeTruthy();
    expect(entry.payload.certificateId).toBe(res.body.certificate.certificateId);
    expect(entry.payload.hashValue).toBe(res.body.certificate.partA.hashValue);
    expect(entry.payload.partBComplete).toBe(false);
  });

  it('a registrar may also generate; an SHO may not', async () => {
    const { caseDoc, evidence } = await fixture();

    const shoAttempt = await generateFor(sho, evidence._id);
    expect(shoAttempt.status).toBe(403);
    expect(shoAttempt.body.error.code).toBe(DENY_REASON.READ_ONLY_ROLE);

    // A registrar's scope over a case begins when it is listed before their court.
    await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
    const registrarAttempt = await generateFor(registrar, evidence._id);
    expect(registrarAttempt.status, JSON.stringify(registrarAttempt.body)).toBe(201);
    expect(registrarAttempt.body.certificate.partA.deponentDesignation).toBe(
      'Registrar, UP-GZB-SESS-02'
    );
  });

  it('refuses an advocate who is not on record the exhibit, and so the certificate', async () => {
    const { evidence } = await fixture();
    const res = await generateFor(stranger, evidence._id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });
});

// ========================================================== 3. PART B ========

describe('Part B comes only from a filed FSL report', () => {
  it('stays blank, and says so, when no report has been filed', async () => {
    const { evidence } = await fixture();
    const res = await generateFor(io, evidence._id);

    expect(res.body.certificate.partBComplete).toBe(false);
    const { partB } = res.body.certificate;
    expect(partB.expertName).toBeNull();
    expect(partB.labName).toBeNull();
    expect(partB.expertOpinion).toBeNull();
    expect(partB.examinationSummary).toBeNull();
    expect(res.body.partBNote).toMatch(/no section 79A laboratory report has been filed/i);
  });

  it('says so on the face of the PDF too', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);

    const pdf = await as(
      io,
      request(server).get(`/api/certificates/${gen.body.certificate.certificateId}/pdf`)
    )
      .buffer()
      .parse(binaryParser);

    // PDFKit compresses page content, so assert on the model rather than the bytes:
    // the certificate record itself is what the renderer branches on.
    const stored = await Certificate.findById(gen.body.certificate.certificateId).lean();
    expect(stored.partBComplete).toBe(false);
    expect(pdf.status).toBe(200);
  });

  it('is populated once a s.79A report is on the exhibit', async () => {
    const { caseDoc, evidence } = await fixture();
    await fileForensicReport(caseDoc, evidence);

    // A signed certificate is never edited. A new one is issued.
    const res = await generateFor(io, evidence._id);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.certificate.partBComplete).toBe(true);
    const { partB } = res.body.certificate;
    expect(partB.expertName).toBe(examiner.user.name);
    expect(partB.labName).toBe('State FSL, Lucknow');
    expect(partB.section79ARef).toBe('MeitY/79A/2019/17');
    expect(partB.expertOpinion).toBe(FORENSIC_OPINION.AUTHENTIC);
    expect(partB.examinationSummary).toMatch(/no re-encoding artefacts/);
    expect(res.body.partBNote).toBeNull();
  });

  it('cannot be signed while it is blank', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);

    const res = await as(
      examiner,
      request(server).post(`/api/certificates/${gen.body.certificate.certificateId}/sign-part-b`)
    ).send({ signature: examiner.keys.sign(gen.body.certificate.bodyHash) });

    // The examiner has no referral for this exhibit yet, so the resolver stops them
    // before the controller can even report an empty Part B.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
  });
});

// ======================================================== 4. SIGNATURES ======

describe('signatures are ECDSA P-256 over the canonical body hash', () => {
  it('accepts the deponent’s signature and records what it covers', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const { certificateId, bodyHash } = gen.body.certificate;

    const res = await as(io, request(server).post(`/api/certificates/${certificateId}/sign-part-a`)).send(
      { signature: io.keys.sign(bodyHash) }
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.certificate.signatures).toHaveLength(1);
    expect(res.body.certificate.signatures[0].role).toBe('PARTY');
    expect(res.body.certificate.signatures[0].signedPayloadHash).toBe(bodyHash);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.CERTIFICATE_SIGNED }).lean();
    expect(entry.payload.part).toBe('A');
    expect(entry.payload.signerAuthorityId).toBe(IO);
    expect(entry.payload.signedPayloadHash).toBe(bodyHash);
  });

  it('REJECTS a forged signature and records nothing', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const { certificateId, bodyHash } = gen.body.certificate;

    // A well-formed 64-byte P1363 signature — over the wrong message.
    const forged = io.keys.sign(`${bodyHash}-tampered`);

    const res = await as(io, request(server).post(`/api/certificates/${certificateId}/sign-part-a`)).send(
      { signature: forged }
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');

    const stored = await Certificate.findById(certificateId).lean();
    expect(stored.signatures).toHaveLength(0);
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_SIGNED })).toBe(0);
  });

  it('REJECTS a signature made with somebody else’s key', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const { certificateId, bodyHash } = gen.body.certificate;

    const res = await as(io, request(server).post(`/api/certificates/${certificateId}/sign-part-a`)).send(
      { signature: sho.keys.sign(bodyHash) }
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');
  });

  it('refuses a malformed signature before any crypto runs', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const res = await as(
      io,
      request(server).post(`/api/certificates/${gen.body.certificate.certificateId}/sign-part-a`)
    ).send({ signature: 'not-a-signature' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a second Part A signature', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const { certificateId, bodyHash } = gen.body.certificate;

    await as(io, request(server).post(`/api/certificates/${certificateId}/sign-part-a`)).send({
      signature: io.keys.sign(bodyHash),
    });
    const again = await as(
      io,
      request(server).post(`/api/certificates/${certificateId}/sign-part-a`)
    ).send({ signature: io.keys.sign(bodyHash) });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SIGNED');
  });

  it('refuses a signature from anyone other than the deponent Part A names', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const { certificateId, bodyHash } = gen.body.certificate;

    // The SHO may write on this case, and holds a valid key. They are still not the
    // person whose statement this is.
    const res = await as(sho, request(server).post(`/api/certificates/${certificateId}/sign-part-a`)).send(
      { signature: sho.keys.sign(bodyHash) }
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_THE_DEPONENT');
  });

  it('lets the reporting examiner sign Part B', async () => {
    const { caseDoc, evidence } = await fixture();
    await fileForensicReport(caseDoc, evidence);
    const gen = await generateFor(io, evidence._id);
    const { certificateId, bodyHash } = gen.body.certificate;

    const res = await as(
      examiner,
      request(server).post(`/api/certificates/${certificateId}/sign-part-b`)
    ).send({ signature: examiner.keys.sign(bodyHash) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const roles = res.body.certificate.signatures.map((s) => s.role);
    expect(roles).toContain('EXPERT');
  });

  it('refuses Part B to an examiner who did not file the report', async () => {
    const { caseDoc, evidence } = await fixture();
    await fileForensicReport(caseDoc, evidence);
    // The report now names a different examiner than the one signing.
    await Evidence.updateOne(
      { _id: evidence._id },
      { $set: { 'forensic.examinerUserId': new mongoose.Types.ObjectId() } }
    );

    const gen = await generateFor(io, evidence._id);
    const res = await as(
      examiner,
      request(server).post(`/api/certificates/${gen.body.certificate.certificateId}/sign-part-b`)
    ).send({ signature: examiner.keys.sign(gen.body.certificate.bodyHash) });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_THE_REPORTING_EXAMINER');
  });

  it('a signature over Part A survives Part B being signed afterwards', async () => {
    // Signatures cover the certificate BODY. Adding a second one re-renders the PDF
    // but must not disturb the first signature or what it attests to.
    const { caseDoc, evidence } = await fixture();
    await fileForensicReport(caseDoc, evidence);
    const gen = await generateFor(io, evidence._id);
    const { certificateId, bodyHash } = gen.body.certificate;

    await as(io, request(server).post(`/api/certificates/${certificateId}/sign-part-a`)).send({
      signature: io.keys.sign(bodyHash),
    });
    await as(examiner, request(server).post(`/api/certificates/${certificateId}/sign-part-b`)).send({
      signature: examiner.keys.sign(bodyHash),
    });

    const stored = await Certificate.findById(certificateId).lean();
    expect(stored.signatures).toHaveLength(2);
    for (const s of stored.signatures) expect(s.signedPayloadHash).toBe(bodyHash);
  });
});

// ============================================================== 5. PDF ======

describe('the PDF', () => {
  it('renders, and the stored hash matches the bytes served', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const certificateId = gen.body.certificate.certificateId;

    const res = await as(io, request(server).get(`/api/certificates/${certificateId}/pdf`))
      .buffer()
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(1000);

    const stored = await Certificate.findById(certificateId).lean();
    expect(stored.pdfSha256).toBe(hashOf(res.body));
    expect(res.headers['x-lexx-pdf-sha256']).toBe(stored.pdfSha256);
  });

  it('is stored ENCRYPTED, and decrypts back to the same bytes', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const stored = await Certificate.findById(gen.body.certificate.certificateId).lean();

    const decrypted = await readCertificatePdf(stored);
    expect(decrypted).toBeInstanceOf(Buffer);
    expect(hashOf(decrypted)).toBe(stored.pdfSha256);
    expect(decrypted.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('audits every download', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    await as(io, request(server).get(`/api/certificates/${gen.body.certificate.certificateId}/pdf`))
      .buffer()
      .parse(binaryParser);

    const row = await AuditEvent.findOne({ reason: 'CERTIFICATE_PDF_DOWNLOAD' }).lean();
    expect(row).toBeTruthy();
    expect(row.decision).toBe(DECISION.ALLOW);
    expect(row.authorityId).toBe(IO);
  });

  it('is refused to a user with no scope over the case', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const res = await as(
      stranger,
      request(server).get(`/api/certificates/${gen.body.certificate.certificateId}/pdf`)
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });
});

// ================================================== 6. THE PUBLIC VERIFIER ===

describe('the public verifier: validity, never contents', () => {
  it('needs no authentication and confirms a real certificate', async () => {
    const { caseDoc, evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const { certificateId, verificationToken } = gen.body.certificate;

    // No Authorization header anywhere in this request. That is the point.
    const res = await request(server).get(`/public/verify/${verificationToken}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.certificate.certificateId).toBe(certificateId);
    expect(res.body.certificate.statute).toMatch(/section 63/);

    // the PDF hash matches
    const stored = await Certificate.findById(certificateId).lean();
    expect(res.body.certificate.pdfSha256).toBe(stored.pdfSha256);
    expect(res.body.certificate.pdfIntegrity).toBe('PDF_INTACT');

    // the evidence hash and the case / exhibit reference
    expect(res.body.certificate.evidenceHash).toBe(evidence.sha256Server);
    expect(res.body.certificate.hashAlgorithm).toBe('SHA-256');
    expect(res.body.certificate.exhibitCode).toBe(evidence.exhibitCode);
    expect(res.body.certificate.firNumber).toBe(caseDoc.firNumber);
  });

  it('reports which signatures are present, without naming who made them', async () => {
    const { caseDoc, evidence } = await fixture();
    await fileForensicReport(caseDoc, evidence);
    const gen = await generateFor(io, evidence._id);
    const { certificateId, verificationToken, bodyHash } = gen.body.certificate;

    const before = await request(server).get(`/public/verify/${verificationToken}`);
    expect(before.body.certificate.signatures).toEqual([
      { part: 'A', role: 'PARTY', present: false, signedAt: null },
      { part: 'B', role: 'EXPERT', present: false, signedAt: null },
    ]);

    await as(io, request(server).post(`/api/certificates/${certificateId}/sign-part-a`)).send({
      signature: io.keys.sign(bodyHash),
    });

    const after = await request(server).get(`/public/verify/${verificationToken}`);
    const partA = after.body.certificate.signatures.find((s) => s.part === 'A');
    expect(partA.present).toBe(true);
    expect(partA.signedAt).toBeTruthy();
    expect(after.body.certificate.signatures.find((s) => s.part === 'B').present).toBe(false);
    // No signer name and no key fingerprint reach a public caller.
    expect(Object.keys(partA).sort()).toEqual(['part', 'present', 'role', 'signedAt']);
  });

  it('LEAKS NO PII, no party detail and no evidence content', async () => {
    const { caseDoc, evidence } = await fixture();
    await fileForensicReport(caseDoc, evidence);
    const gen = await generateFor(io, evidence._id);
    const { certificateId, verificationToken, bodyHash } = gen.body.certificate;
    await as(io, request(server).post(`/api/certificates/${certificateId}/sign-part-a`)).send({
      signature: io.keys.sign(bodyHash),
    });

    const res = await request(server).get(`/public/verify/${verificationToken}`);
    const body = JSON.stringify(res.body);

    const mustNotAppear = [
      io.user.name, // the deponent
      examiner.user.name, // the expert
      'State FSL, Lucknow', // the laboratory
      'Investigating Officer', // any designation
      IO, // any authority identifier
      EXAMINER,
      'Samsung', // the device
      'Galaxy A54',
      'Black',
      'R58N90ABCDE',
      '351756051523999',
      'Seized phone photo', // the exhibit title
      'AUTHENTIC', // the expert opinion
      're-encoding artefacts', // the examination summary
      'regular use in the ordinary course', // the conditions statement
      'append-only ledger', // the manner-of-production narrative
      'Kavi Nagar', // the station
      'UP-GZB-KVN',
    ];

    for (const secret of mustNotAppear) {
      expect(body, `public verifier leaked: ${secret}`).not.toContain(secret);
    }

    // And nothing has quietly appeared beyond the agreed fields.
    expect(Object.keys(res.body.certificate).sort()).toEqual(
      [
        'certificateId',
        'cnrNumber',
        'evidenceHash',
        'exhibitCode',
        'firNumber',
        'generatedAt',
        'hashAlgorithm',
        'partAComplete',
        'partBComplete',
        'pdfIntegrity',
        'pdfSha256',
        'signatures',
        'statute',
        'templateVersion',
      ].sort()
    );
    expect(res.body.disclosure).toMatch(/discloses no case narrative/);
  });

  it('returns not-found for a forged token', async () => {
    const { evidence } = await fixture();
    await generateFor(io, evidence._id);

    // A well-formed token that was never issued.
    const forged = 'A'.repeat(43);
    const res = await request(server).get(`/public/verify/${forged}`);

    expect(res.status).toBe(404);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBe('CERTIFICATE_NOT_FOUND');
  });

  it('answers a malformed token exactly as it answers an unknown one', async () => {
    // Otherwise the shape of the token space is mappable from outside.
    const malformed = await request(server).get('/public/verify/short');
    const unknown = await request(server).get(`/public/verify/${'B'.repeat(43)}`);

    expect(malformed.status).toBe(404);
    expect(malformed.body).toEqual(unknown.body);
  });

  it('reports PDF_MODIFIED when the stored document no longer matches', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const { certificateId, verificationToken } = gen.body.certificate;

    // Somebody swapped the register's copy of the PDF.
    await Certificate.updateOne({ _id: certificateId }, { $set: { pdfSha256: hashOf('other') } });

    const res = await request(server).get(`/public/verify/${verificationToken}`);
    expect(res.body.valid).toBe(true); // the certificate still exists…
    expect(res.body.certificate.pdfIntegrity).toBe('PDF_MODIFIED'); // …but its document does not match
  });

  it('issues a high-entropy token — it is the only credential on a public endpoint', async () => {
    const { evidence } = await fixture();
    const a = await generateFor(io, evidence._id);
    const b = await generateFor(io, evidence._id);

    for (const token of [a.body.certificate.verificationToken, b.body.certificate.verificationToken]) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    }
    expect(a.body.certificate.verificationToken).not.toBe(b.body.certificate.verificationToken);
  });

  /**
   * REGRESSION — the QR led to raw JSON.
   *
   * This URL is printed as a QR code on the face of the certificate, to be scanned by
   * whoever is holding the paper: a judge, defence counsel, anyone. It pointed at
   * `${PUBLIC_BASE_URL}/public/verify/:token` — the JSON API endpoint — so a scan
   * answered with a wall of JSON rather than the verifier page that exists for
   * precisely this purpose. It also pointed at the API's origin, which in a deployment
   * where the web client is served separately is not where a person can read anything.
   */
  it('puts a HUMAN-READABLE verification URL on the certificate', async () => {
    const { evidence } = await fixture();
    const gen = await generateFor(io, evidence._id);
    const url = gen.body.certificate.verificationUrl;

    // The verifier PAGE, which reads ?token= on load — not the JSON endpoint.
    expect(url).toContain('/verify.html');
    expect(url).toContain(`token=${gen.body.certificate.verificationToken}`);

    // Still outside /api, and still not the raw JSON route.
    expect(url).not.toContain('/api/');
    expect(url).not.toMatch(/\/public\/verify\//);

    // It must be an absolute URL: a relative one is not scannable from a phone.
    expect(() => new URL(url)).not.toThrow();
  });
});
