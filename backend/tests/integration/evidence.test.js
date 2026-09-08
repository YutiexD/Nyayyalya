/**
 * Evidence integrity, end to end.
 *
 * Covers demo beats 3 and 5: a real upload with a browser-computed hash and a real
 * ECDSA signature, then a deliberate tamper of the stored bytes and the verification
 * that catches it.
 *
 * The tamper is performed by writing to the vault file directly — exactly what
 * `echo "x" >> vault/<hash>` does on stage — because the property under test is
 * "we detect modification we did not make", and modifying through our own API
 * would not test that at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Evidence } from '../../models/Evidence.js';
import { Ledger } from '../../models/Ledger.js';
import { Case } from '../../models/Case.js';
import { createApp } from '../../app.js';
import { activateUser, makeBrowserKeyPair } from '../helpers/client.js';
import { resolveObjectPath } from '../../services/storage.js';
import { verifyChain } from '../../services/ledger.js';
import { runAnchorCycle } from '../../services/anchor.js';
import { AnchorBatch } from '../../models/AnchorBatch.js';
import {
  FILE_INTEGRITY,
  CHAIN_INTEGRITY,
  LEDGER_EVENT,
  TRIAGE_DISCLAIMER,
  ANCHOR_STATUS,
} from '../../models/enums.js';

let mongo;
let server;
let io;
let caseId;

/** A real JPEG: magic bytes matter, because the server sniffs the content. */
const jpegBytes = (marker = 'demo') =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
    Buffer.from(marker.padEnd(64, ' ')),
    Buffer.from([0xff, 0xd9]),
  ]);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await startDirectories(uri);
  await mongoose.connect(uri, { dbName: 'lexx_test_evidence', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();
  server = createApp();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
  await fsp.rm('./.data/test-vault', { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  io = await activateUser(server, 'UP-GZB-4471');

  const res = await request(server)
    .post('/api/cases/from-fir')
    .set('Authorization', `Bearer ${io.accessToken}`)
    .send({ firNumber: '0123/2026' });
  if (res.status !== 201) throw new Error(`case creation failed: ${JSON.stringify(res.body)}`);
  caseId = res.body.case._id;
});

/** Upload as the browser would: hash locally, sign the hash, send both. */
async function upload(bytes, overrides = {}) {
  const hash = overrides.sha256Client ?? sha256(bytes);
  const signature = overrides.signature ?? io.keys.sign(hash);

  const req = request(server)
    .post('/api/evidence/upload')
    .set('Authorization', `Bearer ${io.accessToken}`)
    .field('caseId', overrides.caseId ?? caseId)
    .field('title', overrides.title ?? 'CCTV still')
    .field('sha256Client', hash)
    .field('signature', signature)
    .field('sourceType', overrides.sourceType ?? 'MOBILE')
    .field('make', 'Samsung')
    .field('model', 'A54');

  if (overrides.metadata) req.field('metadata', overrides.metadata);

  return req.attach('file', bytes, {
    filename: overrides.filename ?? 'still.jpg',
    contentType: overrides.contentType ?? 'image/jpeg',
  });
}

// ============================================================ BEAT 3: upload ==

describe('evidence upload — browser hash + signature verified server-side', () => {
  it('accepts a genuine upload and returns a receipt', async () => {
    const bytes = jpegBytes('genuine');
    const res = await upload(bytes);

    expect(res.status).toBe(201);
    expect(res.body.evidence.sha256Server).toBe(sha256(bytes));
    expect(res.body.evidence.sha256Client).toBe(sha256(bytes));
    expect(res.body.evidence.hashMatchedOnIngest).toBe(true);
    expect(res.body.evidence.signatureValidOnIngest).toBe(true);
    expect(res.body.evidence.exhibitCode).toMatch(/^EX-/);

    // The officer's independent copy — a check on this whole system.
    expect(res.body.receipt.sha256).toBe(sha256(bytes));
    expect(res.body.receipt.ledgerSeq).toBeGreaterThan(0);
    expect(res.body.receipt.entryHash).toHaveLength(64);
    expect(res.body.receipt.receiptHash).toHaveLength(64);
    expect(res.body.receipt.anchorNetwork).toBe('monad-testnet');
  });

  it('never returns key material to the client', async () => {
    const res = await upload(jpegBytes('keys'));
    expect(res.body.evidence.encryption).toBeUndefined();
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/wrappedDek|wrapTag|kekId/);
  });

  it('stores the file ENCRYPTED — plaintext must not be on disk', async () => {
    const marker = 'SECRET-WITNESS-MARKER';
    const res = await upload(jpegBytes(marker));
    const stored = await Evidence.findById(res.body.evidence._id).lean();

    const onDisk = await fsp.readFile(resolveObjectPath(stored.storageKey));
    expect(onDisk.includes(marker)).toBe(false);
    expect(onDisk.equals(jpegBytes(marker))).toBe(false);
  });

  it('writes EVIDENCE_UPLOADED to the ledger and keeps the chain intact', async () => {
    const res = await upload(jpegBytes('ledger'));
    const entry = await Ledger.findOne({ seq: res.body.receipt.ledgerSeq }).lean();

    expect(entry.eventType).toBe(LEDGER_EVENT.EVIDENCE_UPLOADED);
    expect(entry.payload.sha256).toBe(res.body.evidence.sha256Server);
    expect(entry.actorSignature).toBeTruthy();
    expect((await verifyChain()).intact).toBe(true);
  });

  it('attaches triage as REVIEW PRIORITY with the statutory disclaimer', async () => {
    const res = await upload(jpegBytes('triage'));
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(res.body.evidence.triage.priority);
    expect(res.body.evidence.triage.disclaimer).toBe(TRIAGE_DISCLAIMER);

    // Never a verdict, never a score.
    const t = JSON.stringify(res.body.evidence.triage).toUpperCase();
    expect(t).not.toMatch(/AUTHENTIC|MANIPULATED|VERIFIED/);
    expect(t).not.toMatch(/\d+(\.\d+)?%/);
  });

  it('gives two exhibits distinct codes and distinct storage keys', async () => {
    const a = await upload(jpegBytes('one'));
    const b = await upload(jpegBytes('two'));
    expect(a.body.evidence.exhibitCode).not.toBe(b.body.evidence.exhibitCode);
    expect(a.body.evidence.storageKey).not.toBe(b.body.evidence.storageKey);
  });

  it('keeps byte-identical files in different records independently decryptable (ADR-009)', async () => {
    const bytes = jpegBytes('identical');
    const a = await upload(bytes);
    const b = await upload(bytes);

    // Same plaintext hash — that is the integrity identity, and it is expected.
    expect(a.body.evidence.sha256Server).toBe(b.body.evidence.sha256Server);
    // Different stored objects, so neither overwrites the other.
    expect(a.body.evidence.storageKey).not.toBe(b.body.evidence.storageKey);

    for (const id of [a.body.evidence._id, b.body.evidence._id]) {
      const v = await request(server)
        .post(`/api/evidence/${id}/verify`)
        .set('Authorization', `Bearer ${io.accessToken}`);
      expect(v.body.fileIntegrity).toBe(FILE_INTEGRITY.FILE_INTACT);
    }
  });
});

// =========================================================== ingest refusals ==

describe('evidence upload refuses bad input and records the attempt', () => {
  it('rejects a client/server hash mismatch and logs INTEGRITY_EXCEPTION', async () => {
    const res = await upload(jpegBytes('real'), { sha256Client: 'f'.repeat(64) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HASH_MISMATCH');

    const exception = await Ledger.findOne({
      eventType: LEDGER_EVENT.INTEGRITY_EXCEPTION,
    }).lean();
    expect(exception).toBeTruthy();
    expect(exception.payload.reason).toBe('CLIENT_SERVER_HASH_MISMATCH');

    expect(await Evidence.countDocuments()).toBe(0);
  });

  it('rejects a forged signature and logs it', async () => {
    const bytes = jpegBytes('forge');
    const attacker = (await import('../helpers/client.js')).makeBrowserKeyPair();
    const res = await upload(bytes, { signature: attacker.sign(sha256(bytes)) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');

    const exception = await Ledger.findOne({ 'payload.reason': 'SIGNATURE_INVALID' }).lean();
    expect(exception).toBeTruthy();
    expect(await Evidence.countDocuments()).toBe(0);
  });

  it('rejects a signature over a DIFFERENT hash', async () => {
    const bytes = jpegBytes('mismatch');
    const res = await upload(bytes, { signature: io.keys.sign('0'.repeat(64)) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');
  });

  it('rejects a disallowed MIME type', async () => {
    const res = await upload(Buffer.from('MZ\x90\x00binary'), {
      filename: 'evil.exe',
      contentType: 'application/x-msdownload',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MIME_TYPE_NOT_ALLOWED');
  });

  it('rejects MIME spoofing — an executable labelled as a JPEG', async () => {
    // The declared type is allowed, but the bytes say otherwise.
    const res = await upload(Buffer.from('MZ\x90\x00this is a PE binary'), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MIME_TYPE_MISMATCH');
  });

  it('rejects a malformed signature and a malformed hash', async () => {
    expect((await upload(jpegBytes('a'), { signature: 'not-hex' })).status).toBe(400);
    expect((await upload(jpegBytes('b'), { sha256Client: 'short' })).status).toBe(400);
  });

  it('rejects an upload to a case the officer is not on', async () => {
    const other = await Case.create({
      firNumber: '0999/2026',
      firDate: new Date(),
      title: 'Another station',
      stationCode: 'UP-GZB-OTHER',
      districtCode: 'UP-GZB',
      stateCode: 'UP',
      maxPunishmentYears: 3,
      ioUserId: new mongoose.Types.ObjectId(),
      ioAuthorityId: 'UP-GZB-0000',
      createdBy: new mongoose.Types.ObjectId(),
    });

    const res = await upload(jpegBytes('x'), { caseId: String(other._id) });
    expect(res.status).toBe(403);
    expect(await Evidence.countDocuments()).toBe(0);
  });
});

// ============================================== BEAT 5: the tamper detection ==

describe('BEAT 5 — tamper the stored file, watch the right light go red', () => {
  it('reports FILE_INTACT + CHAIN_INTACT before any tampering', async () => {
    const up = await upload(jpegBytes('clean'));
    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.fileIntegrity).toBe(FILE_INTEGRITY.FILE_INTACT);
    expect(res.body.signatureValid).toBe(true);
    expect(res.body.chainIntegrity).toBe(CHAIN_INTEGRITY.CHAIN_INTACT);
    expect(res.body.recomputedSha256).toBe(res.body.expectedSha256);
  });

  it('reports FILE_MODIFIED while the LEDGER STAYS GREEN', async () => {
    const up = await upload(jpegBytes('target'));
    const stored = await Evidence.findById(up.body.evidence._id).lean();

    // The stage move: append a byte to the vault object from outside the system.
    fs.appendFileSync(resolveObjectPath(stored.storageKey), 'x');

    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(res.body.fileIntegrity).toBe(FILE_INTEGRITY.FILE_MODIFIED);
    // The nuance that matters: the file was touched, not the log.
    expect(res.body.chainIntegrity).toBe(CHAIN_INTEGRITY.CHAIN_INTACT);
    expect(res.body.interpretation).toMatch(/FILE was touched, not the log/i);
  });

  it('detects a wholesale file replacement', async () => {
    const up = await upload(jpegBytes('original'));
    const stored = await Evidence.findById(up.body.evidence._id).lean();

    fs.writeFileSync(resolveObjectPath(stored.storageKey), jpegBytes('substituted'));

    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);
    expect(res.body.fileIntegrity).toBe(FILE_INTEGRITY.FILE_MODIFIED);
  });

  it('detects a deleted stored object without losing the recorded hash', async () => {
    const up = await upload(jpegBytes('deleteme'));
    const stored = await Evidence.findById(up.body.evidence._id).lean();
    fs.unlinkSync(resolveObjectPath(stored.storageKey));

    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(res.body.fileIntegrity).toBe(FILE_INTEGRITY.FILE_MISSING);
    expect(res.body.expectedSha256).toBe(stored.sha256Server);
    expect(res.body.chainIntegrity).toBe(CHAIN_INTEGRITY.CHAIN_INTACT);
  });

  it('reports CHAIN_BROKEN with the exact sequence when the LEDGER is tampered', async () => {
    const up = await upload(jpegBytes('chain'));

    // Attack the log itself, bypassing every model guard, as a DB-level attacker would.
    const entry = await Ledger.findOne({ seq: up.body.receipt.ledgerSeq }).lean();
    await mongoose.connection
      .collection('ledger')
      .updateOne({ seq: entry.seq }, { $set: { 'payload.sha256': 'f'.repeat(64) } });

    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(res.body.chainIntegrity).toBe(CHAIN_INTEGRITY.CHAIN_BROKEN);
    expect(res.body.brokenAtSeq).toBe(entry.seq);
    expect(res.body.interpretation).toMatch(/escalate/i);
  });

  it('reports NOT_ANCHORED honestly when no batch has been anchored', async () => {
    const up = await upload(jpegBytes('unanchored'));
    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(res.body.anchorIntegrity).toBe('NOT_ANCHORED');
    expect(res.body.anchorNetwork).toBe('monad-testnet');
  });

  /**
   * REGRESSION — a DRY_RUN batch was reported as ANCHOR_MATCH.
   *
   * `verifyAnchorForEvidence` compared the root recomputed from the ledger against the
   * root stored in the batch and called agreement ANCHOR_MATCH. When the batch was
   * never submitted, both of those roots are ours: the check proves the ledger has not
   * been edited since we hashed it, and nothing else. The verifier UI rendered that as
   * a green light reading "equals the root published on chain" — a claim of
   * independent corroboration where no independent record existed.
   *
   * This deployment runs in DRY_RUN, so that was the state a demo actually showed.
   */
  it('reports ANCHOR_LOCAL_ONLY — not ANCHOR_MATCH — for a batch never submitted', async () => {
    const up = await upload(jpegBytes('dryrun'));
    const cycle = await runAnchorCycle();
    expect(cycle.batched).toBe(true);
    expect(cycle.batch.status).toBe(ANCHOR_STATUS.DRY_RUN);
    expect(cycle.batch.txHash ?? null).toBeNull();

    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.anchorIntegrity).toBe('ANCHOR_LOCAL_ONLY');
    expect(res.body.anchorSubmitted).toBe(false);
    expect(res.body.anchorBatchStatus).toBe(ANCHOR_STATUS.DRY_RUN);

    // The roots DO agree — which is exactly why this needed its own state rather than
    // a mismatch. The ledger is internally consistent; it is simply not anchored.
    expect(res.body.computedRoot).toBe(res.body.publishedRoot);
    expect(res.body.anchorTxHash ?? null).toBeNull();
    expect(res.body.anchorExplorerUrl ?? null).toBeNull();
  });

  it('reports ANCHOR_MATCH once the batch carries a transaction', async () => {
    const up = await upload(jpegBytes('confirmed'));
    const cycle = await runAnchorCycle();

    // What a real submission leaves behind: a tx hash and a CONFIRMED status.
    await AnchorBatch.updateOne(
      { batchId: cycle.batch.batchId },
      { $set: { txHash: `0x${'a'.repeat(64)}`, status: ANCHOR_STATUS.CONFIRMED } }
    );

    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(res.body.anchorIntegrity).toBe('ANCHOR_MATCH');
    expect(res.body.anchorSubmitted).toBe(true);
    expect(res.body.anchorExplorerUrl).toContain('0xaaaa');
  });

  it('still reports ANCHOR_MISMATCH when the ledger no longer produces the root', async () => {
    const up = await upload(jpegBytes('tampered-root'));
    const cycle = await runAnchorCycle();

    await AnchorBatch.updateOne(
      { batchId: cycle.batch.batchId },
      { $set: { txHash: `0x${'b'.repeat(64)}`, status: ANCHOR_STATUS.CONFIRMED } }
    );

    // Edit the ledger underneath it, at the database level, as an attacker with DB
    // access would. The stored root itself is immutable — the model guard refuses to
    // let it be rewritten — so the divergence has to come from the ledger side.
    const anchored = await Ledger.find({ anchorBatchId: cycle.batch.batchId })
      .sort({ seq: 1 })
      .lean();
    await mongoose.connection
      .collection('ledger')
      .updateOne({ seq: anchored[0].seq }, { $set: { entryHash: 'f'.repeat(64) } });

    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(res.body.anchorIntegrity).toBe('ANCHOR_MISMATCH');
    expect(res.body.computedRoot).not.toBe(res.body.publishedRoot);
  });

  it('a mismatch is a mismatch even in DRY_RUN — LOCAL_ONLY is not a catch-all', async () => {
    const up = await upload(jpegBytes('dryrun-mismatch'));
    const cycle = await runAnchorCycle();

    const anchored = await Ledger.find({ anchorBatchId: cycle.batch.batchId })
      .sort({ seq: 1 })
      .lean();
    await mongoose.connection
      .collection('ledger')
      .updateOne({ seq: anchored[0].seq }, { $set: { entryHash: 'e'.repeat(64) } });

    const res = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    // Unsubmitted, but broken: LOCAL_ONLY must never mask a divergence.
    expect(res.body.anchorIntegrity).toBe('ANCHOR_MISMATCH');
    expect(res.body.anchorSubmitted).toBe(false);
  });
});

// ================================================================ streaming ==

describe('evidence download tokens (ADR-010)', () => {
  const mintToken = async (evidenceId) =>
    request(server)
      .post(`/api/evidence/${evidenceId}/stream-token`)
      .set('Authorization', `Bearer ${io.accessToken}`);

  it('streams the ORIGINAL plaintext back with a valid token', async () => {
    const bytes = jpegBytes('roundtrip');
    const up = await upload(bytes);
    const { body } = await mintToken(up.body.evidence._id);

    const res = await request(server)
      .get(`/api/evidence/${up.body.evidence._id}/stream?token=${body.token}`)
      .set('Authorization', `Bearer ${io.accessToken}`)
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(bytes)).toBe(true);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses a REPLAYED token — single use', async () => {
    const up = await upload(jpegBytes('replay'));
    const { body } = await mintToken(up.body.evidence._id);
    const url = `/api/evidence/${up.body.evidence._id}/stream?token=${body.token}`;

    expect((await request(server).get(url).set('Authorization', `Bearer ${io.accessToken}`)).status).toBe(200);

    const replay = await request(server).get(url).set('Authorization', `Bearer ${io.accessToken}`);
    expect(replay.status).toBe(403);
  });

  it('refuses a missing or forged token', async () => {
    const up = await upload(jpegBytes('forged'));
    const id = up.body.evidence._id;

    expect(
      (await request(server).get(`/api/evidence/${id}/stream`).set('Authorization', `Bearer ${io.accessToken}`)).status
    ).toBe(403);
    expect(
      (await request(server)
        .get(`/api/evidence/${id}/stream?token=made-up-token`)
        .set('Authorization', `Bearer ${io.accessToken}`)).status
    ).toBe(403);
  });

  it("refuses a token minted for a DIFFERENT exhibit", async () => {
    const a = await upload(jpegBytes('a'));
    const b = await upload(jpegBytes('b'));
    const { body } = await mintToken(a.body.evidence._id);

    const res = await request(server)
      .get(`/api/evidence/${b.body.evidence._id}/stream?token=${body.token}`)
      .set('Authorization', `Bearer ${io.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('audits every download', async () => {
    const up = await upload(jpegBytes('audited'));
    const { body } = await mintToken(up.body.evidence._id);
    await request(server)
      .get(`/api/evidence/${up.body.evidence._id}/stream?token=${body.token}`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    const { AuditEvent } = await import('../../models/AuditEvent.js');
    const downloads = await AuditEvent.countDocuments({ action: 'DOWNLOAD' });
    expect(downloads).toBeGreaterThanOrEqual(1);
  });
});

// ================================================= key rotation and history ==

describe('signing-key rotation does not invalidate history', () => {
  it('keeps an old exhibit verifiable after the officer re-keys a new device', async () => {
    // The scenario: an officer loses their phone. Without a pinned key snapshot, every
    // exhibit they had ever uploaded would start reporting signatureValid:false —
    // evidence that was never touched, reported as unverifiable.
    const up = await upload(jpegBytes('before-rotation'));
    expect(up.status).toBe(201);

    const before = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);
    expect(before.body.signatureValid).toBe(true);

    // New device: a brand-new keypair, registered with a fresh OTP.
    const newDevice = makeBrowserKeyPair();
    const otpRes = await request(server)
      .post('/api/auth/request-otp')
      .send({ authorityId: 'UP-GZB-4471', purpose: 'LOGIN' });

    const rotated = await request(server)
      .post('/api/auth/rotate-key')
      .set('Authorization', `Bearer ${io.accessToken}`)
      .send({ otp: otpRes.body.demoOtp, publicKeyJwk: newDevice.publicKeyJwk });

    expect(rotated.status).toBe(200);
    expect(rotated.body.rotated).toBe(true);
    expect(rotated.body.publicKeyFingerprint).not.toBe(rotated.body.previousFingerprint);

    // The old exhibit still verifies, against the key that actually signed it.
    const after = await request(server)
      .post(`/api/evidence/${up.body.evidence._id}/verify`)
      .set('Authorization', `Bearer ${io.accessToken}`);

    expect(after.body.signatureValid).toBe(true);
    expect(after.body.fileIntegrity).toBe(FILE_INTEGRITY.FILE_INTACT);
  });

  it('pins the signing key on the evidence record at ingest', async () => {
    const up = await upload(jpegBytes('pinned'));
    const stored = await Evidence.findById(up.body.evidence._id).lean();

    expect(stored.signerPublicKeyJwk).toBeTruthy();
    expect(stored.signerPublicKeyJwk.crv).toBe('P-256');
    expect(stored.signerPublicKeyJwk.x).toBe(io.keys.publicKeyJwk.x);
  });

  it('refuses rotation without a valid OTP', async () => {
    const newDevice = makeBrowserKeyPair();
    const res = await request(server)
      .post('/api/auth/rotate-key')
      .set('Authorization', `Bearer ${io.accessToken}`)
      .send({ otp: '000000', publicKeyJwk: newDevice.publicKeyJwk });
    expect(res.status).toBe(401);
  });

  it('refuses rotation without a session', async () => {
    const newDevice = makeBrowserKeyPair();
    const res = await request(server)
      .post('/api/auth/rotate-key')
      .send({ otp: '123456', publicKeyJwk: newDevice.publicKeyJwk });
    expect(res.status).toBe(401);
  });

  it('rejects uploads signed with the OLD key after rotation', async () => {
    const otpRes = await request(server)
      .post('/api/auth/request-otp')
      .send({ authorityId: 'UP-GZB-4471', purpose: 'LOGIN' });
    const newDevice = makeBrowserKeyPair();
    await request(server)
      .post('/api/auth/rotate-key')
      .set('Authorization', `Bearer ${io.accessToken}`)
      .send({ otp: otpRes.body.demoOtp, publicKeyJwk: newDevice.publicKeyJwk });

    // The retired device must not be able to sign new evidence.
    const res = await upload(jpegBytes('old-key'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');
  });
});
