/**
 * Ledger integrity: chaining, concurrency, tamper detection and immutability.
 *
 * These tests attack the ledger directly at the database level — exactly what an
 * attacker with a stolen Mongo credential would do — because the API-level guards
 * are not the property being tested here. The property is: *if history is altered,
 * verification notices*.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startTestDb, clearTestDb, stopTestDb } from '../helpers/db.js';
import { Ledger } from '../../models/Ledger.js';
import { Counter } from '../../models/Counter.js';
import {
  appendEvent,
  verifyChain,
  computeEntryHash,
  computePayloadHash,
  stampAnchorBatch,
  GENESIS_HASH,
} from '../../services/ledger.js';
import { LEDGER_EVENT, SUBJECT_TYPE } from '../../models/enums.js';

beforeAll(async () => {
  await startTestDb();
});
afterAll(async () => {
  await stopTestDb();
});
beforeEach(async () => {
  await clearTestDb();
});

const append = (n) =>
  appendEvent({
    eventType: LEDGER_EVENT.CASE_CREATED,
    subjectType: SUBJECT_TYPE.CASE,
    payload: { n, note: `event ${n}` },
  });

describe('ledger append and chaining', () => {
  it('starts the chain at seq 1 with the genesis prevHash', async () => {
    const entry = await append(1);
    expect(entry.seq).toBe(1);
    expect(entry.prevHash).toBe(GENESIS_HASH);
    expect(entry.entryHash).toHaveLength(64);
  });

  it('links each entry to its predecessor', async () => {
    const a = await append(1);
    const b = await append(2);
    const c = await append(3);
    expect(b.prevHash).toBe(a.entryHash);
    expect(c.prevHash).toBe(b.entryHash);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });

  it('computes entryHash from exactly its own fields', async () => {
    const e = await append(1);
    expect(
      computeEntryHash({
        seq: e.seq,
        prevHash: e.prevHash,
        payloadHash: e.payloadHash,
        occurredAt: e.occurredAt,
      })
    ).toBe(e.entryHash);
  });

  it('sets occurredAt server-side, ignoring any client-supplied time', async () => {
    const before = Date.now();
    const e = await appendEvent({
      eventType: LEDGER_EVENT.CASE_CREATED,
      // A client asserting it happened in 1999 must not steer the chain input.
      payload: { clientOccurredAt: '1999-01-01T00:00:00.000Z' },
    });
    expect(e.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(e.payload.clientOccurredAt).toBe('1999-01-01T00:00:00.000Z');
  });
});

describe('ledger concurrency (ADR-006)', () => {
  it('produces a gapless, correctly-linked chain under parallel appends', async () => {
    const N = 40;
    await Promise.all(Array.from({ length: N }, (_, i) => append(i)));

    const entries = await Ledger.find().sort({ seq: 1 }).lean();
    expect(entries).toHaveLength(N);

    // Strictly increasing with no gaps.
    entries.forEach((e, i) => expect(e.seq).toBe(i + 1));

    // Every link holds.
    let prev = GENESIS_HASH;
    for (const e of entries) {
      expect(e.prevHash).toBe(prev);
      prev = e.entryHash;
    }

    const result = await verifyChain();
    expect(result.intact).toBe(true);
    expect(result.checked).toBe(N);
  });

  it('never issues a duplicate sequence number from the counter', async () => {
    const values = await Promise.all(Array.from({ length: 100 }, () => Counter.next('t')));
    expect(new Set(values).size).toBe(100);
  });
});

describe('ledger verification detects tampering', () => {
  it('reports CHAIN_INTACT for an untouched chain', async () => {
    for (let i = 0; i < 5; i += 1) await append(i);
    const r = await verifyChain();
    expect(r.intact).toBe(true);
    expect(r.brokenAtSeq).toBeNull();
  });

  it('detects an edited payload at the right sequence', async () => {
    for (let i = 0; i < 5; i += 1) await append(i);

    // Bypass the model guards entirely — raw driver write, as an attacker would.
    await mongoose.connection
      .collection('ledger')
      .updateOne({ seq: 3 }, { $set: { 'payload.note': 'tampered' } });

    const r = await verifyChain();
    expect(r.intact).toBe(false);
    expect(r.brokenAtSeq).toBe(3);
    expect(r.reason).toMatch(/PAYLOAD_HASH_MISMATCH/);
  });

  it('detects a rewritten prevHash link', async () => {
    for (let i = 0; i < 4; i += 1) await append(i);
    await mongoose.connection
      .collection('ledger')
      .updateOne({ seq: 3 }, { $set: { prevHash: 'f'.repeat(64) } });

    const r = await verifyChain();
    expect(r.intact).toBe(false);
    expect(r.brokenAtSeq).toBe(3);
    expect(r.reason).toMatch(/PREV_HASH_MISMATCH/);
  });

  it('detects a deleted entry as a sequence gap', async () => {
    for (let i = 0; i < 5; i += 1) await append(i);
    await mongoose.connection.collection('ledger').deleteOne({ seq: 3 });

    const r = await verifyChain();
    expect(r.intact).toBe(false);
    expect(r.brokenAtSeq).toBe(3);
    expect(r.reason).toMatch(/SEQUENCE_GAP/);
  });

  it('detects a forged entry inserted with a self-consistent but unlinked hash', async () => {
    for (let i = 0; i < 3; i += 1) await append(i);

    // A careful attacker recomputes the entry's own hash so it is internally
    // consistent — but they cannot make it link to the real predecessor.
    const payload = { n: 99, note: 'inserted by attacker' };
    const payloadHash = computePayloadHash(payload);
    const occurredAt = new Date();
    const prevHash = 'a'.repeat(64);
    await mongoose.connection.collection('ledger').insertOne({
      seq: 4,
      eventId: 'forged-0001',
      eventType: LEDGER_EVENT.JUDICIAL_ORDER,
      payload,
      payloadHash,
      prevHash,
      entryHash: computeEntryHash({ seq: 4, prevHash, payloadHash, occurredAt }),
      occurredAt,
      recordedAt: new Date(),
      anchorBatchId: null,
    });

    const r = await verifyChain();
    expect(r.intact).toBe(false);
    expect(r.brokenAtSeq).toBe(4);
    expect(r.reason).toMatch(/PREV_HASH_MISMATCH/);
  });

  it('detects a tampered entryHash', async () => {
    for (let i = 0; i < 3; i += 1) await append(i);
    await mongoose.connection
      .collection('ledger')
      .updateOne({ seq: 2 }, { $set: { entryHash: 'b'.repeat(64) } });

    const r = await verifyChain();
    expect(r.intact).toBe(false);
    expect(r.brokenAtSeq).toBe(2);
    expect(r.reason).toMatch(/ENTRY_HASH_MISMATCH/);
  });

  it('treats an empty ledger as intact', async () => {
    const r = await verifyChain();
    expect(r.intact).toBe(true);
    expect(r.checked).toBe(0);
  });
});

describe('ledger immutability guards (defence in depth)', () => {
  it('refuses updateOne', async () => {
    await append(1);
    await expect(Ledger.updateOne({ seq: 1 }, { $set: { eventType: 'X' } })).rejects.toThrow(
      /append-only/i
    );
  });

  it('refuses findOneAndUpdate', async () => {
    await append(1);
    await expect(
      Ledger.findOneAndUpdate({ seq: 1 }, { $set: { payload: {} } })
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses deleteOne and deleteMany', async () => {
    await append(1);
    await expect(Ledger.deleteOne({ seq: 1 })).rejects.toThrow(/append-only/i);
    await expect(Ledger.deleteMany({})).rejects.toThrow(/append-only/i);
  });

  it('refuses insertMany, because chaining must be serial', async () => {
    await expect(
      Ledger.insertMany([{ seq: 900, eventType: LEDGER_EVENT.CASE_CREATED }])
    ).rejects.toThrow(/append-only|serial/i);
  });

  it('refuses re-saving a loaded document', async () => {
    await append(1);
    const doc = await Ledger.findOne({ seq: 1 });
    doc.eventType = LEDGER_EVENT.JUDICIAL_ORDER;
    // Refused by the schema's `immutable` field validation, which fires ahead of the
    // pre-save guard. Either layer stopping it is the property we want.
    await expect(doc.save()).rejects.toThrow(/append-only|immutable/i);
  });

  it('refuses re-saving even a mutable-looking field on an existing entry', async () => {
    await append(1);
    const doc = await Ledger.findOne({ seq: 1 });
    doc.anchorBatchId = 'sneaky';
    await expect(doc.save()).rejects.toThrow(/append-only/i);
  });

  it('refuses an updateMany that smuggles extra fields alongside anchorBatchId', async () => {
    await append(1);
    // The anchor stamp is the one sanctioned mutation; it must not become a
    // general-purpose write primitive.
    await expect(
      Ledger.updateMany({ seq: 1 }, { $set: { anchorBatchId: 'b1', eventType: 'X' } })
    ).rejects.toThrow(/append-only/i);
  });

  it('allows the sanctioned anchor stamp', async () => {
    await append(1);
    await append(2);
    const res = await stampAnchorBatch([1, 2], '0xbatch');
    expect(res.modifiedCount).toBe(2);

    const entries = await Ledger.find().sort({ seq: 1 }).lean();
    expect(entries.every((e) => e.anchorBatchId === '0xbatch')).toBe(true);

    // Stamping must not disturb the chain.
    expect((await verifyChain()).intact).toBe(true);
  });
});
