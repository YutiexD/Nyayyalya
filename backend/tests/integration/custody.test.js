/**
 * Physical custody: QR labels, the two-scan handshake, and gap detection.
 *
 * Run against the REAL directory services, because the identities that hold custody
 * — an IO, a malkhana custodian, an SHO — are directory facts, and a stubbed
 * directory would let a test pass while the real scoping was broken.
 *
 * The claims under test, in one line each:
 *   a genuine label identifies an item and authorises nothing;
 *   a transfer needs both ends, once, within five minutes;
 *   a broken seal stops the item rather than being noted and ignored;
 *   the IO of a case cannot be the store keeper for its own evidence;
 *   and the ledger, not this API, is where the history is checked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Case } from '../../models/Case.js';
import { CustodyItem } from '../../models/CustodyItem.js';
import { Ledger } from '../../models/Ledger.js';
import { createApp } from '../../app.js';
import custodyRoutes from '../../routes/custody.js';
import { activateUser } from '../helpers/client.js';
import { appendEvent, verifyChain } from '../../services/ledger.js';
import {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  CUSTODY_STATUS,
  CUSTODY_LOCATION,
  ROLE,
} from '../../models/enums.js';

let mongo;
let server;

// Seeded by the directory services.
const IO = 'UP-GZB-4471';
const SHO = 'UP-GZB-4402';
const MALKHANA = 'UP-GZB-4455';
const DISTRICT_SP = 'UP-GZB-9001';
const EXAMINER = 'FSL-LKO-0091';
const ADVOCATE_NOT_ON_RECORD = 'UP/9876/2019';
const FIR = '0123/2026';

/**
 * The real app, with the custody routes mounted where they will live.
 *
 * `backend/app.js` is owned by another engineer and does not yet carry the
 * `app.use('/api/custody', ...)` line. Rather than assemble a parallel middleware
 * stack — which would test something other than what ships — the suite lifts the 404
 * and error handlers off the end of the real app, mounts the router, and puts them
 * back. Once app.js is wired the router is already present and this does nothing.
 */
function appWithCustodyRoutes() {
  const app = createApp();
  const stack = app._router.stack;
  const alreadyMounted = stack.some((l) => l.handle === custodyRoutes);
  if (!alreadyMounted) {
    const tail = stack.splice(stack.length - 2, 2); // notFoundHandler, errorHandler
    app.use('/api/custody', custodyRoutes);
    stack.push(...tail);
  }
  return app;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  await startDirectories(uri);

  await mongoose.connect(uri, { dbName: 'lexx_test_custody', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();

  server = appWithCustodyRoutes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  // Clear only Lexx's own collections. The directories keep their seeded state.
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

// ---------------------------------------------------------------- helpers ----

const auth = (req, session) => req.set('Authorization', `Bearer ${session.accessToken}`);

/** Activate the investigating officer and open the demo case from the FIR. */
async function openCase() {
  const io = await activateUser(server, IO);
  const res = await auth(request(server).post('/api/cases/from-fir'), io).send({ firNumber: FIR });
  expect(res.status).toBe(201);
  return { io, caseId: res.body.case._id, caseDoc: res.body.case };
}

/** Seize an item as the IO. Returns the created item and its printed QR payload. */
async function seizeItem(io, caseId, overrides = {}) {
  const res = await auth(request(server).post('/api/custody/items'), io).send({
    caseId,
    description: 'Samsung Galaxy A54, black',
    sealNumber: 'SEAL-GZB-88231',
    identifiers: { imei: '350123456789012' },
    location: CUSTODY_LOCATION.FIELD,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return { item: res.body.item, qr: res.body.qr.payload, body: res.body };
}

const initiate = (session, itemId, payload) =>
  auth(request(server).post(`/api/custody/items/${itemId}/initiate-transfer`), session).send(payload);

const accept = (session, itemId, payload) =>
  auth(request(server).post(`/api/custody/items/${itemId}/accept-transfer`), session).send(payload);

// ================================================== BEAT 4: the two scans ====

describe('the two-scan custody handshake', () => {
  it('moves an exhibit from the seizing officer to the malkhana', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const { item } = await seizeItem(io, caseId);

    expect(item.status).toBe(CUSTODY_STATUS.SEIZED);
    expect(item.currentHolderUserId).toBe(io.user.userId);

    // ---- scan one: the holder proposes the handover ----
    const initiated = await initiate(io, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit into malkhana rack B14',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });

    expect(initiated.status).toBe(201);
    expect(initiated.body.transferToken).toBeTruthy();
    expect(initiated.body.item.status).toBe(CUSTODY_STATUS.SEIZED); // not yet moved

    // The plaintext token is never stored — only its hash.
    const stored = await CustodyItem.findById(item.id).lean();
    expect(stored.pendingTransfer.tokenHash).not.toBe(initiated.body.transferToken);
    expect(stored.pendingTransfer.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // ---- scan two: the receiver accepts ----
    const accepted = await accept(malkhana, item.id, {
      transferToken: initiated.body.transferToken,
      sealIntact: true,
    });

    expect(accepted.status).toBe(200);
    expect(accepted.body.item.status).toBe(CUSTODY_STATUS.IN_STORE);
    expect(accepted.body.item.currentLocation).toBe(CUSTODY_LOCATION.MALKHANA);
    expect(accepted.body.item.currentHolderUserId).toBe(malkhana.user.userId);
    expect(accepted.body.item.pendingTransfer).toBeNull();
    expect(accepted.body.frozen).toBe(false);
  });

  it('refuses a replayed transfer token', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const { item } = await seizeItem(io, caseId);

    const initiated = await initiate(io, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit into malkhana',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });
    const token = initiated.body.transferToken;

    const first = await accept(malkhana, item.id, { transferToken: token, sealIntact: true });
    expect(first.status).toBe(200);

    // The same token, a second time. The handshake is consumed atomically.
    const replay = await accept(malkhana, item.id, { transferToken: token, sealIntact: true });
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe('TRANSFER_TOKEN_INVALID');

    // And the item did not move twice.
    const stored = await CustodyItem.findById(item.id).lean();
    expect(stored.status).toBe(CUSTODY_STATUS.IN_STORE);
  });

  it('refuses an expired transfer token', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const { item } = await seizeItem(io, caseId);

    const initiated = await initiate(io, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit into malkhana',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });

    // Wind the clock past the TTL rather than waiting five minutes for it.
    await CustodyItem.updateOne(
      { _id: item.id },
      { $set: { 'pendingTransfer.expiresAt': new Date(Date.now() - 1000) } }
    );

    const res = await accept(malkhana, item.id, {
      transferToken: initiated.body.transferToken,
      sealIntact: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TRANSFER_TOKEN_EXPIRED');

    const stored = await CustodyItem.findById(item.id).lean();
    expect(stored.status).toBe(CUSTODY_STATUS.SEIZED);
  });

  it('refuses acceptance by anyone but the intended recipient', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const sho = await activateUser(server, SHO);
    const { item } = await seizeItem(io, caseId);

    const initiated = await initiate(io, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit into malkhana',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });

    // The SHO is entitled to touch this item — the resolver lets them through — and
    // even holds the token. They are still not who it was issued to.
    const res = await accept(sho, item.id, {
      transferToken: initiated.body.transferToken,
      sealIntact: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TRANSFER_WRONG_RECIPIENT');

    const stored = await CustodyItem.findById(item.id).lean();
    expect(String(stored.currentHolderUserId)).toBe(io.user.userId);
  });

  it('refuses a transfer initiated by someone who is not holding the item', async () => {
    const { io, caseId } = await openCase();
    const sho = await activateUser(server, SHO);
    const malkhana = await activateUser(server, MALKHANA);
    const { item } = await seizeItem(io, caseId);

    const res = await initiate(sho, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Supervisor moving it on the officer’s behalf',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_CURRENT_HOLDER');
  });
});

// ================================================= QR: identification only ====

describe('a QR label identifies an item and authorises nothing (ADR-011)', () => {
  it('resolves a genuine label for someone entitled to the item', async () => {
    const { io, caseId } = await openCase();
    const { item, qr } = await seizeItem(io, caseId);

    const res = await auth(request(server).get(`/api/custody/scan/${encodeURIComponent(qr)}`), io);
    expect(res.status).toBe(200);
    expect(res.body.tag.authentic).toBe(true);
    expect(res.body.item.itemCode).toBe(item.itemCode);
    expect(res.body.allowedActions).toContain('INITIATE_TRANSFER');
    expect(res.body.nextStates).toEqual([CUSTODY_STATUS.IN_STORE]);
  });

  it('rejects a tag whose HMAC does not verify', async () => {
    const { io, caseId } = await openCase();
    const { qr } = await seizeItem(io, caseId);

    const [prefix, version, itemCode] = qr.split(':');
    const forgeries = [
      `${prefix}:${version}:${itemCode}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      // The attacker's own item code, signed with a MAC they cannot compute.
      `${prefix}:${version}:IT-99999999-001:${qr.split(':')[3]}`,
      'LEXX:v1:IT-99999999-001',
      'not-a-lexx-tag',
    ];

    for (const forged of forgeries) {
      const res = await auth(
        request(server).get(`/api/custody/scan/${encodeURIComponent(forged)}`),
        io
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_OR_FORGED_TAG');
    }
  });

  it('still denies a VALID label presented by someone with no entitlement', async () => {
    // The whole point of ADR-011. The tag verifies; the scanner is refused anyway.
    const { io, caseId } = await openCase();
    const { qr } = await seizeItem(io, caseId);

    const advocate = await activateUser(server, ADVOCATE_NOT_ON_RECORD);
    const examiner = await activateUser(server, EXAMINER);

    for (const outsider of [advocate, examiner]) {
      const res = await auth(
        request(server).get(`/api/custody/scan/${encodeURIComponent(qr)}`),
        outsider
      );
      expect(res.status).toBe(403);
    }

    // Same label, entitled holder: proof the refusals above were about the person.
    const ok = await auth(request(server).get(`/api/custody/scan/${encodeURIComponent(qr)}`), io);
    expect(ok.status).toBe(200);
  });
});

// ============================================== the custody state machine ====

describe('the custody state machine', () => {
  it('refuses a jump that skips the malkhana', async () => {
    const { io, caseId } = await openCase();
    const examinerHolder = await activateUser(server, MALKHANA);
    const { item } = await seizeItem(io, caseId);

    const res = await initiate(io, item.id, {
      toUserId: examinerHolder.user.userId,
      reason: 'Straight to the lab',
      toStatus: CUSTODY_STATUS.AT_FSL,
      toLocation: CUSTODY_LOCATION.FSL,
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_CUSTODY_TRANSITION');
    // Everything routes through IN_STORE — that is what a malkhana is for.
    expect(res.body.error.details.via).toContain(CUSTODY_STATUS.IN_STORE);
  });

  it('permits the lawful route through the store', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const sho = await activateUser(server, SHO);
    const { item } = await seizeItem(io, caseId);

    const toStore = await initiate(io, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });
    await accept(malkhana, item.id, {
      transferToken: toStore.body.transferToken,
      sealIntact: true,
    });

    const toFsl = await initiate(malkhana, item.id, {
      toUserId: sho.user.userId,
      reason: 'Carriage to State FSL, Lucknow',
      toStatus: CUSTODY_STATUS.AT_FSL,
      toLocation: CUSTODY_LOCATION.FSL,
    });
    expect(toFsl.status).toBe(201);

    const atFsl = await accept(sho, item.id, {
      transferToken: toFsl.body.transferToken,
      sealIntact: true,
    });
    expect(atFsl.status).toBe(200);
    expect(atFsl.body.item.status).toBe(CUSTODY_STATUS.AT_FSL);
  });
});

// ================================================== the broken seal rule ====

describe('a broken seal freezes custody', () => {
  it('records an integrity exception, freezes the item, and blocks the next transfer', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const sho = await activateUser(server, SHO);
    const { item } = await seizeItem(io, caseId);

    const initiated = await initiate(io, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit into malkhana',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });

    const accepted = await accept(malkhana, item.id, {
      transferToken: initiated.body.transferToken,
      sealIntact: false,
    });

    expect(accepted.status).toBe(200);
    expect(accepted.body.frozen).toBe(true);
    expect(accepted.body.integrityException.reason).toBe('SEAL_BROKEN');
    expect(accepted.body.item.sealIntact).toBe(false);

    // The exception is in the ledger, permanently.
    const exception = await Ledger.findOne({
      subjectId: new mongoose.Types.ObjectId(item.id),
      eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION,
    }).lean();
    expect(exception).toBeTruthy();
    expect(exception.payload.reason).toBe('SEAL_BROKEN');

    // And the item cannot move again.
    const next = await initiate(malkhana, item.id, {
      toUserId: sho.user.userId,
      reason: 'Carriage to FSL',
      toStatus: CUSTODY_STATUS.AT_FSL,
      toLocation: CUSTODY_LOCATION.FSL,
    });
    expect(next.status).toBe(403);
    expect(next.body.error.code).toBe('CUSTODY_FROZEN');

    // A scan still resolves the label — it just offers nothing to do.
    const scan = await auth(
      request(server).get(`/api/custody/scan/${encodeURIComponent(item.qrPayload)}`),
      malkhana
    );
    expect(scan.status).toBe(200);
    expect(scan.body.item.frozen).toBe(true);
    expect(scan.body.allowedActions).not.toContain('INITIATE_TRANSFER');
  });
});

// ========================================= the IO / malkhana separation ====

describe('the IO of a case cannot be the store keeper for its own evidence', () => {
  it('refuses at initiation when the IO would take the item into the store', async () => {
    const { io, caseId } = await openCase();
    const { item } = await seizeItem(io, caseId);

    const res = await initiate(io, item.id, {
      // The officer booking their own case's exhibit into the malkhana, under
      // their own custody. Seizing it was fine; storing it is not.
      toUserId: io.user.userId,
      reason: 'Keeping it in my own locker',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IO_CANNOT_HOLD_OWN_CASE_EVIDENCE');
  });

  it('refuses at acceptance when the case is reassigned mid-handover', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const { item } = await seizeItem(io, caseId);

    const initiated = await initiate(io, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit into malkhana',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });
    expect(initiated.status).toBe(201);

    // The case is reassigned to the very person about to take the item into store.
    // The rule is about who ends up holding it, so it is re-checked here and not
    // only at initiation.
    await Case.updateOne({ _id: caseId }, { $set: { ioUserId: malkhana.user.userId } });

    const res = await accept(malkhana, item.id, {
      transferToken: initiated.body.transferToken,
      sealIntact: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IO_CANNOT_HOLD_OWN_CASE_EVIDENCE');

    const stored = await CustodyItem.findById(item.id).lean();
    expect(stored.status).toBe(CUSTODY_STATUS.SEIZED);
  });
});

// ==================================================== ledger and the chain ====

describe('every custody movement is in the ledger', () => {
  it('writes creation, initiation and transfer, and the chain still verifies', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const { item } = await seizeItem(io, caseId);

    const initiated = await initiate(io, item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit into malkhana rack B14',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });
    await accept(malkhana, item.id, {
      transferToken: initiated.body.transferToken,
      sealIntact: true,
    });

    const entries = await Ledger.find({ subjectId: new mongoose.Types.ObjectId(item.id) })
      .sort({ seq: 1 })
      .lean();

    expect(entries.map((e) => e.eventType)).toEqual([
      LEDGER_EVENT.CUSTODY_ITEM_CREATED,
      LEDGER_EVENT.CUSTODY_TRANSFER_INITIATED,
      LEDGER_EVENT.CUSTODY_TRANSFERRED,
    ]);
    expect(entries.every((e) => e.subjectType === SUBJECT_TYPE.CUSTODY_ITEM)).toBe(true);
    expect(entries.map((e) => e.payload.custodySeq)).toEqual([1, 2, 3]);

    // The token is a secret. It must not have leaked into the permanent record.
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain(initiated.body.transferToken);

    const chain = await verifyChain();
    expect(chain.intact).toBe(true);
    expect(chain.brokenAtSeq).toBeNull();
  });

  it('returns the full timeline through /chain', async () => {
    const { io, caseId } = await openCase();
    const { item } = await seizeItem(io, caseId);

    const res = await auth(request(server).get(`/api/custody/items/${item.id}/chain`), io);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].eventType).toBe(LEDGER_EVENT.CUSTODY_ITEM_CREATED);
    expect(res.body.analysis.intact).toBe(true);
    expect(res.body.analysis.findings).toEqual([]);
  });
});

// ============================================================ gap detection ====

describe('gap detection reports what is wrong, not that something is', () => {
  it('finds an illegal state jump and a missing event, and leaves a good chain alone', async () => {
    const { io, caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);
    const sho = await activateUser(server, SHO);

    // ---- a clean item: seized, then properly deposited ----
    const clean = await seizeItem(io, caseId, { description: 'Sealed CD-R of CCTV footage' });
    const initiated = await initiate(io, clean.item.id, {
      toUserId: malkhana.user.userId,
      reason: 'Deposit',
      toStatus: CUSTODY_STATUS.IN_STORE,
      toLocation: CUSTODY_LOCATION.MALKHANA,
    });
    await accept(malkhana, clean.item.id, {
      transferToken: initiated.body.transferToken,
      sealIntact: true,
    });

    // ---- a broken item ----
    // The API refuses to produce this chain, which is the point: the detector exists
    // for records that arrived some other way — a migration, a direct write, or an
    // event that went missing. So it is written straight to the ledger here.
    const broken = await seizeItem(io, caseId, { description: 'Seized handset, no store entry' });
    await appendEvent({
      eventType: LEDGER_EVENT.CUSTODY_TRANSFERRED,
      caseId,
      subjectId: new mongoose.Types.ObjectId(broken.item.id),
      subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
      actorUserId: io.user.userId,
      actorRole: ROLE.IO,
      payload: {
        // custodySeq 4 where 2 was due: two events for this item are unaccounted for.
        custodySeq: 4,
        itemCode: broken.item.itemCode,
        fromStatus: CUSTODY_STATUS.SEIZED,
        toStatus: CUSTODY_STATUS.AT_FSL,
        toLocation: CUSTODY_LOCATION.FSL,
      },
    });

    const res = await auth(request(server).get(`/api/custody/gaps?caseId=${caseId}`), sho);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.withFindings).toBe(1);
    expect(res.body.broken).toEqual([broken.item.itemCode]);

    const cleanReport = res.body.items.find((r) => r.itemCode === clean.item.itemCode);
    expect(cleanReport.intact).toBe(true);
    expect(cleanReport.ledgerStatus).toBe(CUSTODY_STATUS.IN_STORE);

    const brokenReport = res.body.items.find((r) => r.itemCode === broken.item.itemCode);
    expect(brokenReport.intact).toBe(false);
    const codes = brokenReport.findings.map((f) => f.code);
    expect(codes).toContain('ILLEGAL_STATE_TRANSITION');
    expect(codes).toContain('SEQUENCE_DISCONTINUITY');
    // The record and its own history disagree, which is itself a finding.
    expect(codes).toContain('STATE_DIVERGENCE');

    const jump = brokenReport.findings.find((f) => f.code === 'ILLEGAL_STATE_TRANSITION');
    expect(jump.detail).toContain(CUSTODY_STATUS.IN_STORE);
    expect(jump.ledgerSeq).toBeGreaterThan(0);
  });

  it('is scoped: a District SP sees their district, an outsider sees nothing', async () => {
    const { io, caseId } = await openCase();
    await seizeItem(io, caseId);

    const sp = await activateUser(server, DISTRICT_SP);
    const spRes = await auth(request(server).get('/api/custody/gaps'), sp);
    expect(spRes.status).toBe(200);
    expect(spRes.body.total).toBe(1);

    const advocate = await activateUser(server, ADVOCATE_NOT_ON_RECORD);
    const advRes = await auth(request(server).get('/api/custody/gaps'), advocate);
    expect(advRes.status).toBe(200);
    expect(advRes.body.items).toEqual([]);
  });
});

// ================================================================ validation ====

describe('input validation and jurisdiction', () => {
  it('refuses to create an item against a case the caller is not on', async () => {
    const { io } = await openCase();
    const orphanCaseId = new mongoose.Types.ObjectId().toString();

    const res = await auth(request(server).post('/api/custody/items'), io).send({
      caseId: orphanCaseId,
      description: 'Item on a case that does not exist',
      sealNumber: 'SEAL-X',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CASE_NOT_FOUND');
  });

  it('rejects a malformed body before anything is written', async () => {
    const { io, caseId } = await openCase();

    const res = await auth(request(server).post('/api/custody/items'), io).send({
      caseId,
      description: '',
      sealNumber: 'SEAL-GZB-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await CustodyItem.countDocuments()).toBe(0);
  });

  it('refuses a malkhana custodian the right to open a custody item', async () => {
    // Custodians hold items; they do not create the record of a seizure they did
    // not make. The capability check lives in the resolver, not here.
    const { caseId } = await openCase();
    const malkhana = await activateUser(server, MALKHANA);

    const res = await auth(request(server).post('/api/custody/items'), malkhana).send({
      caseId,
      description: 'Item booked in by the store keeper',
      sealNumber: 'SEAL-GZB-2',
    });
    expect(res.status).toBe(403);
  });
});
