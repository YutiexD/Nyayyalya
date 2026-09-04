/**
 * The append-only ledger. This is the tamper-evidence layer that every other
 * guarantee in the system leans on.
 *
 * Immutability is enforced at THREE levels, deliberately redundant:
 *   1. No update/delete route exists in the API.
 *   2. Mongoose middleware below throws on every mutating operation.
 *   3. `entryHash` chains each entry to its predecessor, so a write that bypasses
 *      layers 1 and 2 (e.g. direct `mongosh` access) still breaks verification.
 *
 * Layer 3 is the one that actually matters. Layers 1 and 2 stop mistakes;
 * layer 3 is what makes tampering *detectable* rather than merely inconvenient.
 */
import mongoose from 'mongoose';
import { LEDGER_EVENT, SUBJECT_TYPE, values } from './enums.js';

const { Schema } = mongoose;

const LedgerSchema = new Schema(
  {
    /** Strictly increasing, globally unique. Allocated atomically — see services/ledger.js */
    seq: { type: Number, required: true, unique: true, immutable: true },

    eventId: { type: String, required: true, unique: true, immutable: true },

    eventType: {
      type: String,
      required: true,
      enum: values(LEDGER_EVENT),
      immutable: true,
    },

    caseId: { type: Schema.Types.ObjectId, ref: 'Case', index: true, immutable: true },
    subjectId: { type: Schema.Types.ObjectId, immutable: true },
    subjectType: { type: String, enum: values(SUBJECT_TYPE), immutable: true },

    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', immutable: true },
    actorRole: { type: String, immutable: true },

    /** Canonicalised event body. Hashed into payloadHash; never mutated. */
    payload: { type: Schema.Types.Mixed, required: true, immutable: true },

    payloadHash: { type: String, required: true, immutable: true },
    prevHash: { type: String, required: true, immutable: true },
    entryHash: { type: String, required: true, unique: true, immutable: true },

    /** Client ECDSA signature over entryHash, when the actor signed the action. */
    actorSignature: { type: String, immutable: true },
    actorPubKeyFingerprint: { type: String, immutable: true },

    /** Server-authoritative (ADR-007). Client-asserted times live in payload. */
    occurredAt: { type: Date, required: true, immutable: true },
    recordedAt: { type: Date, required: true, default: Date.now, immutable: true },

    /**
     * Set exactly once, when the entry is included in an anchored Merkle batch.
     * This is the single field permitted to change after insert, and it is applied
     * through `services/ledger.js` only — see the guard below.
     */
    anchorBatchId: { type: String, default: null, index: true },
  },
  {
    collection: 'ledger',
    versionKey: false,
    // Any write not going through our own code path is a bug we want to hear about.
    strict: 'throw',
  }
);

LedgerSchema.index({ caseId: 1, seq: 1 });
LedgerSchema.index({ subjectId: 1, seq: 1 });
LedgerSchema.index({ eventType: 1, seq: 1 });
// Partial index: the anchor batcher only ever scans un-anchored entries.
LedgerSchema.index(
  { seq: 1 },
  { name: 'unanchored_seq', partialFilterExpression: { anchorBatchId: null } }
);

// ------------------------------------------------------------------ immutability ----

class LedgerImmutableError extends Error {
  constructor(op) {
    super(
      `Ledger is append-only: '${op}' is not permitted. ` +
        'Record a compensating event instead of altering history.'
    );
    this.name = 'LedgerImmutableError';
    this.code = 'LEDGER_IMMUTABLE';
    this.status = 500;
  }
}

/**
 * The guard is absolute: every mutating Mongoose operation on this model is refused,
 * with no exception path.
 *
 * The anchor batcher does legitimately need to stamp `anchorBatchId` on existing
 * rows. An earlier draft carved out an exception here, keyed on a query option — but
 * an exception inside the guard is exactly the thing an attacker looks for, and
 * "is this update *really* only touching one field?" is fiddly logic to get right in
 * the place where being wrong is most expensive.
 *
 * Instead that one mutation goes through the raw driver in `services/ledger.js`
 * (`stampAnchorBatch`), which is a single, greppable, auditable function. The guard
 * here stays trivially correct: no Mongoose write to the ledger, ever.
 */
const BLOCKED_QUERY_OPS = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findByIdAndUpdate',
  'findByIdAndDelete',
];

for (const op of BLOCKED_QUERY_OPS) {
  LedgerSchema.pre(op, function guard(next) {
    next(new LedgerImmutableError(op));
  });
}

// Document-level deletes and re-saves.
LedgerSchema.pre('deleteOne', { document: true, query: false }, function guard(next) {
  next(new LedgerImmutableError('document.deleteOne'));
});
LedgerSchema.pre('remove', { document: true, query: false }, function guard(next) {
  next(new LedgerImmutableError('document.remove'));
});
LedgerSchema.pre('save', function guard(next) {
  if (this.isNew) return next();
  // Re-saving an existing ledger document is never legitimate.
  const changed = this.modifiedPaths();
  return next(new LedgerImmutableError(`document.save (modified: ${changed.join(',') || 'none'})`));
});

// Bulk paths bypass the hooks above, so they are refused outright.
LedgerSchema.pre('bulkWrite', function guard(next) {
  next(new LedgerImmutableError('bulkWrite'));
});
LedgerSchema.pre('insertMany', function guard(next) {
  // Batch inserts would break sequential hash chaining, which must be strictly serial.
  next(new LedgerImmutableError('insertMany (chaining must be serial)'));
});

LedgerSchema.statics.LedgerImmutableError = LedgerImmutableError;

export const Ledger = mongoose.model('Ledger', LedgerSchema);
export { LedgerImmutableError };
export default Ledger;
