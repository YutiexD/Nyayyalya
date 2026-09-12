/**
 * Filing a chargesheet puts the case before the court the law points at.
 *
 * Run against the REAL directory services. Three defects are pinned here:
 *
 *   1. `compute-jurisdiction` asked the court directory for `/court/<district code>`,
 *      which is not a court, so it matched nothing and told every case "no court in
 *      this district holds the required designation".
 *   2. Only the one seeded FIR had a court listing, so filing a chargesheet on any
 *      other case failed with NO_COURT_LISTING. The chargesheet is now registered with
 *      the court the jurisdiction router picks, which allots the CNR.
 *   3. A court user's custody listing filtered on `courtId`, a field custody items do
 *      not have. strictQuery dropped it, and one court's evidence room listed every
 *      custody item in every court.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories, urls } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { createApp } from '../../app.js';
import { activateUser } from '../helpers/client.js';
import { CASE_STAGE } from '../../models/enums.js';

let mongo;
let server;

const IO = 'UP-GZB-4471';
const SESSIONS_EVIDENCE_ROOM = 'UP-GZB-EVC-01'; // Sessions Court No. 2
const MAGISTRATE_EVIDENCE_ROOM = 'UP-GZB-EVC-02'; // CJM-01's evidence room
const SESSIONS_JUDGE = 'UP-JUD-2291';
const MAGISTRATE_JUDGE = 'UP-JUD-1180';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_court_listing', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);

async function openCase(io, firNumber) {
  const res = await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.case;
}

describe('the jurisdiction router finds a real court', () => {
  it('routes a 3-year ordinary offence to the Magistrate court of the district', async () => {
    const io = await activateUser(server, IO);
    const c = await openCase(io, '0124/2026');
    const res = await as(io, request(server).post(`/api/cases/${c._id}/compute-jurisdiction`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.jurisdiction.courtType).toBe('MAGISTRATE');
    expect(res.body.court?.code).toBe('UP-GZB-CJM-01');
    expect(res.body.note).toBeNull();
  });

  it('routes an SC/ST Act case to the designated Special Court', async () => {
    const io = await activateUser(server, IO);
    const c = await openCase(io, '0125/2026');
    const res = await as(io, request(server).post(`/api/cases/${c._id}/compute-jurisdiction`)).send({});
    expect(res.body.jurisdiction.requiredDesignation).toBe('SC_ST');
    expect(res.body.court?.code).toBe('UP-GZB-SESS-02');
  });
});

describe('filing a chargesheet registers the case with that court', () => {
  it('allots a CNR from the court register for an FIR that was never listed', async () => {
    const io = await activateUser(server, IO);
    const c = await openCase(io, '0124/2026');

    const res = await as(io, request(server).post(`/api/cases/${c._id}/file-chargesheet`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.case.stage).toBe(CASE_STAGE.CHARGESHEET_FILED);
    expect(res.body.case.courtId).toBe('UP-GZB-CJM-01');
    expect(res.body.case.cnrNumber).toMatch(/^[A-Z]{2}[A-Z0-9]{2}\d{12}$/);

    // The court register itself now lists it — the directory is the source of truth.
    const listed = await fetch(`${urls().court}/directory/listing/by-fir/0124/2026`).then((r) => r.json());
    expect(listed.cnrNumber).toBe(res.body.case.cnrNumber);
    expect(listed.court.code).toBe('UP-GZB-CJM-01');
  });

  it('puts the case on the cause list of THAT court only', async () => {
    const io = await activateUser(server, IO);
    const c = await openCase(io, '0124/2026');
    await as(io, request(server).post(`/api/cases/${c._id}/file-chargesheet`)).send({});

    const magistrate = await activateUser(server, MAGISTRATE_JUDGE);
    const sessions = await activateUser(server, SESSIONS_JUDGE);
    const mine = await as(magistrate, request(server).get('/api/cases'));
    const theirs = await as(sessions, request(server).get('/api/cases'));

    expect(mine.body.cases.map((x) => x._id)).toContain(c._id);
    expect(theirs.body.cases.map((x) => x._id)).not.toContain(c._id);

    // The presiding judge of that court can reach its disclosure; the Sessions bench,
    // which this case is not before, cannot.
    const packs = await as(magistrate, request(server).get(`/api/disclosure/case/${c._id}/packs`));
    expect(packs.status).toBe(200);
    const notTheirs = await as(sessions, request(server).get(`/api/disclosure/case/${c._id}/packs`));
    expect(notTheirs.status).toBe(403);
  });

  it('keeps using the seeded listing where the court register already has one', async () => {
    const io = await activateUser(server, IO);
    const c = await openCase(io, '0123/2026');
    const res = await as(io, request(server).post(`/api/cases/${c._id}/file-chargesheet`)).send({});
    expect(res.body.case.cnrNumber).toBe('UPGB010012342026');
  });
});

describe('a court sees custody items only in cases before it', () => {
  it("does not list another court's custody items to a court's evidence room", async () => {
    const io = await activateUser(server, IO);
    const magistrateCase = await openCase(io, '0124/2026');
    const item = await as(io, request(server).post('/api/custody/items')).send({
      caseId: magistrateCase._id,
      description: 'Handset',
      sealNumber: 'SEAL-T-1',
      identifiers: { imei: '356938035643809' },
      location: 'FIELD',
    });
    expect(item.status).toBe(201);
    await as(io, request(server).post(`/api/cases/${magistrateCase._id}/file-chargesheet`)).send({});

    // The Sessions Court evidence room has no case before it holding that item.
    const room = await activateUser(server, SESSIONS_EVIDENCE_ROOM);
    const listed = await as(room, request(server).get('/api/custody/items'));
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((i) => i.id)).not.toContain(item.body.item.id);

    const gaps = await as(room, request(server).get('/api/custody/gaps'));
    expect(gaps.body.items.map((r) => r.itemId)).not.toContain(item.body.item.id);

    // The Magistrate's registry, before whom it now is, does see it.
    const custodian = await activateUser(server, MAGISTRATE_EVIDENCE_ROOM);
    const theirs = await as(custodian, request(server).get('/api/custody/items'));
    expect(theirs.body.items.map((i) => i.id)).toContain(item.body.item.id);
  });
});
