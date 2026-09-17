/**
 * The realtime change feed (GET /api/events/stream).
 *
 * Run over a real listening socket with a streaming HTTP client, because the claims are
 * about the wire: the stream is not buffered, it opens with `retry` and `ready`, it
 * heartbeats, and every `change` frame carries ids and a type and nothing else.
 *
 * The audience claims run against the REAL directory services and the real resolver:
 *   the uploading IO hears about the upload, an officer not on the case and counsel not
 *   on record do not; counsel accepted by the court hear what follows on that case; an
 *   AI analysis update reaches the laboratory and never the investigating officer.
 *
 * The tests in the audience block are one sequence and run in order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { createApp } from '../../app.js';
import { asUser, sha256Hex } from '../helpers/client.js';
import { drainAnalyses } from '../../services/ai/analysisService.js';
import { appendEvent } from '../../services/ledger.js';
import { closeAllStreams, emitChange, streamCount } from '../../services/realtime.js';
import { LEDGER_EVENT, REALTIME_EVENT } from '../../models/enums.js';

// Read by the feed when a stream opens / an event is emitted, so tests never wait 25 s.
process.env.REALTIME_HEARTBEAT_MS = '150';
process.env.REALTIME_EMIT_DELAY_MS = '10';

const IO = 'UP-GZB-4471';
const OTHER_IO = 'UP-GZB-4455'; // same station, not assigned to this case
const JUDGE = 'UP-JUD-2291';
const ADVOCATE = 'UP/1234/2015';
const OTHER_ADVOCATE = 'UP/9876/2019';
const EXAMINER = 'FSL-LKO-0091';
const FIR = '0123/2026';
const CNR = 'UPGB010012342026';

let mongo;
let httpServer;
let port;

let io;
let otherIo;
let judge;
let advocate;
let otherAdvocate;
let examiner;
let caseId;

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function uploadExhibit(title) {
  const bytes = Buffer.concat([PNG, Buffer.from(title.padEnd(96, '.'), 'utf8')]);
  const sha = sha256Hex(bytes);
  const res = await as(io, request(httpServer).post('/api/evidence/upload'))
    .field('caseId', String(caseId))
    .field('title', title)
    .field('sha256Client', sha)
    .field('signature', io.keys.sign(sha))
    .field('sourceType', 'MOBILE')
    .attach('file', bytes, { filename: `${title}.png`, contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evidence;
}

const pdf = (label) => Buffer.from(`%PDF-1.4\n% vakalatnama — ${label}\n${'.'.repeat(64)}\n%%EOF\n`, 'utf8');

function fileVakalatnama(session, appearingFor = 'ACCUSED') {
  const bytes = pdf(session.authorityId);
  const sha = sha256Hex(bytes);
  return as(session, request(httpServer).post('/api/vakalatnama'))
    .field('cnrNumber', CNR)
    .field('appearingFor', appearingFor)
    .field('partyName', 'Ramesh Singh')
    .field('documentSha256', sha)
    .field('documentSignature', session.keys.sign(sha))
    .attach('document', bytes, { filename: 'vakalatnama.pdf', contentType: 'application/pdf' });
}

// ------------------------------------------------------------ SSE client ----

function parseFrame(block) {
  const frame = { event: null, data: null, retry: null, comment: null, json: null };
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') frame.event = value;
    else if (field === 'data') frame.data = frame.data === null ? value : `${frame.data}\n${value}`;
    else if (field === 'retry') frame.retry = Number(value);
  }
  if (frame.data !== null) {
    try {
      frame.json = JSON.parse(frame.data);
    } catch {
      frame.json = null;
    }
  }
  return frame;
}

/** Open the stream the way the web client does: a plain GET with the bearer header. */
function connect(session) {
  return new Promise((resolveStream, reject) => {
    const headers = session ? { Authorization: `Bearer ${session.accessToken}` } : {};
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events/stream', headers }, (res) => {
      const stream = {
        status: res.statusCode,
        headers: res.headers,
        frames: [],
        ended: false,
        listeners: new Set(),
        close: () => req.destroy(),
      };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          stream.frames.push(parseFrame(buf.slice(0, idx)));
          buf = buf.slice(idx + 2);
          stream.listeners.forEach((fn) => fn());
        }
      });
      const end = () => {
        stream.ended = true;
        stream.listeners.forEach((fn) => fn());
      };
      res.on('end', end);
      res.on('close', end);
      res.on('error', () => {});
      resolveStream(stream);
    });
    req.on('error', reject);
  });
}

function waitForFrame(stream, predicate, timeoutMs = 5_000) {
  return new Promise((resolveFrame) => {
    let timer = null;
    const done = (frame) => {
      clearTimeout(timer);
      stream.listeners.delete(check);
      resolveFrame(frame);
    };
    function check() {
      const found = stream.frames.find(predicate);
      if (found) done(found);
      else if (stream.ended) done(null);
    }
    stream.listeners.add(check);
    timer = setTimeout(() => done(null), timeoutMs);
    check();
  });
}

const isChange = (type, extra = () => true) => (f) => f.event === 'change' && f.json?.type === type && extra(f.json);
const changes = (stream, pred = () => true) => stream.frames.filter((f) => f.event === 'change' && pred(f.json));

// ------------------------------------------------------------------ setup ----

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);

  await mongoose.connect(uri, { dbName: 'lexx_test_realtime', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();

  httpServer = createApp().listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  port = httpServer.address().port;

  io = await asUser(httpServer, IO);
  otherIo = await asUser(httpServer, OTHER_IO);
  judge = await asUser(httpServer, JUDGE);
  advocate = await asUser(httpServer, ADVOCATE);
  otherAdvocate = await asUser(httpServer, OTHER_ADVOCATE);
  examiner = await asUser(httpServer, EXAMINER);

  const created = await as(io, request(httpServer).post('/api/cases/from-fir')).send({ firNumber: FIR });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  caseId = String(created.body.case._id);
}, 180_000);

afterAll(async () => {
  closeAllStreams('test');
  await drainAnalyses();
  httpServer.closeAllConnections?.();
  await new Promise((r) => httpServer.close(r));
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

// ------------------------------------------------------------------ the wire ----

describe('the stream', () => {
  it('refuses a request without a valid bearer token', async () => {
    const none = await request(httpServer).get('/api/events/stream');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('NOT_AUTHENTICATED');

    const forged = await request(httpServer)
      .get('/api/events/stream')
      .set('Authorization', 'Bearer aaaa.bbbb.cccc');
    expect(forged.status).toBe(401);
  });

  it('opens unbuffered, with retry, then a ready frame', async () => {
    const s = await connect(io);
    try {
      expect(s.status).toBe(200);
      expect(s.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(s.headers['cache-control']).toMatch(/no-cache/);
      expect(s.headers['cache-control']).toMatch(/no-transform/);
      expect(s.headers['x-accel-buffering']).toBe('no');

      const ready = await waitForFrame(s, (f) => f.event === 'ready');
      expect(ready).not.toBeNull();
      expect(s.frames[0].retry).toBe(3000);
      expect(Number.isNaN(Date.parse(ready.json.at))).toBe(false);
    } finally {
      s.close();
    }
  });

  it('heartbeats at the configured interval', async () => {
    const s = await connect(io);
    try {
      const ping = await waitForFrame(s, (f) => f.comment === 'ping', 2_000);
      expect(ping).not.toBeNull();
    } finally {
      s.close();
    }
  });

  it('releases the connection when the client goes away', async () => {
    const s = await connect(io);
    await waitForFrame(s, (f) => f.event === 'ready');
    const open = streamCount();
    s.close();
    const deadline = Date.now() + 3_000;
    while (streamCount() >= open && Date.now() < deadline) await settle(25);
    expect(streamCount()).toBe(open - 1);
  });
});

// ------------------------------------------------------------------ audience ----

describe('who hears about a change', () => {
  const streams = {};

  beforeAll(async () => {
    const sessions = { io, otherIo, judge, advocate, otherAdvocate, examiner };
    for (const [name, session] of Object.entries(sessions)) {
      streams[name] = await connect(session);
      expect(await waitForFrame(streams[name], (f) => f.event === 'ready')).not.toBeNull();
    }
  });

  afterAll(() => {
    Object.values(streams).forEach((s) => s.close());
  });

  let exhibit;

  it('tells the uploading IO about their exhibit, with ids and a type only', async () => {
    exhibit = await uploadExhibit('CCTV clip');
    const frame = await waitForFrame(
      streams.io,
      isChange(LEDGER_EVENT.EVIDENCE_UPLOADED, (j) => j.evidenceId === String(exhibit._id))
    );
    expect(frame).not.toBeNull();
    expect(Object.keys(frame.json).sort()).toEqual(['at', 'caseId', 'evidenceId', 'type']);
    expect(frame.json.caseId).toBe(caseId);
    expect(frame.data).not.toMatch(/CCTV|exhibitCode|sha256/i);
  });

  it('tells nobody who may not read the case', async () => {
    await settle();
    for (const name of ['otherIo', 'advocate', 'otherAdvocate', 'judge']) {
      expect(changes(streams[name], (j) => j.caseId === caseId), name).toHaveLength(0);
    }
  });

  it('sends AI analysis updates to the laboratory, never to the IO', async () => {
    await drainAnalyses();
    const frame = await waitForFrame(
      streams.examiner,
      isChange(REALTIME_EVENT.AI_ANALYSIS_UPDATED, (j) => j.evidenceId === String(exhibit._id))
    );
    expect(frame).not.toBeNull();
    expect(Object.keys(frame.json).sort()).toEqual(['at', 'caseId', 'evidenceId', 'type']);

    await settle();
    for (const name of ['io', 'otherIo', 'advocate', 'otherAdvocate', 'judge']) {
      expect(changes(streams[name], (j) => j.type === REALTIME_EVENT.AI_ANALYSIS_UPDATED), name).toHaveLength(0);
    }
  });

  it('opens the feed for a case to counsel the moment the court accepts them', async () => {
    const filed = await as(io, request(httpServer).post(`/api/cases/${caseId}/file-chargesheet`)).send({});
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    await settle();
    // Not on record yet: the stage change is refused to counsel (and cached as refused).
    expect(changes(streams.advocate, (j) => j.caseId === caseId && j.type === LEDGER_EVENT.CASE_STAGE_CHANGED)).toHaveLength(0);
    // Listed before the court now, so the court hears it.
    expect(await waitForFrame(streams.judge, isChange(LEDGER_EVENT.CASE_STAGE_CHANGED, (j) => j.caseId === caseId))).not.toBeNull();

    const filing = await fileVakalatnama(advocate);
    expect(filing.status, JSON.stringify(filing.body)).toBe(201);

    const accepted = await as(judge, request(httpServer).post(`/api/vakalatnama/${filing.body.filing.id}/accept`)).send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(
      await waitForFrame(streams.advocate, isChange(LEDGER_EVENT.VAKALATNAMA_ACCEPTED, (j) => j.caseId === caseId))
    ).not.toBeNull();

    // The cached refusal is gone: the next case event reaches counsel within the cache TTL.
    const order = await as(judge, request(httpServer).post(`/api/cases/${caseId}/record-order`)).send({
      orderType: 'ADJOURNMENT',
      text: 'Adjourned for arguments on charge.',
    });
    expect(order.status, JSON.stringify(order.body)).toBeLessThan(300);
    expect(
      await waitForFrame(streams.advocate, isChange(LEDGER_EVENT.JUDICIAL_ORDER, (j) => j.caseId === caseId))
    ).not.toBeNull();

    await settle();
    expect(changes(streams.otherAdvocate, (j) => j.caseId === caseId)).toHaveLength(0);
    expect(changes(streams.otherIo, (j) => j.caseId === caseId)).toHaveLength(0);
  });

  it('routes an event with no case only to its actor', async () => {
    expect(emitChange({ type: REALTIME_EVENT.RECORD_UPDATED, actorUserId: io.user.userId })).toBe(true);
    const frame = await waitForFrame(streams.io, isChange(REALTIME_EVENT.RECORD_UPDATED));
    expect(frame).not.toBeNull();
    expect(frame.json.caseId).toBeNull();

    emitChange({ type: 'ORPHAN_EVENT_WITHOUT_ACTOR' });
    await settle();
    for (const name of ['otherIo', 'judge', 'advocate', 'examiner']) {
      expect(changes(streams[name], (j) => j.type === REALTIME_EVENT.RECORD_UPDATED), name).toHaveLength(0);
    }
    expect(Object.values(streams).flatMap((s) => changes(s, (j) => j.type === 'ORPHAN_EVENT_WITHOUT_ACTOR'))).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ isolation ----

describe('the feed can never break a write', () => {
  it('swallows malformed input instead of throwing', () => {
    expect(emitChange()).toBe(false);
    expect(emitChange({ type: 'not a type' })).toBe(false);
    const hostile = {
      toString() {
        throw new Error('boom');
      },
    };
    expect(() => emitChange({ type: 'EVIDENCE_UPLOADED', caseId: hostile })).not.toThrow();
  });

  it('appends to the ledger with no listeners, and with one', async () => {
    closeAllStreams('test');
    const quiet = await appendEvent({ eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION, payload: { stage: 'REALTIME_TEST' } });
    expect(quiet.seq).toBeGreaterThan(0);

    const s = await connect(io);
    try {
      await waitForFrame(s, (f) => f.event === 'ready');
      const loud = await appendEvent({
        eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION,
        caseId,
        actorUserId: io.user.userId,
        payload: { stage: 'REALTIME_TEST' },
      });
      expect(loud.seq).toBe(quiet.seq + 1);
      expect(await waitForFrame(s, isChange(LEDGER_EVENT.INTEGRITY_EXCEPTION, (j) => j.caseId === caseId))).not.toBeNull();
    } finally {
      s.close();
    }
  });
});
