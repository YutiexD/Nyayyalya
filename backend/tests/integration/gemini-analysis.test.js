/**
 * The AI model as the source of the deepfake analysis and the review priority.
 *
 * The analysis service talks to a provider-compatible stub (tests/fixtures/geminiStub.js)
 * over real HTTP, so the client, the structured-output request, the schema and business
 * validation, the persistence and every failure path run exactly as they do against the
 * real API. The claims under test:
 *
 *   what is stored is what the model returned — nothing is computed, mapped or explained here;
 *   the priority is the model's choice, never derived from the score;
 *   a failure of any kind leaves NO score, NO priority and NO description, and can be retried;
 *   each exhibit costs exactly ONE request — there is no second, search-grounded call;
 *   a 429 waits for Retry-After when given, retries stay bounded, and a backlog is worked
 *   through one request at a time;
 *   the key travels in a header, the case narrative and names never travel at all;
 *   no AI output reaches the ledger, and no response names the provider.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Evidence } from '../../models/Evidence.js';
import { Ledger } from '../../models/Ledger.js';
import { createApp } from '../../app.js';
import env, { assertGeminiConfigured } from '../../config/env.js';
import { activateUser } from '../helpers/client.js';
import { drainAnalyses, resumePendingAnalyses } from '../../services/ai/analysisService.js';
import { resolveObjectPath } from '../../services/storage.js';
import { createGeminiStub } from '../fixtures/geminiStub.js';
import { AI_ANALYSIS_STATUS, TRIAGE_PRIORITY_ORDER } from '../../models/enums.js';

let mongo;
let server;
let stub;
let io;
let examiner;
let caseDoc;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const auth = (req, session) => req.set('Authorization', `Bearer ${session.accessToken}`);

const png = (marker) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`exhibit ${marker}`.padEnd(80, '.'))]);
const zip = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('archive'.padEnd(80, '.'))]);
const pdf = (marker) => Buffer.from(`%PDF-1.4\n% scanned document ${marker}\n${'.'.repeat(64)}\n%%EOF\n`, 'utf8');

async function upload(bytes, { contentType = 'image/png', filename = 'exhibit.png', title = 'Clip from the accused handset' } = {}) {
  const digest = sha256(bytes);
  const res = await auth(request(server).post('/api/evidence/upload'), io)
    .field('caseId', caseDoc._id)
    .field('title', title)
    .field('sha256Client', digest)
    .field('signature', io.keys.sign(digest))
    .field('sourceType', 'MOBILE')
    .attach('file', bytes, { filename, contentType });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evidence;
}

const analysisOf = async (id) => (await Evidence.findById(id).lean()).aiAnalysis;

/** Retries go through the laboratory, which is who the analysis belongs to. */
const retry = (id, session = examiner) => auth(request(server).post(`/api/evidence/${id}/ai-analysis/retry`), session);

/** Run `fn` with some env values changed, restoring them afterwards. */
async function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, env[k]]));
  Object.assign(env, values);
  try {
    return await fn();
  } finally {
    Object.assign(env, saved);
  }
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_gemini', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();
  stub = createGeminiStub();
  await stub.listen(Number(process.env.GEMINI_STUB_PORT));
}, 120_000);

afterAll(async () => {
  await drainAnalyses();
  await stub.close();
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await drainAnalyses();
  stub.reset();
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  io = await activateUser(server, 'UP-GZB-4471');
  examiner = await activateUser(server, 'FSL-LKO-0091');
  const created = await auth(request(server).post('/api/cases/from-fir'), io).send({ firNumber: '0123/2026' });
  expect(created.status).toBe(201);
  caseDoc = created.body.case;
});

// ================================================== the model is the source ====

describe('the model is the source of the analysis', () => {
  it('queues the exhibit on upload, then stores exactly what the model returned', async () => {
    const uploaded = await upload(png('STUB:HIGH'));
    await drainAnalyses();
    const a = await analysisOf(uploaded._id);

    expect(a.status).toBe(AI_ANALYSIS_STATUS.COMPLETED);
    // Provider and model are persisted for the record…
    expect(a.provider).toBe('GEMINI');
    expect(a.model).toBe('gemini-test-model-stub');
    expect(a.completedAt).toBeTruthy();
    expect(a.deepfakeAssessment).toBe('LIKELY_MANIPULATED');
    expect(a.deepfakeScore).toBe(74);
    expect(a.triagePriority).toBe('HIGH');
    expect(a.analysisDescription).toMatch(/^\[stub\]/);
    expect(a.priorityReason).toMatch(/^\[stub\]/);
    expect(a.detectedIndicators).toEqual(['[stub] fixture indicator one', '[stub] fixture indicator two']);
    expect(a.fslReviewRecommended).toBe(true);
    expect(a.fslReviewReason).toMatch(/^\[stub\]/);
    expect(a.evidenceSummary).toMatch(/^\[stub\]/);
    expect(a.error).toBeNull();
    expect(a.disclaimer).not.toMatch(/gemini|google/i);
    // The online-source check is gone, and leaves nothing behind.
    expect(a).not.toHaveProperty('onlineSource');
  });

  it('asks for structured JSON with the controlled vocabulary, keyed by header', async () => {
    await upload(png('STUB:LOW'));
    await drainAnalyses();

    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call.path).toMatch(/\/models\/gemini-test-model:generateContent$/);
    expect(call.path).not.toContain('key=');
    expect(call.key).toBe(env.GEMINI_API_KEY);
    expect(call.body.tools).toBeUndefined();
    expect(call.body.generationConfig.responseMimeType).toBe('application/json');
    expect(call.body.generationConfig.responseSchema.properties.triagePriority.enum).toEqual([...TRIAGE_PRIORITY_ORDER]);
    expect(call.body.generationConfig.responseSchema.required).toEqual(
      expect.arrayContaining(['deepfakeScore', 'analysisDescription', 'triagePriority', 'priorityReason', 'fslReviewRecommended'])
    );
    const inline = call.body.contents[0].parts.find((p) => p.inline_data);
    expect(inline.inline_data.mime_type).toBe('image/png');
  });

  it('makes exactly one request per exhibit — images included — and never a search-grounded one', async () => {
    await upload(png('STUB:HIGH'));
    await upload(pdf('STUB:MEDIUM'), { contentType: 'application/pdf', filename: 'scan.pdf' });
    await drainAnalyses();
    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) {
      expect(call.body.tools).toBeUndefined();
      expect(JSON.stringify(call.body)).not.toMatch(/google_search|grounding/i);
    }
  });

  it('never sends the case narrative, the exhibit title or anyone’s name', async () => {
    await upload(png('STUB:MEDIUM'), { title: 'Statement of Ramesh Singh' });
    await drainAnalyses();
    for (const call of stub.calls) {
      const text = JSON.stringify(call.body.contents[0].parts.filter((p) => p.text));
      expect(text).not.toContain('Ramesh Singh');
      expect(text).not.toContain(io.user.name);
      expect(text).not.toContain(caseDoc.title);
    }
    expect(JSON.stringify(stub.calls[0].body.contents[0].parts.filter((p) => p.text))).toContain('POCSO');
  });

  it('stores the model’s priority as chosen — a high score is never turned into a band', async () => {
    const uploaded = await upload(png('STUB:LOW_PRIORITY_HIGH_SCORE'));
    await drainAnalyses();
    const a = await analysisOf(uploaded._id);
    expect(a.status).toBe(AI_ANALYSIS_STATUS.COMPLETED);
    expect(a.deepfakeScore).toBe(88);
    expect(a.triagePriority).toBe('LOW');
  });

  it('writes no AI output to the ledger', async () => {
    await upload(png('STUB:CRITICAL'));
    await drainAnalyses();
    const entries = await Ledger.find({}).lean();
    const all = JSON.stringify(entries.map((e) => e.payload));
    expect(all).not.toMatch(/triagePriority|deepfakeScore|analysisDescription|\[stub\]/i);
  });

  it('orders the laboratory’s cases and exhibits by the model’s priority, in a provider-neutral view', async () => {
    await upload(png('STUB:LOW'));
    await upload(png('STUB:CRITICAL'));
    await upload(png('STUB:MEDIUM'));
    await drainAnalyses();

    const res = await auth(request(server).get('/api/fsl/cases'), examiner);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [group] = res.body.cases;
    expect(group.case.firNumber).toBe('0123/2026');
    expect(group.highestPriority).toBe('CRITICAL');
    expect(group.evidence.map((e) => e.aiAnalysis.triagePriority)).toEqual(['CRITICAL', 'MEDIUM', 'LOW']);
    for (const e of group.evidence) {
      expect(e.aiAnalysis).not.toHaveProperty('provider');
      expect(e.aiAnalysis).not.toHaveProperty('model');
      expect(e.aiAnalysis).not.toHaveProperty('onlineSource');
    }
    expect(res.body.uiLabel).toBe('Review priority (AI)');
    expect(JSON.stringify(res.body)).not.toMatch(/gemini|google/i);
  });

  it('shows the examiner the analysis, and only the examiner', async () => {
    const uploaded = await upload(png('STUB:CRITICAL'));
    await drainAnalyses();

    const lab = await auth(request(server).get('/api/fsl/queue?state=ALL'), examiner);
    expect(lab.status).toBe(200);
    const item = lab.body.queue.find((x) => String(x._id) === uploaded._id);
    expect(item.aiAnalysis.triagePriority).toBe('CRITICAL');
    expect(item.aiAnalysis).not.toHaveProperty('provider');
    expect(JSON.stringify(lab.body)).not.toMatch(/gemini|google/i);

    const overview = await auth(request(server).get(`/api/cases/${caseDoc._id}/overview`), io);
    expect(overview.status).toBe(200);
    expect(JSON.stringify(overview.body)).not.toMatch(/aiAnalysis|triagePriority/i);
  });
});

// ========================================= failures produce no analysis ====

describe('a failed analysis never produces a score, a priority or an explanation', () => {
  for (const [marker, code] of [
    ['RATE_LIMIT', 'AI_RATE_LIMITED'],
    ['SERVER_ERROR', 'AI_UNAVAILABLE'],
    ['BAD_JSON', 'AI_INVALID_JSON'],
    ['SCHEMA_INVALID', 'AI_RESPONSE_SCHEMA_INVALID'],
    ['INCOHERENT', 'AI_RESPONSE_INCOHERENT'],
  ]) {
    it(`records ${code} as FAILED, retryable, with nothing invented`, async () => {
      const uploaded = await upload(png(`STUB:${marker}`));
      await drainAnalyses();
      const a = await analysisOf(uploaded._id);
      expect(a.status).toBe(AI_ANALYSIS_STATUS.FAILED);
      expect(a.error.code).toBe(code);
      expect(a.error.retryable).toBe(true);
      expect(a.error.message).not.toMatch(/gemini|google/i);
      expect(a.deepfakeScore).toBeNull();
      expect(a.deepfakeAssessment).toBeNull();
      expect(a.triagePriority).toBeNull();
      expect(a.analysisDescription).toBeNull();
      expect(a.priorityReason).toBeNull();
      // GEMINI_MAX_RETRIES is 0 under test: one request, no second call of any kind.
      expect(stub.calls).toHaveLength(1);
    });
  }

  it('reports a rejected API key as such', async () => {
    const real = env.GEMINI_API_KEY;
    env.GEMINI_API_KEY = 'a-key-the-stub-will-reject';
    try {
      const uploaded = await upload(png('STUB:HIGH'));
      await drainAnalyses();
      const a = await analysisOf(uploaded._id);
      expect(a.status).toBe(AI_ANALYSIS_STATUS.FAILED);
      expect(a.error.code).toBe('AI_INVALID_API_KEY');
      expect(a.error.message).not.toContain('a-key-the-stub-will-reject');
    } finally {
      env.GEMINI_API_KEY = real;
    }
  });

  it('reports a timeout as a timeout', async () => {
    const real = env.GEMINI_TIMEOUT_MS;
    env.GEMINI_TIMEOUT_MS = 300;
    try {
      const uploaded = await upload(png('STUB:SLOW'));
      await drainAnalyses();
      const a = await analysisOf(uploaded._id);
      expect(a.status).toBe(AI_ANALYSIS_STATUS.FAILED);
      expect(a.error.code).toBe('AI_TIMEOUT');
    } finally {
      env.GEMINI_TIMEOUT_MS = real;
    }
  });

  it('marks an unsupported format UNSUPPORTED and sends nothing', async () => {
    const uploaded = await upload(zip(), { contentType: 'application/zip', filename: 'dump.zip' });
    await drainAnalyses();
    const a = await analysisOf(uploaded._id);
    expect(a.status).toBe(AI_ANALYSIS_STATUS.UNSUPPORTED);
    expect(a.error.code).toBe('AI_UNSUPPORTED_FORMAT');
    expect(a.error.retryable).toBe(false);
    expect(a.triagePriority).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it('does not send a stored file that no longer matches its digest', async () => {
    stub.force('RATE_LIMIT');
    const uploaded = await upload(png('STUB:HIGH'));
    await drainAnalyses();
    stub.force(null);
    const callsBefore = stub.calls.length;

    await fsp.appendFile(resolveObjectPath(uploaded.storageKey), Buffer.from('tamper'));
    const res = await retry(uploaded._id);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await drainAnalyses();

    const a = await analysisOf(uploaded._id);
    expect(a.status).toBe(AI_ANALYSIS_STATUS.FAILED);
    expect(['EVIDENCE_UNREADABLE', 'EVIDENCE_INTEGRITY_MISMATCH']).toContain(a.error.code);
    expect(stub.calls.length).toBe(callsBefore);
  });
});

// ============================================== rate limits and API pressure ====

describe('rate limits: the API quota is respected', () => {
  it('waits for the Retry-After a 429 names before trying again', async () => {
    await withEnv({ GEMINI_MAX_RETRIES: 1 }, async () => {
      const uploaded = await upload(png('STUB:RATE_LIMIT_RETRY_AFTER'));
      await drainAnalyses();

      expect(stub.calls).toHaveLength(2);
      // Retry-After: 1 — the second request did not come sooner than a second later,
      // although the configured backoff base under test is 10 ms.
      expect(stub.calls[1].at - stub.calls[0].at).toBeGreaterThanOrEqual(990);
      const a = await analysisOf(uploaded._id);
      expect(a.status).toBe(AI_ANALYSIS_STATUS.COMPLETED);
      expect(a.triagePriority).toBe('LOW');
      expect(a.attempts).toBe(1);
    });
  });

  it('does not sit out a Retry-After longer than it honours — it fails, retryable, after one request', async () => {
    await withEnv({ GEMINI_MAX_RETRIES: 2 }, async () => {
      const uploaded = await upload(png('STUB:RATE_LIMIT_LONG_RETRY_AFTER'));
      await drainAnalyses();
      expect(stub.calls).toHaveLength(1);
      const a = await analysisOf(uploaded._id);
      expect(a.status).toBe(AI_ANALYSIS_STATUS.FAILED);
      expect(a.error.code).toBe('AI_RATE_LIMITED');
      expect(a.error.retryable).toBe(true);
    });
  });

  it('keeps retries of a 429 without Retry-After bounded by GEMINI_MAX_RETRIES, spaced by backoff', async () => {
    await withEnv({ GEMINI_MAX_RETRIES: 2, GEMINI_RETRY_BASE_MS: 20 }, async () => {
      const uploaded = await upload(png('STUB:RATE_LIMIT'));
      await drainAnalyses();
      expect(stub.calls).toHaveLength(3);
      // Equal-jitter backoff from 4 × base for a rate limit: at least 40 ms, then 80 ms.
      expect(stub.calls[1].at - stub.calls[0].at).toBeGreaterThanOrEqual(35);
      expect(stub.calls[2].at - stub.calls[1].at).toBeGreaterThanOrEqual(75);
      expect((await analysisOf(uploaded._id)).status).toBe(AI_ANALYSIS_STATUS.FAILED);
    });
  });

  it('works a restart backlog through the same queue, one request at a time', async () => {
    await withEnv({ AI_ANALYSIS_CONCURRENCY: 1 }, async () => {
      stub.force('RATE_LIMIT');
      const ids = [];
      for (const tag of ['A', 'B', 'C', 'D']) ids.push((await upload(png(`STUB:LOW backlog ${tag}`)))._id);
      await drainAnalyses();

      stub.reset();
      stub.delay(150);
      await Evidence.updateMany({ _id: { $in: ids } }, { $set: { 'aiAnalysis.status': AI_ANALYSIS_STATUS.PENDING } });

      expect(await resumePendingAnalyses()).toBe(4);
      await drainAnalyses();

      expect(stub.calls).toHaveLength(4);
      expect(stub.stats.maxInFlight).toBe(1);
      for (const id of ids) expect((await analysisOf(id)).status).toBe(AI_ANALYSIS_STATUS.COMPLETED);
    });
  });
});

// ===================================================================== retry ====

describe('retrying', () => {
  it('re-runs a failed analysis, and only a failed one', async () => {
    stub.force('RATE_LIMIT');
    const uploaded = await upload(png('STUB:LOW'));
    await drainAnalyses();
    const failed = await analysisOf(uploaded._id);
    expect(failed.status).toBe(AI_ANALYSIS_STATUS.FAILED);

    stub.force(null);
    const res = await retry(uploaded._id);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    // Re-queued at once, so it may already be claimed by the time it is read.
    expect([AI_ANALYSIS_STATUS.PENDING, AI_ANALYSIS_STATUS.PROCESSING, AI_ANALYSIS_STATUS.COMPLETED]).toContain(
      (await analysisOf(uploaded._id)).status
    );
    await drainAnalyses();

    const a = await analysisOf(uploaded._id);
    expect(a.status).toBe(AI_ANALYSIS_STATUS.COMPLETED);
    expect(a.triagePriority).toBe('LOW');
    expect(a.attempts).toBe(2);
    // One request for the failed attempt, one for the retry. Nothing else.
    expect(stub.calls).toHaveLength(2);

    const again = await retry(uploaded._id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AI_ANALYSIS_NOT_RETRYABLE');
  });

  it('refuses the retry to a party to the case', async () => {
    stub.force('RATE_LIMIT');
    const uploaded = await upload(png('STUB:LOW'));
    await drainAnalyses();
    const advocate = await activateUser(server, 'UP/9876/2019');
    const res = await retry(uploaded._id, advocate);
    expect(res.status).toBe(403);
  });

  it('picks up analyses left pending by a restart', async () => {
    stub.force('RATE_LIMIT');
    const uploaded = await upload(png('STUB:MEDIUM'));
    await drainAnalyses();
    stub.force(null);
    await Evidence.updateOne({ _id: uploaded._id }, { $set: { 'aiAnalysis.status': AI_ANALYSIS_STATUS.PENDING } });

    expect(await resumePendingAnalyses()).toBeGreaterThanOrEqual(1);
    await drainAnalyses();
    expect((await analysisOf(uploaded._id)).status).toBe(AI_ANALYSIS_STATUS.COMPLETED);
  });
});

// ============================================================ configuration ====

describe('configuration', () => {
  it('refuses to start the API without a key or a model, and says which is missing', () => {
    const key = env.GEMINI_API_KEY;
    const model = env.GEMINI_MODEL;
    env.GEMINI_API_KEY = undefined;
    try {
      expect(() => assertGeminiConfigured()).toThrow(/GEMINI_API_KEY/);
      env.GEMINI_API_KEY = key;
      env.GEMINI_MODEL = undefined;
      expect(() => assertGeminiConfigured()).toThrow(/GEMINI_MODEL/);
    } finally {
      env.GEMINI_API_KEY = key;
      env.GEMINI_MODEL = model;
    }
    expect(() => assertGeminiConfigured()).not.toThrow();
  });
});
