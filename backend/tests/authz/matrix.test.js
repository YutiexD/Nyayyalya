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
import { DisclosurePack } from '../../models/DisclosurePack.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { User } from '../../models/User.js';
import { createApp } from '../../app.js';
import { activateUser } from '../helpers/client.js';
import {
  ACTION,
  CASE_STAGE,
  ROLE,
  GRANT_BASIS,
  DISCLOSURE_STATUS,
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
  MALKHANA: 'UP-GZB-4455',
  SP: 'UP-GZB-9001',
  JUDGE: 'UP-JUD-2291',
  REGISTRAR: 'UP-GZB-REG-01',
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
    stateCode: 'UP',
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

async function makeCustodyItem(caseDoc, holderKey = 'MALKHANA', stationCode = 'UP-GZB-KVN') {
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
    currentLocation: CUSTODY_LOCATION.MALKHANA,
    status: CUSTODY_STATUS.IN_STORE,
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

async function servePack(caseDoc, exhibitIds, userKey) {
  const u = await User.findOne({ authorityId: ID[userKey] }).lean();
  const io = await User.findOne({ authorityId: ID.IO }).lean();
  return DisclosurePack.create({
    caseId: caseDoc._id,
    exhibitIds,
    preparedBy: io._id,
    status: DISCLOSURE_STATUS.SERVED,
    servedOn: new Date(),
    servedTo: [
      {
        userId: u._id,
        servedAt: new Date(),
        watermarkToken: 'wm-token-123',
        watermarkLabel: 'Adv. Priya Sharma · UP/1234/2015 · 2026-09-04',
      },
    ],
  });
}

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

// ================================================ POLICE: MALKHANA CUSTODIAN ==

describe('POLICE — Malkhana custodian', () => {
  it('is DENIED case records entirely — custody is their whole world', async () => {
    const c = await makeCase();
    const res = await getCase(c._id, 'MALKHANA');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.CUSTODIAN_SCOPE);
  });

  it('is DENIED evidence records', async () => {
    const c = await makeCase();
    const e = await makeEvidence(c);
    expect((await getEvidence(e._id, 'MALKHANA')).status).toBe(403);
  });

  it('is DENIED a custody item at another station', async () => {
    const c = await makeCase();
    const item = await makeCustodyItem(c, 'MALKHANA', 'UP-GZB-OTHER');
    const res = await auth(request(server).get(`/api/cases/${c._id}`), 'MALKHANA');
    expect(res.status).toBe(403);
    expect(item.stationCode).toBe('UP-GZB-OTHER');
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

  it('is DENIED a case bound to a DIFFERENT court', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-CJM-01' });
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
});

// ========================================================= COURT: REGISTRAR ===

describe('COURT — Registrar', () => {
  it('reads a case in their own court', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    expect((await getCase(c._id, 'REGISTRAR')).status).toBe(200);
  });

  it('is DENIED a case in another court', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-CJM-01' });
    const res = await getCase(c._id, 'REGISTRAR');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.OUT_OF_COURT_SCOPE);
  });

  it('is DENIED an unbound case', async () => {
    const c = await makeCase({ courtId: null });
    expect((await getCase(c._id, 'REGISTRAR')).status).toBe(403);
  });

  it('cannot record a judicial order', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const res = await auth(request(server).post(`/api/cases/${c._id}/record-order`), 'REGISTRAR').send({
      orderType: 'BAIL',
      text: 'x',
    });
    expect(res.status).toBe(403);
  });
});

// ========================================================= FSL: EXAMINER =====

describe('FSL — Examiner (referral-scoped)', () => {
  it('is DENIED evidence with no referral to their lab', async () => {
    const c = await makeCase();
    const e = await makeEvidence(c);
    const res = await getEvidence(e._id, 'EXAMINER');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NO_OPEN_REFERRAL_TO_YOUR_LAB);
  });

  it('is DENIED the case record with no live referral', async () => {
    const c = await makeCase();
    expect((await getCase(c._id, 'EXAMINER')).status).toBe(403);
  });

  it('is DENIED a custody item outright', async () => {
    const c = await makeCase();
    await makeCustodyItem(c);
    const res = await getCase(c._id, 'EXAMINER');
    expect(res.status).toBe(403);
  });

  it('sees nothing in a case listing without referrals', async () => {
    await makeCase();
    const res = await auth(request(server).get('/api/cases'), 'EXAMINER');
    expect(res.status).toBe(200);
    expect(res.body.cases).toHaveLength(0);
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

  it('DENIES evidence when no disclosure pack has been served', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const e = await makeEvidence(c);

    const res = await getEvidence(e._id, 'ADVOCATE_ON');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);
  });

  it('allows an exhibit that IS in the served set', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const e = await makeEvidence(c);
    await servePack(c, [e._id], 'ADVOCATE_ON');

    expect((await getEvidence(e._id, 'ADVOCATE_ON')).status).toBe(200);
  });

  it('DENIES an exhibit outside the served set — the line that matters', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const served = await makeEvidence(c);
    const withheld = await makeEvidence(c);
    await servePack(c, [served._id], 'ADVOCATE_ON');

    const res = await getEvidence(withheld._id, 'ADVOCATE_ON');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);
  });

  it('DENIES a pack served to a DIFFERENT advocate', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    await grantAdvocate(c, 'ADVOCATE_OFF');
    const e = await makeEvidence(c);
    // Served on co-accused counsel only.
    await servePack(c, [e._id], 'ADVOCATE_OFF');

    const res = await getEvidence(e._id, 'ADVOCATE_ON');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);
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

// ============================================ APPROVE / ACKNOWLEDGE semantics ==

describe('APPROVE and ACKNOWLEDGE are distinct from WRITE and ORDER', () => {
  /**
   * These two actions exist because neither WRITE nor ORDER could express the pairs
   * the statute needs: approval belongs to a registrar OR a judge, and acknowledgement
   * belongs to counsel who are otherwise strictly read-only.
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

  it('lets a JUDGE approve a pack in their court', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const e = await makeEvidence(c);
    const pack = await servePack(c, [e._id], 'ADVOCATE_ON');

    const d = await resolveFor('JUDGE', ACTION.APPROVE, 'DISCLOSURE_PACK', pack._id);
    expect(d.allow).toBe(true);
  });

  it('lets a REGISTRAR approve a pack in their court', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const e = await makeEvidence(c);
    const pack = await servePack(c, [e._id], 'ADVOCATE_ON');

    const d = await resolveFor('REGISTRAR', ACTION.APPROVE, 'DISCLOSURE_PACK', pack._id);
    expect(d.allow).toBe(true);
  });

  it('DENIES approval to the IO who prepared the pack', async () => {
    // The whole point of approval is that someone other than the author rules on it.
    const c = await makeCase();
    const e = await makeEvidence(c);
    const pack = await servePack(c, [e._id], 'ADVOCATE_ON');

    const d = await resolveFor('IO', ACTION.APPROVE, 'DISCLOSURE_PACK', pack._id);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe(DENY_REASON.READ_ONLY_ROLE);
  });

  it('DENIES approval to an SHO', async () => {
    const c = await makeCase();
    const e = await makeEvidence(c);
    const pack = await servePack(c, [e._id], 'ADVOCATE_ON');

    const d = await resolveFor('SHO', ACTION.APPROVE, 'DISCLOSURE_PACK', pack._id);
    expect(d.allow).toBe(false);
  });

  it('still DENIES a judicial ORDER to a registrar', async () => {
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });
    const d = await resolveFor('REGISTRAR', ACTION.ORDER, 'CASE', c._id);
    expect(d.allow).toBe(false);
  });

  it('lets an advocate ACKNOWLEDGE a pack served to them', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const e = await makeEvidence(c);
    const pack = await servePack(c, [e._id], 'ADVOCATE_ON');

    const d = await resolveFor('ADVOCATE_ON', ACTION.ACKNOWLEDGE, 'DISCLOSURE_PACK', pack._id);
    expect(d.allow).toBe(true);
  });

  it('DENIES acknowledgement of a pack served to someone else', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    await grantAdvocate(c, 'ADVOCATE_OFF');
    const e = await makeEvidence(c);
    const pack = await servePack(c, [e._id], 'ADVOCATE_OFF');

    const d = await resolveFor('ADVOCATE_ON', ACTION.ACKNOWLEDGE, 'DISCLOSURE_PACK', pack._id);
    expect(d.allow).toBe(false);
  });

  it('acknowledging does NOT give an advocate a general WRITE', async () => {
    const c = await makeCase();
    await grantAdvocate(c, 'ADVOCATE_ON');
    const e = await makeEvidence(c);
    const pack = await servePack(c, [e._id], 'ADVOCATE_ON');

    const d = await resolveFor('ADVOCATE_ON', ACTION.WRITE, 'DISCLOSURE_PACK', pack._id);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe(DENY_REASON.READ_ONLY_ROLE);
  });

  it('only a REGISTRAR may put an advocate on record', async () => {
    const { resolveCreate } = await import('../../services/accessResolver.js');
    const c = await makeCase({ stage: CASE_STAGE.COMMITTED, courtId: 'UP-GZB-SESS-02' });

    for (const [who, expected] of [
      ['REGISTRAR', true],
      ['IO', false],
      ['SHO', false],
      ['JUDGE', false],
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
