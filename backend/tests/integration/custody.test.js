/**
 * Physical custody: register an article, record where it goes, detect gaps.
 *
 * Run against the REAL directory services, because who may record a movement — an
 * officer at the station, the laboratory an article is at, the court it was produced
 * in — is decided from directory facts.
 *
 * The claims under test, in one line each:
 *   an article is registered once, on its case, against at most one exhibit;
 *   a movement is ONE act by someone entitled to record it — no handover token;
 *   only lawful moves are accepted, and a laboratory or court moves only what it holds;
 *   a broken seal freezes the article until the SHO decides;
 *   a label identifies an article and authorises nothing;
 *   and the ledger, not this API, is where the history is checked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { CustodyItem } from '../../models/CustodyItem.js';
import { Ledger } from '../../models/Ledger.js';
import { createApp } from '../../app.js';
import { activateUser } from '../helpers/client.js';
import { appendEvent, verifyChain } from '../../services/ledger.js';
import { drainAnalyses } from '../../services/ai/analysisService.js';
import { CUSTODY_STATUS, CUSTODY_LOCATION, DENY_REASON, LEDGER_EVENT, ROLE, SUBJECT_TYPE } from '../../models/enums.js';

let mongo;
let server;
const u = {};

const IDS = {
  io: 'UP-GZB-4471',
  sho: 'UP-GZB-4402',
  store: 'UP-GZB-4455',
  sp: 'UP-GZB-9001',
  examiner: 'FSL-LKO-0091',
  judge: 'UP-JUD-2291',
  advocate: 'UP/9876/2019',
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_custody', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();
}, 120_000);

afterAll(async () => {
  await drainAnalyses();
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  for (const [key, id] of Object.entries(IDS)) u[key] = await activateUser(server, id);
});

afterEach(async () => {
  await drainAnalyses();
});

// ---------------------------------------------------------------- helpers ----

const auth = (req, session) => req.set('Authorization', `Bearer ${session.accessToken}`);
const post = (session, path, body = {}) => auth(request(server).post(path), session).send(body);
const get = (session, path) => auth(request(server).get(path), session);

async function openCase(firNumber = '0123/2026') {
  const res = await post(u.io, '/api/cases/from-fir', { firNumber });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.case;
}

const register = (caseId, overrides = {}) =>
  post(u.io, '/api/custody/items', {
    caseId,
    description: 'Samsung Galaxy A54, black',
    sealNumber: 'SEAL-GZB-88231',
    identifiers: { imei: '350123456789012' },
    ...overrides,
  });

const move = (session, itemId, body) =>
  post(session, `/api/custody/items/${itemId}/move`, {
    reason: 'Recorded in the custody test',
    sealIntact: true,
    ...body,
  });

async function uploadExhibit(caseId, tag) {
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`custody-exhibit-${tag}`.padEnd(64, '.')),
  ]);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const res = await auth(request(server).post('/api/evidence/upload'), u.io)
    .field('caseId', caseId)
    .field('title', `Photograph ${tag}`)
    .field('sha256Client', sha)
    .field('signature', u.io.keys.sign(sha))
    .field('sourceType', 'MOBILE')
    .attach('file', bytes, { filename: `${tag}.png`, contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evidence;
}

// ============================================================ registering ====

describe('registering a physical article', () => {
  it('records it on its case, seized, with a label that authorises nothing', async () => {
    const c = await openCase();
    const res = await register(c._id);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.item.status).toBe(CUSTODY_STATUS.SEIZED);
    expect(res.body.item.currentLocation).toBe(CUSTODY_LOCATION.FIELD);
    expect(res.body.item.firNumber).toBe('0123/2026');
    expect(res.body.qr.payload).toMatch(/^LEXX:v1:/);
    expect(res.body.item.labelUrl).toContain('/scan?label=');
    expect(res.body.qr.printable.notice).toMatch(/grants no authority/);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.CUSTODY_ITEM_CREATED }).lean();
    expect(entry.payload.toStatus).toBe(CUSTODY_STATUS.SEIZED);
    expect(entry.payload.custodySeq).toBe(1);
  });

  it('can be booked straight into the station store', async () => {
    const c = await openCase();
    const res = await register(c._id, { initialStatus: CUSTODY_STATUS.IN_STORE });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.item.status).toBe(CUSTODY_STATUS.IN_STORE);
    expect(res.body.item.currentLocation).toBe(CUSTODY_LOCATION.MALKHANA);
    expect(res.body.item.custodian).toMatch(/Station store/);
  });

  it('links to a digital exhibit of the same case, and to no other', async () => {
    const c = await openCase();
    const ex = await uploadExhibit(c._id, 'linked');

    const linked = await register(c._id, { evidenceId: ex._id });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(linked.body.item.exhibitCode).toBe(ex.exhibitCode);

    // The exhibit now reports the article it came from.
    const exhibit = await get(u.io, `/api/evidence/${ex._id}`);
    expect(exhibit.body.evidence.physicalCustody.itemCode).toBe(linked.body.item.itemCode);

    const second = await register(c._id, { evidenceId: ex._id, sealNumber: 'SEAL-OTHER' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EXHIBIT_ALREADY_HAS_ARTICLE');

    const other = await openCase('0124/2026');
    const foreign = await uploadExhibit(other._id, 'foreign');
    const wrong = await register(c._id, { evidenceId: foreign._id, sealNumber: 'SEAL-WRONG' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('EVIDENCE_NOT_IN_CASE');
  });

  it('registers one seal once per case — the API refuses a duplicate, and so does the database', async () => {
    const c = await openCase();
    const first = await register(c._id);
    expect(first.status).toBe(201);

    const again = await register(c._id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_SEAL');
    expect(again.body.error.details.itemCode).toBe(first.body.item.itemCode);

    // Underneath the API, the unique index still refuses it.
    await expect(
      CustodyItem.create({
        itemCode: 'IT-DIRECT-001',
        caseId: c._id,
        description: 'Written around the API',
        sealNumber: 'SEAL-GZB-88231',
        qrPayload: 'LEXX:v1:IT-DIRECT-001:sig',
        stationCode: 'UP-GZB-KVN',
        districtCode: 'UP-GZB',
        currentHolderUserId: u.io.user.userId,
        createdBy: u.io.user.userId,
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('closes to new registrations at the chargesheet', async () => {
    const c = await openCase();
    expect((await post(u.io, `/api/cases/${c._id}/file-chargesheet`)).status).toBe(200);
    const res = await register(c._id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
  });
});

// ============================================================== movement ====

describe('recording a movement is one act', () => {
  it('moves an article from the scene straight to the laboratory, with the reason on the ledger', async () => {
    const c = await openCase();
    const { body } = await register(c._id);

    const res = await move(u.io, body.item.id, {
      toStatus: CUSTODY_STATUS.AT_FSL,
      reason: 'Sent for media forensics',
      custodian: 'State FSL, Lucknow',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item.status).toBe(CUSTODY_STATUS.AT_FSL);
    expect(res.body.item.currentLocation).toBe(CUSTODY_LOCATION.FSL);
    expect(res.body.item.custodian).toBe('State FSL, Lucknow');
    expect(res.body.item.recordedBy.authorityId).toBe(IDS.io);
    expect(res.body.frozen).toBe(false);

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.CUSTODY_TRANSFERRED }).lean();
    expect(entry.payload).toMatchObject({
      fromStatus: CUSTODY_STATUS.SEIZED,
      toStatus: CUSTODY_STATUS.AT_FSL,
      reason: 'Sent for media forensics',
      recordedByAuthorityId: IDS.io,
      custodySeq: 2,
    });
  });

  it('lets any officer at the station record it — nobody waits for a second scan', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    const res = await move(u.store, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item.status).toBe(CUSTODY_STATUS.IN_STORE);
  });

  it('refuses a move the state machine does not allow, and says what is allowed', async () => {
    const c = await openCase();
    const { body } = await register(c._id);

    const res = await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.RETURNED });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_CUSTODY_TRANSITION');
    expect(res.body.error.details.permitted).toEqual(
      expect.arrayContaining([CUSTODY_STATUS.IN_STORE, CUSTODY_STATUS.AT_FSL, CUSTODY_STATUS.IN_COURT])
    );

    // A finished chain goes nowhere.
    await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.RETURNED });
    const after = await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    expect(after.status).toBe(409);
    expect(after.body.error.details.permitted).toEqual([]);
  });

  it('refuses a movement with no reason', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    const res = await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE, reason: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses the District SP and counsel', async () => {
    const c = await openCase();
    const { body } = await register(c._id);

    const sp = await move(u.sp, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    expect(sp.status).toBe(403);
    expect(sp.body.error.code).toBe(DENY_REASON.READ_ONLY_ROLE);

    const advocate = await move(u.advocate, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    expect(advocate.status).toBe(403);
  });

  it('has no two-scan handshake left to call', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    const res = await post(u.io, `/api/custody/items/${body.item.id}/initiate-transfer`, {});
    expect(res.status).toBe(404);
  });
});

// ========================================= laboratory and court: what they hold ====

describe('a laboratory or a court moves only what is with it', () => {
  it('lets the examiner return an article that is at the laboratory, and nothing else', async () => {
    const c = await openCase();
    const { body } = await register(c._id);

    const tooEarly = await move(u.examiner, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    expect(tooEarly.status).toBe(403);

    expect((await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.AT_FSL })).status).toBe(200);

    const listed = await get(u.examiner, `/api/custody/items?caseId=${c._id}`);
    expect(listed.body.items.map((i) => i.id)).toContain(body.item.id);

    const back = await move(u.examiner, body.item.id, {
      toStatus: CUSTODY_STATUS.IN_STORE,
      reason: 'Examination complete; returned under seal',
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.item.recordedBy.role).toBe(ROLE.FSL_EXAMINER);

    const gone = await move(u.examiner, body.item.id, { toStatus: CUSTODY_STATUS.AT_FSL });
    expect(gone.status).toBe(403);
  });

  it('lets the court return an article produced in court, and refuses one that is not', async () => {
    const c = await openCase();
    const produced = (await register(c._id)).body.item;
    const elsewhere = (await register(c._id, { sealNumber: 'SEAL-GZB-2' })).body.item;
    expect((await post(u.io, `/api/cases/${c._id}/file-chargesheet`)).status).toBe(200);

    // Custody keeps moving after the chargesheet: the police produce it in court.
    const toCourt = await move(u.io, produced.id, { toStatus: CUSTODY_STATUS.IN_COURT });
    expect(toCourt.status, JSON.stringify(toCourt.body)).toBe(200);
    expect(toCourt.body.item.custodian).toMatch(/Sessions Court/);

    const returned = await move(u.judge, produced.id, {
      toStatus: CUSTODY_STATUS.RETURNED,
      reason: 'Released to the owner under the court order',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);

    const notTheirs = await move(u.judge, elsewhere.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    expect(notTheirs.status).toBe(403);
    expect(notTheirs.body.error.code).toBe(DENY_REASON.ARTICLE_NOT_WITH_YOU);
  });
});

// ============================================================ broken seal ====

describe('a broken seal freezes custody', () => {
  it('records the move, writes an integrity exception, and blocks the next move until the SHO decides', async () => {
    const c = await openCase();
    const { body } = await register(c._id);

    const res = await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE, sealIntact: false });
    expect(res.status).toBe(200);
    expect(res.body.frozen).toBe(true);
    expect(res.body.item.status).toBe(CUSTODY_STATUS.IN_STORE);
    expect(res.body.integrityException.reason).toBe('SEAL_BROKEN');
    expect(await Ledger.countDocuments({ eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION })).toBe(1);

    const blocked = await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.AT_FSL });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe(DENY_REASON.CUSTODY_FROZEN);

    const lifted = await post(u.sho, `/api/custody/items/${body.item.id}/lift-freeze`, {
      note: 'Inspected against the seizure memo; contents intact. Re-sealed in my presence.',
      newSealNumber: 'SEAL-GZB-88231-R',
    });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);

    expect((await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.AT_FSL })).status).toBe(200);
  });
});

// ================================================================= labels ====

describe('a QR label identifies an article and authorises nothing (ADR-011)', () => {
  it('resolves a genuine label for someone entitled, with the lawful next moves', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    const res = await get(u.sho, `/api/custody/scan/${encodeURIComponent(body.qr.payload)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tag.authentic).toBe(true);
    expect(res.body.nextStates).toContain(CUSTODY_STATUS.AT_FSL);
    expect(res.body.allowedActions).toContain('RECORD_MOVEMENT');
  });

  it('refuses a genuine label to someone with no entitlement to the article', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    const res = await get(u.advocate, `/api/custody/scan/${encodeURIComponent(body.qr.payload)}`);
    expect(res.status).toBe(403);
  });

  it('refuses a forged label', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    const forged = `${body.qr.payload.slice(0, -1)}${body.qr.payload.endsWith('A') ? 'B' : 'A'}`;
    const res = await get(u.sho, `/api/custody/scan/${encodeURIComponent(forged)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OR_FORGED_TAG');
  });
});

// ========================================================= gap detection ====

describe('gap detection walks the ledger', () => {
  it('leaves a complete chain alone', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.AT_FSL });

    const res = await get(u.sho, '/api/custody/gaps');
    const report = res.body.items.find((r) => r.itemId === body.item.id);
    expect(report.intact).toBe(true);
    expect(res.body.broken).toEqual([]);
  });

  it('names a missing event and a record that disagrees with its own history', async () => {
    const c = await openCase();
    const { body } = await register(c._id);

    // An event that arrived some other way, numbered 4 where 2 was due.
    await appendEvent({
      eventType: LEDGER_EVENT.CUSTODY_TRANSFERRED,
      caseId: new mongoose.Types.ObjectId(c._id),
      subjectId: new mongoose.Types.ObjectId(body.item.id),
      subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
      actorUserId: new mongoose.Types.ObjectId(u.io.user.userId),
      actorRole: ROLE.IO,
      payload: { custodySeq: 4, itemCode: body.item.itemCode, fromStatus: 'SEIZED', toStatus: 'AT_FSL' },
    });

    const res = await get(u.sho, '/api/custody/gaps');
    const report = res.body.items.find((r) => r.itemId === body.item.id);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain('SEQUENCE_DISCONTINUITY');
    expect(codes).toContain('STATE_DIVERGENCE');
    expect(res.body.broken).toContain(body.item.itemCode);
  });

  it('flags a jump no officer could have recorded', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    await appendEvent({
      eventType: LEDGER_EVENT.CUSTODY_TRANSFERRED,
      caseId: new mongoose.Types.ObjectId(c._id),
      subjectId: new mongoose.Types.ObjectId(body.item.id),
      subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
      actorUserId: new mongoose.Types.ObjectId(u.io.user.userId),
      actorRole: ROLE.IO,
      payload: { custodySeq: 2, itemCode: body.item.itemCode, fromStatus: 'SEIZED', toStatus: 'RETURNED' },
    });
    const res = await get(u.sho, `/api/custody/items/${body.item.id}/chain`);
    expect(res.body.analysis.findings.map((f) => f.code)).toContain('ILLEGAL_STATE_TRANSITION');
  });
});

// ============================================================ the register ====

describe('the register and the ledger', () => {
  it('writes every registration and movement to the ledger, and the chain verifies', async () => {
    const c = await openCase();
    const { body } = await register(c._id);
    await move(u.io, body.item.id, { toStatus: CUSTODY_STATUS.IN_STORE });
    await move(u.store, body.item.id, { toStatus: CUSTODY_STATUS.AT_FSL });

    const entries = await Ledger.find({ subjectId: body.item.id }).sort({ seq: 1 }).lean();
    expect(entries.map((e) => e.eventType)).toEqual([
      LEDGER_EVENT.CUSTODY_ITEM_CREATED,
      LEDGER_EVENT.CUSTODY_TRANSFERRED,
      LEDGER_EVENT.CUSTODY_TRANSFERRED,
    ]);
    expect(entries.map((e) => e.payload.custodySeq)).toEqual([1, 2, 3]);
    expect((await verifyChain()).intact).toBe(true);
  });

  it("lists the station's register with the FIR, the custodian and the label link", async () => {
    const c = await openCase();
    await register(c._id);
    const res = await get(u.io, '/api/custody/items');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const [row] = res.body.items;
    expect(row.firNumber).toBe('0123/2026');
    expect(row.custodian).toBe(u.io.user.name);
    expect(row.labelUrl).toContain('/scan?label=');
    expect(row.nextStates).toContain(CUSTODY_STATUS.IN_STORE);
    expect(row).not.toHaveProperty('pendingTransfer');
  });
});
