/**
 * Existing records recover — not only new ones work.
 *
 * Each migration step is exercised against documents shaped exactly as an earlier
 * version wrote them, inserted raw (the current schemas would refuse them). The
 * indexes that depend on the clean-up — one active certificate per exhibit, one seal
 * per case — are built only AFTER the migrations, as the API does at boot, and must
 * then build without error.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { allModels } from '../../models/index.js';
import { runMigrations } from '../../services/migrations.js';
import { ROLE } from '../../models/enums.js';

let mongo;
const quiet = { info() {}, warn() {}, error() {} };
const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'lexx_test_migrations', bufferCommands: false });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('boot-time migrations', () => {
  const ids = {};
  let report;

  beforeAll(async () => {
    const db = mongoose.connection.db;
    ids.caseId = oid();
    ids.evidenceId = oid();

    await db.collection('users').insertMany([
      { authorityId: 'UP-JUD-2291', role: 'JUDGE', authority: 'COURT' },
      { authorityId: 'UP-GZB-EVC-01', role: 'EVIDENCE_CUSTODIAN', authority: 'COURT' },
      { authorityId: 'UP-GZB-4471', role: 'IO', authority: 'POLICE' },
    ]);

    // Two certificates for one exhibit — the duplicate the one-certificate rule forbids.
    ids.blank = oid();
    ids.signed = oid();
    await db.collection('certificates').insertMany([
      { _id: ids.blank, evidenceId: ids.evidenceId, caseId: ids.caseId, templateVersion: 'v1.0', partBComplete: false, signatures: [{ role: 'PARTY' }], generatedAt: new Date('2026-09-12T17:49:48Z'), verificationToken: 'a'.repeat(43) },
      { _id: ids.signed, evidenceId: ids.evidenceId, caseId: ids.caseId, templateVersion: 'v1.0', partBComplete: true, signatures: [{ role: 'PARTY' }, { role: 'EXPERT' }], generatedAt: new Date('2026-09-12T18:03:42Z'), verificationToken: 'b'.repeat(43) },
    ]);

    // An exhibit carrying the old hardcoded heuristic triage.
    await db.collection('evidence').insertOne({
      _id: ids.evidenceId,
      caseId: ids.caseId,
      exhibitCode: 'EX-01242026-001',
      triage: { priority: 'HIGH', indicators: ['Filename suggests a derived copy'], reasons: [{ label: 'x', weight: 12 }] },
    });

    // An exhibit analysed while the online-source check existed, with its stored result.
    ids.analysedId = oid();
    await db.collection('evidence').insertOne({
      _id: ids.analysedId,
      caseId: ids.caseId,
      exhibitCode: 'EX-01242026-002',
      aiAnalysis: {
        status: 'COMPLETED',
        triagePriority: 'LOW',
        onlineSource: { status: 'FOUND_ONLINE', summary: 'x', indicators: [], sources: [] },
      },
    });

    // Three registrations of one sealed bag, recorded SEIZED "at the FSL", with a handshake field.
    ids.items = [oid(), oid(), oid()];
    await db.collection('custody_items').insertMany(
      ids.items.map((_id, i) => ({
        _id,
        caseId: ids.caseId,
        itemCode: `IT-01242026-00${i + 1}`,
        sealNumber: 'abc',
        status: 'SEIZED',
        currentLocation: 'FSL',
        pendingTransfer: null,
        createdAt: new Date(Date.UTC(2026, 8, 12, 17, 51, i)),
        updatedAt: new Date(Date.UTC(2026, 8, 12, 17, 51, i)),
      }))
    );

    report = await runMigrations(quiet);
  });

  it('turns every court role into the single COURT role', async () => {
    const users = await mongoose.connection.db.collection('users').find().toArray();
    const byId = Object.fromEntries(users.map((u) => [u.authorityId, u.role]));
    expect(byId['UP-JUD-2291']).toBe(ROLE.COURT);
    expect(byId['UP-GZB-EVC-01']).toBe(ROLE.COURT);
    expect(byId['UP-GZB-4471']).toBe(ROLE.IO);
    expect(report.courtRolesUnified).toBe(2);
  });

  it('keeps the more complete duplicate certificate active and supersedes — never deletes — the other', async () => {
    const certs = await mongoose.connection.db.collection('certificates').find().toArray();
    expect(certs).toHaveLength(2);
    const signed = certs.find((c) => String(c._id) === String(ids.signed));
    const blank = certs.find((c) => String(c._id) === String(ids.blank));
    expect(signed.status).toBe('ACTIVE');
    expect(blank.status).toBe('SUPERSEDED');
    expect(String(blank.supersededById)).toBe(String(ids.signed));
    expect(report.duplicateCertificatesSuperseded).toBe(1);
  });

  it('removes the heuristic triage and queues the exhibit for Gemini', async () => {
    const e = await mongoose.connection.db.collection('evidence').findOne({ _id: ids.evidenceId });
    expect(e.triage).toBeUndefined();
    expect(e.aiAnalysis.status).toBe('PENDING');
    expect(e.aiAnalysis.triagePriority).toBeNull();
    expect(e.aiAnalysis.deepfakeScore).toBeNull();
  });

  it('removes the retired online-source result and gives every exhibit a permanent label token', async () => {
    const docs = await mongoose.connection.db.collection('evidence').find().toArray();
    const analysed = docs.find((d) => String(d._id) === String(ids.analysedId));
    expect(analysed.aiAnalysis).not.toHaveProperty('onlineSource');
    expect(analysed.aiAnalysis.triagePriority).toBe('LOW');
    expect(report.aiOnlineSourceRemoved).toBe(1);
    for (const d of docs) expect(d.labelToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(docs.map((d) => d.labelToken)).size).toBe(docs.length);
    expect(report.evidenceLabelTokensBackfilled).toBe(2);
  });

  it('flags duplicate seal registrations, drops the handshake field, and makes location follow status', async () => {
    const items = await mongoose.connection.db.collection('custody_items').find().sort({ createdAt: 1 }).toArray();
    expect(items.map((i) => i.duplicateLegacy)).toEqual([false, true, true]);
    for (const i of items) {
      expect(i).not.toHaveProperty('pendingTransfer');
      expect(i.currentLocation).toBe('FIELD');
      expect(i.currentLocationDetail).toMatch(/Recorded at registration as FSL/);
    }
  });

  it('lets the indexes that depend on the clean-up build', async () => {
    for (const m of allModels) await m.createIndexes();
    const certIndexes = await mongoose.connection.db.collection('certificates').indexes();
    expect(certIndexes.map((i) => i.name)).toContain('one_active_certificate_per_evidence');
    const evidenceIndexes = await mongoose.connection.db.collection('evidence').indexes();
    expect(evidenceIndexes.find((i) => i.name === 'labelToken_1')).toMatchObject({ unique: true, sparse: true });
  });

  it('is idempotent', async () => {
    const tokens = async () =>
      (await mongoose.connection.db.collection('evidence').find().sort({ _id: 1 }).toArray()).map((d) => d.labelToken);
    const before = await tokens();
    const second = await runMigrations(quiet);
    expect(await tokens()).toEqual(before);
    expect(second.aiOnlineSourceRemoved).toBe(0);
    expect(second.evidenceLabelTokensBackfilled).toBe(0);
    expect(second.courtRolesUnified).toBe(0);
    expect(second.duplicateCertificatesSuperseded).toBe(0);
    expect(second.evidenceQueuedForGemini).toBe(0);
    expect(second.duplicateSealRegistrationsFlagged).toBe(0);
  });
});
