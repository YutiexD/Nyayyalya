/**
 * The case after the chargesheet: how it reaches the Court, and how it moves there.
 *
 * The first block is the reported defect, reproduced as it happened. FIR 0124/2026 had
 * its chargesheet filed and its s.63 certificate signed by both parties, and it
 * appeared on no court screen. The jurisdiction router had (correctly) bound it to the
 * Chief Judicial Magistrate, and court access was scoped to a single bench — so the
 * one court login anyone used, the Sessions judge, could not see it, and nothing told
 * the court what to do with it anyway. The Court is now one role scoped to the
 * district, and a state machine names the next judicial act.
 *
 * Run against the REAL directory services, as one sequence per case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Ledger } from '../../models/Ledger.js';
import { createApp } from '../../app.js';
import { asUser } from '../helpers/client.js';
import { drainAnalyses } from '../../services/ai/analysisService.js';
import { createGeminiStub } from '../fixtures/geminiStub.js';
import { CASE_ACTION, CASE_STAGE, DENY_REASON, LEDGER_EVENT } from '../../models/enums.js';

let mongo;
let server;
let stub;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n${'.'.repeat(64)}\n%%EOF\n`, 'utf8');
const DEVICE = { sourceType: 'MOBILE', make: 'Apple', model: 'iPhone 15', colour: 'Blue', serialNumber: 'SN-0124', imeiOrUid: '356938035643809' };

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);
const post = (session, path, body = {}) => as(session, request(server).post(path)).send(body);
const get = (session, path) => as(session, request(server).get(path));
const act = (session, caseId, action, note) =>
  post(session, `/api/cases/${caseId}/transition`, { action, ...(note ? { note } : {}) });

async function clearCore() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
}

async function openCase(io, firNumber) {
  const res = await post(io, '/api/cases/from-fir', { firNumber });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.case;
}

async function upload(io, caseId, title) {
  const bytes = Buffer.concat([PNG, Buffer.from(title.padEnd(96, '.'))]);
  const sha = sha256(bytes);
  let req = as(io, request(server).post('/api/evidence/upload'))
    .field('caseId', caseId)
    .field('title', title)
    .field('sha256Client', sha)
    .field('signature', io.keys.sign(sha));
  for (const [k, v] of Object.entries(DEVICE)) req = req.field(k, v);
  const res = await req.attach('file', bytes, { filename: `${title}.png`, contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  // The s.63 certificate is issued automatically on upload.
  return { ...res.body.evidence, certificateId: res.body.certificate?.certificateId ?? null };
}

async function recordVerdict(examiner, evidence, opinion = 'MANIPULATED') {
  const summary = 'Frame-level examination found a splice consistent with an inserted segment.';
  const statement = ['LEXX-FSL-VERDICT', 'v1', evidence.exhibitCode, opinion, summary, '-'].join('|');
  const digest = sha256(Buffer.from(statement, 'utf8'));
  return as(examiner, request(server).post(`/api/evidence/${evidence._id}/forensic-verdict`))
    .field('opinion', opinion)
    .field('examinationSummary', summary)
    .field('verdictSha256', digest)
    .field('verdictSignature', examiner.keys.sign(digest));
}

async function fileVakalatnama(advocate, cnrNumber) {
  const bytes = pdf(`vakalatnama ${advocate.authorityId}`);
  const sha = sha256(bytes);
  return as(advocate, request(server).post('/api/vakalatnama'))
    .field('cnrNumber', cnrNumber)
    .field('appearingFor', 'ACCUSED')
    .field('partyName', 'Mohit Kumar')
    .field('documentSha256', sha)
    .field('documentSignature', advocate.keys.sign(sha))
    .attach('document', bytes, { filename: 'v.pdf', contentType: 'application/pdf' });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_case_workflow', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();
  stub = createGeminiStub();
  await stub.listen(Number(process.env.GEMINI_STUB_PORT));
}, 180_000);

afterAll(async () => {
  await drainAnalyses();
  await stub.close();
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

// ============================================== FIR 0124/2026, as reported ====

describe('FIR 0124/2026 — a filed chargesheet reaches the Court', () => {
  const s = {};
  const c = {};

  beforeAll(async () => {
    await clearCore();
    s.io = await asUser(server, 'UP-GZB-4471');
    s.examiner = await asUser(server, 'FSL-LKO-0091');
    s.sessionsJudge = await asUser(server, 'UP-JUD-2291');
    s.magistrate = await asUser(server, 'UP-JUD-1180');
    s.registry = await asUser(server, 'UP-GZB-EVC-01');
    s.advocate = await asUser(server, 'UP/1234/2015');

    c.case = await openCase(s.io, '0124/2026');
    c.ex = await upload(s.io, c.case._id, 'Photograph of the stolen handset');

    // The s.63 certificate was issued and signed by the system on upload.
    c.certificateId = c.ex.certificateId;
    expect(c.certificateId).toBeTruthy();

    const verdict = await recordVerdict(s.examiner, c.ex);
    expect(verdict.status, JSON.stringify(verdict.body)).toBe(201);

    const filed = await post(s.io, `/api/cases/${c.case._id}/file-chargesheet`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    c.filed = filed.body.case;
    expect(filed.body.workflow.nextCourtAction.action).toBe(CASE_ACTION.TAKE_COGNIZANCE);
  }, 240_000);

  it('binds the case to the Magistrate the jurisdiction router selects', () => {
    expect(c.filed.stage).toBe(CASE_STAGE.CHARGESHEET_FILED);
    expect(c.filed.courtId).toBe('UP-GZB-CJM-01');
    expect(c.filed.cnrNumber).toMatch(/^[A-Z]{2}[A-Z0-9]{2}\d{12}$/);
  });

  it('appears for EVERY Court login in the district, with "take cognizance" as the next act', async () => {
    for (const court of [s.sessionsJudge, s.magistrate, s.registry]) {
      const res = await get(court, '/api/cases');
      expect(res.status).toBe(200);
      const row = res.body.cases.find((x) => x._id === c.case._id);
      expect(row, `${court.authorityId} must see the filed case`).toBeTruthy();
      expect(row.courtName).toMatch(/Chief Judicial Magistrate/);
      expect(row.summary.workflow.nextCourtAction.action).toBe(CASE_ACTION.TAKE_COGNIZANCE);
      expect(row.summary.attention.court).toBeGreaterThan(0);
    }
  });

  it('shows the court the whole case, including the issued certificate, which verifies', async () => {
    const overview = await get(s.sessionsJudge, `/api/cases/${c.case._id}/overview`);
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.evidence).toHaveLength(1);
    expect(overview.body.evidence[0].forensic.opinion).toBe('MANIPULATED');
    expect(overview.body.evidence[0].certificate).toMatchObject({ certificateId: c.certificateId, status: 'ACTIVE' });
    expect(overview.body.evidence[0].certificate.issuedAt).toBeTruthy();
    expect(overview.body.pendingActions.map((a) => a.code)).toContain(CASE_ACTION.TAKE_COGNIZANCE);
    expect(overview.body.pendingActions.map((a) => a.code)).not.toContain('CASE_FILE_NOT_SHARED');
    expect(overview.body).not.toHaveProperty('disclosure');

    const verify = await get(s.magistrate, `/api/certificates/${c.certificateId}/verify`);
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    expect(verify.body.result).toBe('VERIFIED');
  });

  it('refuses the police any judicial act', async () => {
    const res = await act(s.io, c.case._id, CASE_ACTION.TAKE_COGNIZANCE);
    expect(res.status).toBe(403);
  });

  it('refuses to close a case the court has not taken up', async () => {
    const res = await act(s.magistrate, c.case._id, CASE_ACTION.CLOSE_CASE, 'Trying to skip the process');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('takes cognizance, records who did and why, and names the next step', async () => {
    const res = await act(s.magistrate, c.case._id, CASE_ACTION.TAKE_COGNIZANCE, 'Chargesheet and documents perused.');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.case.stage).toBe(CASE_STAGE.COGNIZANCE_TAKEN);
    expect(res.body.case.cognizanceTakenOn).toBeTruthy();
    expect(res.body.workflow.requiresCommittal).toBe(false);
    expect(res.body.workflow.nextCourtAction.action).toBe(CASE_ACTION.BEGIN_TRIAL);

    const entry = await Ledger.findOne({ seq: res.body.ledgerSeq }).lean();
    expect(entry.eventType).toBe(LEDGER_EVENT.CASE_STAGE_CHANGED);
    expect(entry.payload).toMatchObject({
      action: CASE_ACTION.TAKE_COGNIZANCE,
      from: CASE_STAGE.CHARGESHEET_FILED,
      to: CASE_STAGE.COGNIZANCE_TAKEN,
      orderedByAuthorityId: 'UP-JUD-1180',
    });
  });

  it('refuses committal — a Magistrate-triable case is not committed', async () => {
    const res = await act(s.magistrate, c.case._id, CASE_ACTION.COMMIT_FOR_TRIAL);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSITION_NOT_APPLICABLE');
  });

  it('takes counsel on record after a vakalatnama, and opens the case to them', async () => {
    const filed = await fileVakalatnama(s.advocate, c.filed.cnrNumber);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const accepted = await post(s.sessionsJudge, `/api/vakalatnama/${filed.body.filing.id}/accept`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.grant.role).toBe('DEFENCE_COUNSEL');

    const mine = await get(s.advocate, '/api/cases');
    expect(mine.body.cases.map((x) => x._id)).toContain(c.case._id);
  });

  it('begins the trial', async () => {
    const res = await act(s.magistrate, c.case._id, CASE_ACTION.BEGIN_TRIAL, 'Charges framed and read over.');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.case.stage).toBe(CASE_STAGE.TRIAL);
  });

  it('requires a reason to close, then closes and stops the record', async () => {
    const bare = await act(s.magistrate, c.case._id, CASE_ACTION.CLOSE_CASE);
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('NOTE_REQUIRED');

    const closed = await act(s.magistrate, c.case._id, CASE_ACTION.CLOSE_CASE, 'Judgment pronounced; accused convicted.');
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.case.stage).toBe(CASE_STAGE.CLOSED);
    expect(closed.body.workflow.nextCourtAction).toBeNull();

    const again = await act(s.magistrate, c.case._id, CASE_ACTION.BEGIN_TRIAL, 'x x x');
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe(DENY_REASON.CASE_IS_CLOSED);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.CASE_CLOSED }).lean();
    expect(entry.payload.reason).toMatch(/Judgment pronounced/);

    // Closing without a document still records who closed it and why.
    expect(entry.payload.closureDocument).toBeNull();
    expect(closed.body.case.closure).toMatchObject({
      kind: null,
      hasDocument: false,
      sha256: null,
      note: 'Judgment pronounced; accused convicted.',
      signedBy: { roleLabel: 'Court', authorityId: 'UP-JUD-1180' },
    });
    const closedStep = closed.body.workflow.lifecycle.find((x) => x.key === 'CLOSED');
    expect(closedStep.description).toMatch(/^Closed by .+\. Reason recorded: “Judgment pronounced; accused convicted\.”\.$/);
    expect(closedStep.proofs.find((p) => p.kind === 'ledger').value).toBe(entry.entryHash);

    const noDocument = await get(s.magistrate, `/api/cases/${c.case._id}/closure-document`);
    expect(noDocument.status).toBe(404);
    expect(noDocument.body.error.code).toBe('NO_CLOSURE_DOCUMENT');
  });
});

// ===================================== FIR 0123/2026, Sessions-triable POCSO ====

describe('FIR 0123/2026 — a Sessions case is committed before it is tried', () => {
  const s = {};
  const c = {};

  beforeAll(async () => {
    await clearCore();
    s.io = await asUser(server, 'UP-GZB-4471');
    s.court = await asUser(server, 'UP-JUD-2291');
    c.case = await openCase(s.io, '0123/2026');
    const filed = await post(s.io, `/api/cases/${c.case._id}/file-chargesheet`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  }, 120_000);

  it('refuses trial before committal', async () => {
    expect((await act(s.court, c.case._id, CASE_ACTION.TAKE_COGNIZANCE)).status).toBe(200);
    const early = await act(s.court, c.case._id, CASE_ACTION.BEGIN_TRIAL);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('commits the case, then begins the trial', async () => {
    const committed = await act(s.court, c.case._id, CASE_ACTION.COMMIT_FOR_TRIAL, 'Offence exclusively triable by the Court of Session.');
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body.case.stage).toBe(CASE_STAGE.COMMITTED);
    expect(committed.body.case.committedOn).toBeTruthy();

    const trial = await act(s.court, c.case._id, CASE_ACTION.BEGIN_TRIAL);
    expect(trial.status).toBe(200);
    expect(trial.body.workflow.lifecycle.find((x) => x.stage === CASE_STAGE.COMMITTED).state).toBe('done');
  });

  it('refuses further investigation once the trial has begun', async () => {
    const res = await act(s.court, c.case._id, CASE_ACTION.DIRECT_FURTHER_INVESTIGATION, 'Too late for this.');
    expect(res.status).toBe(409);
  });

  it('refuses an unknown act — the client names acts, never stages', async () => {
    const res = await post(s.court, `/api/cases/${c.case._id}/transition`, { action: 'CLOSED' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

// ====================================== further investigation, and back again ====

describe('further investigation returns the case to the police, and a fresh chargesheet returns it', () => {
  const s = {};
  const c = {};

  beforeAll(async () => {
    await clearCore();
    s.io = await asUser(server, 'UP-GZB-4471');
    s.court = await asUser(server, 'UP-JUD-2291');
    c.case = await openCase(s.io, '0125/2026');
    const filed = await post(s.io, `/api/cases/${c.case._id}/file-chargesheet`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    c.cnr = filed.body.case.cnrNumber;
    expect((await act(s.court, c.case._id, CASE_ACTION.TAKE_COGNIZANCE)).status).toBe(200);
  }, 120_000);

  it('needs a reason, and then re-opens the file to the police', async () => {
    const bare = await act(s.court, c.case._id, CASE_ACTION.DIRECT_FURTHER_INVESTIGATION);
    expect(bare.status).toBe(400);

    const sent = await act(s.court, c.case._id, CASE_ACTION.DIRECT_FURTHER_INVESTIGATION, 'Call records not examined.');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.case.stage).toBe(CASE_STAGE.FURTHER_INVESTIGATION);
    expect(sent.body.workflow.nextPoliceAction.action).toBe(CASE_ACTION.FILE_CHARGESHEET);

    // Investigative writes work again.
    await upload(s.io, c.case._id, 'Call detail record');
  });

  it('takes a fresh chargesheet back to the same court for cognizance', async () => {
    const refiled = await post(s.io, `/api/cases/${c.case._id}/file-chargesheet`);
    expect(refiled.status, JSON.stringify(refiled.body)).toBe(200);
    expect(refiled.body.case.stage).toBe(CASE_STAGE.CHARGESHEET_FILED);
    expect(refiled.body.case.cnrNumber).toBe(c.cnr);
    expect(refiled.body.workflow.nextCourtAction.action).toBe(CASE_ACTION.TAKE_COGNIZANCE);
  });
});

// ============================================ the AI analysis is FSL-only ====

/**
 * The AI analysis orders a laboratory's queue. The investigating officer, the station,
 * the court and counsel never receive it — not the analysis, not its priority, not a
 * count derived from it, not an order sorted by it — and no response names the AI
 * provider. The laboratory still receives all of it.
 */
describe('the AI analysis reaches the laboratory and nobody else', () => {
  const s = {};
  const c = {};

  /** Anything the AI analysis produced, or a figure or action derived from it. */
  const AI_LEAK =
    /aiAnalysis|triagePriority|deepfake|highestPriority|fslReviewRecommended|analysisDescription|priorityReason|onlineSource|evidenceSummary|"analysis":|"fsl":|FSL_REVIEW_RECOMMENDED|AI_ANALYSIS|\[stub\]|pinterest\.com/i;
  const PROVIDER = /gemini|google/i;

  beforeAll(async () => {
    await clearCore();
    s.io = await asUser(server, 'UP-GZB-4471');
    s.sho = await asUser(server, 'UP-GZB-4402');
    s.examiner = await asUser(server, 'FSL-LKO-0091');
    s.court = await asUser(server, 'UP-JUD-1180');
    s.advocate = await asUser(server, 'UP/1234/2015');

    c.case = await openCase(s.io, '0124/2026');
    c.critical = await upload(s.io, c.case._id, 'STUB:CRITICAL photograph of the handset');
    c.failed = await upload(s.io, c.case._id, 'STUB:RATE_LIMIT photograph of the receipt');
    await drainAnalyses();

    const filed = await post(s.io, `/api/cases/${c.case._id}/file-chargesheet`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const vakalatnama = await fileVakalatnama(s.advocate, filed.body.case.cnrNumber);
    expect(vakalatnama.status, JSON.stringify(vakalatnama.body)).toBe(201);
    const accepted = await post(s.court, `/api/vakalatnama/${vakalatnama.body.filing.id}/accept`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  }, 240_000);

  it('completed an analysis for the laboratory to see', async () => {
    const lab = await get(s.examiner, '/api/fsl/cases');
    expect(lab.status, JSON.stringify(lab.body)).toBe(200);
    const group = lab.body.cases.find((g) => g.case.id === c.case._id);
    expect(group.highestPriority).toBe('CRITICAL');
    expect(group.evidence[0].aiAnalysis.triagePriority).toBe('CRITICAL');
    expect(group.summary.analysis.failed).toBe(1);
    expect(JSON.stringify(lab.body)).not.toMatch(PROVIDER);

    const queue = await get(s.examiner, '/api/fsl/queue?state=ALL');
    expect(queue.status).toBe(200);
    expect(queue.body.queue[0].aiAnalysis.triagePriority).toBe('CRITICAL');
    expect(JSON.stringify(queue.body)).not.toMatch(PROVIDER);
  });

  for (const role of ['io', 'sho', 'court', 'advocate']) {
    it(`never gives ${role} the analysis, a figure derived from it, or the provider's name`, async () => {
      const who = s[role];
      const paths = [
        '/api/cases',
        `/api/cases/${c.case._id}`,
        `/api/cases/${c.case._id}/overview`,
        `/api/cases/${c.case._id}/workflow`,
        '/api/search?q=photograph',
        `/api/search?q=handset&caseId=${c.case._id}`,
        '/api/fsl/cases',
        '/api/fsl/queue',
      ];
      let readable = 0;
      for (const path of paths) {
        const res = await get(who, path);
        expect([200, 403, 404], `${role} ${path}: ${JSON.stringify(res.body)}`).toContain(res.status);
        if (res.status !== 200) continue;
        readable += 1;
        const body = JSON.stringify(res.body);
        expect(body, `${role} ${path}`).not.toMatch(AI_LEAK);
        expect(body, `${role} ${path}`).not.toMatch(PROVIDER);
      }
      expect(readable).toBeGreaterThanOrEqual(3);

      const list = await get(who, '/api/cases');
      const row = list.body.cases.find((x) => x._id === c.case._id);
      expect(row, `${role} must see the case`).toBeTruthy();
      expect(row.summary).not.toHaveProperty('analysis');
      expect(row.summary).not.toHaveProperty('highestPriority');
      expect(row.summary).not.toHaveProperty('fslReviewRecommended');
      expect(row.summary.attention).not.toHaveProperty('fsl');
    });
  }

  it('orders the officer’s exhibits newest first, not by the AI priority', async () => {
    const overview = await get(s.io, `/api/cases/${c.case._id}/overview`);
    expect(overview.status).toBe(200);
    // The failed (unranked) exhibit was uploaded last, so it comes first for the officer.
    expect(overview.body.evidence.map((e) => e.exhibitCode)).toEqual([c.failed.exhibitCode, c.critical.exhibitCode]);
    for (const e of overview.body.evidence) expect(e).not.toHaveProperty('aiAnalysis');
  });

  it('shows the officer’s search results without any analysis field', async () => {
    const found = await get(s.io, '/api/search?q=photograph');
    expect(found.status).toBe(200);
    expect(found.body.evidence.length).toBe(2);
    for (const e of found.body.evidence) expect(e).not.toHaveProperty('aiAnalysis');
  });
});
