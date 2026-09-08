/**
 * The append-only ledger service.
 *
 * # Why this file is careful
 *
 * A hash chain is inherently serial: entry N+1's `prevHash` is entry N's `entryHash`,
 * so N must exist before N+1 can be computed. Two concurrent appends that each
 * allocate a sequence number and then race to read "the previous entry" will produce
 * a forked or dangling chain — and a forked chain silently destroys the single
 * property the whole system is selling.
 *
 * So appends are serialised, at two levels:
 *   1. an in-process promise queue, which handles the common case with no I/O; and
 *   2. a MongoDB-backed advisory lock, which holds across processes (the API and the
 *      anchor batcher are separate processes, and a real deployment runs several).
 *
 * The unique indexes on `seq` and `entryHash` remain the backstop: if both layers
 * somehow fail, the database refuses the duplicate rather than corrupting history.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Ledger } from '../models/Ledger.js';
import { Counter } from '../models/Counter.js';
import { canonicalHash } from './canonical.js';
import { sha256Hex, randomHex } from '../config/crypto.js';
import { loggerFor } from '../utils/logger.js';
import { Internal } from '../utils/errors.js';

const log = loggerFor('ledger');

/** prevHash of the very first entry. 32 zero bytes. */
export const GENESIS_HASH = '0'.repeat(64);

/** Bumping this changes every subsequent entryHash, so it is versioned explicitly. */
export const CHAIN_VERSION = 'v1';

const LEDGER_SEQ_COUNTER = 'ledger.seq';
const LOCK_ID = 'ledger.append';
const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

// ---------------------------------------------------------------- hashing ----

/**
 * The chain hash. Fields are delimited by `|` and the version is prefixed, so that
 * no two different field sets can produce the same input string (ADR-007).
 * Concatenating undelimited values would let (seq=1, prev="23") collide with
 * (seq=12, prev="3").
 */
export function computeEntryHash({ seq, prevHash, payloadHash, occurredAt }) {
  const iso = occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt);
  return sha256Hex(`${CHAIN_VERSION}|${seq}|${prevHash}|${payloadHash}|${iso}`);
}

export const computePayloadHash = (payload) => canonicalHash(payload);

// ---------------------------------------------------------------- locking ----

const LockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    holder: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'locks', versionKey: false }
);
const Lock = mongoose.models.Lock ?? mongoose.model('Lock', LockSchema);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock() {
  const holder = randomHex(12);
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    const now = new Date();
    try {
      const doc = await Lock.findOneAndUpdate(
        // Free if never held, released, or the holder's lease has expired (crash safety).
        { _id: LOCK_ID, $or: [{ holder: null }, { expiresAt: { $lte: now } }] },
        { $set: { holder, expiresAt: new Date(Date.now() + LOCK_TTL_MS) } },
        { new: true, upsert: true }
      ).lean();
      if (doc?.holder === holder) return holder;
    } catch (err) {
      // Upsert against an existing, currently-held document → duplicate key.
      // That is "someone else holds it", not a failure.
      if (err?.code !== 11000) throw err;
    }
    await sleep(5 + Math.floor(Math.random() * 20)); // jitter avoids lockstep retries
  }

  throw Internal('LEDGER_LOCK_TIMEOUT', 'Could not acquire the ledger append lock');
}

async function releaseLock(holder) {
  try {
    await Lock.updateOne({ _id: LOCK_ID, holder }, { $set: { holder: null, expiresAt: new Date(0) } });
  } catch (err) {
    // A failed release is not fatal — the lease expires on its own.
    log.warn({ err: err.message }, 'ledger lock release failed; lease will expire');
  }
}

/** In-process serialisation, so same-process concurrency never touches the DB lock. */
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  // Keep the chain alive after a rejection, without swallowing the caller's error.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ---------------------------------------------------------------- append ----

/**
 * Append one event. This is the ONLY way anything enters the ledger.
 *
 * @param {object} e
 * @param {string} e.eventType       LEDGER_EVENT value
 * @param {any}    [e.caseId]
 * @param {any}    [e.subjectId]
 * @param {string} [e.subjectType]
 * @param {any}    [e.actorUserId]
 * @param {string} [e.actorRole]
 * @param {object} e.payload         canonicalised and hashed; must not contain secrets
 * @param {string} [e.actorSignature] client ECDSA signature over the entry hash
 * @param {string} [e.actorPubKeyFingerprint]
 * @returns {Promise<import('mongoose').Document>} the created entry
 */
export async function appendEvent(e) {
  if (!e?.eventType) throw Internal('LEDGER_BAD_EVENT', 'eventType is required');
  if (!e.payload || typeof e.payload !== 'object') {
    throw Internal('LEDGER_BAD_EVENT', 'payload must be an object');
  }

  return enqueue(async () => {
    const holder = await acquireLock();
    try {
      // Timestamp is server-authoritative (ADR-007). A client-asserted time, if any,
      // travels inside the payload where it is evidence rather than chain input.
      const occurredAt = new Date();
      const payloadHash = computePayloadHash(e.payload);

      // Bounded retry: a duplicate key here means another writer beat us despite the
      // lock (e.g. a lease expired under load). Recomputing from a fresh tail is correct.
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const seq = await Counter.next(LEDGER_SEQ_COUNTER);

        const prev = await Ledger.findOne({ seq: seq - 1 }, { entryHash: 1 }).lean();
        if (seq > 1 && !prev) {
          // The predecessor is missing. Two very different causes, and treating them
          // the same permanently wedged the ledger:
          //
          //   (a) a concurrent writer has allocated seq-1 and not yet committed it —
          //       transient, and backing off is right;
          //   (b) seq-1 was ALLOCATED AND NEVER WRITTEN, because a previous append
          //       threw a non-duplicate error (a validation failure, a dropped
          //       connection mid-insert) after Counter.next() had already advanced.
          //
          // In case (b) the gap never heals. Every later append allocates seq+1,
          // finds no predecessor, retries five times — burning five MORE counter
          // values each time — and fails with LEDGER_APPEND_FAILED. Since every write
          // path in the system appends to the ledger, the whole system stops
          // accepting writes, permanently, from one transient insert error.
          //
          // So: reconcile against the real tail instead of trusting the counter. The
          // ledger itself is the authority on what has been written.
          const tail = await Ledger.findOne({}, { seq: 1 }).sort({ seq: -1 }).lean();
          const trueNext = (tail?.seq ?? 0) + 1;
          if (trueNext < seq) {
            log.warn(
              { allocated: seq, trueNext },
              'ledger counter ran ahead of the chain; reconciling to the real tail'
            );
            await Counter.reset(LEDGER_SEQ_COUNTER, tail?.seq ?? 0);
            lastErr = new Error(`counter ahead of tail (allocated ${seq}, tail ${tail?.seq ?? 0})`);
            continue;
          }
          lastErr = new Error(`predecessor seq=${seq - 1} not found`);
          await sleep(10);
          continue;
        }
        const prevHash = seq === 1 ? GENESIS_HASH : prev.entryHash;
        const entryHash = computeEntryHash({ seq, prevHash, payloadHash, occurredAt });

        try {
          const [doc] = await Ledger.create(
            [
              {
                seq,
                eventId: crypto.randomUUID(),
                eventType: e.eventType,
                caseId: e.caseId ?? null,
                subjectId: e.subjectId ?? null,
                subjectType: e.subjectType ?? null,
                actorUserId: e.actorUserId ?? null,
                actorRole: e.actorRole ?? null,
                payload: e.payload,
                payloadHash,
                prevHash,
                entryHash,
                actorSignature: e.actorSignature ?? null,
                actorPubKeyFingerprint: e.actorPubKeyFingerprint ?? null,
                occurredAt,
                recordedAt: new Date(),
              },
            ],
            { ordered: true }
          );
          return doc;
        } catch (err) {
          if (err?.code === 11000) {
            lastErr = err;
            continue; // seq or entryHash taken; allocate a fresh one
          }
          throw err;
        }
      }
      throw Internal('LEDGER_APPEND_FAILED', `Ledger append failed: ${lastErr?.message ?? 'unknown'}`);
    } finally {
      await releaseLock(holder);
    }
  });
}

// ---------------------------------------------------------------- verification ----

/**
 * Walk the chain and recompute every hash.
 *
 * Reports the FIRST break and why. Distinguishing "the payload was edited" from
 * "the link was rewritten" from "an entry is missing" is what makes the output
 * actionable rather than merely alarming.
 *
 * @param {object} [opts]
 * @param {number} [opts.from=1]
 * @param {number} [opts.to]
 * @returns {Promise<{intact:boolean, checked:number, brokenAtSeq:number|null, reason:string|null, firstSeq:number|null, lastSeq:number|null}>}
 */
export async function verifyChain({ from = 1, to } = {}) {
  const query = { seq: { $gte: from } };
  if (Number.isFinite(to)) query.seq.$lte = to;

  const cursor = Ledger.find(query).sort({ seq: 1 }).lean().cursor();

  let expectedSeq = from;
  let prevHash = null;
  let checked = 0;
  let firstSeq = null;
  let lastSeq = null;

  for await (const entry of cursor) {
    if (firstSeq === null) {
      firstSeq = entry.seq;
      // Anchor the walk: from the true start we know prevHash; mid-chain we adopt
      // the entry's own claim and verify every link after it.
      prevHash = entry.seq === 1 ? GENESIS_HASH : entry.prevHash;
      expectedSeq = entry.seq;
    }

    if (entry.seq !== expectedSeq) {
      return {
        intact: false,
        checked,
        brokenAtSeq: expectedSeq,
        reason: `SEQUENCE_GAP: expected seq ${expectedSeq}, found ${entry.seq}`,
        firstSeq,
        lastSeq,
      };
    }

    if (entry.prevHash !== prevHash) {
      return {
        intact: false,
        checked,
        brokenAtSeq: entry.seq,
        reason: 'PREV_HASH_MISMATCH: this entry does not link to its predecessor',
        firstSeq,
        lastSeq,
      };
    }

    const payloadHash = computePayloadHash(entry.payload);
    if (payloadHash !== entry.payloadHash) {
      return {
        intact: false,
        checked,
        brokenAtSeq: entry.seq,
        reason: 'PAYLOAD_HASH_MISMATCH: the stored payload no longer matches its hash',
        firstSeq,
        lastSeq,
      };
    }

    const entryHash = computeEntryHash({
      seq: entry.seq,
      prevHash: entry.prevHash,
      payloadHash: entry.payloadHash,
      occurredAt: entry.occurredAt,
    });
    if (entryHash !== entry.entryHash) {
      return {
        intact: false,
        checked,
        brokenAtSeq: entry.seq,
        reason: 'ENTRY_HASH_MISMATCH: the entry hash does not match its own fields',
        firstSeq,
        lastSeq,
      };
    }

    prevHash = entry.entryHash;
    lastSeq = entry.seq;
    expectedSeq = entry.seq + 1;
    checked += 1;
  }

  return { intact: true, checked, brokenAtSeq: null, reason: null, firstSeq, lastSeq };
}

/** Chain events for one case, oldest first. */
export const getCaseTimeline = (caseId, { limit = 500 } = {}) =>
  Ledger.find({ caseId }).sort({ seq: 1 }).limit(limit).lean();

/** Chain events for one subject (an exhibit, a custody item), oldest first. */
export const getSubjectTimeline = (subjectId, { limit = 500 } = {}) =>
  Ledger.find({ subjectId }).sort({ seq: 1 }).limit(limit).lean();

/** Entries not yet included in an anchor batch, in sequence order. */
export const getUnanchored = (limit) =>
  Ledger.find({ anchorBatchId: null }).sort({ seq: 1 }).limit(limit).lean();

/**
 * Stamp a set of entries with their anchor batch id.
 *
 * This is the ONLY sanctioned mutation of an existing ledger row, and the only place
 * in the codebase that writes to the ledger collection through the raw driver. It
 * deliberately bypasses the Mongoose guards, which is why it is confined to this one
 * function rather than exposed as an option other code could pass.
 *
 * It touches exactly one field, only on entries that are not yet anchored, and it
 * cannot alter any hash — so the chain remains verifiable across the operation.
 */
export async function stampAnchorBatch(seqs, batchId) {
  if (!Array.isArray(seqs) || seqs.length === 0) return { modifiedCount: 0 };
  if (typeof batchId !== 'string' || !batchId) {
    throw Internal('LEDGER_BAD_BATCH_ID', 'batchId must be a non-empty string');
  }
  if (!seqs.every((s) => Number.isInteger(s))) {
    throw Internal('LEDGER_BAD_SEQ', 'seqs must all be integers');
  }

  const res = await Ledger.collection.updateMany(
    { seq: { $in: seqs }, anchorBatchId: null },
    { $set: { anchorBatchId: batchId } }
  );
  return { modifiedCount: res.modifiedCount };
}

export const getHead = () => Ledger.findOne().sort({ seq: -1 }).lean();

/** Test-only: reset the in-process queue between suites. */
export const __resetQueue = () => {
  queue = Promise.resolve();
};

export default { appendEvent, verifyChain, getCaseTimeline, getUnanchored, stampAnchorBatch };
