/**
 * Vakalatnama e-filing: the only way an advocate comes on record.
 *
 * Run against the REAL directory services, because the claim under test crosses the
 * boundary: a filing in Lexx grants nothing, and an acceptance puts the advocate on
 * record only by way of the COURT register — so the register itself is read back here,
 * not just Lexx's own copy of events.
 *
 * The tests in this file are one sequence and run in order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Ledger } from '../../models/Ledger.js';
import { CaseAccessGrant } from '../../models/CaseAccessGrant.js';
import { createApp } from '../../app.js';
import { asUser, sha256Hex } from '../helpers/client.js';
import { ADVOCATE_ROLES, DENY_REASON, GRANT_BASIS, LEDGER_EVENT, ROLE } from '../../models/enums.js';

let mongo;
let server;
let courtUrl;

const IO = 'UP-GZB-4471';
const JUDGE = 'UP-JUD-2291';
const ADVOCATE = 'UP/1234/2015';
const OTHER_ADVOCATE = 'UP/9876/2019';
const FIR = '0123/2026';
const CNR = 'UPGB010012342026';

let io;
let judge;
let advocate;
let other;
let caseId;

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);

const pdf = (label) => Buffer.from(`%PDF-1.4\n% vakalatnama — ${label}\n${'.'.repeat(64)}\n%%EOF\n`, 'utf8');

/** File as the browser would: hash the bytes, sign the hex digest, send both. */
function file(session, { bytes = pdf(session.authorityId), appearingFor = 'ACCUSED', cnrNumber = CNR, signWith } = {}) {
  const sha = sha256Hex(bytes);
  return as(session, request(server).post('/api/vakalatnama'))
    .field('cnrNumber', cnrNumber)
    .field('appearingFor', appearingFor)
    .field('partyName', 'Ramesh Singh')
    .field('documentSha256', sha)
    .field('documentSignature', (signWith ?? session).keys.sign(sha))
    .attach('document', bytes, { filename: 'vakalatnama.pdf', contentType: 'application/pdf' });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  courtUrl = (await startDirectories(uri)).court;

  await mongoose.connect(uri, { dbName: 'lexx_test_vakalatnama', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();

  io = await asUser(server, IO);
  judge = await asUser(server, JUDGE);
  advocate = await asUser(server, ADVOCATE);
  other = await asUser(server, OTHER_ADVOCATE);

  // A case before a court: created from the FIR, then committed by the chargesheet.
  const created = await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber: FIR });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  caseId = created.body.case._id;
  const filed = await as(io, request(server).post(`/api/cases/${caseId}/file-chargesheet`)).send({});
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

let filingId;
let otherFilingId;

describe('filing grants nothing', () => {
  it('accepts a signed PDF against a listed CNR, as PENDING', async () => {
    const res = await file(advocate);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.filing.status).toBe('PENDING');
    expect(res.body.filing.cnrNumber).toBe(CNR);
    expect(res.body.notice).toMatch(/NOT on record/);
    filingId = res.body.filing.id;

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.VAKALATNAMA_FILED }).lean();
    expect(entry.payload.advocateAuthorityId).toBe(ADVOCATE);
  });

  it('leaves the filer refused the case until the registry rules', async () => {
    const res = await as(advocate, request(server).get(`/api/cases/${caseId}`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('refuses a second live filing for the same appearance', async () => {
    const res = await file(advocate);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VAKALATNAMA_ALREADY_FILED');
  });

  it('refuses a document signed by someone else’s key', async () => {
    const res = await file(other, { appearingFor: 'VICTIM', signWith: advocate });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');
  });

  it('refuses a document that is not a PDF', async () => {
    const res = await file(other, { bytes: Buffer.from('plain text is not a vakalatnama') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOCUMENT_MUST_BE_PDF');
  });

  it('refuses a CNR no court case in Lexx carries', async () => {
    const res = await file(other, { cnrNumber: 'UPGB019999992026' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CNR_NOT_FOUND');
  });

  it('refuses a filing by anyone who is not an advocate', async () => {
    const res = await file(io);
    expect(res.status).toBe(403);
  });
});

describe('who may see a filing', () => {
  it('shows the registry and the judge the filings on a case', async () => {
    for (const session of [judge]) {
      const res = await as(session, request(server).get(`/api/vakalatnama/case/${caseId}`));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.pending).toBe(1);
      expect(res.body.filings[0].advocateAuthorityId).toBe(ADVOCATE);
    }
  });

  it('refuses the police the representation record entirely', async () => {
    const list = await as(io, request(server).get(`/api/vakalatnama/case/${caseId}`));
    expect(list.status).toBe(403);
    const doc = await as(io, request(server).get(`/api/vakalatnama/${filingId}/document`));
    expect(doc.status).toBe(403);
  });

  it('lets the filer, and only the filer, download the filed document', async () => {
    const own = await as(advocate, request(server).get(`/api/vakalatnama/${filingId}/document`));
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toMatch(/application\/pdf/);

    const stranger = await as(other, request(server).get(`/api/vakalatnama/${filingId}/document`));
    expect(stranger.status).toBe(403);
  });

  it('lists an advocate their own filings and nobody else’s', async () => {
    const mine = await as(advocate, request(server).get('/api/vakalatnama/mine'));
    expect(mine.body.filings.map((f) => f.id)).toEqual([filingId]);
    const theirs = await as(other, request(server).get('/api/vakalatnama/mine'));
    expect(theirs.body.filings).toHaveLength(0);
  });
});

/**
 * Ruling on a vakalatnama is the presiding judge's act.
 *
 * It used to be a registrar's, and that was a second court login standing between an
 * advocate and the case they had just filed into — the step every rehearsal and every
 * real user hit as an unexplained dead end. The authority did not move outward: it
 * moved to the one identity the court directory's roster already vouches for as
 * sitting in this court today.
 */
describe("the ruling is the court’s act", () => {
  it('refuses the advocate ruling on their own filing', async () => {
    const res = await as(advocate, request(server).post(`/api/vakalatnama/${filingId}/accept`)).send({});
    expect(res.status).toBe(403);
  });

  it('on acceptance, records the appearance in the COURT register, then grants', async () => {
    const res = await as(judge, request(server).post(`/api/vakalatnama/${filingId}/accept`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.filing.status).toBe('ACCEPTED');
    expect(res.body.courtRegister).toBe('RECORDED');

    // The court register — not Lexx — now says this advocate is on record.
    const register = await fetch(
      `${courtUrl}/directory/vakalatnama?enrolmentNo=${encodeURIComponent(ADVOCATE)}`
    ).then((r) => r.json());
    const row = register.vakalatnamas.find((v) => v.cnrNumber === CNR);
    expect(row.status).toBe('ACCEPTED');
    expect(row.acceptedBy).toBe(JUDGE);

    const grant = await CaseAccessGrant.findOne({
      caseId,
      userId: advocate.user.userId,
      revokedAt: null,
    }).lean();
    expect(grant.role).toBe(ROLE.DEFENCE_COUNSEL);
    expect(grant.grantBasis).toBe(GRANT_BASIS.VAKALATNAMA);
  });

  it('opens the case to the advocate on their very next request', async () => {
    const res = await as(advocate, request(server).get(`/api/cases/${caseId}`));
    expect(res.status).toBe(200);
  });

  it('cannot be ruled on twice', async () => {
    const res = await as(judge, request(server).post(`/api/vakalatnama/${filingId}/reject`)).send({
      note: 'Second thoughts after acceptance.',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VAKALATNAMA_NOT_PENDING');
  });

  it('stays consistent with a re-sync from the court register', async () => {
    const res = await as(judge, request(server).post(`/api/disclosure/${caseId}/sync-representation`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.revoked).toHaveLength(0);
    // Exactly one advocate grant: the sync found the same appearance and added nothing.
    const live = await CaseAccessGrant.countDocuments({
      caseId,
      role: { $in: ADVOCATE_ROLES },
      revokedAt: null,
    });
    expect(live).toBe(1);
  });

  it('a refusal carries its reason back to the advocate, and grants nothing', async () => {
    const filed = await file(other, { appearingFor: 'VICTIM' });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    otherFilingId = filed.body.filing.id;

    const bare = await as(judge, request(server).post(`/api/vakalatnama/${otherFilingId}/reject`)).send({});
    expect(bare.status).toBe(400);

    const res = await as(judge, request(server).post(`/api/vakalatnama/${otherFilingId}/reject`)).send({
      note: 'Not executed by the victim or a guardian; refile with the guardian’s signature.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.filing.status).toBe('REJECTED');

    const mine = await as(other, request(server).get('/api/vakalatnama/mine'));
    expect(mine.body.filings[0].decisionNote).toMatch(/guardian/);

    const denied = await as(other, request(server).get(`/api/cases/${caseId}`));
    expect(denied.status).toBe(403);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.VAKALATNAMA_REJECTED }).lean();
    expect(entry.payload.advocateAuthorityId).toBe(OTHER_ADVOCATE);
  });
});
