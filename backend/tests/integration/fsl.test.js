/**
 * FSL referral and report (F7) — collaboration across departments, with a boundary.
 *
 * Run against the REAL directory services: `labId`, `labName` and the s.79A
 * notification reference are directory facts, and the point of the test is that they
 * cannot be asserted by the officer making the referral.
 *
 * The claims under test:
 *   an examiner sees an exhibit only while a live referral to THEIR lab exists;
 *   an opinion is signed, and an unverifiable signature is refused outright;
 *   AUTHENTIC / MANIPULATED / INCONCLUSIVE is the only authenticity vocabulary, and
 *   only a lab produces it — automated triage is never touched by this flow.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Evidence } from '../../models/Evidence.js';
import { Referral } from '../../models/Referral.js';
import { Ledger } from '../../models/Ledger.js';
import { User } from '../../models/User.js';
import { createApp } from '../../app.js';
import fslRoutes, { evidenceFslRouter } from '../../routes/fsl.js';
import { activateUser } from '../helpers/client.js';
import { verifyChain } from '../../services/ledger.js';
import { drainAnalyses } from '../../services/ai/analysisService.js';
import { createGeminiStub } from '../fixtures/geminiStub.js';
import {
  LEDGER_EVENT,
  REFERRAL_STATUS,
  FORENSIC_STATUS,
  FORENSIC_OPINION,
  FSL_DISCIPLINE,
  TRIAGE_PRIORITY_ORDER,
} from '../../models/enums.js';

let mongo;
let server;
let stub;

const IO = 'UP-GZB-4471';
const SHO = 'UP-GZB-4402';
const EXAMINER = 'FSL-LKO-0091';
const LAB = 'UP-FSL-LKO';
const OTHER_LAB = 'UP-FSL-AGR';
const FIR = '0123/2026';

/**
 * The real app, with the FSL routers mounted where they will live.
 *
 * `backend/app.js` is owned by another engineer. Rather than assemble a parallel
 * middleware stack, the suite lifts the 404 and error handlers off the end of the
 * real app, mounts the routers at their production paths, and puts the handlers back.
 * Once app.js carries those `app.use` lines this does nothing.
 */
function appWithFslRoutes() {
  const app = createApp();
  const stack = app._router.stack;
  const tail = stack.splice(stack.length - 2, 2); // notFoundHandler, errorHandler
  if (!stack.some((l) => l.handle === fslRoutes)) app.use('/api/fsl', fslRoutes);
  if (!stack.some((l) => l.handle === evidenceFslRouter)) {
    app.use('/api/evidence', evidenceFslRouter);
  }
  stack.push(...tail);
  return app;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  await startDirectories(uri);

  await mongoose.connect(uri, { dbName: 'lexx_test_fsl', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();

  server = appWithFslRoutes();
  stub = createGeminiStub();
  await stub.listen(Number(process.env.GEMINI_STUB_PORT));
}, 120_000);

afterAll(async () => {
  await drainAnalyses();
  await stub.close();
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

// ---------------------------------------------------------------- helpers ----

const auth = (req, session) => req.set('Authorization', `Bearer ${session.accessToken}`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A real PNG header, so the upload's magic-byte check passes. */
const pngBytes = (tag) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`lexx-test-exhibit-${tag}`, 'utf8'),
  ]);

/** A minimal but genuinely PDF-shaped report. */
const pdfBytes = (tag) =>
  Buffer.from(`%PDF-1.7\n% forensic report ${tag}\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n`, 'utf8');

/** Open the demo case as the IO and upload one exhibit to it. */
async function caseWithExhibit(tag = 'a') {
  const io = await activateUser(server, IO);

  const created = await auth(request(server).post('/api/cases/from-fir'), io).send({
    firNumber: FIR,
  });
  expect(created.status).toBe(201);
  const caseId = created.body.case._id;

  const bytes = pngBytes(tag);
  const digest = sha256(bytes);

  const upload = await auth(request(server).post('/api/evidence/upload'), io)
    .field('caseId', caseId)
    .field('title', 'Mobile video recovered from the handset')
    .field('sha256Client', digest)
    .field('signature', io.keys.sign(digest))
    .field('sourceType', 'MOBILE')
    .attach('file', bytes, { filename: 'exhibit.png', contentType: 'image/png' });

  expect(upload.status).toBe(201);
  return { io, caseId, evidence: upload.body.evidence };
}

const refer = (session, evidenceId, body) =>
  auth(request(server).post(`/api/evidence/${evidenceId}/refer-fsl`), session).send({
    labCode: LAB,
    discipline: FSL_DISCIPLINE.MEDIA_FORENSICS,
    questionsPosed: 'Is the recording continuous, and has it been re-encoded?',
    ...body,
  });

function fileReport(session, referralId, { opinion, bytes, signature, summary }) {
  const digest = sha256(bytes);
  return auth(request(server).post(`/api/fsl/referrals/${referralId}/report`), session)
    .field('opinion', opinion)
    .field('examinationSummary', summary ?? 'Container and stream durations agree; no re-encode detected.')
    .field('reportSha256', digest)
    .field('reportSignature', signature ?? session.keys.sign(digest))
    .attach('report', bytes, { filename: 'report.pdf', contentType: 'application/pdf' });
}

/** The statement an examiner signs, recomputed exactly as the server recomputes it. */
const verdictDigest = (evidence, opinion, summary, documentSha256 = null) =>
  sha256(
    Buffer.from(
      ['LEXX-FSL-VERDICT', 'v1', evidence.exhibitCode, opinion, summary, documentSha256 ?? '-'].join('|'),
      'utf8'
    )
  );

/** Record a verdict the way the browser does: hash the statement, sign the hash. */
function recordVerdict(session, evidence, { opinion, summary = 'Examined; nothing further to report.', signature }) {
  const digest = verdictDigest(evidence, opinion, summary);
  return auth(
    request(server).post(`/api/evidence/${evidence._id}/forensic-verdict`),
    session
  ).send({
    opinion,
    examinationSummary: summary,
    verdictSha256: digest,
    verdictSignature: signature ?? session.keys.sign(digest),
  });
}

// ================================================================ referral ====

describe('an SHO refers an exhibit to a laboratory', () => {
  it('takes the lab identity from the directory, not from the request', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);

    const res = await refer(sho, evidence._id, {
      // Attacker-supplied lab facts. Every one of these must be discarded: a s.79A
      // reference asserted by the referring officer proves nothing about the lab.
      labName: 'Definitely A Real Lab',
      section79ARef: 'MADE/UP/2026/1',
      labId: 'XX-FSL-FAKE',
      status: REFERRAL_STATUS.REPORTED,
    });

    expect(res.status).toBe(201);
    expect(res.body.referral.labId).toBe(LAB);
    expect(res.body.referral.labName).toBe('State FSL, Lucknow');
    expect(res.body.referral.section79ARef).toBe('MeitY/79A/2019/17');
    expect(res.body.referral.status).toBe(REFERRAL_STATUS.OPEN);

    const stored = await Referral.findById(res.body.referral.id).lean();
    expect(stored.labId).toBe(LAB);
    expect(stored.section79ARef).toBe('MeitY/79A/2019/17');

    const exhibit = await Evidence.findById(evidence._id).lean();
    expect(exhibit.forensic.status).toBe(FORENSIC_STATUS.REFERRED);
    expect(exhibit.forensic.labId).toBe(LAB);
    expect(exhibit.forensic.opinion).toBeNull();

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.REFERRED_TO_FSL }).lean();
    expect(entry.payload.labId).toBe(LAB);
    expect(entry.payload.section79ARef).toBe('MeitY/79A/2019/17');
  });

  it('refuses a second live referral of the same exhibit to the same lab', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);

    const first = await refer(sho, evidence._id);
    expect(first.status).toBe(201);

    const second = await refer(sho, evidence._id);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_LIVE_REFERRAL');
    expect(second.body.error.details.referralId).toBe(first.body.referral.id);

    // The unique partial index held: exactly one referral exists, not two.
    expect(await Referral.countDocuments({ evidenceId: evidence._id, labId: LAB })).toBe(1);
  });

  it('refuses a lab the directory does not know', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);

    const res = await refer(sho, evidence._id, { labCode: 'XX-FSL-NOWHERE' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LAB_NOT_FOUND');
    expect(await Referral.countDocuments()).toBe(0);
  });

  it('refuses an investigating officer: referral is a supervisory decision', async () => {
    const { io, evidence } = await caseWithExhibit();

    const res = await refer(io, evidence._id);
    expect(res.status).toBe(403);
    expect(await Referral.countDocuments()).toBe(0);
  });
});

// =============================================== the examiner's own lab ====

describe("an examiner's world is the referrals to their own lab", () => {
  it('lists only their lab, never another lab’s work', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);

    const mine = await refer(sho, evidence._id);
    expect(mine.status).toBe(201);

    // The same exhibit, referred elsewhere. Written directly because the directory
    // knows only one lab — what matters is that the query is scoped, not how the row
    // arrived.
    const theirs = await Referral.create({
      caseId: evidence.caseId,
      evidenceId: evidence._id,
      exhibitCode: evidence.exhibitCode,
      labId: OTHER_LAB,
      labName: 'Regional FSL, Agra',
      section79ARef: 'MeitY/79A/2019/44',
      discipline: FSL_DISCIPLINE.MOBILE_FORENSICS,
      referredByUserId: sho.user.userId,
    });

    const res = await auth(request(server).get('/api/fsl/referrals'), examiner);
    expect(res.status).toBe(200);
    expect(res.body.labId).toBe(LAB);
    expect(res.body.referrals).toHaveLength(1);
    expect(res.body.referrals[0].id).toBe(mine.body.referral.id);
    expect(res.body.referrals.map((r) => r.id)).not.toContain(String(theirs._id));
  });

  it('denies another lab’s examiner with NO_OPEN_REFERRAL_TO_YOUR_LAB', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);
    const referral = (await refer(sho, evidence._id)).body.referral;

    // The examiner is moved to a different laboratory. Their session is unchanged;
    // authority is re-read from the database on every request, so the referral they
    // could see a moment ago is now someone else's.
    await User.updateOne({ authorityId: EXAMINER }, { $set: { 'scope.labId': OTHER_LAB } });

    const list = await auth(request(server).get('/api/fsl/referrals'), examiner);
    expect(list.status).toBe(200);
    expect(list.body.labId).toBe(OTHER_LAB);
    expect(list.body.referrals).toEqual([]);

    const acceptRes = await auth(
      request(server).post(`/api/fsl/referrals/${referral.id}/accept`),
      examiner
    );
    expect(acceptRes.status).toBe(403);
    expect(acceptRes.body.error.code).toBe('NO_OPEN_REFERRAL_TO_YOUR_LAB');

    const reportRes = await fileReport(examiner, referral.id, {
      opinion: FORENSIC_OPINION.AUTHENTIC,
      bytes: pdfBytes('foreign'),
    });
    expect(reportRes.status).toBe(403);
    expect(reportRes.body.error.code).toBe('NO_OPEN_REFERRAL_TO_YOUR_LAB');
  });

  it('refuses a police officer who is otherwise inside the case', async () => {
    // The IO passes the case-level policy and would reach the handler. Filing an
    // opinion is an act OF a laboratory, and they hold no lab scope at all.
    const { io, evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const referral = (await refer(sho, evidence._id)).body.referral;

    const accepted = await auth(
      request(server).post(`/api/fsl/referrals/${referral.id}/accept`),
      io
    );
    expect(accepted.status).toBe(403);
    expect(accepted.body.error.code).toBe('NO_OPEN_REFERRAL_TO_YOUR_LAB');

    const reported = await fileReport(io, referral.id, {
      opinion: FORENSIC_OPINION.AUTHENTIC,
      bytes: pdfBytes('io'),
    });
    expect(reported.status).toBe(403);
    expect(reported.body.error.code).toBe('NO_OPEN_REFERRAL_TO_YOUR_LAB');

    const exhibit = await Evidence.findById(evidence._id).lean();
    expect(exhibit.forensic.opinion).toBeNull();
    expect(exhibit.forensic.status).toBe(FORENSIC_STATUS.REFERRED);
  });
});

// ================================================================ workflow ====

describe('accept, then report', () => {
  it('accepting moves the exhibit to UNDER_EXAMINATION', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);
    const referral = (await refer(sho, evidence._id)).body.referral;

    const res = await auth(
      request(server).post(`/api/fsl/referrals/${referral.id}/accept`),
      examiner
    );
    expect(res.status).toBe(200);
    expect(res.body.referral.status).toBe(REFERRAL_STATUS.ACCEPTED);
    expect(res.body.referral.acceptedAt).toBeTruthy();

    const exhibit = await Evidence.findById(evidence._id).lean();
    expect(exhibit.forensic.status).toBe(FORENSIC_STATUS.UNDER_EXAMINATION);
    expect(String(exhibit.forensic.examinerUserId)).toBe(examiner.user.userId);

    // Accepting twice is not a second acceptance.
    const again = await auth(
      request(server).post(`/api/fsl/referrals/${referral.id}/accept`),
      examiner
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REFERRAL_NOT_OPEN');
  });

  it('refuses a report before the referral has been accepted', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);
    const referral = (await refer(sho, evidence._id)).body.referral;

    const res = await fileReport(examiner, referral.id, {
      opinion: FORENSIC_OPINION.INCONCLUSIVE,
      bytes: pdfBytes('early'),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REFERRAL_NOT_ACCEPTED');
  });

  it('files a signed opinion and records it as the forensic outcome', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);
    const referral = (await refer(sho, evidence._id)).body.referral;

    await auth(request(server).post(`/api/fsl/referrals/${referral.id}/accept`), examiner);

    const bytes = pdfBytes('final');
    const res = await fileReport(examiner, referral.id, {
      opinion: FORENSIC_OPINION.MANIPULATED,
      bytes,
      summary: 'Frame-level compression discontinuity across a 4 second span.',
    });

    expect(res.status).toBe(201);
    expect(res.body.referral.status).toBe(REFERRAL_STATUS.REPORTED);
    expect(res.body.forensic.opinion).toBe(FORENSIC_OPINION.MANIPULATED);
    expect(res.body.forensic.reportSha256).toBe(sha256(bytes));
    expect(res.body.forensic.section79ARef).toBe('MeitY/79A/2019/17');

    const exhibit = await Evidence.findById(evidence._id).lean();
    expect(exhibit.forensic.status).toBe(FORENSIC_STATUS.REPORT_FILED);
    expect(exhibit.forensic.opinion).toBe(FORENSIC_OPINION.MANIPULATED);
    expect(exhibit.forensic.reportSha256).toBe(sha256(bytes));
    expect(exhibit.forensic.reportFileKey).toMatch(/^[0-9a-f]{64}-[0-9a-f]{24}$/);
    expect(String(exhibit.forensic.examinerUserId)).toBe(examiner.user.userId);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.FSL_REPORT_FILED }).lean();
    expect(entry.payload.opinion).toBe(FORENSIC_OPINION.MANIPULATED);
    expect(entry.payload.labId).toBe(LAB);
    expect(entry.actorSignature).toBeTruthy();

    const chain = await verifyChain();
    expect(chain.intact).toBe(true);
  });

  it('refuses a report whose signature does not verify', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);
    const referral = (await refer(sho, evidence._id)).body.referral;
    await auth(request(server).post(`/api/fsl/referrals/${referral.id}/accept`), examiner);

    const bytes = pdfBytes('forged');

    // Another registered user's key over the right hash. It is a perfectly valid
    // ECDSA signature — just not by the person filing the opinion.
    const forged = sho.keys.sign(sha256(bytes));

    const res = await fileReport(examiner, referral.id, {
      opinion: FORENSIC_OPINION.AUTHENTIC,
      bytes,
      signature: forged,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');

    const exhibit = await Evidence.findById(evidence._id).lean();
    expect(exhibit.forensic.opinion).toBeNull();
    expect(exhibit.forensic.status).toBe(FORENSIC_STATUS.UNDER_EXAMINATION);

    // The attempt is a finding, and it is permanent.
    const exception = await Ledger.findOne({
      eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION,
    }).lean();
    expect(exception.payload.reason).toBe('SIGNATURE_INVALID');
    expect(exception.payload.stage).toBe('FSL_REPORT');
  });

  it('refuses a report whose bytes do not match the hash that was signed', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);
    const referral = (await refer(sho, evidence._id)).body.referral;
    await auth(request(server).post(`/api/fsl/referrals/${referral.id}/accept`), examiner);

    const signedBytes = pdfBytes('signed');
    const sentBytes = pdfBytes('swapped');
    const digest = sha256(signedBytes);

    const res = await auth(
      request(server).post(`/api/fsl/referrals/${referral.id}/report`),
      examiner
    )
      .field('opinion', FORENSIC_OPINION.AUTHENTIC)
      .field('examinationSummary', 'No indicators of manipulation.')
      .field('reportSha256', digest)
      .field('reportSignature', examiner.keys.sign(digest))
      .attach('report', sentBytes, { filename: 'report.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REPORT_HASH_MISMATCH');
  });

  it('refuses an opinion outside the controlled vocabulary', async () => {
    const { evidence } = await caseWithExhibit();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);
    const referral = (await refer(sho, evidence._id)).body.referral;
    await auth(request(server).post(`/api/fsl/referrals/${referral.id}/accept`), examiner);

    for (const opinion of ['VERIFIED', 'GENUINE', 'HIGH', 'FAKE']) {
      const res = await fileReport(examiner, referral.id, { opinion, bytes: pdfBytes(opinion) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

// ================================================ triage and opinion apart ====

describe('the Gemini analysis and the forensic opinion are separate claims', () => {
  it('leaves the Gemini analysis untouched through referral, acceptance and report', async () => {
    const { evidence } = await caseWithExhibit('STUB:HIGH separate');
    await drainAnalyses();
    const sho = await activateUser(server, SHO);
    const examiner = await activateUser(server, EXAMINER);

    const before = (await Evidence.findById(evidence._id).lean()).aiAnalysis;
    expect(before.status).toBe('COMPLETED');
    expect(before.disclaimer).toMatch(/not expert opinion under BSA s\.39/i);

    const referral = (await refer(sho, evidence._id)).body.referral;
    await auth(request(server).post(`/api/fsl/referrals/${referral.id}/accept`), examiner);
    const filed = await fileReport(examiner, referral.id, {
      opinion: FORENSIC_OPINION.AUTHENTIC,
      bytes: pdfBytes('analysis-check'),
    });
    expect(filed.status).toBe(201);

    const after = (await Evidence.findById(evidence._id).lean()).aiAnalysis;
    expect(after).toEqual(before);

    // And no ledger event in this flow carries an AI claim.
    const entries = await Ledger.find({
      eventType: {
        $in: [
          LEDGER_EVENT.REFERRED_TO_FSL,
          LEDGER_EVENT.FSL_EXAMINATION_STARTED,
          LEDGER_EVENT.FSL_REPORT_FILED,
        ],
      },
    }).lean();
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.payload.triagePriority).toBeUndefined();
      expect(e.payload.aiAnalysis).toBeUndefined();
      expect(e.payload.deepfakeScore).toBeUndefined();
    }
  });
});

// ========================================================== review queue ====

/**
 * The queue the automatic review priority exists for.
 *
 * Before this, an exhibit reached a laboratory only when a police supervisor
 * remembered to refer it — so the exhibits most likely to be manipulated sat in a
 * station queue, unseen, and the priority computed for them at ingest had no
 * audience at all. The laboratory now sees the digital evidence registered in the
 * state it serves, in the order the system says it should be looked at.
 */
describe('the laboratory review queue', () => {
  it('lists evidence never referred to anyone, in the priority Gemini recommended', async () => {
    const { caseId, io } = await caseWithExhibit('STUB:LOW queue-1');
    const bytes = pngBytes('STUB:CRITICAL queue-2');
    const digest = sha256(bytes);
    await auth(request(server).post('/api/evidence/upload'), io)
      .field('caseId', caseId)
      .field('title', 'Forwarded clip')
      .field('sha256Client', digest)
      .field('signature', io.keys.sign(digest))
      .field('sourceType', 'MOBILE')
      .attach('file', bytes, { filename: 'whatsapp-forward.png', contentType: 'image/png' });
    await drainAnalyses();

    const examiner = await activateUser(server, EXAMINER);
    const res = await auth(request(server).get('/api/fsl/queue'), examiner);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.labId).toBe(LAB);
    expect(res.body.queue.length).toBe(2);
    expect(res.body.queue.map((x) => x.aiAnalysis.triagePriority)).toEqual(['CRITICAL', 'LOW']);
    expect(res.body.uiLabel).toBe('Review priority (AI)');
    expect(res.body.disclaimer).toMatch(/not expert opinion/i);
    // The provider is persisted for the record, never sent.
    for (const item of res.body.queue) {
      expect(item.aiAnalysis).not.toHaveProperty('provider');
      expect(item.aiAnalysis).not.toHaveProperty('model');
    }
    expect(JSON.stringify(res.body)).not.toMatch(/gemini|google/i);
    expect(TRIAGE_PRIORITY_ORDER).toContain(res.body.queue[0].aiAnalysis.triagePriority);
  });

  it('counts the pending work by band, and never counts finished work into it', async () => {
    const { evidence } = await caseWithExhibit('counts');
    const examiner = await activateUser(server, EXAMINER);

    const before = await auth(request(server).get('/api/fsl/queue'), examiner);
    expect(before.body.counts.pending).toBe(1);
    expect(before.body.counts.reviewed).toBe(0);

    await recordVerdict(examiner, evidence, { opinion: FORENSIC_OPINION.AUTHENTIC });

    const after = await auth(request(server).get('/api/fsl/queue'), examiner);
    expect(after.body.counts.pending).toBe(0);
    expect(after.body.counts.reviewed).toBe(1);
    // A band with nothing left to do in it reads as zero, not as history.
    expect(Object.values(after.body.counts.byPriority).every((n) => n === 0)).toBe(true);
  });

  it('shows nobody else the laboratory queue', async () => {
    await caseWithExhibit('scope');
    const sho = await activateUser(server, SHO);
    const res = await auth(request(server).get('/api/fsl/queue'), sho);
    // Police hold no lab scope, so the queue is empty — the policy answering, not
    // an empty register.
    expect(res.status).toBe(200);
    expect(res.body.queue).toEqual([]);
    expect(res.body.labId).toBeNull();
  });
});

// ============================================================== verdict ====

/**
 * The whole of the laboratory's act, in one step.
 *
 * The refer/accept/report pipeline still exists and is still right when a station
 * puts named questions to a named lab about an article it has sent. What it made
 * impossible was the simple case: an examiner looking at the queue, seeing a
 * CRITICAL exhibit nobody had thought to refer, and wanting to record what they
 * found. Three roles and two round trips stood between them and a sentence.
 *
 * What does not change: the vocabulary, the signature, and the ledger entry.
 */
describe('a direct forensic verdict', () => {
  it('records a signed opinion with no referral in sight', async () => {
    const { evidence } = await caseWithExhibit('verdict');
    const examiner = await activateUser(server, EXAMINER);

    const res = await recordVerdict(examiner, evidence, {
      opinion: FORENSIC_OPINION.MANIPULATED,
      summary: 'Re-encoding artefacts at frame boundaries consistent with a splice.',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.forensic.opinion).toBe(FORENSIC_OPINION.MANIPULATED);
    expect(res.body.forensic.basis).toBe('DIRECT_REVIEW');
    // The lab's identity is a directory fact, never a request field.
    expect(res.body.forensic.labId).toBe(LAB);
    expect(res.body.forensic.section79ARef).toBe('MeitY/79A/2019/17');

    const stored = await Evidence.findById(evidence._id).lean();
    expect(stored.forensic.opinion).toBe(FORENSIC_OPINION.MANIPULATED);
    expect(stored.forensic.status).toBe(FORENSIC_STATUS.REPORT_FILED);
    expect(stored.forensic.examinerName).toBeTruthy();

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.FSL_REPORT_FILED }).lean();
    expect(entry.payload.opinion).toBe(FORENSIC_OPINION.MANIPULATED);
    expect(entry.payload.basis).toBe('DIRECT_REVIEW');
    expect((await verifyChain()).intact).toBe(true);
  });

  it('refuses a signature that does not verify, and logs the attempt', async () => {
    const { evidence } = await caseWithExhibit('forged');
    const examiner = await activateUser(server, EXAMINER);

    const res = await recordVerdict(examiner, evidence, {
      opinion: FORENSIC_OPINION.AUTHENTIC,
      signature: 'f'.repeat(128),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION })).toBe(1);
    expect((await Evidence.findById(evidence._id).lean()).forensic.opinion).toBeNull();
  });

  it('refuses a digest that is not the digest of the verdict that arrived', async () => {
    const { evidence } = await caseWithExhibit('swapped');
    const examiner = await activateUser(server, EXAMINER);

    // Sign a digest of one opinion, then send another. The server recomputes the
    // statement from what it received, so the two cannot be separated.
    const honest = verdictDigest(evidence, FORENSIC_OPINION.AUTHENTIC, 'Nothing to report.');
    const res = await auth(
      request(server).post(`/api/evidence/${evidence._id}/forensic-verdict`),
      examiner
    ).send({
      opinion: FORENSIC_OPINION.MANIPULATED,
      examinationSummary: 'Nothing to report.',
      verdictSha256: honest,
      verdictSignature: examiner.keys.sign(honest),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERDICT_HASH_MISMATCH');
  });

  it('refuses everyone who is not a laboratory', async () => {
    const { evidence, io } = await caseWithExhibit('who');
    const sho = await activateUser(server, SHO);

    for (const who of [io, sho]) {
      const res = await recordVerdict(who, evidence, { opinion: FORENSIC_OPINION.AUTHENTIC });
      expect(res.status, 'only a laboratory produces an authenticity opinion').toBe(403);
    }
    expect((await Evidence.findById(evidence._id).lean()).forensic.opinion).toBeNull();
  });

  it('does not read or write the Gemini analysis — the two claims stay separate', async () => {
    const { evidence } = await caseWithExhibit('STUB:MEDIUM separate');
    await drainAnalyses();
    const examiner = await activateUser(server, EXAMINER);
    const before = (await Evidence.findById(evidence._id).lean()).aiAnalysis;

    await recordVerdict(examiner, evidence, { opinion: FORENSIC_OPINION.INCONCLUSIVE });

    const after = (await Evidence.findById(evidence._id).lean()).aiAnalysis;
    expect(after).toEqual(before);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.FSL_REPORT_FILED }).lean();
    expect(entry.payload.triagePriority).toBeUndefined();
    expect(entry.payload.aiAnalysis).toBeUndefined();
  });

  it('refuses a second verdict — the first stays the official finding', async () => {
    const { evidence } = await caseWithExhibit('twice');
    const examiner = await activateUser(server, EXAMINER);
    expect((await recordVerdict(examiner, evidence, { opinion: FORENSIC_OPINION.MANIPULATED })).status).toBe(201);
    const second = await recordVerdict(examiner, evidence, { opinion: FORENSIC_OPINION.AUTHENTIC });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('VERDICT_ALREADY_RECORDED');
    expect((await Evidence.findById(evidence._id).lean()).forensic.opinion).toBe(FORENSIC_OPINION.MANIPULATED);
  });

  it('closes any referral the laboratory still had open on the exhibit', async () => {
    const { evidence } = await caseWithExhibit('closes');
    const sho = await activateUser(server, SHO);
    const referred = await refer(sho, evidence._id);
    expect(referred.status).toBe(201);

    const examiner = await activateUser(server, EXAMINER);
    await recordVerdict(examiner, evidence, { opinion: FORENSIC_OPINION.AUTHENTIC });

    // Otherwise the same work reads as outstanding on one screen and finished on
    // another.
    const stored = await Referral.findById(referred.body.referral.id).lean();
    expect(stored.status).toBe(REFERRAL_STATUS.REPORTED);
  });
});

// ======================================================= grouped by case ====

describe('GET /api/fsl/cases — the laboratory sees the case first, then its evidence', () => {
  it('groups exhibits under their case, most urgent first, with custody and certificate state', async () => {
    const { caseId, io } = await caseWithExhibit('STUB:MEDIUM grouped-1');
    const bytes = pngBytes('STUB:CRITICAL grouped-2');
    const digest = sha256(bytes);
    const second = await auth(request(server).post('/api/evidence/upload'), io)
      .field('caseId', caseId)
      .field('title', 'Second clip')
      .field('sha256Client', digest)
      .field('signature', io.keys.sign(digest))
      .field('sourceType', 'MOBILE')
      .attach('file', bytes, { filename: 'second.png', contentType: 'image/png' });
    expect(second.status).toBe(201);
    await drainAnalyses();

    const examiner = await activateUser(server, EXAMINER);
    const res = await auth(request(server).get('/api/fsl/cases'), examiner);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cases).toHaveLength(1);

    const [group] = res.body.cases;
    expect(group.case.firNumber).toBe(FIR);
    expect(group.case.stageLabel).toBe('Under investigation');
    expect(group.highestPriority).toBe('CRITICAL');
    expect(group.evidence.map((e) => e.aiAnalysis.triagePriority)).toEqual(['CRITICAL', 'MEDIUM']);
    expect(group.summary).toMatchObject({ exhibits: 2, awaitingVerdict: 2, verdicts: 0 });
    for (const e of group.evidence) {
      expect(e).toHaveProperty('physicalCustody');
      expect(e).toHaveProperty('certificate');
      expect(e.forensic.status).toBe(FORENSIC_STATUS.NOT_REFERRED);
    }
  });

  it('shows police no laboratory work', async () => {
    await caseWithExhibit('police');
    const sho = await activateUser(server, SHO);
    const res = await auth(request(server).get('/api/fsl/cases'), sho);
    expect(res.status).toBe(200);
    expect(res.body.cases).toEqual([]);
    expect(res.body.labId).toBeNull();
  });
});
