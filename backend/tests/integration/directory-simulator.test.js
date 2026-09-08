/**
 * The one write endpoint in the three authority directories.
 *
 * `POST /directory/vakalatnama` is an AUTHORITY SIMULATOR, not a Lexx feature. In the
 * real world a registrar accepts a vakalatnama in eCourts and Lexx only ever reads the
 * result; this endpoint exists so the demo can show that happening, because the grant
 * it produces is what later unlocks disclosure for an advocate.
 *
 * That makes it the most misreadable thing in the repo: a reviewer who took it for
 * part of the product would conclude Lexx grants itself lawyer access. Nothing calls
 * it — not the seed, not the frontend, not the API — so nothing else in the suite
 * would have noticed if the label or the gate came off. Hence this file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { mongoose } from '../../../shared/mongo.js';
import { createApp } from '../../../directories/common/app.js';
import { directoryRouter } from '../../../directories/court/routes/directory.js';
import { seedCourt } from '../../../directories/court/seed.js';
import { models, CaseListing, RegistryStaff } from '../../../directories/court/models/index.js';

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
    writeExceptions: [{ method: 'POST', path: '/directory/vakalatnama' }],
  });

let listing;
let registrar;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'test_dir_court_sim', bufferCommands: false });
  for (const m of models) await m.createIndexes();
  // The seed manages its own connection when run as a script; here the test owns it.
  await seedCourt({ manageConnection: false, logger: { info() {} } });

  registrar = await RegistryStaff.findOne({ role: 'REGISTRAR', serviceStatus: 'ACTIVE' }).lean();
  listing = await CaseListing.findOne({ courtId: registrar.courtId }).lean();
  expect(registrar, 'court seed must contain a serving registrar').toBeTruthy();
  expect(listing, 'court seed must contain a case listed in that registrar’s court').toBeTruthy();
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
  acceptedByRegistrar: registrar.staffCode,
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

  it('reading the register is unaffected — Lexx only ever reads', async () => {
    const res = await request(appWith(false)).get(
      `/directory/vakalatnama?enrolmentNo=${encodeURIComponent('UP/1234/2015')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
  });
});
