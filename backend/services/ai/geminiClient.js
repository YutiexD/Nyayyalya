/**
 * The AI provider client. The ONLY module in this codebase that talks to the model API.
 *
 * Everything about the transport lives here and nowhere else: the endpoint, the key
 * header, the timeout, the mapping of HTTP failures onto a small vocabulary the rest
 * of the system can act on. Controllers, routes and the React client never see a
 * provider URL or key — they see `analysisService`, which sees this.
 *
 * # Provider neutrality
 *
 * The provider is an implementation detail. Error codes are `AI_*` and every message
 * this module produces says "the AI service", because those messages are persisted on
 * the evidence record and shown to the laboratory. Only the environment variable names
 * (GEMINI_API_KEY, GEMINI_MODEL, …) and the persisted `provider` / `model` fields name
 * the provider, and neither ever reaches an API response.
 *
 * # One call
 *
 * `generateStructured` asks for a JSON response constrained by a response schema and
 * returns the parsed object. It is the only request this system makes: there is no
 * search-grounded or tool-using call.
 *
 * # Rate limits
 *
 * A 429 / RESOURCE_EXHAUSTED failure carries `retryAfterMs` when the provider said how
 * long to wait — the `Retry-After` header (seconds or an HTTP date) or a RetryInfo
 * `retryDelay` in the error body. The caller decides whether and when to retry.
 *
 * # Secrets
 *
 * The key travels in the `x-goog-api-key` header, never in the URL, so it cannot leak
 * through an error message, a proxy log or a stack trace that prints the request URL.
 */
import env from '../../config/env.js';

/** Failure codes a caller can branch on. `retryable` says whether trying again can help. */
export const AI_ERROR = Object.freeze({
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  INVALID_API_KEY: 'AI_INVALID_API_KEY',
  PERMISSION_DENIED: 'AI_PERMISSION_DENIED',
  MODEL_NOT_FOUND: 'AI_MODEL_NOT_FOUND',
  INVALID_REQUEST: 'AI_INVALID_REQUEST',
  PAYLOAD_TOO_LARGE: 'AI_PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'AI_RATE_LIMITED',
  UNAVAILABLE: 'AI_UNAVAILABLE',
  TIMEOUT: 'AI_TIMEOUT',
  BLOCKED: 'AI_RESPONSE_BLOCKED',
  EMPTY_RESPONSE: 'AI_EMPTY_RESPONSE',
  PARTIAL_RESPONSE: 'AI_PARTIAL_RESPONSE',
  INVALID_JSON: 'AI_INVALID_JSON',
});

/** Kept under its historical name for any importer that still uses it. Values are AI_*. */
export const GEMINI_ERROR = AI_ERROR;

export class AiServiceError extends Error {
  constructor(code, message, { retryable = false, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'AiServiceError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    /** How long the provider asked the caller to wait before retrying, if it said. */
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The wait a rate-limited answer asked for, in milliseconds, or null if it named none.
 * Reads the `Retry-After` header (delta-seconds or an HTTP date) first, then a
 * google.rpc.RetryInfo `retryDelay` ("12s", "1.5s") in the error body.
 */
export function parseRetryAfterMs(headerValue, body = null, now = Date.now()) {
  if (typeof headerValue === 'string' && headerValue.trim()) {
    const v = headerValue.trim();
    if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
    const at = Date.parse(v);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  for (const d of details) {
    const m = typeof d?.retryDelay === 'string' ? d.retryDelay.trim().match(/^(\d+(?:\.\d+)?)s$/) : null;
    if (m) return Math.round(Number(m[1]) * 1000);
  }
  return null;
}

/** Historical alias. */
export const GeminiError = AiServiceError;

/** True when the key and model are both present. The API refuses to start otherwise. */
export const geminiConfigured = () => Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL);

/** The model this deployment analyses with — persisted on every analysis, never sent to a client. */
export const geminiModel = () => env.GEMINI_MODEL ?? null;

/**
 * Remove provider names and hosts from text that may be persisted or shown. Provider
 * error bodies can name the product or its API host; neither belongs on a screen.
 */
export function neutralText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/https?:\/\/[^\s"')]*googleapis\.com[^\s"')]*/gi, '[AI service endpoint]')
    .replace(/\b[\w.-]*googleapis\.com\b/gi, '[AI service endpoint]')
    .replace(/\bgoogle\s+search\b/gi, 'web search')
    .replace(/\b(?:google\s+)?gemini(?:-[\w.-]+)?\b/gi, 'the AI service')
    .replace(/\bgoogle\b/gi, 'the AI provider');
}

/** A short, safe message out of a provider error body. Truncated: it is persisted. */
function errorMessageFrom(body, fallback) {
  const msg = body?.error?.message;
  return typeof msg === 'string' && msg.trim() ? neutralText(msg.trim()).slice(0, 300) : fallback;
}

function classifyHttpFailure(status, body, headers = null) {
  const message = errorMessageFrom(body, `The AI service answered HTTP ${status}`);
  const reason = String(body?.error?.status ?? '');
  const details = JSON.stringify(body?.error?.details ?? []);

  if ((status === 400 && /API_KEY_INVALID|API key not valid/i.test(`${details} ${body?.error?.message ?? ''}`)) || status === 401) {
    return new AiServiceError(AI_ERROR.INVALID_API_KEY, 'The configured AI service API key was rejected', { status });
  }
  if (status === 403) return new AiServiceError(AI_ERROR.PERMISSION_DENIED, message, { status });
  if (status === 404) {
    return new AiServiceError(AI_ERROR.MODEL_NOT_FOUND, `The configured AI model is not available: ${message}`, { status });
  }
  if (status === 413) return new AiServiceError(AI_ERROR.PAYLOAD_TOO_LARGE, message, { status });
  if (status === 429 || reason === 'RESOURCE_EXHAUSTED') {
    return new AiServiceError(AI_ERROR.RATE_LIMITED, message, {
      status,
      retryable: true,
      retryAfterMs: parseRetryAfterMs(headers?.get?.('retry-after') ?? null, body),
    });
  }
  if (status >= 500) {
    return new AiServiceError(AI_ERROR.UNAVAILABLE, message, {
      status,
      retryable: true,
      retryAfterMs: status === 503 ? parseRetryAfterMs(headers?.get?.('retry-after') ?? null, null) : null,
    });
  }
  return new AiServiceError(AI_ERROR.INVALID_REQUEST, message, { status });
}

/** POST one generateContent request and return the first usable candidate. */
async function generateContent(body) {
  if (!geminiConfigured()) {
    throw new AiServiceError(AI_ERROR.NOT_CONFIGURED, 'The AI service API key and model must be set in the environment');
  }

  const url = `${env.GEMINI_API_BASE_URL.replace(/\/+$/, '')}/models/${encodeURIComponent(
    env.GEMINI_MODEL
  )}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.GEMINI_TIMEOUT_MS);

  let response;
  let json = null;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    try {
      json = await response.json();
    } catch {
      json = null;
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new AiServiceError(AI_ERROR.TIMEOUT, `The AI service did not answer within ${env.GEMINI_TIMEOUT_MS} ms`, {
        retryable: true,
      });
    }
    throw new AiServiceError(AI_ERROR.UNAVAILABLE, 'The AI service could not be reached', { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw classifyHttpFailure(response.status, json, response.headers);

  if (json?.promptFeedback?.blockReason) {
    throw new AiServiceError(AI_ERROR.BLOCKED, `The AI service declined to analyse this evidence (${json.promptFeedback.blockReason})`);
  }

  const candidate = json?.candidates?.[0];
  if (!candidate) {
    throw new AiServiceError(AI_ERROR.EMPTY_RESPONSE, 'The AI service returned no analysis', { retryable: true });
  }

  const finish = candidate.finishReason ?? 'STOP';
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
    throw new AiServiceError(AI_ERROR.BLOCKED, `The AI service stopped the analysis (${finish})`);
  }
  if (finish !== 'STOP') {
    // MAX_TOKENS and friends: whatever came back is a fragment, not an analysis.
    throw new AiServiceError(AI_ERROR.PARTIAL_RESPONSE, `The AI service returned an incomplete analysis (${finish})`, {
      retryable: true,
    });
  }

  const text = (candidate.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  if (!text) {
    throw new AiServiceError(AI_ERROR.EMPTY_RESPONSE, 'The AI service returned an empty analysis', { retryable: true });
  }

  return { text, candidate, modelVersion: json.modelVersion ?? null, usage: json.usageMetadata ?? null };
}

/**
 * One structured-output request.
 *
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<object>} args.parts          content parts (text, inline_data)
 * @param {object} args.responseSchema        response schema (OpenAPI subset)
 * @returns {Promise<{ data: object, modelVersion: string|null, usage: object|null }>}
 */
export async function generateStructured({ systemInstruction, parts, responseSchema }) {
  const { text, modelVersion, usage } = await generateContent({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      // An analysis should not change because it was asked twice.
      temperature: 0,
    },
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiServiceError(AI_ERROR.INVALID_JSON, 'The AI service returned an analysis that is not valid JSON', {
      retryable: true,
    });
  }
  return { data, modelVersion, usage };
}

export default {
  generateStructured,
  parseRetryAfterMs,
  geminiConfigured,
  geminiModel,
  neutralText,
  AiServiceError,
  AI_ERROR,
};
