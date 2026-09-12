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

async function handOver(itemId, from, to, toStatus, toLocation, sealIntact = true) {
  const started = await post(from, `/api/custody/items/${itemId}/initiate-transfer`, {
    toUserId: to.user.userId,
    reason: 'Handover in the workflow audit',
    toStatus,
    toLocation,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return post(to, `/api/custody/items/${itemId}/accept-transfer`, {
    transferToken: started.body.transferToken,
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

describe('disclosure: a court can refuse an exclusion, and the s.230 clock runs', () => {
  const c = {};

  beforeAll(async () => {
    c.caseId = await openCase('0123/2026');
    c.ex1 = (await upload(c.caseId, 'CCTV still')).evidence;
    c.ex2 = (await upload(c.caseId, 'Mobile video')).evidence;
    c.ex3 = (await upload(c.caseId, 'Witness statement')).evidence;

    // A certificate for ex1 BEFORE any report — its Part B is blank for good.
    const cert = await post(s.io, '/api/certificates/generate', { evidenceId: c.ex1._id });
    expect(cert.status, JSON.stringify(cert.body)).toBe(201);

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

    // Disclosure is composed by the court, and only once the case is before it.
    const prepared = await post(s.judge, `/api/disclosure/${c.caseId}/prepare`, {
      excludedItems: [
        { itemId: c.ex2._id, reason: 'Requested withholding — the court should refuse this one.' },
        { itemId: c.ex3._id, reason: 'Identifies a protected witness; withheld pending a redaction order.' },
      ],
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
    c.packId = prepared.body.pack.packId;
  }, 240_000);

  it('starts the fourteen-day BNSS s.230 clock when the chargesheet is filed', () => {
    const due = new Date(c.case.clocks.disclosureDueOn).getTime();
    const filedOn = new Date(c.case.chargesheetFiledOn).getTime();
    expect(due - filedOn).toBe(14 * DAY);
  });

  it('tells whoever can issue a certificate that a report now needs a fresh one', async () => {
    const res = await get(s.io, `/api/certificates?evidenceId=${c.ex1._id}`);
    expect(res.body.reportFiled).toBe(true);
    expect(res.body.freshCertificateNeeded).toBe(true);
  });

  it('records a refusal as a ruling, puts the exhibit back in the set, and lets the pack be served', async () => {
    const approved = await post(s.judge, `/api/disclosure/${c.packId}/approve`, {
      approvedExclusions: [c.ex3._id],
      refusedExclusions: [c.ex2._id],
      refusalNote: 'The ground given does not justify withholding this from the accused.',
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.servable).toBe(true);
    expect(approved.body.pack.exhibitIds).toContain(c.ex2._id);
    expect(approved.body.pack.exhibitIds).not.toContain(c.ex3._id);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.DISCLOSURE_APPROVED }).lean();
    expect(entry.payload.refusedExclusions).toEqual([c.ex2._id]);

    const served = await post(s.judge, `/api/disclosure/${c.packId}/serve`);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
  });

  it('refuses a contrary second ruling on an exclusion already ruled', async () => {
    // The pack is served now, so any re-approval is refused outright.
    const res = await post(s.judge, `/api/disclosure/${c.packId}/approve`, {
      approvedExclusions: [c.ex2._id],
    });
    expect(res.status).toBe(409);
  });

  it("shows counsel the refused exhibit, withholds only the approved one, and runs the clock", async () => {
    const res = await get(s.advocate, `/api/disclosure/my-pack/${c.caseId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const codes = res.body.exhibits.map((e) => e.exhibitCode);
    expect(codes).toContain(c.ex2.exhibitCode);
    expect(codes).not.toContain(c.ex3.exhibitCode);
    expect(res.body.withheld).toHaveLength(1);
    expect(res.body.withheld[0].reason).toMatch(/protected witness/);
    expect(res.body.dueOn).toBeTruthy();
  });

  it('never shows counsel machine triage — not on an exhibit, the list, the queue or search', async () => {
    const one = await get(s.advocate, `/api/evidence/${c.ex1._id}`);
    expect(one.status).toBe(200);
    expect(one.body.evidence.triage).toBeUndefined();

    const list = await get(s.advocate, `/api/evidence?caseId=${c.caseId}`);
    for (const e of list.body.evidence) expect(e.triage).toBeUndefined();

    const queue = await get(s.advocate, '/api/evidence/queue/triage');
    expect(queue.body.queue).toEqual([]);

    const found = await get(s.advocate, '/api/search?q=CCTV');
    expect(found.status).toBe(200);
    for (const e of found.body.evidence) expect(e.triage).toBeUndefined();
  });

  it('does not let search find an exhibit withheld from counsel', async () => {
    const res = await get(s.advocate, '/api/search?q=Witness');
    expect(res.status).toBe(200);
    expect(res.body.evidence.map((e) => e.exhibitCode)).not.toContain(c.ex3.exhibitCode);

    // The officer, whose scope is the whole case, still finds it.
    const io = await get(s.io, '/api/search?q=Witness');
    expect(io.body.evidence.map((e) => e.exhibitCode)).toContain(c.ex3.exhibitCode);
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
  });

  it('refuses — and audits — counsel reaching for a withheld exhibit by its code', async () => {
    const res = await get(s.advocate, `/api/evidence/by-code/${c.ex3.exhibitCode}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);

    const served = await get(s.advocate, `/api/evidence/by-code/${c.ex2.exhibitCode}`);
    expect(served.status).toBe(200);
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

    expect((await handOver(c.itemId, s.io, s.store, 'IN_STORE', 'MALKHANA')).status).toBe(200);
    expect((await handOver(c.itemId, s.store, s.examiner, 'AT_FSL', 'FSL')).status).toBe(200);
    await fileReport(c.referralId);

    // Filed WITHOUT a pack — the order that used to strand disclosure.
    const filed = await post(s.io, `/api/cases/${c.caseId}/file-chargesheet`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  }, 240_000);

  it('lets the examiner hand the article back after reporting, after the chargesheet', async () => {
    const back = await handOver(c.itemId, s.examiner, s.store, 'IN_STORE', 'MALKHANA');
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.item.status).toBe('IN_STORE');
  });

  it('lets station police receive an article after the chargesheet — custody is not investigation', async () => {
    const returned = await handOver(c.itemId, s.store, s.sho, 'RETURNED', 'FIELD');
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

  /**
   * Disclosure happens AFTER filing, which is the only time it ever happens — and it
   * is the court that composes it. Requiring an investigative WRITE here would have
   * refused every pack that was ever actually needed, since the case is closed to
   * writes by then; APPROVE is the action, and the court holds it.
   */
  it('lets the court compose disclosure after filing, and reports the pack on the case', async () => {
    const prepared = await post(s.magistrate, `/api/disclosure/${c.caseId}/prepare`, {
      excludedItems: [],
      maskVictimIdentity: true,
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
    c.packId = prepared.body.pack.packId;

    const got = await get(s.io, `/api/cases/${c.caseId}`);
    expect(got.body.disclosure).toMatchObject({ packId: c.packId, status: 'DRAFT' });
  });

  it('refuses the investigating officer disclosure entirely', async () => {
    const res = await post(s.io, `/api/disclosure/${c.caseId}/prepare`, { excludedItems: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.READ_ONLY_ROLE);
  });

  it('never unmasks a victim at approval when the approval does not mention masking', async () => {
    const approved = await post(s.magistrate, `/api/disclosure/${c.packId}/approve`, {
      approvedExclusions: [],
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.pack.maskVictimIdentity).toBe(true);

    const explicitOff = await post(s.magistrate, `/api/disclosure/${c.packId}/approve`, {
      maskVictimIdentity: false,
    });
    expect(explicitOff.body.pack.maskVictimIdentity).toBe(true);
  });

  it("does not list another court's case's custody register to a court, even by ?caseId", async () => {
    const other = await get(s.evidenceRoom, `/api/custody/items?caseId=${c.caseId}`);
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);

    const gaps = await get(s.evidenceRoom, `/api/custody/gaps?caseId=${c.caseId}`);
    expect(gaps.body.items).toEqual([]);

    const own = await get(s.magistrate, `/api/custody/items?caseId=${c.caseId}`);
    expect(own.body.items.map((i) => i.id)).toContain(c.itemId);
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
    const accepted = await handOver(c.itemId, s.io, s.store, 'IN_STORE', 'MALKHANA', false);
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
    const again = await post(s.store, `/api/custody/items/${c.itemId}/initiate-transfer`, {
      toUserId: s.sho.user.userId,
      reason: 'Released after decision',
      toStatus: 'RETURNED',
      toLocation: 'FIELD',
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
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
