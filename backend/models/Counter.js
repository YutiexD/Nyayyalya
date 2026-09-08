/**
 * Atomic sequence allocator (ADR-006).
 *
 * The ledger's `seq` must be strictly increasing with no duplicates under
 * concurrency. Reading `max(seq)+1` races: two concurrent appends read the same
 * maximum and both try to claim it.
 *
 * `findOneAndUpdate` with `$inc` is atomic at the document level in MongoDB, so
 * every caller gets a distinct value even across processes. The unique index on
 * `Ledger.seq` remains the backstop.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

const CounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    value: { type: Number, required: true, default: 0 },
  },
  { collection: 'counters', versionKey: false }
);

/**
 * Atomically reserve the next value for a named counter.
 * @param {string} name
 * @param {object} [session] optional mongoose session
 * @returns {Promise<number>} a value no other caller will receive
 */
CounterSchema.statics.next = async function next(name, session) {
  const doc = await this.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { new: true, upsert: true, session, setDefaultsOnInsert: true }
  ).lean();
  return doc.value;
};

/**
 * Wind a counter back to a known-good value.
 *
 * Only one caller has any business doing this: the ledger's append loop, when it finds
 * the counter has run AHEAD of the chain because a value was allocated and then never
 * written (a non-duplicate insert error after Counter.next() had already advanced).
 * Left alone, that gap makes every subsequent append fail its predecessor check
 * forever — see services/ledger.js.
 *
 * Guarded so it can only ever move a counter DOWN, and only to a value the caller has
 * actually observed in the collection. A reset that could raise a counter would be a
 * way to re-issue sequence numbers that are already in use, which is the opposite of
 * what this exists for.
 */
CounterSchema.statics.reset = async function reset(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError('Counter.reset: value must be a non-negative integer');
  }
  const doc = await this.findOneAndUpdate(
    { _id: name, value: { $gt: value } },
    { $set: { value } },
    { new: true }
  ).lean();
  return doc?.value ?? null;
};

/** Current value without consuming one. For diagnostics only. */
CounterSchema.statics.peek = async function peek(name) {
  const doc = await this.findById(name).lean();
  return doc?.value ?? 0;
};

export const Counter = mongoose.model('Counter', CounterSchema);
export default Counter;
