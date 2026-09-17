/**
 * Regressions from the end-to-end workflow audit.
 *
 * Each block pins one defect that stopped a role finishing a step the product is
 * meant to support, or let a role see what it must not. Run against the REAL directory
 * services, as one sequence per case, because most of these only show up when several
 * roles act on the same case in order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Ledger } from '../../models/Ledger.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { Certificate } from '../../models/Certificate.js';
import { createApp } from '../../app.js';
import { asUser, sha256Hex } from '../helpers/client.js';
import { runAnchorCycle } from '../../services/anchor.js';
import { DECISION, DENY_REASON, LEDGER_EVENT } from '../../models/enums.js';

let mongo;
let server;
let s = {};

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);
const DAY = 86_400_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n${'.'.repeat(64)}\n%%EOF\n`, 'utf8');

const DEVICE = { sourceType: 'MOBILE', make: 'Samsung', model: 'A54', colour: 'Black', serialNumber: 'SN-1', imeiOrUid: '351756051523999' };

async function openCase(firNumber) {
  const res = await as(s.io, request(server).post('/api/cases/from-fir')).send({ firNumber });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.case._id;
}

async function upload(caseId, title) {
  const bytes = Buffer.concat([PNG, Buffer.from(title.padEnd(96, '.'))]);
  const sha = sha256Hex(bytes);
  let req = as(s.io, request(server).post('/api/evidence/upload'))
    .field('caseId', caseId)
    .field('title', title)
    .field('sha256Client', sha)
    .field('signature', s.io.keys.sign(sha));
  for (const [k, v] of Object.entries(DEVICE)) req = req.field(k, v);
  const res = await req.attach('file', bytes, { filename: `${title}.png`, contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

const post = (session, path, body = {}) => as(session, request(server).post(path)).send(body);
const get = (session, path) => as(session, request(server).get(path));

/** Record one custody movement — one act, no handover token. */
function moveTo(itemId, who, toStatus, sealIntact = true) {
  return post(who, `/api/custody/items/${itemId}/move`, {
    toStatus,
    reason: 'Movement in the workflow audit',
    sealIntact,
  });
}

async function fileReport(referralId) {
  const bytes = pdf('FSL report');
  const sha = sha256Hex(bytes);
  const res = await as(s.examiner, request(server).post(`/api/fsl/referrals/${referralId}/report`))
    .field('opinion', 'AUTHENTIC')
    .field('examinationSummary', 'No manipulation found.')
    .field('reportSha256', sha)
    .field('reportSignature', s.examiner.keys.sign(sha))
    .attach('report', bytes, { filename: 'r.pdf', contentType: 'application/pdf' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function fileAndAcceptVakalatnama(advocate, court, cnrNumber) {
  const bytes = pdf(`vakalatnama ${advocate.authorityId}`);
  const sha = sha256Hex(bytes);
  const filed = await as(advocate, request(server).post('/api/vakalatnama'))
    .field('cnrNumber', cnrNumber)
    .field('appearingFor', 'ACCUSED')
    .field('partyName', 'Ramesh Singh')
    .field('documentSha256', sha)
    .field('documentSignature', advocate.keys.sign(sha))
    .attach('document', bytes, { filename: 'v.pdf', contentType: 'application/pdf' });
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const accepted = await post(court, `/api/vakalatnama/${filed.body.filing.id}/accept`);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_workflow', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();

  s = {
    io: await asUser(server, 'UP-GZB-4471'),
    sho: await asUser(server, 'UP-GZB-4402'),
    // Another officer at the station, who keeps its store. There is no custodian
    // role any more; the separation that matters is enforced per case.
    store: await asUser(server, 'UP-GZB-4455'),
    examiner: await asUser(server, 'FSL-LKO-0091'),
    judge: await asUser(server, 'UP-JUD-2291'),
    magistrate: await asUser(server, 'UP-JUD-1180'),
    evidenceRoom: await asUser(server, 'UP-GZB-EVC-01'),
    advocate: await asUser(server, 'UP/1234/2015'),
    stranger: await asUser(server, 'UP/9876/2019'),
  };
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

// ====================================================== the main case, 0123 ====

describe('counsel on record read the case file at once, and nobody else does', () => {
  const c = {};

  beforeAll(async () => {
    c.caseId = await openCase('0123/2026');
    c.ex1 = (await upload(c.caseId, 'CCTV still')).evidence;
    c.ex2 = (await upload(c.caseId, 'Mobile video')).evidence;
    c.ex3 = (await upload(c.caseId, 'Witness statement')).evidence;

    const ref = await post(s.sho, `/api/evidence/${c.ex1._id}/refer-fsl`, {
      labCode: 'UP-FSL-LKO',
      discipline: 'MEDIA_FORENSICS',
    });
    expect(ref.status, JSON.stringify(ref.body)).toBe(201);
    c.referralId = ref.body.referral.id;
    await post(s.examiner, `/api/fsl/referrals/${c.referralId}/accept`);
    await fileReport(c.referralId);

    const filed = await post(s.io, `/api/cases/${c.caseId}/file-chargesheet`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    c.case = filed.body.case;
    await fileAndAcceptVakalatnama(s.advocate, s.judge, c.case.cnrNumber);
  }, 240_000);

  it('starts the fourteen-day BNSS s.230 clock when the chargesheet is filed', () => {
    const due = new Date(c.case.clocks.disclosureDueOn).getTime();
    const filedOn = new Date(c.case.chargesheetFiledOn).getTime();
    expect(due - filedOn).toBe(14 * DAY);
  });

  it('filing the laboratory report does not touch the certificate — and creates no second one', async () => {
    // Recording a forensic opinion is the laboratory's act on the exhibit. The s.63
    // certificate is issued on upload and is neither rewritten by nor gated on it.
    expect(await Certificate.countDocuments({ evidenceId: c.ex1._id })).toBe(1);
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.CERTIFICATE_PART_B_ATTACHED })).toBe(0);
  });

  it('gives counsel the whole case file the moment the vakalatnama is accepted — no share step', async () => {
    const res = await get(s.advocate, `/api/disclosure/case-file/${c.caseId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const codes = res.body.exhibits.map((e) => e.exhibitCode);
    expect(codes).toEqual(expect.arrayContaining([c.ex1.exhibitCode, c.ex2.exhibitCode, c.ex3.exhibitCode]));
    expect(res.body.exhibitCount).toBe(3);
    expect(res.body.onRecord.length).toBeGreaterThan(0);
  });

  it('reports no disclosure pack and no "case file not shared" action on the case', async () => {
    for (const who of [s.io, s.judge]) {
      const one = await get(who, `/api/cases/${c.caseId}`);
      expect(one.status).toBe(200);
      expect(one.body).not.toHaveProperty('disclosure');
      expect(one.body.case.summary).not.toHaveProperty('disclosure');

      const overview = await get(who, `/api/cases/${c.caseId}/overview`);
      expect(overview.status).toBe(200);
      expect(overview.body).not.toHaveProperty('disclosure');
      expect(overview.body.pendingActions.map((a) => a.code)).not.toContain('CASE_FILE_NOT_SHARED');
    }
  });

  it('never shows counsel machine triage — not on an exhibit, the list, the queue, search or the case', async () => {
    const one = await get(s.advocate, `/api/evidence/${c.ex1._id}`);
    expect(one.status).toBe(200);
    expect(one.body.evidence.aiAnalysis).toBeUndefined();

    const list = await get(s.advocate, `/api/evidence?caseId=${c.caseId}`);
    for (const e of list.body.evidence) expect(e.aiAnalysis).toBeUndefined();

    const queue = await get(s.advocate, '/api/evidence/queue/triage');
    expect(queue.body.queue ?? []).toEqual([]);

    const found = await get(s.advocate, '/api/search?q=CCTV');
    expect(found.status).toBe(200);
    for (const e of found.body.evidence) expect(e.aiAnalysis).toBeUndefined();

    const overview = await get(s.advocate, `/api/cases/${c.caseId}/overview`);
    if (overview.status === 200) expect(JSON.stringify(overview.body)).not.toMatch(/aiAnalysis|triagePriority/);
  });

  it('lets search find the exhibits of a case counsel is on record for, and nothing for a stranger', async () => {
    const res = await get(s.advocate, '/api/search?q=Witness');
    expect(res.status).toBe(200);
    expect(res.body.evidence.map((e) => e.exhibitCode)).toContain(c.ex3.exhibitCode);

    const stranger = await get(s.stranger, '/api/search?q=Witness');
    expect(stranger.status).toBe(200);
    expect(stranger.body.evidence.map((e) => e.exhibitCode)).not.toContain(c.ex3.exhibitCode);
  });

  it('refuses — and audits — an advocate reaching for a case by CNR they are not on record for', async () => {
    const res = await get(s.stranger, `/api/cases/by-cnr/${c.case.cnrNumber}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
    const row = await AuditEvent.findOne({
      authorityId: 'UP/9876/2019',
      decision: DECISION.DENY,
      reason: DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE,
    }).lean();
    expect(row).toBeTruthy();

    const mine = await get(s.advocate, `/api/cases/by-cnr/${c.case.cnrNumber}`);
    expect(mine.status).toBe(200);

    const file = await get(s.stranger, `/api/disclosure/case-file/${c.caseId}`);
    expect(file.status).toBe(403);
    expect(file.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('lets counsel on record open any exhibit by its code, and refuses a stranger', async () => {
    const mine = await get(s.advocate, `/api/evidence/by-code/${c.ex3.exhibitCode}`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);

    const theirs = await get(s.stranger, `/api/evidence/by-code/${c.ex3.exhibitCode}`);
    expect(theirs.status).toBe(403);
    expect(theirs.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('answers an unknown CNR or code as not found, like an unknown id', async () => {
    expect((await get(s.advocate, '/api/cases/by-cnr/UPGB019999992026')).status).toBe(404);
    expect((await get(s.advocate, '/api/evidence/by-code/EX-00000000-999')).status).toBe(404);
  });
});

// ================================================== the Magistrate case, 0124 ====

describe('custody keeps moving after the chargesheet, and a lab can return an article', () => {
  const c = {};

  beforeAll(async () => {
    c.caseId = await openCase('0124/2026');
    c.ex = (await upload(c.caseId, 'Seized handset photo')).evidence;
    const booked = await post(s.io, '/api/custody/items', {
      caseId: c.caseId,
      evidenceId: c.ex._id,
      description: 'Redmi handset',
      sealNumber: 'SEAL-WF-1',
      identifiers: { imei: '356938035643809' },
      location: 'FIELD',
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    c.itemId = booked.body.item.id;

    const ref = await post(s.sho, `/api/evidence/${c.ex._id}/refer-fsl`, {
      labCode: 'UP-FSL-LKO',
      discipline: 'MEDIA_FORENSICS',
    });
    c.referralId = ref.body.referral.id;
    await post(s.examiner, `/api/fsl/referrals/${c.referralId}/accept`);

    expect((await moveTo(c.itemId, s.store, 'IN_STORE')).status).toBe(200);
    expect((await moveTo(c.itemId, s.store, 'AT_FSL')).status).toBe(200);
    await fileReport(c.referralId);

    const filed = await post(s.io, `/api/cases/${c.caseId}/file-chargesheet`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  }, 240_000);

  it('lets the examiner hand the article back after reporting, after the chargesheet', async () => {
    const back = await moveTo(c.itemId, s.examiner, 'IN_STORE');
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.item.status).toBe('IN_STORE');
  });

  it('lets station police record a return after the chargesheet — custody is not investigation', async () => {
    const returned = await moveTo(c.itemId, s.sho, 'RETURNED');
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body.item.status).toBe('RETURNED');
  });

  it('still refuses booking a NEW article after the chargesheet', async () => {
    const res = await post(s.io, '/api/custody/items', {
      caseId: c.caseId,
      description: 'Booked too late',
      sealNumber: 'SEAL-WF-LATE',
      location: 'FIELD',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
  });

  it("does not list a case's custody register to a court in another district, even by ?caseId", async () => {
    // One Court role for the district: every court login there reads the register.
    const same = await get(s.evidenceRoom, `/api/custody/items?caseId=${c.caseId}`);
    expect(same.status).toBe(200);
    expect(same.body.items.map((i) => i.id)).toContain(c.itemId);

    // A court identity from another district does not.
    const users = mongoose.connection.collection('users');
    await users.updateOne({ authorityId: 'UP-GZB-EVC-01' }, { $set: { 'scope.districtCode': 'UP-LKO' } });
    try {
      const other = await get(s.evidenceRoom, `/api/custody/items?caseId=${c.caseId}`);
      expect(other.status).toBe(200);
      expect(other.body.items).toEqual([]);
      const gaps = await get(s.evidenceRoom, `/api/custody/gaps?caseId=${c.caseId}`);
      expect(gaps.body.items).toEqual([]);
    } finally {
      await users.updateOne({ authorityId: 'UP-GZB-EVC-01' }, { $set: { 'scope.districtCode': 'UP-GZB' } });
    }
  });
});

// ===================================================== a frozen article, 0125 ====

describe('a frozen article can be released — by the SHO, on a recorded decision', () => {
  const c = {};

  beforeAll(async () => {
    c.caseId = await openCase('0125/2026');
    const booked = await post(s.io, '/api/custody/items', {
      caseId: c.caseId,
      description: 'Laptop',
      sealNumber: 'SEAL-WF-9',
      identifiers: { serialNumber: 'LT-9' },
      location: 'FIELD',
    });
    c.itemId = booked.body.item.id;
    const accepted = await moveTo(c.itemId, s.io, 'IN_STORE', false);
    expect(accepted.body.frozen).toBe(true);
  }, 120_000);

  it('refuses the release to anyone but the SHO', async () => {
    for (const who of [s.io, s.store]) {
      const res = await post(who, `/api/custody/items/${c.itemId}/lift-freeze`, {
        note: 'I would like to move this again, please.',
      });
      expect(res.status).toBe(403);
    }
  });

  it('refuses a release with no stated decision', async () => {
    const res = await post(s.sho, `/api/custody/items/${c.itemId}/lift-freeze`, { note: 'ok' });
    expect(res.status).toBe(400);
  });

  it('lifts the freeze, re-seals under a new number, and keeps the exception in the chain', async () => {
    const res = await post(s.sho, `/api/custody/items/${c.itemId}/lift-freeze`, {
      note: 'Inspected against the seizure memo; contents intact. Re-sealed in my presence.',
      newSealNumber: 'SEAL-WF-9R',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item.frozen).toBe(false);
    expect(res.body.item.sealNumber).toBe('SEAL-WF-9R');

    const chain = await get(s.sho, `/api/custody/items/${c.itemId}/chain`);
    const types = chain.body.events.map((e) => e.eventType);
    expect(types).toContain(LEDGER_EVENT.INTEGRITY_EXCEPTION);
    expect(types).toContain(LEDGER_EVENT.CUSTODY_FREEZE_LIFTED);

    // …and the item can move again.
    const again = await moveTo(c.itemId, s.store, 'RETURNED');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });
});

// ============================================================ the verifier ====

describe('the public receipt check reports a tampered batch as a failure, not as "not yet batched"', () => {
  it('names the batch and fails the proof when an anchored entry has been altered', async () => {
    const { batch } = await runAnchorCycle();
    expect(batch).toBeTruthy();

    // Alter one anchored entry underneath the application (the ledger model refuses
    // updates, so this goes to the collection directly — as an attacker would).
    const victim = await Ledger.findOne({ anchorBatchId: batch.batchId }).sort({ seq: 1 }).lean();
    const forged = 'f'.repeat(64);
    await mongoose.connection.collection('ledger').updateOne({ _id: victim._id }, { $set: { entryHash: forged } });

    const res = await request(server).get(`/api/anchors/entry/${victim.seq}/${forged}`);
    expect(res.status).toBe(200);
    expect(res.body.anchored).toBe(true);
    expect(res.body.includedInRoot).toBe(false);
    expect(res.body.reason).toBe('ROOT_MISMATCH');
    expect(res.body.batchId).toBe(batch.batchId);
  });
});
