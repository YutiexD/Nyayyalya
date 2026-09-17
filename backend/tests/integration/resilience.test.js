/**
 * Failure behaviour — the review fixes, exercised end to end.
 *
 * Every test here is a regression test for something that was found by review rather
 * than by a failing test, which is exactly the class of defect that stays hidden: none
 * of these broke a request, they all quietly made a claim untrue.
 *
 *   1. The anchor scheduler existed and was never started, so `/readyz` reported a
 *      healthy system that was not anchoring anything.
 *   2. A denied upload left its temp file on disk forever, because `authorizeCreate`
 *      calls `next(err)` and the controller's `finally` never runs.
 *   3. Search caught its own database errors and returned `[]`, so "we failed to look"
 *      and "nothing matched" were indistinguishable to an investigator.
 *   4. Audit writes fail open by design; nothing capped that, so a logging outage
 *      silently turned "every decision is recorded" into "every decision we managed
 *      to record" — including while disclosure was being served.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Case } from '../../models/Case.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { createApp } from '../../app.js';
import { asUser, sha256Hex } from '../helpers/client.js';
import env from '../../config/env.js';
import {
  setSchedulerState,
  recordAuditFailure,
  recordAuditSuccess,
  AUDIT_UNHEALTHY_THRESHOLD,
  __resetHealth,
} from '../../services/health.js';
import { DECISION } from '../../models/enums.js';

let mongo;
let server;

const IO = 'UP-GZB-4471';
const FIR = '0123/2026';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PER_TEST_COLLECTIONS = ['cases', 'evidence', 'ledger', 'counters', 'audit_events'];

let io;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_resilience', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();
  io = await asUser(server, IO);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  __resetHealth();
  vi.restoreAllMocks();
  await Promise.all(
    PER_TEST_COLLECTIONS.map((name) =>
      mongoose.connection.collection(name).deleteMany({}).catch(() => {})
    )
  );
});

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);

// ============================================================== 1. /readyz ==

describe('/readyz reports the anchor scheduler instead of assuming it', () => {
  it('is degraded while the scheduler has never reported in', async () => {
    // 'unknown' is the boot state. A process that answers requests without ever
    // having tried to start the batcher must not call itself ready.
    const res = await request(server).get('/readyz');
    expect(res.body.anchorScheduler.state).toBe('unknown');
    expect(res.body.status).toBe('degraded');
    expect(res.status).toBe(503);
  });

  it('is ready once the scheduler reports active', async () => {
    setSchedulerState('active');
    const res = await request(server).get('/readyz');
    expect(res.body.anchorScheduler.state).toBe('active');
    expect(res.body.status).toBe('ready');
    expect(res.status).toBe(200);
  });

  it('treats a DISABLED scheduler as healthy — that is a configuration, not a fault', async () => {
    setSchedulerState('disabled');
    const res = await request(server).get('/readyz');
    expect(res.body.status).toBe('ready');
    expect(res.status).toBe(200);
  });

  it('is degraded, with the reason, when the scheduler failed to start', async () => {
    setSchedulerState('failed', 'no anchor RPC configured');
    const res = await request(server).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.anchorScheduler).toMatchObject({
      state: 'failed',
      detail: 'no anchor RPC configured',
    });
  });

  it('says whether it is actually SUBMITTING transactions or only computing roots', async () => {
    setSchedulerState('active');
    const res = await request(server).get('/readyz');
    // The distinction that matters for a demo: DRY_RUN computes the Merkle root and
    // writes the batch, but sends nothing to the chain.
    expect(res.body.anchorScheduler.submitting).toBe(env.ANCHOR_ENABLED);
    expect(res.body.anchorScheduler.network).toBe(env.ANCHOR_NETWORK);
  });

  it('goes degraded when the audit writer has failed repeatedly', async () => {
    setSchedulerState('active');
    for (let i = 0; i < AUDIT_UNHEALTHY_THRESHOLD; i += 1) recordAuditFailure('connection reset');

    const res = await request(server).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.audit).toMatchObject({
      healthy: false,
      consecutiveFailures: AUDIT_UNHEALTHY_THRESHOLD,
    });
  });

  it('never discloses the audit failure MESSAGE — only that it failed, and how often', async () => {
    setSchedulerState('active');
    recordAuditFailure('mongodb://user:hunter2@10.0.0.4:27017 refused the connection');
    const res = await request(server).get('/readyz');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.body.audit.totalFailures).toBe(1);
  });
});

// ================================================== 2. denied upload cleanup ==

describe('a rejected upload does not leave its bytes on disk', () => {
  // multer stages uploads in the OS temp directory, which is shared — including with
  // whatever else is running on this machine — so the assertion is "no NEW file
  // survived", never "the directory is empty".
  const TEMP_DIR = path.join(os.tmpdir(), 'lexx-uploads');
  const tempFiles = () => (fs.existsSync(TEMP_DIR) ? new Set(fs.readdirSync(TEMP_DIR)) : new Set());

  const leaked = (before) => [...tempFiles()].filter((f) => !before.has(f));

  /** The reaper runs on the response's `close` event, so it lands just after the body. */
  async function settle(before) {
    for (let i = 0; i < 40; i += 1) {
      if (leaked(before).length === 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** A real, well-formed case at ANOTHER station — the resolver denies on assignment. */
  async function foreignCase() {
    return Case.create({
      firNumber: '0999/2026',
      firDate: new Date(),
      title: 'Another station',
      stationCode: 'UP-GZB-OTHER',
      districtCode: 'UP-GZB',
      stateCode: 'UP',
      maxPunishmentYears: 3,
      ioUserId: new mongoose.Types.ObjectId(),
      ioAuthorityId: 'UP-GZB-0000',
      createdBy: new mongoose.Types.ObjectId(),
    });
  }

  it('removes the temp file when the resolver DENIES the upload', async () => {
    const other = await foreignCase();
    const bytes = Buffer.concat([PNG, Buffer.alloc(4096, 7)]);
    const sha = sha256Hex(bytes);

    const before = tempFiles();

    // `authorizeCreate` calls next(err), Express skips the controller entirely, and
    // the controller's `finally` — which the route comment used to claim cleaned up
    // "on every failure path, including denial" — never runs at all.
    const res = await as(io, request(server).post('/api/evidence/upload'))
      .field('caseId', String(other._id))
      .field('title', 'Not my case')
      .field('sha256Client', sha)
      .field('signature', io.keys.sign(sha))
      .field('sourceType', 'MOBILE')
      .attach('file', bytes, { filename: 'x.png', contentType: 'image/png' });

    expect(res.status).toBe(403);

    await settle(before);
    expect(leaked(before)).toEqual([]);
  });

  it('removes the temp file when validation rejects the request', async () => {
    const created = await as(io, request(server).post('/api/cases/from-fir')).send({
      firNumber: FIR,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bytes = Buffer.concat([PNG, Buffer.alloc(2048, 3)]);

    const before = tempFiles();

    const res = await as(io, request(server).post('/api/evidence/upload'))
      .field('caseId', String(created.body.case._id))
      .field('title', 'Bad digest')
      .field('sha256Client', 'not-a-sha256')
      .field('signature', 'zz')
      .field('sourceType', 'MOBILE')
      .attach('file', bytes, { filename: 'x.png', contentType: 'image/png' });

    expect(res.status).toBeGreaterThanOrEqual(400);

    await settle(before);
    expect(leaked(before)).toEqual([]);
  });

  it('removes the temp file on the SUCCESS path too', async () => {
    const created = await as(io, request(server).post('/api/cases/from-fir')).send({
      firNumber: FIR,
    });
    const bytes = Buffer.concat([PNG, Buffer.alloc(1024, 9)]);
    const sha = sha256Hex(bytes);

    const before = tempFiles();

    const res = await as(io, request(server).post('/api/evidence/upload'))
      .field('caseId', String(created.body.case._id))
      .field('title', 'Accepted exhibit')
      .field('sha256Client', sha)
      .field('signature', io.keys.sign(sha))
      .field('sourceType', 'MOBILE')
      .attach('file', bytes, { filename: 'x.png', contentType: 'image/png' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    await settle(before);
    expect(leaked(before)).toEqual([]);
  });
});

// ============================================== 3. search fails as a failure ==

describe('search reports a failure as a failure, never as an empty result', () => {
  it('returns SEARCH_UNAVAILABLE 503 when the query throws', async () => {
    await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber: FIR });

    // The precise failure does not matter; what matters is that it cannot be mistaken
    // for "no records matched".
    vi.spyOn(Case, 'find').mockImplementation(() => {
      throw new Error('no text index on cases.$**');
    });

    const res = await as(io, request(server).get('/api/search?q=phone'));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SEARCH_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/not a statement that no records matched/i);
  });

  it('does not leak the database error to the caller', async () => {
    await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber: FIR });
    vi.spyOn(Case, 'find').mockImplementation(() => {
      throw new Error('mongodb://user:hunter2@10.0.0.4:27017 timed out');
    });

    const res = await as(io, request(server).get('/api/search?q=phone'));
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('still audits the query, so a failed search is not an unrecorded one', async () => {
    await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber: FIR });
    vi.spyOn(Case, 'find').mockImplementation(() => {
      throw new Error('boom');
    });

    await as(io, request(server).get('/api/search?q=cctv'));
    const rows = await AuditEvent.find({ reason: 'SEARCH_QUERY' }).lean();
    expect(rows.length).toBe(1);
    expect(rows[0].resourceLabel).toBe('cctv');
    expect(rows[0].decision).toBe(DECISION.ALLOW);
  });

  it('an empty result is still an empty result, not an error', async () => {
    await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber: FIR });
    const res = await as(io, request(server).get('/api/search?q=zzzzznothingmatches'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

// ========================================== 4. audit failure closes the gate ==

describe('the two operations that may not happen unrecorded', () => {
  const unhealthy = () => {
    for (let i = 0; i < AUDIT_UNHEALTHY_THRESHOLD; i += 1) recordAuditFailure('audit down');
  };

  it('refuses a JUDICIAL STEP on a case while the audit trail is broken', async () => {
    unhealthy();
    const res = await as(
      io,
      request(server).post(`/api/cases/${new mongoose.Types.ObjectId()}/transition`)
    ).send({});

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AUDIT_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/not permitted to take place unrecorded/i);
  });

  it('refuses to FILE a forensic report while the audit trail is broken', async () => {
    unhealthy();
    const res = await as(
      io,
      request(server).post(`/api/fsl/referrals/${new mongoose.Types.ObjectId()}/report`)
    ).send({});

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AUDIT_UNAVAILABLE');
  });

  it('refuses BEFORE the resolver runs, so nothing is loaded to decide about', async () => {
    unhealthy();
    const before = await AuditEvent.countDocuments({});
    await as(
      io,
      request(server).post(`/api/cases/${new mongoose.Types.ObjectId()}/transition`)
    ).send({});
    // The guard is the first middleware on the route: no decision was reached, so
    // there is nothing to record — which is the point, since recording is broken.
    expect(await AuditEvent.countDocuments({})).toBe(before);
  });

  it('lifts the refusal as soon as one audit write succeeds', async () => {
    unhealthy();
    recordAuditSuccess();

    const res = await as(
      io,
      request(server).post(`/api/cases/${new mongoose.Types.ObjectId()}/transition`)
    ).send({});

    // Past the audit gate now: the resolver takes over and refuses it on its merits.
    expect(res.status).not.toBe(503);
    expect(res.body.error?.code).not.toBe('AUDIT_UNAVAILABLE');
  });

  it('leaves ordinary reads working — the trade is deliberately narrow', async () => {
    unhealthy();
    const res = await as(io, request(server).get('/api/cases/'));
    expect(res.status).toBe(200);
  });

  it('a failing audit write does not break the request it describes', async () => {
    // The fail-OPEN half of the same trade, which the fail-closed half must not have
    // quietly replaced.
    vi.spyOn(AuditEvent, 'create').mockRejectedValue(new Error('audit collection is gone'));
    const res = await as(io, request(server).post('/api/cases/from-fir')).send({
      firNumber: FIR,
    });
    expect(res.status).toBe(201);
    expect(await Case.countDocuments({})).toBe(1);
  });
});
