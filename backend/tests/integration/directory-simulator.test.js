/**
 * The one write endpoint in the three authority directories.
 *
 * `POST /directory/vakalatnama` is an AUTHORITY SIMULATOR, not a Lexx feature. In the
 * real world a court accepts a vakalatnama in eCourts and Lexx only ever reads the
 * result; this endpoint exists so the demo can show that happening, because the grant
 * it produces is what later unlocks disclosure for an advocate.
 *
 * That makes it the most misreadable thing in the repo: a reviewer who took it for
 * part of the product would conclude Lexx grants itself lawyer access. It is called
 * from exactly one place — the presiding judge's acceptance of a filed vakalatnama
 * (controllers/vakalatnama.js), relaying the registry's own act to the court register
 * — and nothing else in the suite would notice if the label or the gate came off.
 * Hence this file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { mongoose } from '../../../shared/mongo.js';
import { createApp } from '../../../directories/common/app.js';
import { directoryRouter } from '../../../directories/court/routes/directory.js';
import { seedCourt } from '../../../directories/court/seed.js';
import { models, CaseListing, Roster, Judge } from '../../../directories/court/models/index.js';

let mongo;

const config = {
  service: 'directory-court-test',
  nodeEnv: 'test',
  bodyLimit: '100kb',
  corsOrigins: ['http://localhost:5000'],
};

/** The court directory app, with the simulator gate set either way. */
const appWith = (allowSimulatedFilings) =>
  createApp({
    config: { ...config, allowSimulatedFilings },
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => this },
    router: directoryRouter({ ...config, allowSimulatedFilings }),
    writeExceptions: [
      { method: 'POST', path: '/directory/vakalatnama' },
      { method: 'POST', path: '/directory/listing' },
    ],
  });

let listing;
let presidingJudge;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'test_dir_court_sim', bufferCommands: false });
  for (const m of models) await m.createIndexes();
  // The seed manages its own connection when run as a script; here the test owns it.
  await seedCourt({ manageConnection: false, logger: { info() {} } });

  listing = await CaseListing.findOne().lean();
  // The judge the roster places in that court today — the only identity the court
  // register will accept an appearance from.
  const roster = await Roster.findOne({ courtId: listing.courtId, validTo: null }).lean();
  presidingJudge = await Judge.findById(roster.judgeId).lean();
  expect(listing, 'court seed must contain a listed case').toBeTruthy();
  expect(presidingJudge, 'the roster must place a serving judge in that court').toBeTruthy();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const filing = (advocate) => ({
  cnrNumber: listing.cnrNumber,
  advocateEnrolmentNo: advocate,
  appearingFor: 'ACCUSED',
  partyName: 'Test Party',
  acceptedBy: presidingJudge.judgeCode,
});

describe('POST /directory/vakalatnama is labelled as a simulator', () => {
  it('says on the face of its own response that it is simulated', async () => {
    const res = await request(appWith(true))
      .post('/directory/vakalatnama')
      .send(filing('UP/5551/2021'));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.simulated).toBe(true);
    expect(res.body.notice).toMatch(/simulated/i);
    expect(res.body.notice).toMatch(/eCourts/);
    expect(res.body.status).toBe('ACCEPTED');
  });

  it('is REFUSED when simulated filings are turned off', async () => {
    const res = await request(appWith(false))
      .post('/directory/vakalatnama')
      .send(filing('UP/5552/2021'));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SIMULATED_FILING_DISABLED');
    expect(res.body.error.message).toMatch(/eCourts/);
  });

  it('writes NOTHING when it refuses', async () => {
    const enrolment = 'UP/5553/2021';
    await request(appWith(false)).post('/directory/vakalatnama').send(filing(enrolment));

    const found = await request(appWith(true)).get(
      `/directory/vakalatnama?enrolmentNo=${encodeURIComponent(enrolment)}`
    );
    expect(found.status).toBe(200);
    expect(found.body.count).toBe(0);
  });

  it('refuses before it validates the body, so a disabled service leaks no shape', async () => {
    const res = await request(appWith(false)).post('/directory/vakalatnama').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SIMULATED_FILING_DISABLED');
  });

  it('still refuses every OTHER write on /directory, gate or no gate', async () => {
    for (const app of [appWith(true), appWith(false)]) {
      const res = await request(app).post('/directory/legal-aid').send({});
      expect(res.status).toBe(405);
    }
  });

  it('reading the register is unaffected by the gate', async () => {
    // Filed through the open gate in the first test of this block.
    const res = await request(appWith(false)).get(
      `/directory/vakalatnama?enrolmentNo=${encodeURIComponent('UP/5551/2021')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
  });
});

describe('POST /directory/listing — the court registering a chargesheet', () => {
  const registration = (firNumber, courtCode = 'UP-GZB-CJM-01') => ({
    firNumber,
    stationCode: 'UP-GZB-KVN',
    courtCode,
    caseCategory: 'MAGISTRATE_TRIAL',
  });

  it('allots a CNR, says it is simulated, and lists the FIR before that court', async () => {
    const res = await request(appWith(true)).post('/directory/listing').send(registration('0901/2026'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.simulated).toBe(true);
    expect(res.body.notice).toMatch(/eCourts/);
    expect(res.body.cnrNumber).toMatch(/^[A-Z]{2}[A-Z0-9]{2}\d{12}$/);
    expect(res.body.court.code).toBe('UP-GZB-CJM-01');

    const found = await request(appWith(false)).get('/directory/listing/by-fir/0901/2026');
    expect(found.body.cnrNumber).toBe(res.body.cnrNumber);
  });

  it('answers a second registration of the same FIR with the SAME listing', async () => {
    const first = await request(appWith(true)).post('/directory/listing').send(registration('0902/2026'));
    const again = await request(appWith(true)).post('/directory/listing').send(registration('0902/2026'));
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.cnrNumber).toBe(first.body.cnrNumber);
  });

  it('refuses a court it does not hold', async () => {
    const res = await request(appWith(true))
      .post('/directory/listing')
      .send(registration('0903/2026', 'UP-XXX-NONE-01'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COURT_NOT_FOUND');
  });

  it('is REFUSED when simulated filings are turned off', async () => {
    const res = await request(appWith(false)).post('/directory/listing').send(registration('0904/2026'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SIMULATED_FILING_DISABLED');
  });

  it('lists the courts of a district for the jurisdiction router', async () => {
    const res = await request(appWith(false)).get('/directory/courts?districtCode=UP-GZB');
    expect(res.status).toBe(200);
    const codes = res.body.courts.map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['UP-GZB-SESS-02', 'UP-GZB-CJM-01']));
  });
});
