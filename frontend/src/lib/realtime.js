/**
 * Live change notifications.
 *
 * The server pushes one small frame per ledger event (`GET /api/events/stream`) for the
 * cases this user may read; the client refetches whatever the frame touches. Nothing in
 * a frame is rendered — it names what changed, never the change itself, so the
 * disclosure boundary stays with the normal read endpoints.
 *
 * # Why fetch and not EventSource
 *
 * `EventSource` cannot send an Authorization header, and the access token must never go
 * in a URL (it would land in proxy and server logs). So the stream is read with `fetch`
 * and parsed here, following the WHATWG event-stream rules: lines end in LF, CRLF or CR,
 * a blank line dispatches, `:` lines are comments (heartbeats), and a frame split across
 * network chunks is reassembled before it is dispatched.
 *
 * # Connection policy
 *
 *   - 401: one refresh through the same flow every other request uses, then reconnect.
 *     If the refresh ends the session, `onSessionEnded` stops the stream.
 *   - Anything else (network loss, server restart, 404 before the route exists):
 *     exponential backoff 1 s → 30 s with jitter. Coming back online or back to the tab
 *     wakes a pending backoff at once.
 *   - A connection that goes silent for longer than the heartbeat allows is treated as
 *     dead and replaced — a half-open TCP connection otherwise looks "live" forever.
 *   - It stays connected while the tab is hidden: a judge's tab in the background should
 *     still be current when they come back to it.
 */
import { getAccessToken, onSessionEnded, refreshSession } from '@/lib/api';

const STREAM_PATH = '/api/events/stream';
const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** No bytes at all (not even a `: ping`) for this long means the connection is dead. */
const SILENCE_LIMIT_MS = 75_000;

// ------------------------------------------------------------------ parser ----

/**
 * An incremental event-stream parser.
 *
 * @param {object} handlers
 * @param {(event: { type: string, data: string, id: string|null }) => void} handlers.onEvent
 * @param {(text: string) => void} [handlers.onComment]
 * @param {(ms: number) => void} [handlers.onRetry]
 */
export function createSseParser({ onEvent, onComment, onRetry }) {
  let buffer = '';
  let eventType = '';
  let data = [];
  let lastId = null;

  const dispatch = () => {
    if (data.length) onEvent({ type: eventType || 'message', data: data.join('\n'), id: lastId });
    eventType = '';
    data = [];
  };

  const line = (text) => {
    if (text === '') return dispatch();
    if (text[0] === ':') return onComment?.(text.slice(1).trim());
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') eventType = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') lastId = value;
    else if (field === 'retry' && /^\d+$/.test(value)) onRetry?.(Number(value));
    return undefined;
  };

  return {
    push(chunk) {
      buffer += chunk;
      let pos = 0;
      while (pos < buffer.length) {
        const cr = buffer.indexOf('\r', pos);
        const lf = buffer.indexOf('\n', pos);
        if (cr === -1 && lf === -1) break;
        let end;
        let next;
        if (cr !== -1 && (lf === -1 || cr < lf)) {
          // A CR at the very end may be the first half of a CRLF split across chunks.
          if (cr === buffer.length - 1) break;
          end = cr;
          next = buffer[cr + 1] === '\n' ? cr + 2 : cr + 1;
        } else {
          end = lf;
          next = lf + 1;
        }
        line(buffer.slice(pos, end));
        pos = next;
      }
      buffer = buffer.slice(pos);
    },
    /** The stream ended: an unterminated frame is discarded, as the spec requires. */
    reset() {
      buffer = '';
      eventType = '';
      data = [];
    },
  };
}

// ------------------------------------------------------------------- state ----

/** `idle` (not running) | `connecting` | `live` | `reconnecting`. */
let state = Object.freeze({ status: 'idle', downSince: null });
const statusListeners = new Set();
const changeListeners = new Set();
const readyListeners = new Set();

function setStatus(status) {
  if (state.status === status) return;
  const downSince = status === 'live' || status === 'idle' ? null : state.downSince ?? Date.now();
  state = Object.freeze({ status, downSince });
  for (const fn of statusListeners) fn();
}

const emit = (set, payload) => {
  for (const fn of set) {
    try {
      fn(payload);
    } catch {
      /* a bad listener must not break the stream */
    }
  }
};

export const getRealtimeState = () => state;

export function subscribeRealtimeStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** `fn({ type, caseId, evidenceId, at })` for every change frame. */
export function onRealtimeChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** `fn({ reconnected })` whenever the server confirms a connection. */
export function onRealtimeReady(fn) {
  readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

// -------------------------------------------------------------- connection ----

let controller = null;
let wake = null;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      if (wake === done) wake = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    wake = done;
  });
}

const backoff = (attempt) => {
  const ceiling = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
};

function parseChange(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    return {
      type: typeof value.type === 'string' ? value.type : null,
      caseId: value.caseId ? String(value.caseId) : null,
      evidenceId: value.evidenceId ? String(value.evidenceId) : null,
      at: value.at ?? null,
    };
  } catch {
    return null;
  }
}

async function run(signal) {
  let attempt = 0;
  let refreshTried = false;
  let everReady = false;
  let retryHint = null;

  while (!signal.aborted) {
    const token = getAccessToken();
    if (!token) break;
    setStatus(everReady ? 'reconnecting' : 'connecting');

    const conn = new AbortController();
    const abortConn = () => conn.abort();
    signal.addEventListener('abort', abortConn, { once: true });
    let silence = null;
    const heard = () => {
      clearTimeout(silence);
      silence = setTimeout(abortConn, SILENCE_LIMIT_MS);
    };
    let wasLive = false;
    let retryNow = false;

    try {
      heard();
      const response = await fetch(STREAM_PATH, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: conn.signal,
      });

      if (response.status === 401) {
        clearTimeout(silence);
        if (!refreshTried) {
          refreshTried = true;
          if (await refreshSession()) retryNow = true;
        }
        if (!retryNow) throw new Error('Stream refused the session');
      } else {
        if (!response.ok || !response.body) throw new Error(`Stream unavailable (${response.status})`);

        const parser = createSseParser({
          onComment: heard,
          onRetry: (ms) => {
            retryHint = ms;
          },
          onEvent: (event) => {
            heard();
            if (event.type === 'ready') {
              const reconnected = everReady;
              everReady = true;
              wasLive = true;
              attempt = 0;
              refreshTried = false;
              setStatus('live');
              emit(readyListeners, { reconnected });
            } else if (event.type === 'change') {
              const change = parseChange(event.data);
              if (change) emit(changeListeners, change);
            }
          },
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          heard();
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.reset();
      }
    } catch {
      /* network loss, abort, refusal: fall through to the backoff */
    } finally {
      clearTimeout(silence);
      signal.removeEventListener('abort', abortConn);
      conn.abort();
    }

    if (signal.aborted) break;
    if (retryNow) continue;
    if (!getAccessToken()) break;

    setStatus(everReady ? 'reconnecting' : 'connecting');
    const delay = wasLive && retryHint ? retryHint : backoff(attempt);
    attempt += 1;
    // A later 401 deserves one more refresh after the wait.
    if (!wasLive) refreshTried = false;
    await sleep(delay, signal);
  }
}

/** Start streaming. Idempotent. */
export function startRealtime() {
  if (controller) return;
  const own = new AbortController();
  controller = own;
  run(own.signal).finally(() => {
    if (controller === own) {
      controller = null;
      setStatus('idle');
    }
  });
}

/** Stop streaming (sign-out, session end, unmount). Idempotent. */
export function stopRealtime() {
  const own = controller;
  controller = null;
  own?.abort();
  setStatus('idle');
}

onSessionEnded(() => stopRealtime());

if (typeof window !== 'undefined') {
  const nudge = () => {
    if (controller && state.status !== 'live') wake?.();
  };
  window.addEventListener('online', nudge);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') nudge();
  });
}
