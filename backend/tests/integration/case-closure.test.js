/**
 * Closing a case with a signed document, and lifecycles that explain themselves.
 *
 *   1. The court may attach a signed PDF (final judgment, declaration or order) when it
 *      closes a case. The PDF is hashed and signed in the judge's browser; the server
 *      re-hashes it, verifies the signature against the judge's registered device key,
 *      seals it in the vault and records its digest in the CASE_CLOSED ledger entry.
 *      Any failed check writes nothing.
 *   2. Every lifecycle entry — case strip, authenticated exhibit lifecycle, public
 *      lifecycle — carries a description, the actor and verifiable proofs read from the
 *      ledger. The public variant carries no notes and no opinion.
 *
 * Run against the REAL directory services, as one sequence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Case } from '../../models/Case.js';
import { Evidence } from '../../models/Evidence.js';
import { Ledger } from '../../models/Ledger.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { createApp } from '../../app.js';
import { asUser, makeBrowserKeyPair } from '../helpers/client.js';
import { drainAnalyses } from '../../services/ai/analysisService.js';
import { runAnchorCycle } from '../../services/anchor.js';
import { CASE_ACTION, CASE_STAGE, LEDGER_EVENT } from '../../models/enums.js';

let mongo;
let server;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n${'.'.repeat(256)}\n%%EOF\n`, 'utf8');

const COGNIZANCE_NOTE = 'Chargesheet and documents perused; cognizance taken.';
const TRIAL_NOTE = 'Charges framed and read over to the accused.';
const CLOSE_NOTE = 'Judgment pronounced; the accused is acquitted of all charges.';
const VERDICT_SUMMARY = 'Frame-level examination found a splice consistent with an inserted segment.';

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);
const post = (session, path, body = {}) => as(session, request(server).post(path)).send(body);
const get = (session, path) => as(session, request(server).get(path));
const act = (session, caseId, action, note) =>
  post(session, `/api/cases/${caseId}/transition`, { action, ...(note ? { note } : {}) });

/** Parse a binary response body into a Buffer. */
const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

/** Close as the browser would: hash the PDF, sign the hex digest, send both with the file. */
function closeWith(session, caseId, opts = {}) {
  const bytes = opts.bytes ?? pdf('final judgment');
  const sha = opts.sha ?? sha256(bytes);
  const signature = opts.signature ?? session.keys.sign(sha);
  let req = as(session, request(server).post(`/api/cases/${caseId}/transition`))
    .field('action', 'CLOSE_CASE')
    .field('note', opts.note ?? CLOSE_NOTE);
  if (opts.kind !== null) req = req.field('documentKind', opts.kind ?? 'FINAL_JUDGMENT');
  req = req.field('documentSha256', sha).field('documentSignature', signature);
  return req.attach('document', bytes, {
    filename: opts.filename ?? 'judgment.pdf',
    contentType: opts.contentType ?? 'application/pdf',
  });
}

const s = {};
const c = {};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_case_closure', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();

  s.io = await asUser(server, 'UP-GZB-4471');
  s.examiner = await asUser(server, 'FSL-LKO-0091');
  s.court = await asUser(server, 'UP-JUD-1180');
  s.advocate = await asUser(server, 'UP/1234/2015');
  s.stranger = await asUser(server, 'UP/9876/2019');

  // ---- FIR 0124/2026, Magistrate-triable, all the way to trial ----
  const created = await post(s.io, '/api/cases/from-fir', { firNumber: '0124/2026' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  c.caseId = created.body.case._id;
  expect(created.body.case.closure).toBeNull();

  const bytes = Buffer.concat([PNG, Buffer.from('Photograph of the handset'.padEnd(96, '.'))]);
  const sha = sha256(bytes);
  const up = await as(s.io, request(server).post('/api/evidence/upload'))
    .field('caseId', c.caseId)
    .field('title', 'Photograph of the handset')
    .field('description', 'SECRET-DESCRIPTION of where the handset was found')
    .field('sha256Client', sha)
    .field('signature', s.io.keys.sign(sha))
    .field('sourceType', 'MOBILE')
    .attach('file', bytes, { filename: 'h.png', contentType: 'image/png' });
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  c.evidence = up.body.evidence;
  await drainAnalyses();

  const statement = ['LEXX-FSL-VERDICT', 'v1', c.evidence.exhibitCode, 'MANIPULATED', VERDICT_SUMMARY, '-'].join('|');
  const digest = sha256(Buffer.from(statement, 'utf8'));
  const verdict = await as(s.examiner, request(server).post(`/api/evidence/${c.evidence._id}/forensic-verdict`))
    .field('opinion', 'MANIPULATED')
    .field('examinationSummary', VERDICT_SUMMARY)
    .field('verdictSha256', digest)
    .field('verdictSignature', s.examiner.keys.sign(digest));
  expect(verdict.status, JSON.stringify(verdict.body)).toBe(201);

  const filed = await post(s.io, `/api/cases/${c.caseId}/file-chargesheet`);
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  c.cnr = filed.body.case.cnrNumber;

  expect((await act(s.court, c.caseId, CASE_ACTION.TAKE_COGNIZANCE, COGNIZANCE_NOTE)).status).toBe(200);

  const vbytes = pdf(`vakalatnama ${s.advocate.authorityId}`);
  const vsha = sha256(vbytes);
  const vak = await as(s.advocate, request(server).post('/api/vakalatnama'))
    .field('cnrNumber', c.cnr)
    .field('appearingFor', 'ACCUSED')
    .field('partyName', 'Mohit Kumar')
    .field('documentSha256', vsha)
    .field('documentSignature', s.advocate.keys.sign(vsha))
    .attach('document', vbytes, { filename: 'v.pdf', contentType: 'application/pdf' });
  expect(vak.status, JSON.stringify(vak.body)).toBe(201);
  expect((await post(s.court, `/api/vakalatnama/${vak.body.filing.id}/accept`)).status).toBe(200);

  expect((await act(s.court, c.caseId, CASE_ACTION.BEGIN_TRIAL, TRIAL_NOTE)).status).toBe(200);
}, 240_000);

afterAll(async () => {
  await drainAnalyses();
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

/** Nothing about the case moved, and nothing was recorded as a closing. */
async function expectNothingWritten() {
  const doc = await Case.findById(c.caseId).select('+closure.storageKey').lean();
  expect(doc.stage).toBe(CASE_STAGE.TRIAL);
  expect(doc.closure ?? null).toBeNull();
  expect(doc.closedOn).toBeNull();
  expect(await Ledger.countDocuments({ caseId: c.caseId, eventType: LEDGER_EVENT.CASE_CLOSED })).toBe(0);
}

// ================================================ 1. refusals write nothing ====

describe('closing with a document refuses anything it cannot verify', () => {
  it('refuses a file that is not a PDF by its bytes', async () => {
    const png = Buffer.concat([PNG, Buffer.from('not a judgment'.padEnd(96, '.'))]);
    const res = await closeWith(s.court, c.caseId, { bytes: png, filename: 'judgment.pdf' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CLOSURE_DOCUMENT_NOT_PDF');
    await expectNothingWritten();
  });

  it('refuses a document without its kind', async () => {
    const res = await closeWith(s.court, c.caseId, { kind: null });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CLOSURE_DOCUMENT_KIND_REQUIRED');
    await expectNothingWritten();
  });

  it('refuses bytes that are not the bytes whose hash was signed', async () => {
    const signedFor = pdf('the version the judge signed');
    const sha = sha256(signedFor);
    const res = await closeWith(s.court, c.caseId, {
      bytes: pdf('a different version'),
      sha,
      signature: s.court.keys.sign(sha),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('HASH_MISMATCH');
    await expectNothingWritten();
  });

  it('refuses a signature made by any key but the judge’s registered one, and audits it', async () => {
    const bytes = pdf('judgment signed elsewhere');
    const sha = sha256(bytes);
    const res = await closeWith(s.court, c.caseId, { bytes, sha, signature: makeBrowserKeyPair().sign(sha) });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');
    await expectNothingWritten();
    expect(await AuditEvent.countDocuments({ caseId: c.caseId, reason: 'SIGNATURE_INVALID', decision: 'DENY' })).toBe(1);
  });

  it('refuses a document over 20 MB', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20 * 1024 * 1024 + 16, 0x20)]);
    const res = await closeWith(s.court, c.caseId, { bytes: big, sha: 'a'.repeat(64), signature: 'b'.repeat(128) });
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body.error.code).toBe('CLOSURE_DOCUMENT_TOO_LARGE');
    await expectNothingWritten();
  }, 60_000);

  it('refuses a document attached to any act other than closing', async () => {
    const bytes = pdf('order');
    const sha = sha256(bytes);
    const res = await as(s.court, request(server).post(`/api/cases/${c.caseId}/transition`))
      .field('action', 'BEGIN_TRIAL')
      .field('documentKind', 'ORDER')
      .field('documentSha256', sha)
      .field('documentSignature', s.court.keys.sign(sha))
      .attach('document', bytes, { filename: 'o.pdf', contentType: 'application/pdf' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expectNothingWritten();
  });

  it('refuses the police, before reading the upload', async () => {
    const res = await closeWith(s.io, c.caseId, {});
    expect(res.status).toBe(403);
    await expectNothingWritten();
  });
});

// ================================================ 2. a signed closing ====

describe('the court closes the case with a signed final judgment', () => {
  const judgment = pdf('FINAL JUDGMENT — State v. Mohit Kumar');
  const judgmentSha = sha256(judgment);

  beforeAll(async () => {
    // The browser may send the P1363 signature as base64 too.
    const signature = Buffer.from(s.court.keys.sign(judgmentSha), 'hex').toString('base64');
    const res = await closeWith(s.court, c.caseId, { bytes: judgment, signature, filename: 'judgment 0124.pdf' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    c.closed = res.body;
    await runAnchorCycle();
  }, 60_000);

  it('closes the case and returns the closure view, with no storage or key material', () => {
    expect(c.closed.case.stage).toBe(CASE_STAGE.CLOSED);
    expect(c.closed.case.closure).toEqual({
      kind: 'FINAL_JUDGMENT',
      kindLabel: 'Final judgment',
      fileName: 'judgment 0124.pdf',
      sizeBytes: judgment.length,
      sha256: judgmentSha,
      signedBy: { name: s.court.user.name, roleLabel: 'Court', authorityId: 'UP-JUD-1180' },
      signerKeyFingerprint: s.court.user.publicKeyFingerprint,
      uploadedAt: expect.any(String),
      note: CLOSE_NOTE,
      hasDocument: true,
    });
    const body = JSON.stringify(c.closed);
    for (const leak of ['storageKey', 'signerPublicKeyJwk', '"signature"', 'wrappedDek']) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it('stores the digest in the ledger and seals the document in the vault', async () => {
    const entry = await Ledger.findOne({ caseId: c.caseId, eventType: LEDGER_EVENT.CASE_CLOSED }).lean();
    expect(entry.seq).toBe(c.closed.ledgerSeq);
    expect(entry.payload.reason).toBe(CLOSE_NOTE);
    expect(entry.payload.closureDocument).toEqual({
      kind: 'FINAL_JUDGMENT',
      sha256: judgmentSha,
      signerKeyFingerprint: s.court.user.publicKeyFingerprint,
    });
    expect(entry.actorSignature).toMatch(/^[0-9a-f]{128}$/);

    const stored = await Case.findById(c.caseId).select('+closure.storageKey').lean();
    expect(stored.closure.storageKey).toBeTruthy();
    expect(stored.closure.signature).toBe(entry.actorSignature);
    // Not selected by default.
    expect((await Case.findById(c.caseId).lean()).closure.storageKey).toBeUndefined();
  });

  for (const who of ['court', 'io', 'advocate']) {
    it(`gives ${who} the identical bytes, with the digest header, and audits the download`, async () => {
      const before = await AuditEvent.countDocuments({ caseId: c.caseId, reason: 'CLOSURE_DOCUMENT_DOWNLOAD' });
      const res = await binary(get(s[who], `/api/cases/${c.caseId}/closure-document`));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toMatch(/^inline; filename="judgment 0124\.pdf"/);
      expect(res.headers['x-lexx-sha256']).toBe(judgmentSha);
      expect(Buffer.compare(res.body, judgment)).toBe(0);
      expect(await AuditEvent.countDocuments({ caseId: c.caseId, reason: 'CLOSURE_DOCUMENT_DOWNLOAD' })).toBe(before + 1);
    });
  }

  it('refuses an advocate who is not on record', async () => {
    const res = await get(s.stranger, `/api/cases/${c.caseId}/closure-document`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ON_RECORD_FOR_THIS_CASE');
  });

  it('shows the closure on the case list, the case, the overview and the workflow — to counsel too', async () => {
    const list = await get(s.advocate, '/api/cases');
    const row = list.body.cases.find((x) => x._id === c.caseId);
    expect(row.closure).toMatchObject({ kind: 'FINAL_JUDGMENT', hasDocument: true, sha256: judgmentSha });

    for (const path of [`/api/cases/${c.caseId}`, `/api/cases/${c.caseId}/overview`]) {
      const res = await get(s.advocate, path);
      expect(res.status, path).toBe(200);
      expect(res.body.case.closure, path).toMatchObject({ kindLabel: 'Final judgment', note: CLOSE_NOTE });
      expect(JSON.stringify(res.body), path).not.toContain('storageKey');
    }

    // Counsel's lifecycle timeline reads the workflow, and the closure beside it.
    const workflow = await get(s.advocate, `/api/cases/${c.caseId}/workflow`);
    expect(workflow.status).toBe(200);
    expect(workflow.body.closure).toEqual(c.closed.case.closure);
    expect(workflow.body.workflow.lifecycle.find((x) => x.key === 'CLOSED').description).toContain('Final judgment attached');

    const caseFile = await get(s.advocate, `/api/disclosure/case-file/${c.caseId}`);
    expect(caseFile.status, JSON.stringify(caseFile.body)).toBe(200);
    expect(caseFile.body.closure).toEqual(c.closed.case.closure);
    expect(JSON.stringify(caseFile.body)).not.toContain('storageKey');
  });

  it('refuses a second closing', async () => {
    const res = await closeWith(s.court, c.caseId, {});
    expect(res.status).toBe(403);
  });
});

// ================================================ 3. lifecycle details ====

/** Every entry, wherever returned, has the full shape. */
function expectEntryShape(entry) {
  expect(typeof entry.key).toBe('string');
  expect(typeof entry.label).toBe('string');
  expect(['done', 'current', 'upcoming', 'not_applicable']).toContain(entry.state);
  expect(entry).toHaveProperty('at');
  expect(typeof entry.description).toBe('string');
  expect(entry.description.length).toBeGreaterThan(5);
  expect(entry).toHaveProperty('actor');
  expect(Array.isArray(entry.proofs)).toBe(true);
  for (const p of entry.proofs) {
    expect(typeof p.label).toBe('string');
    expect(typeof p.value).toBe('string');
    expect(['hash', 'key', 'ledger', 'anchor', 'text']).toContain(p.kind);
  }
}

const ledgerProof = (entry) => entry.proofs.find((p) => p.kind === 'ledger');

describe('the case strip explains every step', () => {
  it('describes each milestone from the ledger, with who did it, the notes and the proofs', async () => {
    const res = await get(s.court, `/api/cases/${c.caseId}/workflow`);
    expect(res.status).toBe(200);
    const strip = res.body.workflow.lifecycle;
    expect(strip.map((x) => x.stage)).toEqual([
      'UNDER_INVESTIGATION',
      'CHARGESHEET_FILED',
      'COGNIZANCE_TAKEN',
      'COMMITTED',
      'TRIAL',
      'CLOSED',
    ]);
    strip.forEach(expectEntryShape);
    const by = Object.fromEntries(strip.map((x) => [x.key, x]));

    const created = await Ledger.findOne({ caseId: c.caseId, eventType: LEDGER_EVENT.CASE_CREATED }).lean();
    expect(by.UNDER_INVESTIGATION.description).toMatch(/Case opened from FIR 0124\/2026/);
    expect(by.UNDER_INVESTIGATION.actor).toEqual({ name: s.io.user.name, roleLabel: 'Investigating Officer', authorityId: 'UP-GZB-4471' });
    expect(ledgerProof(by.UNDER_INVESTIGATION)).toEqual({ label: `Ledger entry #${created.seq}`, value: created.entryHash, kind: 'ledger' });

    expect(by.CHARGESHEET_FILED.description).toMatch(new RegExp(`Filed by ${s.io.user.name}.*CNR ${c.cnr} allotted`));

    const cognizance = await Ledger.findOne({ caseId: c.caseId, 'payload.action': CASE_ACTION.TAKE_COGNIZANCE }).lean();
    expect(by.COGNIZANCE_TAKEN.description).toContain(`Recorded by ${s.court.user.name} (Court).`);
    expect(by.COGNIZANCE_TAKEN.description).toContain(COGNIZANCE_NOTE);
    expect(ledgerProof(by.COGNIZANCE_TAKEN).value).toBe(cognizance.entryHash);
    expect(by.COMMITTED.state).toBe('not_applicable');
    expect(by.COMMITTED.proofs).toEqual([]);
    expect(by.TRIAL.description).toContain(TRIAL_NOTE);

    const closedEntry = await Ledger.findOne({ caseId: c.caseId, eventType: LEDGER_EVENT.CASE_CLOSED }).lean();
    expect(by.CLOSED.description).toContain(`Closed by ${s.court.user.name}.`);
    expect(by.CLOSED.description).toContain('Final judgment attached (signed with the judge’s device key).');
    expect(by.CLOSED.description).toContain(CLOSE_NOTE);
    expect(by.CLOSED.proofs.find((p) => p.kind === 'hash').value).toBe(c.closed.case.closure.sha256);
    expect(by.CLOSED.proofs.find((p) => p.kind === 'key').value).toBe(s.court.user.publicKeyFingerprint);
    expect(ledgerProof(by.CLOSED)).toEqual({ label: `Ledger entry #${closedEntry.seq}`, value: closedEntry.entryHash, kind: 'ledger' });
    // The anchor cycle ran after closing, in DRY_RUN.
    expect(by.CLOSED.proofs.find((p) => p.kind === 'anchor').value).toMatch(/^Recorded locally \(dry run\) in batch 0x[0-9a-f]+$/);

    const overview = await get(s.io, `/api/cases/${c.caseId}/overview`);
    expect(overview.body.workflow.lifecycle).toEqual(strip);
  });
});

describe('GET /api/evidence/:id/lifecycle', () => {
  it('describes the exhibit milestone by milestone, with the proofs, to anyone who may read the exhibit', async () => {
    const evidence = await Evidence.findById(c.evidence._id).lean();
    const uploadEntry = await Ledger.findOne({ seq: evidence.ledgerSeq }).lean();

    for (const who of ['io', 'court', 'advocate']) {
      const res = await get(s[who], `/api/evidence/${c.evidence._id}/lifecycle`);
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.evidenceId).toBe(c.evidence._id);
      expect(res.body.exhibitCode).toBe(c.evidence.exhibitCode);
      res.body.lifecycle.forEach(expectEntryShape);

      const by = Object.fromEntries(res.body.lifecycle.map((x) => [x.key, x]));
      expect(by.UPLOADED.description).toMatch(new RegExp(`^Uploaded by ${s.io.user.name} \\(Investigating Officer, UP-GZB-4471\\)\\.`));
      expect(by.UPLOADED.proofs.slice(0, 3)).toEqual([
        { label: 'Evidence SHA-256', value: evidence.sha256Server, kind: 'hash' },
        { label: 'Uploader key fingerprint', value: evidence.signerPubKeyFingerprint, kind: 'key' },
        { label: `Ledger entry #${uploadEntry.seq}`, value: uploadEntry.entryHash, kind: 'ledger' },
      ]);
      expect(by.CERTIFICATE_ISSUED.description).toMatch(/LEXX Certificate Authority on behalf of/);
      expect(by.CERTIFICATE_ISSUED.proofs.map((p) => p.label)).toEqual(
        expect.arrayContaining(['Certificate PDF SHA-256', 'Authority key fingerprint'])
      );
      expect(by.FORENSIC_EXAMINATION.description).toContain(`by ${s.examiner.user.name}`);
      expect(by.FORENSIC_EXAMINATION.description).toContain('Verdict recorded');
      expect(by.COGNIZANCE_TAKEN.description).toContain(COGNIZANCE_NOTE);
      expect(by.CLOSED.description).toContain('Final judgment attached');

      const body = JSON.stringify(res.body);
      for (const secret of ['MANIPULATED', VERDICT_SUMMARY, 'aiAnalysis', 'SECRET-DESCRIPTION']) {
        expect(body, `${who} lifecycle leaked ${secret}`).not.toContain(secret);
      }
    }
  });

  it('refuses whoever may not read the exhibit', async () => {
    const res = await get(s.stranger, `/api/evidence/${c.evidence._id}/lifecycle`);
    expect(res.status).toBe(403);
  });
});

describe('the public lifecycle carries the proofs but no notes and no opinion', () => {
  it('describes every milestone on the scanned label without the court’s notes or the verdict', async () => {
    const res = await request(server).get(`/public/evidence/${c.evidence.label.token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    res.body.lifecycle.forEach(expectEntryShape);
    const by = Object.fromEntries(res.body.lifecycle.map((x) => [x.key, x]));

    expect(by.UPLOADED.actor.authorityId).toBe('UP-GZB-4471');
    expect(by.FORENSIC_EXAMINATION.description).toMatch(/^Examined at .+ by a forensic examiner\.$/);
    expect(by.FORENSIC_EXAMINATION.actor).toEqual({ name: null, roleLabel: 'Forensic Examiner', authorityId: null });
    expect(by.COGNIZANCE_TAKEN.description).toBe(`Recorded by ${s.court.user.name} (Court).`);
    expect(by.CLOSED.description).toBe(
      `Closed by ${s.court.user.name}. Final judgment attached (signed with the judge’s device key).`
    );
    expect(by.CLOSED.proofs.find((p) => p.kind === 'hash').value).toBe(c.closed.case.closure.sha256);

    const body = JSON.stringify(res.body);
    for (const secret of [
      COGNIZANCE_NOTE,
      TRIAL_NOTE,
      CLOSE_NOTE,
      'MANIPULATED',
      VERDICT_SUMMARY,
      'SECRET-DESCRIPTION',
      s.examiner.user.name,
      'storageKey',
    ]) {
      expect(body, `public lifecycle leaked ${secret}`).not.toContain(secret);
    }
  });
});

// ============================= further investigation, in the description ====

describe('a direction for further investigation appears in the investigation step', () => {
  it('names the judge and the reason', async () => {
    const created = await post(s.io, '/api/cases/from-fir', { firNumber: '0125/2026' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.case._id;
    expect((await post(s.io, `/api/cases/${id}/file-chargesheet`)).status).toBe(200);
    expect((await act(s.court, id, CASE_ACTION.TAKE_COGNIZANCE)).status).toBe(200);
    const sent = await act(s.court, id, CASE_ACTION.DIRECT_FURTHER_INVESTIGATION, 'Call records not examined.');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const strip = sent.body.workflow.lifecycle;
    strip.forEach(expectEntryShape);
    const investigation = strip.find((x) => x.key === 'UNDER_INVESTIGATION');
    expect(investigation.state).toBe('current');
    expect(investigation.description).toMatch(
      new RegExp(`Further investigation directed by ${s.court.user.name} \\(Court\\) on \\d{4}-\\d{2}-\\d{2}: “Call records not examined\\.”`)
    );
    expect(investigation.proofs.filter((p) => p.kind === 'ledger')).toHaveLength(2);
    expect(strip.find((x) => x.key === 'CHARGESHEET_FILED').description).toMatch(/fresh chargesheet/);
  });
});
