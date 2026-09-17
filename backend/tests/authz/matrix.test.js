/**
 * THE AUTHORIZATION MATRIX.
 *
 * Every role, against every scope boundary, through the real HTTP API.
 *
 * This is the phase gate the engineering plan refuses to move past. If cross-scope
 * authorization is broken here, every feature built on top inherits the hole — so
 * this file is deliberately exhaustive and deliberately boring.
 *
 * Case fixtures are written straight into the database rather than created through
 * the API. That is the point: the resolver must be correct for cases in stations,
 * districts and courts that the seeded directory does not contain, and constructing
 * them directly is the only way to cover the whole matrix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Case } from '../../models/Case.js';
import { Evidence } from '../../models/Evidence.js';
import { CustodyItem } from '../../models/CustodyItem.js';
import { CaseAccessGrant } from '../../models/CaseAccessGrant.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { User } from '../../models/User.js';
import { createApp } from '../../app.js';
import { activateUser } from '../helpers/client.js';
import {
  ACTION,
  CASE_STAGE,
  ROLE,
  GRANT_BASIS,
  DENY_REASON,
  DECISION,
  SOURCE_TYPE,
  EVIDENCE_KIND,
  CUSTODY_STATUS,
  CUSTODY_LOCATION,
} from '../../models/enums.js';

let mongo;
let server;
const users = {};

const ID = {
  IO: 'UP-GZB-4471',
  SHO: 'UP-GZB-4402',
  SP: 'UP-GZB-9001',
  JUDGE: 'UP-JUD-2291',
  EVIDENCE_ROOM: 'UP-GZB-EVC-01',
  EXAMINER: 'FSL-LKO-0091',
  ADVOCATE_ON: 'UP/1234/2015',
  ADVOCATE_OFF: 'UP/9876/2019',
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_authz', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  for (const [key, authorityId] of Object.entries(ID)) {
    users[key] = await activateUser(server, authorityId);
  }
});

// ---------------------------------------------------------------- fixtures ----

const auth = (req, who) => req.set('Authorization', `Bearer ${users[who].accessToken}`);

/** A case with explicitly chosen jurisdiction, so every boundary can be exercised. */
async function makeCase({
  firNumber = '0123/2026',
  stationCode = 'UP-GZB-KVN',
  districtCode = 'UP-GZB',
  // The state matters now: a forensic laboratory's review queue is scoped to the
  // state it serves, so an out-of-state case is how that boundary gets exercised.
  stateCode = 'UP',
  ioUserKey = 'IO',
  stage = CASE_STAGE.UNDER_INVESTIGATION,
  courtId = null,
} = {}) {
  const ioUser = await User.findOne({ authorityId: ID[ioUserKey] }).lean();
  return Case.create({
    firNumber,
    firDate: new Date('2026-01-04'),
    title: `FIR ${firNumber}`,
    stationCode,
    districtCode,
    stateCode,
    bnsSections: ['103(1)'],
    maxPunishmentYears: 20,
    sensitivityClass: 'POCSO',
    isVictimProtected: true,
    ioUserId: ioUser._id,
    ioAuthorityId: ioUser.authorityId,
    stage,
    courtId,
    cnrNumber: courtId ? 'UPGB010012342026' : null,
    createdBy: ioUser._id,
  });
}

async function makeEvidence(caseDoc, overrides = {}) {
  const io = await User.findOne({ authorityId: ID.IO }).lean();
  const id = new mongoose.Types.ObjectId();
  return Evidence.create({
    _id: id,
    exhibitCode: `EX-TEST-${String(Math.random()).slice(2, 8)}`,
    caseId: caseDoc._id,
    title: 'Test exhibit',
    kind: EVIDENCE_KIND.DIGITAL,
    sha256Client: 'a'.repeat(64),
    sha256Server: 'a'.repeat(64),
    signature: 'b'.repeat(128),
    signerUserId: io._id,
    signerPubKeyFingerprint: 'c'.repeat(64),
    hashMatchedOnIngest: true,
    signatureValidOnIngest: true,
    storageKey: `${'a'.repeat(64)}-${String(id)}`,
    sizeBytes: 1024,
    mimeType: 'image/jpeg',
    encryption: {
      algo: 'AES-256-GCM',
      iv: 'aXY=',
      tag: 'dGFn',
      wrappedDek: 'ZGVr',
      wrapIv: 'aXY=',
      wrapTag: 'dGFn',
      kekId: 'kek-v1',
    },
    sourceDevice: { sourceType: SOURCE_TYPE.MOBILE },
    uploadedByUserId: io._id,
    ...overrides,
  });
}

async function makeCustodyItem(
  caseDoc,
  holderKey = 'SHO',
  stationCode = 'UP-GZB-KVN',
  status = CUSTODY_STATUS.IN_STORE
) {
  const holder = await User.findOne({ authorityId: ID[holderKey] }).lean();
  return CustodyItem.create({
    itemCode: `IT-TEST-${String(Math.random()).slice(2, 8)}`,
    caseId: caseDoc._id,
    description: 'Samsung Galaxy A54, black',
    sealNumber: 'SEAL-GZB-88231',
    qrPayload: 'LEXX:v1:IT-TEST:sig',
    stationCode,
    districtCode: 'UP-GZB',
    currentHolderUserId: holder._id,
    currentLocation:
      status === CUSTODY_STATUS.SEIZED ? CUSTODY_LOCATION.FIELD : CUSTODY_LOCATION.MALKHANA,
    status,
    createdBy: holder._id,
  });
}

const grantAdvocate = (caseDoc, userKey, overrides = {}) =>
  User.findOne({ authorityId: ID[userKey] })
    .lean()
    .then((u) =>
      CaseAccessGrant.create({
        caseId: caseDoc._id,
        userId: u._id,
        role: ROLE.DEFENCE_COUNSEL,
        grantBasis: GRANT_BASIS.VAKALATNAMA,
        grantRef: 'UP/VAK/2026/8891',
        ...overrides,
      })
    );

const getCase = (id, who) => auth(request(server).get(`/api/cases/${id}`), who);
const getEvidence = (id, who) => auth(request(server).get(`/api/evidence/${id}`), who);

// ============================================================== POLICE: IO ====

describe('POLICE — Investigating Officer', () => {
  it('reads their own case at their own station', async () => {
    const c = await makeCase();
    expect((await getCase(c._id, 'IO')).status).toBe(200);
  });

  it('is DENIED another IO\'s case at the same station', async () => {
    // Being posted to the right station is not the same as being on the case.
    const c = await makeCase({ ioUserKey: 'SHO' });
    const res = await getCase(c._id, 'IO');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ASSIGNED_IO);
  });

  it('is DENIED a case at another station', async () => {
    const c = await makeCase({ stationCode: 'UP-GZB-OTHER', firNumber: '0999/2026' });
    const res = await getCase(c._id, 'IO');
    expect(res.status).toBe(403);
  });

  it('is DENIED a case in another district', async () => {
    const c = await makeCase({
      stationCode: 'UP-MRT-XYZ',
      districtCode: 'UP-MRT',
      firNumber: '0888/2026',
    });
    expect((await getCase(c._id, 'IO')).status).toBe(403);
  });

  it('cannot WRITE once the case has left investigation', async () => {
    const c = await makeCase({ stage: CASE_STAGE.CHARGESHEET_FILED });
    const res = await auth(request(server).post(`/api/cases/${c._id}/compute-jurisdiction`), 'IO');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
  });

  it('can still READ a case that is closed to writes', async () => {
    const c = await makeCase({ stage: CASE_STAGE.TRIAL });
    expect((await getCase(c._id, 'IO')).status).toBe(200);
  });

  it('cannot record a judicial order', async () => {
    const c = await makeCase();
    const res = await auth(request(server).post(`/api/cases/${c._id}/record-order`), 'IO').send({
      orderType: 'BAIL',
      text: 'Granted',
    });
    expect(res.status).toBe(403);
  });

  it('lists only their own cases', async () => {
    await makeCase();
    await makeCase({ ioUserKey: 'SHO', firNumber: '0777/2026' });
    const res = await auth(request(server).get('/api/cases'), 'IO');
    expect(res.status).toBe(200);
    expect(res.body.cases).toHaveLength(1);
  });
});

// ============================================================= POLICE: SHO ====

describe('POLICE — SHO', () => {
  it('reads any case at their own station, including another officer\'s', async () => {
    const c = await makeCase({ ioUserKey: 'IO' });
    expect((await getCase(c._id, 'SHO')).status).toBe(200);
  });

  it('is DENIED a case at another station', async () => {
    const c = await makeCase({ stationCode: 'UP-GZB-OTHER', firNumber: '0999/2026' });
    const res = await getCase(c._id, 'SHO');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.OUT_OF_JURISDICTION);
  });

  it('cannot record a judicial order', async () => {
    const c = await makeCase();
    const res = await auth(request(server).post(`/api/cases/${c._id}/record-order`), 'SHO').send({
      orderType: 'BAIL',
      text: 'Granted',
    });
    expect(res.status).toBe(403);
  });

  it('sees every case at their station in a listing', async () => {
    await makeCase();
    await makeCase({ ioUserKey: 'SHO', firNumber: '0777/2026' });
    await makeCase({ stationCode: 'UP-GZB-OTHER', firNumber: '0999/2026' });
    const res = await auth(request(server).get('/api/cases'), 'SHO');
    expect(res.body.cases).toHaveLength(2);
  });
});

// ====================================================== POLICE: DISTRICT SP ====

describe('POLICE — District SP (read-only oversight)', () => {
  it('reads any case in their district', async () => {
    const c = await makeCase({ stationCode: 'UP-GZB-OTHER', firNumber: '0999/2026' });
    expect((await getCase(c._id, 'SP')).status).toBe(200);
  });

  it('is DENIED a case in another district', async () => {
    const c = await makeCase({
      stationCode: 'UP-MRT-XYZ',
      districtCode: 'UP-MRT',
      firNumber: '0888/2026',
    });
    const res = await getCase(c._id, 'SP');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.OUT_OF_JURISDICTION);
  });

  it('CANNOT write, even inside their own district', async () => {
    const c = await makeCase();
    const res = await auth(request(server).post(`/api/cases/${c._id}/compute-jurisdiction`), 'SP');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.READ_ONLY_ROLE);
  });
});

// ================================================== POLICE: THE STATION STORE ==

/**
 * There is no malkhana custodian role any more, and these tests are what is left of
 * it: the RULE it existed to enforce, which was never really about a job title.
 *
 * The investigating officer on a case must not be the person who keeps that case's
 * evidence in the station store — one person cannot both collect the evidence and be
 * the only witness to its safekeeping. That is now enforced against whoever would
 * actually end up holding the article, rather than by requiring a separate account
 * that every handover had to queue behind.
 */
describe('POLICE — physical custody', () => {
  const moveAs = (who, itemId, toStatus) =>
    auth(request(server).post(`/api/custody/items/${itemId}/move`), who).send({
      toStatus,
      reason: 'Recorded in the authorization matrix',
      sealIntact: true,
    });

  it('lets any officer at the station record a movement — there is no second scan to wait for', async () => {
    const c = await makeCase();
    const item = await makeCustodyItem(c, 'SHO', 'UP-GZB-KVN', CUSTODY_STATUS.SEIZED);
    const res = await moveAs('IO', item._id, CUSTODY_STATUS.IN_STORE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item.status).toBe(CUSTODY_STATUS.IN_STORE);
  });

  it('refuses an officer from another station', async () => {
    const c = await makeCase({ firNumber: '0777/2026', stationCode: 'UP-GZB-OTHER' });
    const item = await makeCustodyItem(c, 'SHO', 'UP-GZB-OTHER', CUSTODY_STATUS.SEIZED);
    const res = await moveAs('IO', item._id, CUSTODY_STATUS.IN_STORE);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.OUT_OF_JURISDICTION);
  });

  it('keeps the District SP read-only over custody', async () => {
    const c = await makeCase();
    const item = await makeCustodyItem(c, 'SHO', 'UP-GZB-KVN', CUSTODY_STATUS.SEIZED);
    const res = await moveAs('SP', item._id, CUSTODY_STATUS.IN_STORE);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.READ_ONLY_ROLE);
  });

  it('refuses the laboratory and the court an article that is not with them', async () => {
    const c = await makeCase({ stage: CASE_STAGE.CHARGESHEET_FILED, courtId: 'UP-GZB-SESS-02' });
    const item = await makeCustodyItem(c, 'SHO', 'UP-GZB-KVN', CUSTODY_STATUS.IN_STORE);

    const court = await moveAs('JUDGE', item._id, CUSTODY_STATUS.RETURNED);
    expect(court.status).toBe(403);
    expect(court.body.error.code).toBe(DENY_REASON.ARTICLE_NOT_WITH_YOU);

    const lab = await moveAs('EXAMINER', item._id, CUSTODY_STATUS.AT_FSL);
    expect(lab.status).toBe(403);
  });
});

// ============================================================ COURT: JUDGE ====

describe('COURT — Judge (court from the roster, never assigned by Lexx)', () => {
  it('is DENIED a case still under investigation and before no court (ADR-015)', async () => {
    const c = await makeCase({ courtId: null });
    const res = await getCase(c._id, 'JUDGE');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.CASE_NOT_LISTED_IN_YOUR_COURT);
  });

  it('reads a case once it is bound to THEIR court', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    expect((await getCase(c._id, 'JUDGE')).status).toBe(200);
  });

  it('reads a case listed before ANOTHER court of the same district — the Court is one role', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-CJM-01' });
    expect((await getCase(c._id, 'JUDGE')).status).toBe(200);
  });

  it('is DENIED a case listed in another district', async () => {
    const c = await makeCase({
      stationCode: 'UP-LKO-HZG',
      districtCode: 'UP-LKO',
      stage: CASE_STAGE.COMMITTED,
      courtId: 'UP-LKO-SESS-01',
    });
    const res = await getCase(c._id, 'JUDGE');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.CASE_NOT_LISTED_IN_YOUR_COURT);
  });

  it('can record an order on a case in their court', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const res = await auth(request(server).post(`/api/cases/${c._id}/record-order`), 'JUDGE').send({
      orderType: 'COMMITTAL',
      text: 'Committed to Sessions.',
    });
    expect(res.status).toBe(201);
    expect(res.body.ledgerSeq).toBeGreaterThan(0);
  });

  it('cannot perform an investigative WRITE', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const res = await auth(request(server).post(`/api/cases/${c._id}/compute-jurisdiction`), 'JUDGE');
    expect(res.status).toBe(403);
  });

  /**
   * The registry powers, which used to need a second court login.
   *
   * A court that can rule but not act is not a court — it is a queue with a judge at
   * the front of it. These are the acts that moved when the registrar went away.
   */
  it('holds APPROVE on a case listed in their court', async () => {
    const { resolve } = await import('../../services/accessResolver.js');
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const u = await User.findOne({ authorityId: ID.JUDGE }).lean();
    const d = await resolve({
      user: { ...u, userId: u._id, scope: u.scope ?? {} },
      action: ACTION.APPROVE,
      resourceType: 'CASE',
      resourceId: c._id,
    });
    expect(d.allow).toBe(true);
  });

  it('nobody authors a disclosure pack any more — sharing is not a step', async () => {
    const { resolveCreate } = await import('../../services/accessResolver.js');
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });

    for (const who of ['JUDGE', 'IO', 'SHO', 'ADVOCATE_ON']) {
      const u = await User.findOne({ authorityId: ID[who] }).lean();
      const d = await resolveCreate({
        user: { ...u, userId: u._id, scope: u.scope ?? {} },
        resourceType: 'DISCLOSURE_PACK',
        context: { caseId: c._id },
      });
      expect(d.allow, `${who} must not author a disclosure pack`).toBe(false);
    }
  });

  it('closes a case, after which nobody may write to it — the court included', async () => {
    const { resolve } = await import('../../services/accessResolver.js');
    const c = await makeCase({ stage: CASE_STAGE.TRIAL, courtId: 'UP-GZB-SESS-02' });

    const closed = await auth(request(server).post(`/api/cases/${c._id}/close`), 'JUDGE').send({
      reason: 'Judgment pronounced; the case is disposed of.',
    });
    expect(closed.status).toBe(200);
    expect(closed.body.case.stage).toBe(CASE_STAGE.CLOSED);
    expect(closed.body.ledgerSeq).toBeGreaterThan(0);

    // Still readable by everyone who could read it. Closing preserves; it does not hide.
    expect((await getCase(c._id, 'JUDGE')).status).toBe(200);
    expect((await getCase(c._id, 'SHO')).status).toBe(200);

    for (const who of ['JUDGE', 'SHO', 'IO']) {
      const u = await User.findOne({ authorityId: ID[who] }).lean();
      const d = await resolve({
        user: { ...u, userId: u._id, scope: u.scope ?? {} },
        action: ACTION.WRITE,
        resourceType: 'CASE',
        resourceId: c._id,
      });
      expect(d.allow, `${who} must not write a closed case`).toBe(false);
    }
  });

  it('refuses to close the same case twice', async () => {
    const c = await makeCase({ stage: CASE_STAGE.TRIAL, courtId: 'UP-GZB-SESS-02' });
    const body = { reason: 'Judgment pronounced; the case is disposed of.' };
    expect(
      (await auth(request(server).post(`/api/cases/${c._id}/close`), 'JUDGE').send(body)).status
    ).toBe(200);
    const again = await auth(request(server).post(`/api/cases/${c._id}/close`), 'JUDGE').send(body);
    // Refused by the policy before the controller is reached, and CASE_IS_CLOSED is
    // the more useful of the two possible answers.
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe(DENY_REASON.CASE_IS_CLOSED);
  });

  it('DENIES closing to everyone but the court', async () => {
    const c = await makeCase({ stage: CASE_STAGE.TRIAL, courtId: 'UP-GZB-SESS-02' });
    for (const who of ['IO', 'SHO', 'SP', 'EXAMINER', 'ADVOCATE_ON']) {
      const res = await auth(request(server).post(`/api/cases/${c._id}/close`), who).send({
        reason: 'Trying to close a case that is not mine to close.',
      });
      expect(res.status, `${who} must not close a case`).toBe(403);
    }
  });
});

// ============================================ COURT: ONE ROLE FOR EVERY OFFICER ====

/**
 * The court used to be two roles — a presiding judge and an evidence room — each
 * scoped to one bench. Registry staff now resolve to the same Court role as a judge,
 * scoped to the district court establishment, so there is one court identity, one
 * dashboard and one set of powers.
 */
describe('COURT — registry staff hold the same single Court role', () => {
  it('resolves every court identity to COURT', () => {
    expect(users.EVIDENCE_ROOM.user.role).toBe(ROLE.COURT);
    expect(users.JUDGE.user.role).toBe(ROLE.COURT);
  });

  it('reads a case listed in the district', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    expect((await getCase(c._id, 'EVIDENCE_ROOM')).status).toBe(200);
  });

  it('is DENIED an unbound case', async () => {
    const c = await makeCase({ courtId: null });
    expect((await getCase(c._id, 'EVIDENCE_ROOM')).status).toBe(403);
  });

  it('records an order like any Court login', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const res = await auth(request(server).post(`/api/cases/${c._id}/record-order`), 'EVIDENCE_ROOM').send({
      orderType: 'ADJOURNMENT',
      text: 'Adjourned to the next date.',
    });
    expect(res.status).toBe(201);
  });
});

// ========================================================= FSL: EXAMINER =====

/**
 * A laboratory reaches evidence two ways, and they are different in kind.
 *
 *   REFERRAL     — a named question about one exhibit, with the article to go with it.
 *   JURISDICTION — the digital evidence registered in the state the lab serves, so
 *                  the review queue the automatic priority feeds can exist at all.
 *
 * The second is new. It is what stopped the highest-priority exhibits in the register
 * sitting unseen because nobody had thought to refer them. It is bounded by the lab's
 * own state code, which comes from the FSL directory at sign-in and is not something
 * a session can assert — and it does NOT extend to custody, which stays referral-
 * bound: a laboratory examines exhibits, it does not handle articles nobody sent it.
 */
describe('FSL — Examiner', () => {
  it('reads evidence in the state its laboratory serves, with no referral at all', async () => {
    const c = await makeCase();
    const e = await makeEvidence(c);
    expect((await getEvidence(e._id, 'EXAMINER')).status).toBe(200);
  });

  it('is DENIED evidence in a case outside its state', async () => {
    const c = await makeCase({ firNumber: '0199/2026', stateCode: 'MH' });
    const e = await makeEvidence(c);
    const res = await getEvidence(e._id, 'EXAMINER');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
  });

  it('is DENIED a custody item — the wider read is about exhibits, not articles', async () => {
    const { resolve } = await import('../../services/accessResolver.js');
    const c = await makeCase();
    const item = await makeCustodyItem(c);
    const u = await User.findOne({ authorityId: ID.EXAMINER }).lean();

    const d = await resolve({
      user: { ...u, userId: u._id, scope: u.scope ?? {} },
      action: ACTION.READ,
      resourceType: 'CUSTODY_ITEM',
      resourceId: item._id,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
  });

  it('cannot record a judicial order or rule on disclosure', async () => {
    const { resolve } = await import('../../services/accessResolver.js');
    const c = await makeCase();
    const e = await makeEvidence(c);
    const u = await User.findOne({ authorityId: ID.EXAMINER }).lean();

    for (const action of [ACTION.ORDER, ACTION.APPROVE]) {
      const d = await resolve({
        user: { ...u, userId: u._id, scope: u.scope ?? {} },
        action,
        resourceType: 'EVIDENCE',
        resourceId: e._id,
      });
      expect(d.allow, `an examiner must not hold ${action}`).toBe(false);
    }
  });

  it('sees nothing at all when the session carries no laboratory scope', async () => {
    // The failure direction that matters: a scoping bug must empty the queue, never
    // fill it with the register.
    const { scopeFilterFor } = await import('../../services/accessResolver.js');
    const u = await User.findOne({ authorityId: ID.EXAMINER }).lean();
    expect(scopeFilterFor({ ...u, userId: u._id, scope: {} }, 'EVIDENCE')).toBeNull();
  });
});

// ============================================================ LEGAL: ADVOCATE ==

describe('LEGAL — Advocate (the confidentiality boundary)', () => {
  it('DENIES an advocate who is not on record', async () => {
    const c = await makeCase();
    const res = await getCase(c._id, 'ADVOCATE_OFF');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('records that denial in the audit log', async () => {
    const c = await makeCase();
    await getCase(c._id, 'ADVOCATE_OFF');

    const denial = await AuditEvent.findOne({
      decision: DECISION.DENY,
      reason: DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE,
    }).lean();

    expect(denial).toBeTruthy();
    expect(denial.authorityId).toBe(ID.ADVOCATE_OFF);
    expect(String(denial.caseId)).toBe(String(c._id));
  });

  it('allows an advocate ON RECORD to read the case', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    expect((await getCase(c._id, 'ADVOCATE_ON')).status).toBe(200);
  });

  it('allows EVERY exhibit of a case they are on record for — no pack, no share step', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const first = await makeEvidence(c);
    const second = await makeEvidence(c);

    expect((await getEvidence(first._id, 'ADVOCATE_ON')).status).toBe(200);
    expect((await getEvidence(second._id, 'ADVOCATE_ON')).status).toBe(200);
  });

  it('DENIES an exhibit in a case they are NOT on record for — the line that matters', async () => {
    const mine = await makeCase();
    const other = await makeCase({ firNumber: '0777/2026', ioUserKey: 'SHO' });
    await grantAdvocate(mine, 'ADVOCATE_ON');
    const e = await makeEvidence(other);

    const res = await getEvidence(e._id, 'ADVOCATE_ON');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('lists every exhibit of their cases, and nothing from anyone else’s', async () => {
    const mine = await makeCase();
    const other = await makeCase({ firNumber: '0777/2026', ioUserKey: 'SHO' });
    await grantAdvocate(mine, 'ADVOCATE_ON');
    const a = await makeEvidence(mine);
    const b = await makeEvidence(mine);
    const foreign = await makeEvidence(other);

    const res = await auth(request(server).get('/api/evidence'), 'ADVOCATE_ON');
    expect(res.status).toBe(200);
    const codes = res.body.evidence.map((e) => e.exhibitCode);
    expect(codes).toContain(a.exhibitCode);
    expect(codes).toContain(b.exhibitCode);
    expect(codes).not.toContain(foreign.exhibitCode);
  });

  it('DENIES a custody item, even in a case they are on record for', async () => {
    const { resolve } = await import('../../services/accessResolver.js');
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const item = await makeCustodyItem(c);
    const u = await User.findOne({ authorityId: ID.ADVOCATE_ON }).lean();

    const d = await resolve({
      user: { ...u, userId: u._id, scope: u.scope ?? {} },
      action: ACTION.READ,
      resourceType: 'CUSTODY_ITEM',
      resourceId: item._id,
    });
    expect(d.allow).toBe(false);
  });

  it('DENIES access once the grant is revoked', async () => {
    const c = await makeCase();
    const grant = await grantAdvocate(c, 'ADVOCATE_ON');
    expect((await getCase(c._id, 'ADVOCATE_ON')).status).toBe(200);

    await CaseAccessGrant.updateOne(
      { _id: grant._id },
      { $set: { revokedAt: new Date(), revocationReason: 'VAKALATNAMA_WITHDRAWN' } }
    );

    const res = await getCase(c._id, 'ADVOCATE_ON');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('DENIES access on an expired grant', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON', {
      validFrom: new Date('2026-01-01'),
      validTo: new Date('2026-02-01'),
    });
    const res = await getCase(c._id, 'ADVOCATE_ON');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.GRANT_EXPIRED);
  });

  it('DENIES access on a grant that is not yet valid', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON', { validFrom: new Date('2099-01-01') });
    const res = await getCase(c._id, 'ADVOCATE_ON');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.GRANT_NOT_YET_VALID);
  });

  it('is read-only even on a case they are on record for', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const res = await auth(request(server).post(`/api/cases/${c._id}/compute-jurisdiction`), 'ADVOCATE_ON');
    expect(res.status).toBe(403);
  });

  it('lists only cases they are on record for', async () => {
    const mine = await makeCase();
    await makeCase({ firNumber: '0777/2026', ioUserKey: 'SHO' });
    await grantAdvocate(mine, 'ADVOCATE_ON');

    const res = await auth(request(server).get('/api/cases'), 'ADVOCATE_ON');
    expect(res.body.cases).toHaveLength(1);
    expect(String(res.body.cases[0]._id)).toBe(String(mine._id));
  });

  it('an advocate on NO case sees an empty listing, never everything', async () => {
    await makeCase();
    const res = await auth(request(server).get('/api/cases'), 'ADVOCATE_OFF');
    expect(res.status).toBe(200);
    expect(res.body.cases).toEqual([]);
  });
});

// ================================================= cross-cutting invariants ===

describe('cross-cutting authorization invariants', () => {
  it('every decision — allow AND deny — is audited', async () => {
    const c = await makeCase();
    await getCase(c._id, 'IO'); // allow
    await getCase(c._id, 'ADVOCATE_OFF'); // deny

    const allows = await AuditEvent.countDocuments({ decision: DECISION.ALLOW, caseId: c._id });
    const denies = await AuditEvent.countDocuments({ decision: DECISION.DENY, caseId: c._id });
    expect(allows).toBeGreaterThanOrEqual(1);
    expect(denies).toBeGreaterThanOrEqual(1);
  });

  it('a non-existent resource is a 404 for everyone, leaking nothing', async () => {
    const ghost = new mongoose.Types.ObjectId();
    for (const who of ['IO', 'SHO', 'SP', 'JUDGE', 'ADVOCATE_OFF']) {
      const res = await getCase(ghost, who);
      expect(res.status).toBe(404);
    }
  });

  it('a malformed id is rejected without a stack trace', async () => {
    const res = await getCase('not-an-object-id', 'IO');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:|node_modules|Error:/);
  });

  it('an unauthenticated request is refused on every protected route', async () => {
    const c = await makeCase();
    for (const path of [
      '/api/cases',
      `/api/cases/${c._id}`,
      `/api/cases/${c._id}/timeline`,
      '/api/evidence',
    ]) {
      expect((await request(server).get(path)).status).toBe(401);
    }
  });

  it('denial reasons never leak protected data', async () => {
    const c = await makeCase();
    const res = await getCase(c._id, 'ADVOCATE_OFF');
    const body = JSON.stringify(res.body);

    // A reason code may say why the CALLER is not entitled. It must not disclose
    // anything about the resource itself.
    expect(body).not.toContain('0123/2026');
    expect(body).not.toContain('UP-GZB-KVN');
    expect(body).not.toContain('POCSO');
    expect(body).not.toMatch(/complainant|accused/i);
  });
});

// ======================================================= APPROVE semantics ==

describe('APPROVE is distinct from WRITE and ORDER, and counsel hold no mutation at all', () => {
  /**
   * APPROVE exists because neither WRITE nor ORDER could express what the statute
   * needs: ruling on what someone else prepared (a vakalatnama) is not authorship.
   * Counsel, on record or not, are strictly read-only.
   *
   * The resolver is exercised directly here — the point is the policy itself, not any
   * one route that happens to use it.
   */
  const resolveFor = async (who, action, resourceType, resourceId) => {
    const { resolve } = await import('../../services/accessResolver.js');
    const u = await User.findOne({ authorityId: ID[who] }).lean();
    return resolve({
      user: { ...u, userId: u._id, scope: u.scope ?? {} },
      action,
      resourceType,
      resourceId,
    });
  };

  it('lets any Court login APPROVE on a case listed in the district', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    for (const who of ['JUDGE', 'EVIDENCE_ROOM']) {
      const d = await resolveFor(who, ACTION.APPROVE, 'CASE', c._id);
      expect(d.allow, `${who} should hold APPROVE`).toBe(true);
    }
  });

  it('DENIES approval to the investigating officer', async () => {
    const c = await makeCase();
    const d = await resolveFor('IO', ACTION.APPROVE, 'CASE', c._id);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe(DENY_REASON.READ_ONLY_ROLE);
  });

  it('DENIES approval to an SHO', async () => {
    const c = await makeCase();
    const d = await resolveFor('SHO', ACTION.APPROVE, 'CASE', c._id);
    expect(d.allow).toBe(false);
  });

  it('DENIES a judicial ORDER to the laboratory', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const d = await resolveFor('EXAMINER', ACTION.ORDER, 'CASE', c._id);
    expect(d.allow).toBe(false);
  });

  it('DENIES counsel on record every mutation on their own case and its exhibits', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const e = await makeEvidence(c);

    for (const action of [ACTION.WRITE, ACTION.APPROVE, ACTION.ORDER, ACTION.ACKNOWLEDGE, ACTION.ATTEST]) {
      for (const [type, id] of [['CASE', c._id], ['EVIDENCE', e._id]]) {
        const d = await resolveFor('ADVOCATE_ON', action, type, id);
        expect(d.allow, `counsel must not hold ${action} on ${type}`).toBe(false);
        expect(d.reason).toBe(DENY_REASON.READ_ONLY_ROLE);
      }
    }
    for (const action of [ACTION.READ, ACTION.VERIFY, ACTION.DOWNLOAD]) {
      const d = await resolveFor('ADVOCATE_ON', action, 'EVIDENCE', e._id);
      expect(d.allow, `counsel on record should hold ${action} on an exhibit`).toBe(true);
    }
  });

  it('a disclosure pack is no longer a resource anyone can act on', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    await grantAdvocate(c, 'ADVOCATE_ON');
    const packId = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('disclosure_packs').insertOne({
      _id: packId,
      caseId: c._id,
      exhibitIds: [],
      status: 'SERVED',
      servedTo: [],
    });

    for (const [who, action] of [['JUDGE', ACTION.APPROVE], ['ADVOCATE_ON', ACTION.READ]]) {
      const d = await resolveFor(who, action, 'DISCLOSURE_PACK', packId);
      expect(d.allow).toBe(false);
      expect(d.reason).toBe(DENY_REASON.RESOURCE_NOT_FOUND);
    }
  });

  it('only the Court may put an advocate on record', async () => {
    const { resolveCreate } = await import('../../services/accessResolver.js');
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });

    for (const [who, expected] of [
      ['JUDGE', true],
      ['IO', false],
      ['SHO', false],
      ['EVIDENCE_ROOM', true],
    ]) {
      const u = await User.findOne({ authorityId: ID[who] }).lean();
      const d = await resolveCreate({
        user: { ...u, userId: u._id, scope: u.scope ?? {} },
        resourceType: 'CASE_ACCESS_GRANT',
        context: { caseId: c._id },
      });
      expect(d.allow, `${who} should ${expected ? '' : 'NOT '}be able to grant representation`).toBe(
        expected
      );
    }
  });
});

// ================================= the case stage lock applies to EVERY role ==

/**
 * REGRESSION — the case never actually closed to writes.
 *
 * The IO branch of the resolver carried `if (action === WRITE && !WRITABLE_CASE_STAGES
 * .includes(caseDoc.stage)) deny(CASE_STAGE_CLOSED_TO_WRITES)`. The SHO branch did
 * not. So once the chargesheet was filed the assigned investigating officer was
 * correctly refused — and the station SHO, who supervises that officer and holds
 * station-wide scope over the same case, could still write to it.
 *
 * "The record is fixed at the chargesheet" is one of the strongest claims this system
 * makes to a court. It was true of one role and false of the role above it, and no
 * test anywhere exercised the SHO against a closed case.
 */
describe('a case closed to writes is closed to writes for everyone', () => {
  const resolveAs = async (who, action, resourceType, resourceId) => {
    const { resolve } = await import('../../services/accessResolver.js');
    const u = await User.findOne({ authorityId: ID[who] }).lean();
    return resolve({
      user: { ...u, userId: u._id, scope: u.scope ?? {} },
      action,
      resourceType,
      resourceId,
    });
  };

  for (const stage of [CASE_STAGE.CHARGESHEET_FILED, CASE_STAGE.COMMITTED, CASE_STAGE.TRIAL]) {
    it(`DENIES an SHO a WRITE on a case at ${stage}`, async () => {
      const c = await makeCase({ stage, courtId: 'UP-GZB-SESS-02' });
      const d = await resolveAs('SHO', ACTION.WRITE, 'CASE', c._id);
      expect(d.allow, `SHO must not write a case at ${stage}`).toBe(false);
      expect(d.reason).toBe(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
    });

    it(`DENIES the assigned IO a WRITE on a case at ${stage}`, async () => {
      const c = await makeCase({ stage, courtId: 'UP-GZB-SESS-02' });
      const d = await resolveAs('IO', ACTION.WRITE, 'CASE', c._id);
      expect(d.allow).toBe(false);
      expect(d.reason).toBe(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
    });
  }

  it('still lets an SHO READ a closed case — supervision does not stop at filing', async () => {
    const c = await makeCase({ stage: CASE_STAGE.CHARGESHEET_FILED, courtId: 'UP-GZB-SESS-02' });
    const d = await resolveAs('SHO', ACTION.READ, 'CASE', c._id);
    expect(d.allow).toBe(true);
  });

  it('still lets an SHO WRITE while the case is open to investigation', async () => {
    const c = await makeCase({ stage: CASE_STAGE.UNDER_INVESTIGATION });
    const d = await resolveAs('SHO', ACTION.WRITE, 'CASE', c._id);
    expect(d.allow).toBe(true);
  });

  it('closes the case to an SHO UPLOAD over HTTP, not merely in the resolver', async () => {
    const c = await makeCase({ stage: CASE_STAGE.CHARGESHEET_FILED, courtId: 'UP-GZB-SESS-02' });
    const res = await auth(
      request(server).post('/api/custody/items'),
      'SHO'
    ).send({
      caseId: String(c._id),
      description: 'Item booked after the chargesheet',
      sealNumber: 'SEAL-GZB-99999',
      stationCode: 'UP-GZB-KVN',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.CASE_STAGE_CLOSED_TO_WRITES);
  });
});
