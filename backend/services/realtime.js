/**
 * The realtime change feed: server-sent events telling open pages that something changed.
 *
 *   ledger append / analysis status change
 *     → emitChange({ type, caseId, evidenceId })      in-process EventEmitter
 *     → every open stream evaluates, in arrival order: may THIS user read that case?
 *     → `event: change` with ids and a type — the page refetches through the normal API
 *
 * # What travels, and what never does
 *
 * A frame carries `{ type, caseId, evidenceId, at }` and nothing else. No titles, no
 * names, no payloads, no AI output. The client learns that something it may already
 * read has changed, and fetches it through the ordinary authorised routes — so the feed
 * cannot become a second, weaker read path.
 *
 * # Audience
 *
 * Decided by the single policy point, `accessResolver.resolve` (READ on the CASE, the
 * resolver loading the case itself), never by anything in the event. A decision is
 * cached per connection per case for DECISION_TTL_MS and dropped early when an
 * access-changing event for that case arrives, so counsel accepted onto a case receive
 * the events that follow. The session is re-read from the database on the same cadence,
 * so a suspended or re-designated user's stream is closed.
 *
 * AI_ANALYSIS_UPDATED is further restricted to laboratory users: the analysis belongs to
 * the laboratory (see ai/visibility.js). An event with no case goes only to the actor's
 * own streams; with no identifiable actor it is dropped.
 *
 * Resolver calls made here are deliberately not written to the audit trail: they decide
 * whether an id may be MENTIONED to a page, and the read that follows is audited as usual.
 *
 * # Bounded
 *
 * A total and a per-user connection cap, a bounded decision cache, a bounded backlog of
 * unevaluated events, and a cap on bytes the socket has not yet taken. A stream that
 * exceeds any of them is closed; the client reconnects and refetches, which is always
 * correct.
 */
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { setInterval, clearInterval, setTimeout, clearTimeout, setImmediate } from 'node:timers';

import { resolve } from './accessResolver.js';
import { User } from '../models/User.js';
import {
  ACTION,
  AUTHORITY,
  LEDGER_EVENT,
  REALTIME_EVENT,
  RESOURCE_TYPE,
  SUBJECT_TYPE,
  USER_STATUS,
} from '../models/enums.js';
import { isTest } from '../config/env.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('realtime');

export const DEFAULT_HEARTBEAT_MS = 25_000;
export const RETRY_MS = 3_000;
export const DECISION_TTL_MS = 30_000;

const MAX_CONNECTIONS = 2_000;
const MAX_CONNECTIONS_PER_USER = 8;
const MAX_CACHED_DECISIONS = 500;
const MAX_PENDING_EVENTS = 500;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A short hold before an event is delivered. Several write paths finish a record just
 * AFTER its ledger append (the exhibit's `ledgerSeq`, a certificate's `lastVerification`,
 * a filing's `grantId`); a page that refetched the instant the entry committed would
 * read the record one write early.
 */
const DEFAULT_EMIT_DELAY_MS = 150;

/**
 * Events after which a user's right to read the case may have changed. Their cached
 * decisions for that case are discarded before the event itself is evaluated.
 */
const ACCESS_CHANGING = new Set([
  LEDGER_EVENT.CASE_CREATED,
  LEDGER_EVENT.CASE_STAGE_CHANGED,
  LEDGER_EVENT.CASE_CLOSED,
  LEDGER_EVENT.REFERRED_TO_FSL,
  LEDGER_EVENT.FSL_EXAMINATION_STARTED,
  LEDGER_EVENT.FSL_REPORT_FILED,
  LEDGER_EVENT.JUDICIAL_ORDER,
  LEDGER_EVENT.REPRESENTATION_SYNCED,
  LEDGER_EVENT.VAKALATNAMA_ACCEPTED,
  LEDGER_EVENT.VAKALATNAMA_REJECTED,
  REALTIME_EVENT.CASE_ACCESS_CHANGED,
]);

const TYPE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const bus = new EventEmitter();
bus.setMaxListeners(MAX_CONNECTIONS + 16);

/** @type {Set<object>} insertion-ordered, so the oldest stream is first */
const connections = new Set();

function idOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  return ID_RE.test(s) ? s : null;
}

function envMs(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// ------------------------------------------------------------------ emission ----

/**
 * Announce a change. Fire-and-forget: never throws, never awaits, returns at once.
 *
 * @param {object} change
 * @param {string} change.type           ledger event type, or a REALTIME_EVENT value
 * @param {any}    [change.caseId]
 * @param {any}    [change.evidenceId]
 * @param {any}    [change.actorUserId]  used only to route a case-less event; never sent
 * @param {string} [change.subjectType]  never sent
 * @param {any}    [change.subjectId]    never sent
 * @returns {boolean} whether anything was scheduled for delivery
 */
export function emitChange({
  type,
  caseId = null,
  evidenceId = null,
  actorUserId = null,
  subjectType = null,
  subjectId = null,
} = {}) {
  try {
    if (typeof type !== 'string' || !TYPE_RE.test(type)) return false;
    if (bus.listenerCount('change') === 0) return false;

    const event = Object.freeze({
      type,
      caseId: idOrNull(caseId),
      evidenceId: idOrNull(evidenceId),
      at: new Date().toISOString(),
    });
    const meta = Object.freeze({
      actorUserId: idOrNull(actorUserId),
      subjectType: typeof subjectType === 'string' ? subjectType : null,
      subjectId: idOrNull(subjectId),
    });

    const fire = () => {
      try {
        bus.emit('change', event, meta);
      } catch (err) {
        log.warn({ err: err.message, type }, 'change delivery failed');
      }
    };
    const delay = envMs('REALTIME_EMIT_DELAY_MS', DEFAULT_EMIT_DELAY_MS, 0);
    if (delay > 0) setTimeout(fire, Math.min(delay, 10_000));
    else setImmediate(fire);
    return true;
  } catch (err) {
    log.warn({ err: err.message }, 'emitChange failed');
    return false;
  }
}

/** The ledger's post-append hook. Takes the entry exactly as written. */
export function emitLedgerAppend(entry) {
  if (!entry?.eventType) return false;
  const evidenceId =
    entry.subjectType === SUBJECT_TYPE.EVIDENCE ? entry.subjectId : (entry.payload?.evidenceId ?? null);
  return emitChange({
    type: entry.eventType,
    caseId: entry.caseId,
    evidenceId,
    actorUserId: entry.actorUserId,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
  });
}

// ------------------------------------------------------------------ audience ----

/** The session as the database has it now; closes the stream if it no longer holds. */
async function currentUser(conn) {
  if (Date.now() - conn.userCheckedAt < DECISION_TTL_MS) return conn.user;

  const doc = await User.findById(conn.userId);
  if (conn.closed) return null;
  if (
    !doc ||
    doc.status !== USER_STATUS.ACTIVE ||
    doc.role !== conn.user.role ||
    doc.authority !== conn.user.authority
  ) {
    closeConnection(conn, 'session-invalid');
    return null;
  }
  const fresh = doc.toSessionContext();
  if (JSON.stringify(fresh.scope) !== JSON.stringify(conn.user.scope)) conn.cache.clear();
  conn.user = fresh;
  conn.userCheckedAt = Date.now();
  return fresh;
}

/** READ on one resource, through the resolver, cached per connection. */
async function mayRead(conn, user, resourceType, resourceId) {
  const key = `${resourceType}:${resourceId}`;
  const hit = conn.cache.get(key);
  if (hit && Date.now() - hit.at < DECISION_TTL_MS) return hit.allow;

  const decision = await resolve({ user, action: ACTION.READ, resourceType, resourceId });
  const allow = Boolean(decision?.allow);
  if (conn.closed) return false;

  conn.cache.delete(key);
  conn.cache.set(key, { allow, at: Date.now() });
  while (conn.cache.size > MAX_CACHED_DECISIONS) {
    conn.cache.delete(conn.cache.keys().next().value);
  }
  return allow;
}

async function mayReceive(conn, event, meta) {
  if (!event.caseId) {
    return Boolean(meta.actorUserId) && meta.actorUserId === conn.userId;
  }

  if (ACCESS_CHANGING.has(event.type)) {
    conn.cache.delete(`${RESOURCE_TYPE.CASE}:${event.caseId}`);
  }

  const user = await currentUser(conn);
  if (!user) return false;

  if (event.type === REALTIME_EVENT.AI_ANALYSIS_UPDATED) {
    if (user.authority !== AUTHORITY.FSL) return false;
    return mayRead(conn, user, RESOURCE_TYPE.CASE, event.caseId);
  }

  if (await mayRead(conn, user, RESOURCE_TYPE.CASE, event.caseId)) return true;

  // A vakalatnama is filed by someone who, by definition, cannot read the case yet.
  // The filing advocate may read their own filing, so they hear about its ruling.
  if (meta.subjectType === SUBJECT_TYPE.VAKALATNAMA && meta.subjectId) {
    return mayRead(conn, user, RESOURCE_TYPE.VAKALATNAMA, meta.subjectId);
  }
  return false;
}

// ------------------------------------------------------------------ streams ----

function write(conn, chunk) {
  if (conn.closed) return;
  try {
    conn.res.write(chunk);
    if (conn.res.writableLength > MAX_BUFFERED_BYTES) closeConnection(conn, 'slow-consumer');
  } catch (err) {
    log.warn({ err: err.message }, 'stream write failed');
    closeConnection(conn, 'write-failed');
  }
}

function cleanup(conn) {
  if (conn.closed) return;
  conn.closed = true;
  bus.off('change', conn.listener);
  clearInterval(conn.heartbeat);
  clearTimeout(conn.expiry);
  conn.cache.clear();
  connections.delete(conn);
}

function closeConnection(conn, reason) {
  if (conn.closed) return;
  cleanup(conn);
  log.debug?.({ reason, userId: conn.userId }, 'change stream closed');
  try {
    conn.res.end();
  } catch {
    /* socket already gone */
  }
}

function enqueue(conn, event, meta) {
  if (conn.closed) return;
  if (conn.pending >= MAX_PENDING_EVENTS) {
    closeConnection(conn, 'backlog');
    return;
  }
  conn.pending += 1;
  conn.chain = conn.chain
    .then(async () => {
      if (conn.closed) return;
      try {
        if (await mayReceive(conn, event, meta)) {
          write(conn, `event: change\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (err) {
        // An error deciding is a refusal, never a delivery.
        log.warn({ err: err.message, type: event.type }, 'change audience check failed');
      }
    })
    .finally(() => {
      conn.pending -= 1;
    });
}

let shutdownHookInstalled = false;
function installShutdownHook() {
  if (shutdownHookInstalled || isTest) return;
  shutdownHookInstalled = true;
  // Open streams would otherwise hold server.close() until its forced-exit timer.
  // server.js owns the process's signal handling; this only ends the streams alongside it.
  process.once('SIGINT', () => closeAllStreams('shutdown'));
  process.once('SIGTERM', () => closeAllStreams('shutdown'));
}

/**
 * GET /api/events/stream — mounted after requireSession, so `req.user` and `req.auth`
 * are the database-authoritative session.
 */
export function openStream(req, res) {
  const user = req.user;

  if (connections.size >= MAX_CONNECTIONS) {
    return res.status(503).json({
      error: { code: 'REALTIME_UNAVAILABLE', message: 'Too many live connections. Try again shortly.' },
    });
  }

  // One person with many tabs is fine; an unbounded number is not. The oldest goes.
  const mine = [...connections].filter((c) => c.userId === user.userId);
  if (mine.length >= MAX_CONNECTIONS_PER_USER) closeConnection(mine[0], 'superseded');

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const socket = req.socket;
  socket?.setTimeout?.(0);
  socket?.setNoDelay?.(true);
  socket?.setKeepAlive?.(true, 30_000);

  const conn = {
    id: crypto.randomUUID(),
    userId: String(user.userId),
    user,
    userCheckedAt: Date.now(),
    cache: new Map(),
    chain: Promise.resolve(),
    pending: 0,
    closed: false,
    res,
    listener: null,
    heartbeat: null,
    expiry: null,
  };
  conn.listener = (event, meta) => enqueue(conn, event, meta);

  connections.add(conn);
  bus.on('change', conn.listener);
  res.on('close', () => cleanup(conn));
  res.on('error', () => cleanup(conn));

  write(conn, `retry: ${RETRY_MS}\n\n`);
  write(conn, `event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  const heartbeatMs = envMs('REALTIME_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS, 10);
  conn.heartbeat = setInterval(() => write(conn, ': ping\n\n'), heartbeatMs);

  // The stream must not outlive the access token that opened it. The client
  // reconnects with a refreshed token and refetches.
  const expMs = Number(req.auth?.exp) * 1000;
  if (Number.isFinite(expMs)) {
    const remaining = Math.max(0, expMs - Date.now());
    conn.expiry = setTimeout(() => closeConnection(conn, 'token-expired'), Math.min(remaining, MAX_TIMER_MS));
  }

  installShutdownHook();
  return undefined;
}

/** End every open stream. For shutdown, and for tests. */
export function closeAllStreams(reason = 'shutdown') {
  for (const conn of [...connections]) closeConnection(conn, reason);
}

/** Number of open streams. */
export const streamCount = () => connections.size;

export default { emitChange, emitLedgerAppend, openStream, closeAllStreams, streamCount };
