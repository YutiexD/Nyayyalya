/**
 * Counsel on record and the case file (spec §8 F8).
 *
 * Run against the REAL directory services. The claims under test:
 *
 *   - an advocate's access to a case comes from the COURT REGISTRY and nowhere else;
 *   - once on record, counsel read the case and EVERY exhibit in it (and each exhibit's
 *     certificate) through the ordinary read endpoints — no pack, no share step;
 *   - counsel stay read-only and case-scoped, never see machine analysis, and an
 *     advocate who is not on record is refused and the refusal is audited;
 *   - the manual sharing workflow and the watermark are gone, including from data
 *     written by earlier versions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Case } from '../../models/Case.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { CaseAccessGrant } from '../../models/CaseAccessGrant.js';
import { createApp } from '../../app.js';
import { asUser, sha256Hex } from '../helpers/client.js';
import { runMigrations } from '../../services/migrations.js';
import { ensureSystemCertificate } from '../../services/certificateIssuer.js';
import { ADVOCATE_ROLES, DECISION, DENY_REASON, GRANT_BASIS, ROLE } from '../../models/enums.js';

let mongo;
let server;

// Seeded identities (see each directory's seed.js).
const IO = 'UP-GZB-4471';
const JUDGE = 'UP-JUD-2291';
const ADVOCATE_ON_RECORD = 'UP/1234/2015'; // vakalatnama ACCEPTED for the demo CNR (put on the register below)
const ADVOCATE_NOT_ON_RECORD = 'UP/9876/2019'; // real advocate, on no case at all
const LEGAL_AID_ADVOCATE = 'UP/7777/2018'; // BNSS s.341 assignment for the same CNR

const FIR = '0123/2026';
const OTHER_FIR = '0124/2026'; // a second case, which nobody here is on record for
const CNR = 'UPGB010012342026';

/** Collections rebuilt for every test. `users` is kept: activation costs bcrypt. */
const PER_TEST_COLLECTIONS = [
  'cases',
  'evidence',
  'disclosure_packs',
  'case_access_grants',
  'certificates',
  'referrals',
  'custody_items',
  'ledger',
  'counters',
  'audit_events',
  'anchor_batches',
  'stream_tokens',
];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Everything Part A of the s.63 Schedule asks for, so a certificate can be generated. */
const FULL_DEVICE = Object.freeze({
  sourceType: 'MOBILE',
  make: 'Samsung',
  model: 'Galaxy A54',
  colour: 'Black',
  serialNumber: 'R58N90ABCDE',
  imeiOrUid: '351756051523999',
});

const quiet = { info() {}, warn() {}, error() {} };

let io;
let judge;
let onRecord;
let notOnRecord;
let legalAid;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  const directories = await startDirectories(uri);

  // The court register starts with nobody on record. This suite is about MIRRORING
  // that register, so the appearance is put on it directly, as the registry would —
  // Lexx's own e-filing flow has its own suite (vakalatnama.test.js).
  const filed = await fetch(`${directories.court}/directory/vakalatnama`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cnrNumber: CNR,
      advocateEnrolmentNo: ADVOCATE_ON_RECORD,
      appearingFor: 'ACCUSED',
      partyName: 'Ramesh Singh',
      acceptedBy: JUDGE,
    }),
  });
  expect([201, 409]).toContain(filed.status);

  await mongoose.connect(uri, { dbName: 'lexx_test_disclosure', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();

  server = createApp();

  io = await asUser(server, IO);
  judge = await asUser(server, JUDGE);
  onRecord = await asUser(server, ADVOCATE_ON_RECORD);
  notOnRecord = await asUser(server, ADVOCATE_NOT_ON_RECORD);
  legalAid = await asUser(server, LEGAL_AID_ADVOCATE);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(
    PER_TEST_COLLECTIONS.map((name) =>
      mongoose.connection.collection(name).deleteMany({}).catch(() => {})
    )
  );
});

// ---------------------------------------------------------------- helpers ----

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);
const get = (session, path) => as(session, request(server).get(path));
const post = (session, path, body = {}) => as(session, request(server).post(path)).send(body);

async function createCase(firNumber = FIR) {
  const res = await post(io, '/api/cases/from-fir', { firNumber });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.case;
}

/** Upload one exhibit as the IO, signing the hash exactly as the browser would. */
async function uploadExhibit(caseId, title, device = FULL_DEVICE) {
  const bytes = Buffer.concat([PNG, Buffer.from(title.padEnd(96, '.'), 'utf8')]);
  const sha = sha256Hex(bytes);

  let req = as(io, request(server).post('/api/evidence/upload'))
    .field('caseId', String(caseId))
    .field('title', title)
    .field('sha256Client', sha)
    .field('signature', io.keys.sign(sha))
    .field('sourceType', device.sourceType ?? 'MOBILE');

  for (const [key, value] of Object.entries(device)) {
    if (key !== 'sourceType') req = req.field(key, String(value));
  }

  const res = await req.attach('file', bytes, { filename: `${title}.png`, contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evidence;
}

/** A case listed before a court: created, given exhibits, and filed. Nobody on record. */
async function listedCase({ firNumber = FIR, titles = ['CCTV clip', 'Mobile video', 'Witness statement'] } = {}) {
  const caseDoc = await createCase(firNumber);
  const exhibits = [];
  for (const title of titles) exhibits.push(await uploadExhibit(caseDoc._id, title));

  const filed = await post(io, `/api/cases/${caseDoc._id}/file-chargesheet`);
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);

  return { caseId: String(caseDoc._id), exhibits };
}

/** A listed case with counsel put on record from the court register — and nothing else. */
async function caseWithCounsel(options) {
  const listed = await listedCase(options);
  const synced = await post(judge, `/api/disclosure/${listed.caseId}/sync-representation`);
  expect(synced.status, JSON.stringify(synced.body)).toBe(200);
  return { ...listed, synced: synced.body };
}

const denialRows = (reason) => AuditEvent.find({ decision: DECISION.DENY, reason }).lean();

// ================================================= representation from court ==

describe('representation is mirrored from the court directory, never asserted', () => {
  it('creates a VAKALATNAMA grant from the accepted vakalatnama in dir_court', async () => {
    const { caseId, synced } = await caseWithCounsel({ titles: [] });

    expect(synced.cnrNumber).toBe(CNR);
    expect(synced.source).toBe('COURT_DIRECTORY');

    const grant = await CaseAccessGrant.findOne({ caseId, userId: onRecord.user.userId }).lean();
    expect(grant).toBeTruthy();
    expect(grant.role).toBe(ROLE.DEFENCE_COUNSEL);
    expect(grant.grantBasis).toBe(GRANT_BASIS.VAKALATNAMA);
    expect(grant.grantRef).toContain(CNR);
    expect(grant.grantRef).toContain(ADVOCATE_ON_RECORD);
  });

  it('creates NO grant for the advocate who is on no case', async () => {
    const { caseId } = await caseWithCounsel({ titles: [] });
    const holders = (await CaseAccessGrant.find({ caseId }).lean()).map((g) => String(g.userId));
    expect(holders).not.toContain(String(notOnRecord.user.userId));
  });

  it('also mirrors a BNSS s.341 legal-aid assignment', async () => {
    const { caseId } = await caseWithCounsel({ titles: [] });
    const grant = await CaseAccessGrant.findOne({ caseId, role: ROLE.LEGAL_AID_COUNSEL }).lean();
    expect(grant).toBeTruthy();
    expect(grant.grantBasis).toBe(GRANT_BASIS.LEGAL_AID_ORDER);
    expect(grant.grantRef).toBe('SC/GZB/341/2026/44');
  });

  it('is idempotent — polling twice does not duplicate a grant', async () => {
    const { caseId } = await caseWithCounsel({ titles: [] });
    const second = await post(judge, `/api/disclosure/${caseId}/sync-representation`);
    expect(second.body.granted).toEqual([]);
    expect(await CaseAccessGrant.countDocuments({ caseId, role: ROLE.DEFENCE_COUNSEL })).toBe(1);
  });

  it('refuses to sync a case that is not yet listed before a court', async () => {
    const caseDoc = await createCase();
    const res = await post(judge, `/api/disclosure/${caseDoc._id}/sync-representation`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.CASE_NOT_LISTED_IN_YOUR_COURT);
  });

  it('refuses counsel putting themselves, or anyone, on record', async () => {
    const { caseId } = await listedCase({ titles: [] });
    const res = await post(onRecord, `/api/disclosure/${caseId}/sync-representation`);
    expect(res.status).toBe(403);
    // The IO's own posting grant exists from case creation; no ADVOCATE grant may.
    expect(await CaseAccessGrant.countDocuments({ caseId, role: { $in: ADVOCATE_ROLES } })).toBe(0);
  });
});

// ====================================== on record = the whole case file ==

describe('counsel on record read every exhibit of the case, with no share step', () => {
  it('opens each exhibit the moment counsel is on record — no pack exists, none is needed', async () => {
    const { exhibits } = await caseWithCounsel();

    for (const e of exhibits) {
      const res = await get(onRecord, `/api/evidence/${e._id}`);
      expect(res.status, `${e.exhibitCode}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.evidence.exhibitCode).toBe(e.exhibitCode);
    }
    expect(await mongoose.connection.collection('disclosure_packs').countDocuments()).toBe(0);
  });

  it('lists every exhibit of the case on GET /api/evidence, with or without ?caseId', async () => {
    const { caseId, exhibits } = await caseWithCounsel();

    for (const path of ['/api/evidence', `/api/evidence?caseId=${caseId}`]) {
      const res = await get(onRecord, path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const codes = res.body.evidence.map((e) => e.exhibitCode);
      for (const e of exhibits) expect(codes, path).toContain(e.exhibitCode);
    }
  });

  it('returns the case and all its exhibits from GET /api/disclosure/case-file/:caseId', async () => {
    const { caseId, exhibits } = await caseWithCounsel();

    const res = await get(onRecord, `/api/disclosure/case-file/${caseId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.caseId).toBe(caseId);
    expect(res.body.cnrNumber).toBe(CNR);
    expect(res.body.exhibitCount).toBe(exhibits.length);
    expect(res.body.exhibits.map((e) => e.evidenceId).sort()).toEqual(exhibits.map((e) => e._id).sort());
    expect(res.body.onRecord.map((g) => g.role)).toContain(ROLE.DEFENCE_COUNSEL);
    // Coming on record is when the material became available; the date is recorded.
    expect(res.body.clocks.disclosureServedOn).toBeTruthy();

    // The older path answers identically, so a client not yet updated keeps working.
    const alias = await get(onRecord, `/api/disclosure/my-pack/${caseId}`);
    expect(alias.status).toBe(200);
    expect(alias.body.exhibitCount).toBe(exhibits.length);
  });

  it('opens the case file to legal-aid counsel on record too', async () => {
    const { exhibits } = await caseWithCounsel();
    const res = await get(legalAid, `/api/evidence/${exhibits[2]._id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('never sends counsel AI analysis, triage or key material', async () => {
    const { caseId, exhibits } = await caseWithCounsel();

    const file = await get(onRecord, `/api/disclosure/case-file/${caseId}`);
    expect(JSON.stringify(file.body)).not.toMatch(/aiAnalysis|triage|deepfake|encryption|wrappedDek|storageKey/i);

    const one = await get(onRecord, `/api/evidence/${exhibits[0]._id}`);
    expect(one.body.evidence.aiAnalysis).toBeUndefined();

    const list = await get(onRecord, `/api/evidence?caseId=${caseId}`);
    for (const e of list.body.evidence) expect(e.aiAnalysis).toBeUndefined();
  });

  it('reads the s.63 certificate of any exhibit in the case', async () => {
    const { caseId, exhibits } = await caseWithCounsel();
    // Certificates are issued by the system on upload; make sure this one is done.
    const { certificate } = await ensureSystemCertificate(exhibits[2]._id);
    expect(certificate).toBeTruthy();
    const certificateId = String(certificate._id);

    const res = await get(onRecord, `/api/certificates/${certificateId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).toContain(certificateId);

    const listed = await get(onRecord, `/api/certificates?evidenceId=${exhibits[2]._id}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);

    const file = await get(onRecord, `/api/disclosure/case-file/${caseId}`);
    const row = file.body.exhibits.find((e) => e.evidenceId === String(exhibits[2]._id));
    expect(row.certificateId).toBe(certificateId);
  });

  it('existing counsel whose case has an old, partial served pack still read everything', async () => {
    // A pack written by an earlier version, served on this advocate with ONE exhibit.
    const { caseId, exhibits } = await caseWithCounsel();
    await mongoose.connection.collection('disclosure_packs').insertOne({
      caseId: new mongoose.Types.ObjectId(caseId),
      exhibitIds: [new mongoose.Types.ObjectId(exhibits[0]._id)],
      excludedItems: [],
      preparedBy: new mongoose.Types.ObjectId(judge.user.userId),
      status: 'SERVED',
      servedTo: [{ userId: new mongoose.Types.ObjectId(onRecord.user.userId), servedAt: new Date() }],
    });

    for (const e of exhibits) {
      expect((await get(onRecord, `/api/evidence/${e._id}`)).status).toBe(200);
    }
  });
});

// ================================================== counsel stay read-only ==

describe('counsel on record remain read-only', () => {
  it('cannot add an exhibit to the case they are on record for', async () => {
    const { caseId, exhibits } = await caseWithCounsel({ titles: ['CCTV clip'] });
    const bytes = Buffer.concat([PNG, Buffer.from('counsel upload'.padEnd(96, '.'))]);
    const sha = sha256Hex(bytes);
    const res = await as(onRecord, request(server).post('/api/evidence/upload'))
      .field('caseId', caseId)
      .field('title', 'Counsel upload')
      .field('sha256Client', sha)
      .field('signature', onRecord.keys.sign(sha))
      .field('sourceType', 'MOBILE')
      .attach('file', bytes, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(await mongoose.connection.collection('evidence').countDocuments({})).toBe(exhibits.length);
  });

  it('cannot book a custody item or record an order', async () => {
    const { caseId } = await caseWithCounsel({ titles: ['CCTV clip'] });
    const item = await post(onRecord, '/api/custody/items', {
      caseId,
      description: 'Booked by counsel',
      sealNumber: 'SEAL-COUNSEL-1',
    });
    expect(item.status).toBe(403);
    expect(await mongoose.connection.collection('custody_items').countDocuments({})).toBe(0);
    const order = await post(onRecord, `/api/cases/${caseId}/record-order`, {
      orderType: 'ADJOURNMENT',
      text: 'Counsel cannot record an order.',
    });
    expect(order.status).toBe(403);
  });
});

// ==================================================== the denial, front and centre ==

describe('an advocate NOT on record is denied, and the denial is recorded', () => {
  it('refuses the case file with NOT_ON_RECORD_FOR_THIS_CASE', async () => {
    const { caseId } = await caseWithCounsel();
    const res = await get(notOnRecord, `/api/disclosure/case-file/${caseId}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('writes a DENY row to audit_events naming the advocate and the case', async () => {
    const { caseId } = await caseWithCounsel();
    await get(notOnRecord, `/api/disclosure/case-file/${caseId}`);

    const rows = await denialRows(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
    const row = rows.find((r) => r.authorityId === ADVOCATE_NOT_ON_RECORD);
    expect(row).toBeTruthy();
    expect(row.decision).toBe(DECISION.DENY);
    expect(row.role).toBe(ROLE.DEFENCE_COUNSEL);
    expect(String(row.caseId)).toBe(caseId);
  });

  it('refuses them every exhibit, and lists them none', async () => {
    const { caseId, exhibits } = await caseWithCounsel();
    for (const e of exhibits) {
      const res = await get(notOnRecord, `/api/evidence/${e._id}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
    }
    const list = await get(notOnRecord, `/api/evidence?caseId=${caseId}`);
    expect(list.status).toBe(200);
    expect(list.body.evidence).toEqual([]);
  });

  it('refuses them the case itself', async () => {
    const { caseId } = await caseWithCounsel();
    const res = await get(notOnRecord, `/api/cases/${caseId}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });
});

// ================================================ case-scoped, moment to moment ==

describe('access is scoped to the case and follows the grant', () => {
  it('counsel on record for one case see nothing of another', async () => {
    const mine = await caseWithCounsel({ titles: ['CCTV clip'] });
    const other = await listedCase({ firNumber: OTHER_FIR, titles: ['Unrelated exhibit'] });

    const exhibit = await get(onRecord, `/api/evidence/${other.exhibits[0]._id}`);
    expect(exhibit.status).toBe(403);
    expect(exhibit.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);

    const file = await get(onRecord, `/api/disclosure/case-file/${other.caseId}`);
    expect(file.status).toBe(403);
    expect(file.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);

    for (const path of ['/api/evidence', `/api/evidence?caseId=${other.caseId}`]) {
      const list = await get(onRecord, path);
      const codes = list.body.evidence.map((e) => e.exhibitCode);
      expect(codes, path).not.toContain(other.exhibits[0].exhibitCode);
    }
    const listed = await get(onRecord, '/api/evidence');
    expect(listed.body.evidence.map((e) => e.exhibitCode)).toContain(mine.exhibits[0].exhibitCode);
  });

  it('refuses the exhibits before counsel is on record', async () => {
    const { exhibits } = await listedCase({ titles: ['CCTV clip'] });
    const res = await get(onRecord, `/api/evidence/${exhibits[0]._id}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('a REVOKED grant takes the case file away again', async () => {
    const { caseId, exhibits } = await caseWithCounsel({ titles: ['CCTV clip'] });
    expect((await get(onRecord, `/api/evidence/${exhibits[0]._id}`)).status).toBe(200);

    await CaseAccessGrant.updateOne(
      { caseId, role: ROLE.DEFENCE_COUNSEL, revokedAt: null },
      { $set: { revokedAt: new Date(), revocationReason: 'VAKALATNAMA_WITHDRAWN' } }
    );

    for (const path of [`/api/evidence/${exhibits[0]._id}`, `/api/disclosure/case-file/${caseId}`]) {
      const res = await get(onRecord, path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
    }
  });
});

// ============================================== the manual workflow is gone ==

describe('the manual sharing workflow and the watermark are gone', () => {
  it('has no share, prepare, approve, serve, acknowledge, pack-list or trace route', async () => {
    const { caseId } = await caseWithCounsel({ titles: ['CCTV clip'] });
    const someId = new mongoose.Types.ObjectId().toString();

    for (const [method, path] of [
      ['post', `/api/disclosure/${caseId}/share`],
      ['post', `/api/disclosure/${caseId}/prepare`],
      ['post', `/api/disclosure/${someId}/approve`],
      ['post', `/api/disclosure/${someId}/serve`],
      ['post', `/api/disclosure/${someId}/acknowledge`],
      ['get', `/api/disclosure/case/${caseId}/packs`],
      ['get', `/api/disclosure/trace/${'A'.repeat(43)}`],
    ]) {
      const res = await as(judge, request(server)[method](path)).send({});
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
    }
  });

  it('never mentions a watermark in what counsel or the court receive', async () => {
    const { caseId, exhibits, synced } = await caseWithCounsel({ titles: ['CCTV clip'] });
    const bodies = [
      synced,
      (await get(onRecord, `/api/disclosure/case-file/${caseId}`)).body,
      (await get(onRecord, `/api/evidence/${exhibits[0]._id}`)).body,
      (await get(judge, `/api/cases/${caseId}`)).body,
    ];
    for (const body of bodies) expect(JSON.stringify(body)).not.toMatch(/watermark/i);

    const ledger = await mongoose.connection.collection('ledger').find({}).toArray();
    expect(JSON.stringify(ledger)).not.toMatch(/watermark/i);
  });
});

// =================================================== existing data migrates ==

describe('the boot migration strips watermarks from existing records', () => {
  it('unsets watermark fields, drops the watermark index, and is idempotent', async () => {
    const db = mongoose.connection.db;
    const packs = db.collection('disclosure_packs');
    const tokens = db.collection('stream_tokens');

    const packId = new mongoose.Types.ObjectId();
    await packs.insertOne({
      _id: packId,
      caseId: new mongoose.Types.ObjectId(),
      exhibitIds: [],
      preparedBy: new mongoose.Types.ObjectId(),
      status: 'SERVED',
      servedTo: [
        {
          userId: new mongoose.Types.ObjectId(),
          servedAt: new Date(),
          watermarkToken: 'A'.repeat(43),
          watermarkLabel: 'Adv. X · UP/1/2000 · 2026-01-01T00:00:00.000Z',
          acknowledgedAt: null,
        },
      ],
    });
    await packs.createIndex({ 'servedTo.watermarkToken': 1 }, { sparse: true });

    const tokenId = new mongoose.Types.ObjectId();
    await tokens.insertOne({
      _id: tokenId,
      tokenHash: 'f'.repeat(64),
      userId: new mongoose.Types.ObjectId(),
      resourceId: new mongoose.Types.ObjectId(),
      purpose: 'EVIDENCE',
      watermarkLabel: 'Adv. X · UP/1/2000',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const first = await runMigrations(quiet);
    expect(first.watermarkFieldsRemovedFromPacks).toBe(1);
    expect(first.watermarkFieldsRemovedFromStreamTokens).toBe(1);
    expect(first.watermarkIndexesDropped).toBe(1);

    const pack = await packs.findOne({ _id: packId });
    expect(pack.servedTo[0].watermarkToken).toBeUndefined();
    expect(pack.servedTo[0].watermarkLabel).toBeUndefined();
    expect(pack.servedTo[0].userId).toBeTruthy();
    expect((await tokens.findOne({ _id: tokenId })).watermarkLabel).toBeUndefined();
    expect((await packs.indexes()).map((i) => i.name)).not.toContain('servedTo.watermarkToken_1');

    const second = await runMigrations(quiet);
    expect(second.watermarkFieldsRemovedFromPacks).toBe(0);
    expect(second.watermarkFieldsRemovedFromStreamTokens).toBe(0);
    expect(second.watermarkIndexesDropped).toBe(0);
  });

  it('leaves the BNSS s.230 dates on the case untouched', async () => {
    const { caseId } = await caseWithCounsel({ titles: [] });
    const before = (await Case.findById(caseId).lean()).clocks;
    await runMigrations(quiet);
    const after = (await Case.findById(caseId).lean()).clocks;
    expect(String(after.disclosureDueOn)).toBe(String(before.disclosureDueOn));
    expect(String(after.disclosureServedOn)).toBe(String(before.disclosureServedOn));
  });
});
