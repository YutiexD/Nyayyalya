/**
 * A stand-in for the generateContent endpoint of the AI provider — TEST FIXTURE ONLY.
 *
 * It lives under backend/tests/ and is reachable only when GEMINI_API_BASE_URL is
 * pointed at it (the test setup does that; a real .env never should). Nothing in the
 * application imports it, so it cannot activate in a demo or production run.
 *
 * It speaks the real wire format — the `x-goog-api-key` header, the `models/<m>:
 * generateContent` path, `candidates[0].content.parts[0].text` — so the client, the
 * schema validation and the failure handling are exercised exactly as in production.
 *
 * Behaviour is chosen by a marker inside the uploaded file's bytes, so a test decides
 * what the model says by what it uploads:
 *
 *   STUB:CRITICAL | STUB:HIGH | STUB:MEDIUM | STUB:LOW    a valid analysis with that priority
 *   STUB:RATE_LIMIT                                        HTTP 429, no Retry-After
 *   STUB:RATE_LIMIT_RETRY_AFTER                            HTTP 429 with `Retry-After: 1` on the
 *                                                          FIRST request for that file, then a
 *                                                          valid LOW analysis
 *   STUB:RATE_LIMIT_LONG_RETRY_AFTER                       HTTP 429 with `Retry-After: 3600`
 *   STUB:SERVER_ERROR                                      HTTP 503
 *   STUB:BAD_JSON                                          a candidate whose text is not JSON
 *   STUB:SCHEMA_INVALID                                    JSON missing required fields
 *   STUB:INCOHERENT                                        LIKELY_MANIPULATED with score 10
 *   STUB:SLOW                                              answers after 10 s
 *   (no marker)                                            a valid MEDIUM / INCONCLUSIVE analysis
 *
 * Every request is recorded in `calls` with the time it arrived; `maxInFlight` is the
 * most requests the stub was ever answering at once, and `delay(ms)` holds every
 * answer for that long (so overlapping requests would show).
 *
 *   node backend/tests/fixtures/geminiStub.js [port]      run standalone for a local rehearsal
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const STUB_API_KEY = 'test-gemini-key-not-a-real-credential';

const analysisFor = (priority) => {
  const manipulated = priority === 'CRITICAL' || priority === 'HIGH';
  return {
    deepfakeAssessment: manipulated ? 'LIKELY_MANIPULATED' : priority === 'LOW' ? 'LIKELY_AUTHENTIC' : 'INCONCLUSIVE',
    deepfakeScore: { CRITICAL: 92, HIGH: 74, MEDIUM: 50, LOW: 12 }[priority],
    analysisDescription: `[stub] Fixture analysis returned for a ${priority} test exhibit. This text comes from the test stub standing in for the AI model.`,
    detectedIndicators: manipulated ? ['[stub] fixture indicator one', '[stub] fixture indicator two'] : [],
    triagePriority: priority,
    priorityReason: `[stub] The fixture was asked to return ${priority}.`,
    fslReviewRecommended: priority !== 'LOW',
    fslReviewReason: priority !== 'LOW' ? '[stub] Fixture recommends review.' : '[stub] Fixture does not recommend review.',
    evidenceSummary: '[stub] Test exhibit.',
  };
};

const candidate = (text) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  modelVersion: 'gemini-test-model-stub',
});

const RATE_LIMITED = { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } };

function inlineDataOf(body) {
  const parts = body?.contents?.[0]?.parts ?? [];
  const inline = parts.find((p) => p.inline_data || p.inlineData);
  return inline?.inline_data?.data ?? inline?.inlineData?.data ?? '';
}

const markerIn = (data) => Buffer.from(data, 'base64').toString('latin1').match(/STUB:([A-Z_]+)/)?.[1] ?? null;

export function createGeminiStub({ apiKey = process.env.GEMINI_API_KEY ?? STUB_API_KEY } = {}) {
  const calls = [];
  /** How many requests have been seen per file (sha256 of the inline data). */
  const seen = new Map();
  /** When set, every request behaves as if its file carried this marker. */
  let forced = null;
  let delayMs = 0;
  let inFlight = 0;
  const stats = { maxInFlight: 0 };

  const server = http.createServer((req, res) => {
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        inFlight -= 1;
      }
    };
    res.on('close', finish);

    const send = (status, obj, headers = {}) => {
      const write = () => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (delayMs > 0) setTimeout(write, delayMs);
      else write();
    };

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: { code: 400, message: 'Invalid JSON payload', status: 'INVALID_ARGUMENT' } });
      }
      calls.push({ path: req.url, key: req.headers['x-goog-api-key'], body, at: Date.now() });

      if (!/\/models\/[^/]+:generateContent$/.test(req.url.split('?')[0])) {
        return send(404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
      }
      if (req.headers['x-goog-api-key'] !== apiKey) {
        return send(400, {
          error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
        });
      }

      const data = inlineDataOf(body);
      const fileKey = crypto.createHash('sha256').update(data).digest('hex');
      const nth = (seen.get(fileKey) ?? 0) + 1;
      seen.set(fileKey, nth);

      const marker = forced ?? markerIn(data);
      switch (marker) {
        case 'RATE_LIMIT':
          return send(429, RATE_LIMITED);
        case 'RATE_LIMIT_RETRY_AFTER':
          return nth === 1
            ? send(429, RATE_LIMITED, { 'retry-after': '1' })
            : send(200, candidate(JSON.stringify(analysisFor('LOW'))));
        case 'RATE_LIMIT_LONG_RETRY_AFTER':
          return send(429, RATE_LIMITED, { 'retry-after': '3600' });
        case 'SERVER_ERROR':
          return send(503, { error: { code: 503, message: 'The model is overloaded', status: 'UNAVAILABLE' } });
        case 'BAD_JSON':
          return send(200, candidate('this is not json'));
        case 'SCHEMA_INVALID':
          return send(200, candidate(JSON.stringify({ deepfakeScore: 'high' })));
        case 'INCOHERENT':
          return send(200, candidate(JSON.stringify({ ...analysisFor('HIGH'), deepfakeScore: 10 })));
        case 'LOW_PRIORITY_HIGH_SCORE':
          // Valid and coherent (INCONCLUSIVE has no direction), and deliberately a
          // combination no score threshold would produce.
          return send(
            200,
            candidate(JSON.stringify({ ...analysisFor('LOW'), deepfakeAssessment: 'INCONCLUSIVE', deepfakeScore: 88 }))
          );
        case 'SLOW':
          return setTimeout(() => send(200, candidate(JSON.stringify(analysisFor('LOW')))), 10_000);
        case 'CRITICAL':
        case 'HIGH':
        case 'MEDIUM':
        case 'LOW':
          return send(200, candidate(JSON.stringify(analysisFor(marker))));
        default:
          return send(200, candidate(JSON.stringify(analysisFor('MEDIUM'))));
      }
    });
  });

  return {
    calls,
    stats,
    /** Force a behaviour for every request (e.g. 'RATE_LIMIT'), or null to read markers again. */
    force: (marker) => {
      forced = marker;
    },
    /** Hold every answer for `ms` milliseconds (0 to answer at once). */
    delay: (ms) => {
      delayMs = ms;
    },
    /** Forget call history, per-file counts and the in-flight high-water mark. */
    reset: () => {
      calls.length = 0;
      seen.clear();
      stats.maxInFlight = 0;
      forced = null;
      delayMs = 0;
    },
    listen: (port) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? process.env.GEMINI_STUB_PORT ?? 18080);
  const stub = createGeminiStub();
  stub.listen(port).then((p) => console.log(`[ai-stub] TEST FIXTURE listening on http://127.0.0.1:${p}/v1beta`));
}

export default { createGeminiStub, STUB_API_KEY };
