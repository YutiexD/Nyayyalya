/**
 * The AI analysis service — the one entry point to the AI provider for the rest of the system.
 *
 *   Evidence uploaded
 *     → requestAnalysis(evidenceId)            queued, status PENDING
 *     → runAnalysis                            status PROCESSING
 *         decrypt the stored exhibit and re-check its digest
 *         → generateStructured                 structured JSON, schema-constrained
 *         → validateAnalysis                   schema + business validation
 *     → persist                                status COMPLETED, or FAILED with the reason
 *
 * # What this module never does
 *
 * It never produces a score, a priority, a source or a sentence of its own. If the
 * model cannot be reached, times out, rate-limits, returns something malformed or
 * self-contradictory, or the file cannot be sent, the exhibit is marked FAILED (or
 * UNSUPPORTED) with the reason, the evidence itself is untouched, and a retry is
 * possible. An exhibit without a completed analysis simply has no AI priority.
 *
 * # One call per exhibit
 *
 * Each analysis is exactly one generateContent request (plus bounded retries of that
 * same request). There is no second, web-search-grounded call. Requests leave through
 * one queue limited to AI_ANALYSIS_CONCURRENCY (default 1), and a rate-limited (429)
 * answer waits for the provider's Retry-After when it gives one, or backs off
 * exponentially with jitter when it does not — never more than GEMINI_MAX_RETRIES times.
 *
 * # Privacy
 *
 * This sends the exhibit's decrypted bytes to the configured AI provider, together
 * with the context listed in `deepfakePrompt.js` (no names, no narrative). That is a
 * deliberate product decision and a data-processing relationship a real deployment
 * must approve. The analysis is shown to FSL examiners only (see `visibility.js`).
 */
import { setImmediate } from 'node:timers';
import mongoose from 'mongoose';

import env from '../../config/env.js';
import { Evidence } from '../../models/Evidence.js';
import { Case } from '../../models/Case.js';
import { AI_ANALYSIS_STATUS, AI_PROVIDER, AI_DISCLAIMER, REALTIME_EVENT } from '../../models/enums.js';
import { unwrapDek } from '../envelope.js';
import { getDecryptedStream, objectExists } from '../storage.js';
import { sha256Hex } from '../../config/crypto.js';
import { AI_ERROR, generateStructured, geminiModel, neutralText } from './geminiClient.js';
import { SYSTEM_INSTRUCTION, buildContextText } from './deepfakePrompt.js';
import { RESPONSE_SCHEMA, validateAnalysis } from './analysisSchema.js';
import { loggerFor } from '../../utils/logger.js';
import { emitChange } from '../realtime.js';

const log = loggerFor('ai-analysis');

/** Tell open laboratory pages an analysis moved. Ids only; the analysis never travels. */
const announceAnalysis = (evidence) =>
  emitChange({ type: REALTIME_EVENT.AI_ANALYSIS_UPDATED, caseId: evidence.caseId, evidenceId: evidence._id });

/** Formats the provider accepts as inline media and that a manipulation analysis makes sense for. */
export const SUPPORTED_MIME_TYPES = Object.freeze(
  new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/webm',
    'video/x-msvideo',
    'video/3gpp',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
    'application/pdf',
  ])
);

/**
 * The longest Retry-After this service will wait out. A provider asking for longer is
 * not retried: the exhibit is marked FAILED (retryable) instead of holding the one
 * analysis slot for minutes.
 */
export const MAX_HONOURED_RETRY_AFTER_MS = 120_000;

/** Ceiling on a computed (no Retry-After) backoff. */
const MAX_BACKOFF_MS = 60_000;

/**
 * A PROCESSING claim older than this is treated as abandoned (the process died mid-call).
 * One call, its retries, and the longest wait between them.
 */
const staleAfterMs = () =>
  env.GEMINI_TIMEOUT_MS * (env.GEMINI_MAX_RETRIES + 1) + MAX_HONOURED_RETRY_AFTER_MS * env.GEMINI_MAX_RETRIES + 120_000;

/** The initial state written at ingest. Nothing but "we have asked". */
export const initialAnalysisState = () => ({
  status: AI_ANALYSIS_STATUS.PENDING,
  provider: AI_PROVIDER.GEMINI,
  requestedAt: new Date(),
  attempts: 0,
  disclaimer: AI_DISCLAIMER,
});

// ------------------------------------------------------------------- queue ----

const queue = [];
const queued = new Set();
let active = 0;
let idleWaiters = [];

/** Queue an exhibit for analysis. Idempotent while it is waiting or running. */
export function requestAnalysis(evidenceId) {
  const id = String(evidenceId);
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  setImmediate(pump);
}

function pump() {
  while (active < env.AI_ANALYSIS_CONCURRENCY && queue.length) {
    const id = queue.shift();
    active += 1;
    runAnalysis(id)
      .catch((err) => log.error({ evidenceId: id, err: err.message }, 'analysis job crashed'))
      .finally(() => {
        active -= 1;
        queued.delete(id);
        if (!active && !queue.length) {
          const waiters = idleWaiters;
          idleWaiters = [];
          waiters.forEach((resolve) => resolve());
        }
        pump();
      });
  }
}

/** Resolves when nothing is queued or running. Used by tests and graceful shutdown. */
export function drainAnalyses() {
  if (!active && !queue.length) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

// ---------------------------------------------------------------- the work ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readExhibitBytes(evidence) {
  const dek = unwrapDek(evidence.encryption, evidence.caseId);
  try {
    const stream = getDecryptedStream(evidence.storageKey, dek, evidence.encryption);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    dek.fill(0);
  }
}

class LocalFailure extends Error {
  constructor(code, message, { retryable = false, status = AI_ANALYSIS_STATUS.FAILED } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.analysisStatus = status;
  }
}

/**
 * How long to wait before retry number `attempt + 1`, or null when the failure should
 * not be retried at all.
 *
 *   - The provider's Retry-After (header, or RetryInfo in the error body) is honoured
 *     exactly, plus a little jitter so concurrent waiters do not return in lockstep.
 *     One longer than MAX_HONOURED_RETRY_AFTER_MS is not waited for.
 *   - Otherwise exponential backoff with "equal jitter": half the exponential step
 *     fixed, half random. A rate limit starts from four times the base.
 */
export function retryDelayMs(err, attempt, { base = env.GEMINI_RETRY_BASE_MS, random = Math.random } = {}) {
  if (Number.isFinite(err?.retryAfterMs) && err.retryAfterMs >= 0) {
    if (err.retryAfterMs > MAX_HONOURED_RETRY_AFTER_MS) return null;
    return Math.ceil(err.retryAfterMs + random() * Math.min(1000, Math.max(50, err.retryAfterMs * 0.1)));
  }
  const factor = err?.code === AI_ERROR.RATE_LIMITED ? 4 : 1;
  const step = Math.min(MAX_BACKOFF_MS, base * factor * 2 ** attempt);
  return Math.floor(step / 2 + random() * (step / 2));
}

/** Run `attempt` with the configured retries and backoff for retryable failures. */
async function withRetries(evidence, label, attempt) {
  let lastErr;
  for (let n = 0; n <= env.GEMINI_MAX_RETRIES; n += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (!err.retryable || n === env.GEMINI_MAX_RETRIES) break;
      const delay = retryDelayMs(err, n);
      if (delay === null) {
        log.warn(
          { evidenceId: String(evidence._id), code: err.code, retryAfterMs: err.retryAfterMs, label },
          'ai service asked for a longer wait than this deployment honours; not retrying'
        );
        break;
      }
      log.warn(
        { evidenceId: String(evidence._id), code: err.code, attempt: n + 1, delay, retryAfter: err.retryAfterMs ?? null, label },
        'ai attempt failed; retrying'
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

const inlineParts = (evidence, bytes, textPart) => [
  { inline_data: { mime_type: evidence.mimeType, data: bytes.toString('base64') } },
  { text: textPart },
];

async function analyseDeepfake({ evidence, caseDoc, bytes }) {
  const parts = inlineParts(evidence, bytes, buildContextText({ evidence, caseDoc }));
  return withRetries(evidence, 'deepfake', async () => {
    const result = await generateStructured({
      systemInstruction: SYSTEM_INSTRUCTION,
      parts,
      responseSchema: RESPONSE_SCHEMA,
    });
    return { analysis: validateAnalysis(result.data), modelVersion: result.modelVersion };
  });
}

/**
 * Analyse one exhibit. Safe to call concurrently: the PENDING → PROCESSING claim is
 * atomic, so only one caller does the work.
 */
export async function runAnalysis(evidenceId) {
  if (mongoose.connection.readyState !== 1) return null;

  const claimed = await Evidence.findOneAndUpdate(
    { _id: evidenceId, 'aiAnalysis.status': AI_ANALYSIS_STATUS.PENDING },
    {
      $set: {
        'aiAnalysis.status': AI_ANALYSIS_STATUS.PROCESSING,
        'aiAnalysis.startedAt': new Date(),
        'aiAnalysis.provider': AI_PROVIDER.GEMINI,
        'aiAnalysis.error': null,
      },
      $inc: { 'aiAnalysis.attempts': 1 },
    },
    { new: true }
  ).lean();
  if (!claimed) return null;

  const id = String(claimed._id);
  announceAnalysis(claimed);
  let bytes = null;
  try {
    if (!SUPPORTED_MIME_TYPES.has(claimed.mimeType)) {
      throw new LocalFailure(
        'AI_UNSUPPORTED_FORMAT',
        `AI deepfake analysis is not available for ${claimed.mimeType} evidence.`,
        { status: AI_ANALYSIS_STATUS.UNSUPPORTED }
      );
    }
    if (claimed.sizeBytes > env.GEMINI_MAX_INLINE_BYTES) {
      throw new LocalFailure(
        'AI_FILE_TOO_LARGE',
        `The file is larger than the ${Math.floor(env.GEMINI_MAX_INLINE_BYTES / (1024 * 1024))} MB this deployment sends for analysis.`,
        { status: AI_ANALYSIS_STATUS.UNSUPPORTED }
      );
    }
    if (!objectExists(claimed.storageKey)) {
      throw new LocalFailure('EVIDENCE_OBJECT_MISSING', 'The stored exhibit is missing, so it could not be analysed.');
    }

    try {
      bytes = await readExhibitBytes(claimed);
    } catch {
      throw new LocalFailure('EVIDENCE_UNREADABLE', 'The stored exhibit failed its encryption integrity check and was not analysed.');
    }
    // Analyse only the bytes the officer signed. A modified file is a finding for the
    // verify endpoint, not something to send off for an opinion.
    if (sha256Hex(bytes) !== claimed.sha256Server) {
      throw new LocalFailure('EVIDENCE_INTEGRITY_MISMATCH', 'The stored exhibit no longer matches its recorded digest and was not analysed.');
    }

    const caseDoc = await Case.findById(claimed.caseId)
      .select('sensitivityClass maxPunishmentYears')
      .lean();

    const { analysis, modelVersion } = await analyseDeepfake({ evidence: claimed, caseDoc, bytes });

    await Evidence.updateOne(
      { _id: claimed._id, 'aiAnalysis.status': AI_ANALYSIS_STATUS.PROCESSING },
      {
        $set: {
          'aiAnalysis.status': AI_ANALYSIS_STATUS.COMPLETED,
          'aiAnalysis.completedAt': new Date(),
          'aiAnalysis.model': modelVersion ?? geminiModel(),
          'aiAnalysis.deepfakeAssessment': analysis.deepfakeAssessment,
          'aiAnalysis.deepfakeScore': analysis.deepfakeScore,
          'aiAnalysis.analysisDescription': analysis.analysisDescription,
          'aiAnalysis.detectedIndicators': analysis.detectedIndicators,
          'aiAnalysis.triagePriority': analysis.triagePriority,
          'aiAnalysis.priorityReason': analysis.priorityReason,
          'aiAnalysis.fslReviewRecommended': analysis.fslReviewRecommended,
          'aiAnalysis.fslReviewReason': analysis.fslReviewReason,
          'aiAnalysis.evidenceSummary': analysis.evidenceSummary,
          'aiAnalysis.error': null,
          'aiAnalysis.disclaimer': AI_DISCLAIMER,
        },
      }
    );
    announceAnalysis(claimed);
    log.info(
      { evidenceId: id, exhibitCode: claimed.exhibitCode, priority: analysis.triagePriority },
      'ai analysis completed'
    );
    return AI_ANALYSIS_STATUS.COMPLETED;
  } catch (err) {
    const status = err.analysisStatus ?? AI_ANALYSIS_STATUS.FAILED;
    const code = err.code ?? 'AI_ANALYSIS_FAILED';
    log.warn({ evidenceId: id, exhibitCode: claimed.exhibitCode, code, status }, 'ai analysis did not complete');
    await Evidence.updateOne(
      { _id: claimed._id, 'aiAnalysis.status': AI_ANALYSIS_STATUS.PROCESSING },
      {
        $set: {
          'aiAnalysis.status': status,
          'aiAnalysis.completedAt': new Date(),
          'aiAnalysis.model': geminiModel(),
          'aiAnalysis.error': {
            code,
            message: neutralText(String(err.message ?? 'Analysis failed')).slice(0, 500),
            retryable: status === AI_ANALYSIS_STATUS.FAILED,
            issues: Array.isArray(err.issues) ? err.issues.slice(0, 10) : [],
            at: new Date(),
          },
        },
      }
    ).catch((e) => log.error({ evidenceId: id, err: e.message }, 'could not record analysis failure'));
    announceAnalysis(claimed);
    return status;
  } finally {
    if (bytes) bytes.fill(0);
  }
}

/**
 * Put an exhibit back in the queue. Allowed for a FAILED analysis, and for one stuck
 * in PROCESSING long enough that the process that claimed it must have died. A
 * COMPLETED analysis is not re-run: the recorded result is part of the history.
 *
 * @returns {Promise<object|null>} the evidence document, or null if nothing to retry
 */
export async function retryAnalysis(evidenceId) {
  const stale = new Date(Date.now() - staleAfterMs());
  const updated = await Evidence.findOneAndUpdate(
    {
      _id: evidenceId,
      $or: [
        { 'aiAnalysis.status': AI_ANALYSIS_STATUS.FAILED },
        { 'aiAnalysis.status': AI_ANALYSIS_STATUS.PROCESSING, 'aiAnalysis.startedAt': { $lt: stale } },
      ],
    },
    {
      $set: {
        'aiAnalysis.status': AI_ANALYSIS_STATUS.PENDING,
        'aiAnalysis.requestedAt': new Date(),
        'aiAnalysis.error': null,
      },
    },
    { new: true }
  ).lean();
  if (updated) requestAnalysis(updated._id);
  return updated;
}

/**
 * On boot: queue everything still PENDING, and reclaim anything left PROCESSING by a
 * process that stopped mid-analysis.
 *
 * Everything goes through `requestAnalysis`, i.e. the same queue as a fresh upload, so
 * a backlog is worked through AI_ANALYSIS_CONCURRENCY at a time — a restart with a
 * hundred pending exhibits never fires a hundred requests at once.
 */
export async function resumePendingAnalyses() {
  const stale = new Date(Date.now() - staleAfterMs());
  await Evidence.updateMany(
    { 'aiAnalysis.status': AI_ANALYSIS_STATUS.PROCESSING, 'aiAnalysis.startedAt': { $lt: stale } },
    { $set: { 'aiAnalysis.status': AI_ANALYSIS_STATUS.PENDING } }
  );
  const pending = await Evidence.find({ 'aiAnalysis.status': AI_ANALYSIS_STATUS.PENDING })
    .select('_id')
    .sort({ createdAt: 1 })
    .lean();
  pending.forEach((e) => requestAnalysis(e._id));
  return pending.length;
}

export default {
  requestAnalysis,
  runAnalysis,
  retryAnalysis,
  resumePendingAnalyses,
  drainAnalyses,
  initialAnalysisState,
  retryDelayMs,
  SUPPORTED_MIME_TYPES,
};
