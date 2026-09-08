/**
 * Disclosure and lawyer scoping (spec §8 F8).
 *
 * Run against the REAL directory services. The claim under test is that an
 * advocate's access to a case comes from the COURT REGISTRY and nowhere else, and
 * that being on record buys them the served set and not one exhibit more.
 *
 * The denials are the assertions that matter here. Each one is checked twice: once
 * in the HTTP response the advocate sees, and once in `audit_events`, because a
 * refusal nobody recorded is a refusal nobody can prove happened.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { Case } from '../../models/Case.js';
import { Ledger } from '../../models/Ledger.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { DisclosurePack } from '../../models/DisclosurePack.js';
import { CaseAccessGrant } from '../../models/CaseAccessGrant.js';
import { createApp } from '../../app.js';
import { asUser, sha256Hex } from '../helpers/client.js';
import {
  DECISION,
  DENY_REASON,
  DISCLOSURE_STATUS,
  GRANT_BASIS,
  LEDGER_EVENT,
  ROLE,
} from '../../models/enums.js';

let mongo;
let server;

// Seeded identities (see each directory's seed.js).
const IO = 'UP-GZB-4471';
const REGISTRAR = 'UP-GZB-REG-01';
const ADVOCATE_ON_RECORD = 'UP/1234/2015'; // vakalatnama ACCEPTED for the demo CNR
const ADVOCATE_NOT_ON_RECORD = 'UP/9876/2019'; // real advocate, on no case at all
const LEGAL_AID_ADVOCATE = 'UP/7777/2018'; // BNSS s.341 assignment for the same CNR

const FIR = '0123/2026';
const CNR = 'UPGB010012342026';

/** Collections rebuilt for every test. `users` is kept: activation costs bcrypt. */
const PER_TEST_COLLECTIONS = [
  'cases',
  'evidence',
  'disclosure_packs',
  'case_access_grants',
  'certificates',
  'referrals',
  'custody_items',
  'ledger',
  'counters',
  'audit_events',
  'anchor_batches',
  'stream_tokens',
];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Everything Part A of the s.63 Schedule asks for, so a certificate can be generated. */
const FULL_DEVICE = Object.freeze({
  sourceType: 'MOBILE',
  make: 'Samsung',
  model: 'Galaxy A54',
  colour: 'Black',
  serialNumber: 'R58N90ABCDE',
  imeiOrUid: '351756051523999',
});

let io;
let registrar;
let onRecord;
let notOnRecord;
let legalAid;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  await startDirectories(uri);

  await mongoose.connect(uri, { dbName: 'lexx_test_disclosure', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();

  server = createApp();

  // Activated once. Password hashing at 12 rounds is deliberately expensive, so
  // repeating it per test would spend the whole budget proving bcrypt works.
  io = await asUser(server, IO);
  registrar = await asUser(server, REGISTRAR);
  onRecord = await asUser(server, ADVOCATE_ON_RECORD);
  notOnRecord = await asUser(server, ADVOCATE_NOT_ON_RECORD);
  legalAid = await asUser(server, LEGAL_AID_ADVOCATE);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(
    PER_TEST_COLLECTIONS.map((name) =>
      mongoose.connection.collection(name).deleteMany({}).catch(() => {})
    )
  );
});

// ---------------------------------------------------------------- helpers ----

const as = (session, req) => req.set('Authorization', `Bearer ${session.accessToken}`);

async function createCase() {
  const res = await as(io, request(server).post('/api/cases/from-fir')).send({ firNumber: FIR });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.case;
}

/** Upload one exhibit as the IO, signing the hash exactly as the browser would. */
async function uploadExhibit(caseId, title, device = {}) {
  const bytes = Buffer.concat([PNG, Buffer.from(title.padEnd(96, '.'), 'utf8')]);
  const sha = sha256Hex(bytes);

  let req = as(io, request(server).post('/api/evidence/upload'))
    .field('caseId', String(caseId))
    .field('title', title)
    .field('sha256Client', sha)
    .field('signature', io.keys.sign(sha))
    .field('sourceType', device.sourceType ?? 'MOBILE');

  for (const [key, value] of Object.entries(device)) {
    if (key !== 'sourceType') req = req.field(key, String(value));
  }

  const res = await req.attach('file', bytes, { filename: `${title}.png`, contentType: 'image/png' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evidence;
}

/**
 * The full statutory sequence, in the order the law actually runs:
 * case → exhibits → IO prepares → chargesheet filed → representation synced from the
 * court directory → registrar approves → registrar serves.
 */
async function fixture({
  exclude = 1,
  approveAllExclusions = true,
  serveTo = 'ON_RECORD',
  device = {},
} = {}) {
  const caseDoc = await createCase();

  const exhibits = [
    await uploadExhibit(caseDoc._id, 'CCTV clip', device),
    await uploadExhibit(caseDoc._id, 'Mobile video', device),
    await uploadExhibit(caseDoc._id, 'Seized phone photo', device),
  ];

  const excluded = exhibits.slice(exhibits.length - exclude);

  const prepared = await as(io, request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)).send({
    excludedItems: excluded.map((e) => ({
      itemId: e._id,
      reason: 'Identifies a protected witness; withheld pending a redaction order.',
    })),
  });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
  const packId = prepared.body.pack.packId;

  const filed = await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);

  const synced = await as(
    registrar,
    request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)
  ).send({});
  expect(synced.status, JSON.stringify(synced.body)).toBe(200);

  const approved = await as(registrar, request(server).post(`/api/disclosure/${packId}/approve`)).send({
    approvedExclusions: approveAllExclusions ? excluded.map((e) => e._id) : excluded.slice(1).map((e) => e._id),
    redactionVariant: 'DEFENCE_V1',
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);

  let recipientUserIds;
  if (serveTo === 'ON_RECORD') {
    const grant = await CaseAccessGrant.findOne({
      caseId: caseDoc._id,
      role: ROLE.DEFENCE_COUNSEL,
      revokedAt: null,
    }).lean();
    recipientUserIds = grant ? [String(grant.userId)] : [];
  }

  const served = await as(registrar, request(server).post(`/api/disclosure/${packId}/serve`)).send(
    recipientUserIds ? { recipientUserIds } : {}
  );

  return {
    caseDoc: await Case.findById(caseDoc._id).lean(),
    caseId: String(caseDoc._id),
    packId,
    exhibits,
    disclosed: exhibits.slice(0, exhibits.length - exclude),
    excluded,
    approved: approved.body,
    served,
  };
}

const denialRows = (reason) =>
  AuditEvent.find({ decision: DECISION.DENY, reason }).lean();

// ================================================= representation from court ==

describe('representation is mirrored from the court directory, never asserted', () => {
  it('creates a VAKALATNAMA grant from the accepted vakalatnama in dir_court', async () => {
    const caseDoc = await createCase();
    await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});

    const res = await as(
      registrar,
      request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)
    ).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cnrNumber).toBe(CNR);
    expect(res.body.source).toBe('COURT_DIRECTORY');

    const grant = await CaseAccessGrant.findOne({
      caseId: caseDoc._id,
      userId: onRecord.user.userId,
    }).lean();
    expect(grant).toBeTruthy();
    expect(grant.role).toBe(ROLE.DEFENCE_COUNSEL);
    expect(grant.grantBasis).toBe(GRANT_BASIS.VAKALATNAMA);
    // The external document the grant traces back to.
    expect(grant.grantRef).toContain(CNR);
    expect(grant.grantRef).toContain(ADVOCATE_ON_RECORD);
  });

  it('creates NO grant for the advocate who is on no case', async () => {
    const caseDoc = await createCase();
    await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
    await as(registrar, request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)).send({});

    const grants = await CaseAccessGrant.find({ caseId: caseDoc._id }).lean();
    const holders = grants.map((g) => String(g.userId));
    expect(holders).not.toContain(String(notOnRecord.user.userId));
  });

  it('also mirrors a BNSS s.341 legal-aid assignment', async () => {
    const caseDoc = await createCase();
    await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
    await as(registrar, request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)).send({});

    const grant = await CaseAccessGrant.findOne({
      caseId: caseDoc._id,
      role: ROLE.LEGAL_AID_COUNSEL,
    }).lean();
    expect(grant).toBeTruthy();
    expect(grant.grantBasis).toBe(GRANT_BASIS.LEGAL_AID_ORDER);
    expect(grant.grantRef).toBe('SC/GZB/341/2026/44');
  });

  it('is idempotent — polling twice does not duplicate a grant', async () => {
    const caseDoc = await createCase();
    await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
    await as(registrar, request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)).send({});
    const second = await as(
      registrar,
      request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)
    ).send({});

    expect(second.body.granted).toEqual([]);
    expect(await CaseAccessGrant.countDocuments({ caseId: caseDoc._id, role: ROLE.DEFENCE_COUNSEL })).toBe(1);
  });

  it('refuses to sync a case that is not yet listed before a court', async () => {
    const caseDoc = await createCase();
    const res = await as(
      registrar,
      request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)
    ).send({});
    // A registrar has no scope over a case with no courtId — the resolver stops it.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.OUT_OF_COURT_SCOPE);
  });
});

// ============================================================== preparation ==

describe('the IO proposes the set; the set is computed, not submitted', () => {
  it('includes every exhibit except the ones excluded with a reason', async () => {
    const caseDoc = await createCase();
    const a = await uploadExhibit(caseDoc._id, 'CCTV clip');
    const b = await uploadExhibit(caseDoc._id, 'Witness statement');

    const res = await as(io, request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)).send({
      excludedItems: [{ itemId: b._id, reason: 'Names a protected witness under POCSO.' }],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.pack.exhibitIds).toEqual([a._id]);
    expect(res.body.pack.excludedItems).toHaveLength(1);
    expect(res.body.pack.excludedItems[0].approved).toBe(false);
    expect(res.body.pack.status).toBe(DISCLOSURE_STATUS.DRAFT);
  });

  it('refuses an exclusion with no reason', async () => {
    const caseDoc = await createCase();
    const a = await uploadExhibit(caseDoc._id, 'CCTV clip');

    const res = await as(io, request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)).send({
      excludedItems: [{ itemId: a._id, reason: '' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an exclusion naming an exhibit from another case', async () => {
    const caseDoc = await createCase();
    await uploadExhibit(caseDoc._id, 'CCTV clip');

    const res = await as(io, request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)).send({
      excludedItems: [
        { itemId: new mongoose.Types.ObjectId().toString(), reason: 'Not in this case at all.' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EXCLUDED_ITEM_NOT_IN_CASE');
  });

  it('an advocate cannot prepare a pack', async () => {
    const caseDoc = await createCase();
    const res = await as(onRecord, request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('writes DISCLOSURE_PREPARED to the ledger with the exclusion reasons', async () => {
    const caseDoc = await createCase();
    const a = await uploadExhibit(caseDoc._id, 'CCTV clip');
    await as(io, request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)).send({
      excludedItems: [{ itemId: a._id, reason: 'Withheld pending a redaction order.' }],
    });

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.DISCLOSURE_PREPARED }).lean();
    expect(entry).toBeTruthy();
    expect(entry.payload.exclusions[0].reason).toMatch(/redaction order/);
  });
});

// ================================================================= serving ==

describe('serving', () => {
  it('REFUSES to serve while any exclusion is still unapproved', async () => {
    // Material may be withheld from an accused person only on a ruling actually
    // made. Two exclusions requested, one ruled on: the pack cannot go out.
    const f = await fixture({ exclude: 2, approveAllExclusions: false, serveTo: 'ALL' });

    expect(f.served.status, JSON.stringify(f.served.body)).toBe(409);
    expect(f.served.body.error.code).toBe('UNAPPROVED_EXCLUSIONS');
    expect(f.served.body.error.details.itemIds).toHaveLength(1);

    const pack = await DisclosurePack.findById(f.packId).lean();
    expect(pack.status).toBe(DISCLOSURE_STATUS.APPROVED);
    expect(pack.servedTo).toHaveLength(0);
  });

  it('serves once every exclusion has been ruled on', async () => {
    const f = await fixture();
    expect(f.served.status, JSON.stringify(f.served.body)).toBe(200);
    const pack = await DisclosurePack.findById(f.packId).lean();
    expect(pack.status).toBe(DISCLOSURE_STATUS.SERVED);
  });

  it('records a high-entropy watermark token and label PER RECIPIENT', async () => {
    const f = await fixture();
    const recipient = f.served.body.servedNow[0];

    expect(recipient.authorityId).toBe(ADVOCATE_ON_RECORD);
    // randomBase64Url(32) → 43 characters of base64url. Guessing one is the only
    // way to forge another recipient's mark, so the entropy is the control.
    expect(recipient.watermarkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Spec §8 F8: {advocateName} · {enrolmentNo} · {timestamp}
    expect(recipient.watermarkLabel).toMatch(
      /^Adv\. Priya Sharma · UP\/1234\/2015 · \d{4}-\d{2}-\d{2}T[\d:.]+Z$/
    );

    const pack = await DisclosurePack.findById(f.packId).lean();
    expect(pack.servedTo).toHaveLength(1);
    expect(pack.servedTo[0].watermarkToken).toBe(recipient.watermarkToken);

    // The token is in the append-only record too, so a leak stays traceable against
    // a log nobody can rewrite afterwards.
    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.DISCLOSURE_SERVED }).lean();
    expect(entry.payload.recipients[0].watermarkToken).toBe(recipient.watermarkToken);
    expect(entry.payload.recipients[0].authorityId).toBe(ADVOCATE_ON_RECORD);
  });

  it('gives two recipients two different tokens', async () => {
    const f = await fixture({ serveTo: 'ALL' });
    expect(f.served.status, JSON.stringify(f.served.body)).toBe(200);
    const tokens = f.served.body.servedNow.map((r) => r.watermarkToken);
    expect(tokens.length).toBeGreaterThan(1);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('stops the BNSS s.230 clock on the case, not only on the pack', async () => {
    const f = await fixture();
    const caseDoc = await Case.findById(f.caseId).lean();
    expect(caseDoc.clocks.disclosureServedOn).toBeInstanceOf(Date);

    const pack = await DisclosurePack.findById(f.packId).lean();
    expect(pack.servedOn.toISOString()).toBe(caseDoc.clocks.disclosureServedOn.toISOString());
  });

  it('refuses to serve a recipient who is not on record', async () => {
    const f = await fixture();
    const stranger = String(notOnRecord.user.userId);
    const res = await as(registrar, request(server).post(`/api/disclosure/${f.packId}/serve`)).send({
      recipientUserIds: [stranger],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECIPIENT_NOT_ON_RECORD');
  });

  it('an IO cannot serve their own pack', async () => {
    const f = await fixture({ exclude: 0 });
    const res = await as(io, request(server).post(`/api/disclosure/${f.packId}/serve`)).send({});
    // The case left the writable stages when the chargesheet was filed.
    expect(res.status).toBe(403);
  });
});

// ======================================================= the advocate's view ==

describe('an advocate on record sees the served set, and only the served set', () => {
  it('returns exactly pack.exhibitIds', async () => {
    const f = await fixture();

    const res = await as(onRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const returned = res.body.exhibits.map((e) => e.evidenceId).sort();
    expect(returned).toEqual(f.disclosed.map((e) => e._id).sort());
    expect(returned).not.toContain(f.excluded[0]._id);
    expect(res.body.cnrNumber).toBe(CNR);
  });

  it('carries the recipient watermark for rendering onto every served page', async () => {
    const f = await fixture();
    const res = await as(onRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));
    expect(res.body.watermark.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.watermark.label).toContain(ADVOCATE_ON_RECORD);
  });

  it('discloses THAT material was withheld and why, but never which item', async () => {
    const f = await fixture();
    const res = await as(onRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));

    expect(res.body.withheld).toHaveLength(1);
    expect(res.body.withheld[0].reason).toMatch(/protected witness/);
    expect(JSON.stringify(res.body)).not.toContain(f.excluded[0]._id);
    expect(JSON.stringify(res.body)).not.toContain(f.excluded[0].exhibitCode);
  });

  it('never leaks triage priority to a party', async () => {
    // Triage is machine review-prioritisation, not a finding about the exhibit.
    const f = await fixture();
    const res = await as(onRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));
    expect(JSON.stringify(res.body)).not.toMatch(/triage/i);
    expect(JSON.stringify(res.body)).not.toMatch(/"priority"/);
  });

  it('can fetch a disclosed exhibit', async () => {
    const f = await fixture();
    const res = await as(onRecord, request(server).get(`/api/evidence/${f.disclosed[0]._id}`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.evidence.exhibitCode).toBe(f.disclosed[0].exhibitCode);
  });

  it('is REFUSED an exhibit outside the served set — EXHIBIT_NOT_IN_DISCLOSURE_SET', async () => {
    const f = await fixture();
    const res = await as(onRecord, request(server).get(`/api/evidence/${f.excluded[0]._id}`));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);

    const rows = await denialRows(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);
    expect(rows).toHaveLength(1);
    expect(rows[0].authorityId).toBe(ADVOCATE_ON_RECORD);
    expect(rows[0].resourceId?.toString()).toBe(f.excluded[0]._id);
  });
});

// ==================================================== the denial, front and centre ==

describe('an advocate NOT on record is denied, and the denial is recorded', () => {
  it('refuses my-pack with NOT_ON_RECORD_FOR_THIS_CASE', async () => {
    const f = await fixture();

    const res = await as(notOnRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('writes a DENY row to audit_events naming the advocate and the case', async () => {
    const f = await fixture();
    await as(notOnRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));

    const rows = await denialRows(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r.authorityId === ADVOCATE_NOT_ON_RECORD);
    expect(row).toBeTruthy();
    expect(row.decision).toBe(DECISION.DENY);
    expect(row.role).toBe(ROLE.DEFENCE_COUNSEL);
    expect(String(row.caseId)).toBe(f.caseId);
  });

  it('refuses them every exhibit in the case, disclosed or not', async () => {
    const f = await fixture();
    for (const exhibit of f.exhibits) {
      const res = await as(notOnRecord, request(server).get(`/api/evidence/${exhibit._id}`));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
    }
  });

  it('refuses them the case itself', async () => {
    const f = await fixture();
    const res = await as(notOnRecord, request(server).get(`/api/cases/${f.caseId}`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });
});

// ============================================== timing, revocation, co-accused ==

describe('scoping is per pack, per recipient and per moment', () => {
  it('denies access BEFORE the pack is served, even to counsel on record', async () => {
    const caseDoc = await createCase();
    const a = await uploadExhibit(caseDoc._id, 'CCTV clip');
    await as(io, request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)).send({});
    await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
    await as(registrar, request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)).send({});

    // On record — but nothing has been served yet.
    const pack = await as(onRecord, request(server).get(`/api/disclosure/my-pack/${caseDoc._id}`));
    expect(pack.status).toBe(403);
    expect(pack.body.error.code).toBe(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);

    const exhibit = await as(onRecord, request(server).get(`/api/evidence/${a._id}`));
    expect(exhibit.status).toBe(403);
    expect(exhibit.body.error.code).toBe(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);
  });

  it('a REVOKED grant denies access, even though the pack was served', async () => {
    const f = await fixture();
    const ok = await as(onRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));
    expect(ok.status).toBe(200);

    // The vakalatnama is withdrawn: revocation is a timestamp, never a delete.
    await CaseAccessGrant.updateOne(
      { caseId: f.caseId, role: ROLE.DEFENCE_COUNSEL, revokedAt: null },
      { $set: { revokedAt: new Date(), revocationReason: 'VAKALATNAMA_WITHDRAWN' } }
    );

    const after = await as(onRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);

    const exhibit = await as(onRecord, request(server).get(`/api/evidence/${f.disclosed[0]._id}`));
    expect(exhibit.status).toBe(403);
    expect(exhibit.body.error.code).toBe(DENY_REASON.NOT_ON_RECORD_FOR_THIS_CASE);
  });

  it('a pack served on ONE advocate is not served on another advocate on the same case', async () => {
    // Legal-aid counsel is genuinely on record for this CNR (BNSS s.341) but was not
    // among the recipients. Co-accused counsel must not inherit someone else's pack.
    const f = await fixture({ serveTo: 'ON_RECORD' });

    const mine = await as(onRecord, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));
    expect(mine.status).toBe(200);

    const theirs = await as(legalAid, request(server).get(`/api/disclosure/my-pack/${f.caseId}`));
    expect(theirs.status).toBe(403);
    expect(theirs.body.error.code).toBe(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);

    // And the exhibits go with it: the resolver checks servedTo[].userId, not caseId.
    const exhibit = await as(legalAid, request(server).get(`/api/evidence/${f.disclosed[0]._id}`));
    expect(exhibit.status).toBe(403);
    expect(exhibit.body.error.code).toBe(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);
  });
});

// ========================================================== acknowledgement ==

describe('acknowledgement stops the 14-day clock for the recipient', () => {
  it('stamps the acknowledging advocate and nobody else', async () => {
    const f = await fixture({ serveTo: 'ALL' });
    expect(f.served.status).toBe(200);

    const res = await as(onRecord, request(server).post(`/api/disclosure/${f.packId}/acknowledge`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.alreadyAcknowledged).toBe(false);

    const pack = await DisclosurePack.findById(f.packId).lean();
    const mine = pack.servedTo.find(
      (s) => String(s.userId) === String(onRecord.user.userId)
    );
    const others = pack.servedTo.filter(
      (s) => String(s.userId) !== String(onRecord.user.userId)
    );
    expect(mine.acknowledgedAt).toBeInstanceOf(Date);
    for (const other of others) expect(other.acknowledgedAt).toBeNull();

    const entry = await Ledger.findOne({ eventType: LEDGER_EVENT.DISCLOSURE_ACKNOWLEDGED }).lean();
    expect(entry.payload.recipientAuthorityId).toBe(ADVOCATE_ON_RECORD);
    expect(entry.payload.watermarkToken).toBe(mine.watermarkToken);
  });

  it('is idempotent', async () => {
    const f = await fixture();
    await as(onRecord, request(server).post(`/api/disclosure/${f.packId}/acknowledge`)).send({});
    const again = await as(onRecord, request(server).post(`/api/disclosure/${f.packId}/acknowledge`)).send({});
    expect(again.status).toBe(200);
    expect(again.body.alreadyAcknowledged).toBe(true);
  });

  it('cannot be acknowledged by an advocate it was not served on', async () => {
    const f = await fixture({ serveTo: 'ON_RECORD' });
    const res = await as(legalAid, request(server).post(`/api/disclosure/${f.packId}/acknowledge`)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);
  });
});

// ================================================================== ledger ==

describe('the whole disclosure sequence lands in the append-only ledger', () => {
  it('writes PREPARED, APPROVED, SERVED and ACKNOWLEDGED in order', async () => {
    const f = await fixture();
    await as(onRecord, request(server).post(`/api/disclosure/${f.packId}/acknowledge`)).send({});

    const entries = await Ledger.find({
      eventType: {
        $in: [
          LEDGER_EVENT.DISCLOSURE_PREPARED,
          LEDGER_EVENT.DISCLOSURE_APPROVED,
          LEDGER_EVENT.DISCLOSURE_SERVED,
          LEDGER_EVENT.DISCLOSURE_ACKNOWLEDGED,
        ],
      },
    })
      .sort({ seq: 1 })
      .lean();

    expect(entries.map((e) => e.eventType)).toEqual([
      LEDGER_EVENT.DISCLOSURE_PREPARED,
      LEDGER_EVENT.DISCLOSURE_APPROVED,
      LEDGER_EVENT.DISCLOSURE_SERVED,
      LEDGER_EVENT.DISCLOSURE_ACKNOWLEDGED,
    ]);
  });
});

// ============================================ certificates follow the pack ==

/**
 * REGRESSION — a s.63 certificate is a statement ABOUT an exhibit, and was leaking
 * exhibits the pack deliberately withheld.
 *
 * Before this, `GET /api/certificates/:id` was guarded by `authorize(READ,
 * CERTIFICATE)`, and the resolver's LEGAL branch handled EVIDENCE and
 * DISCLOSURE_PACK explicitly but let CERTIFICATE fall through to a bare
 * `allowReadOnly`. So an advocate on record — correctly refused the excluded
 * exhibit itself — could still fetch the certificate for it and read out the
 * exhibit code, the SHA-256 digest, the source device's make, model, serial and
 * IMEI, and the laboratory's opinion. That is most of what the exclusion existed to
 * withhold, handed over through a side door.
 */
describe('a certificate is scoped to the same served set as its exhibit', () => {
  /** Generate certificates for one disclosed and one excluded exhibit, as the IO. */
  async function certifiedFixture() {
    const f = await fixture({ device: FULL_DEVICE });
    expect(f.served.status, JSON.stringify(f.served.body)).toBe(200);

    const generate = async (evidenceId) => {
      const res = await as(io, request(server).post('/api/certificates/generate')).send({
        evidenceId: String(evidenceId),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.certificate.certificateId;
    };

    return {
      ...f,
      disclosedCertId: await generate(f.disclosed[0]._id),
      excludedCertId: await generate(f.excluded[0]._id),
    };
  }

  it('lets the advocate read the certificate for an exhibit they were served', async () => {
    const f = await certifiedFixture();
    const res = await as(onRecord, request(server).get(`/api/certificates/${f.disclosedCertId}`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.certificate.certificateId).toBe(f.disclosedCertId);
  });

  it('REFUSES the certificate for an exhibit excluded from their pack', async () => {
    const f = await certifiedFixture();
    const res = await as(onRecord, request(server).get(`/api/certificates/${f.excludedCertId}`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);
  });

  it('refuses the PDF of that certificate too, not merely its metadata', async () => {
    const f = await certifiedFixture();
    const res = await as(
      onRecord,
      request(server).get(`/api/certificates/${f.excludedCertId}/pdf`)
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);
  });

  it('records the refusal, so the attempt on a withheld exhibit is provable', async () => {
    const f = await certifiedFixture();
    await as(onRecord, request(server).get(`/api/certificates/${f.excludedCertId}`));

    const rows = await denialRows(DENY_REASON.EXHIBIT_NOT_IN_DISCLOSURE_SET);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => String(r.resourceId) === f.excludedCertId)).toBe(true);
  });

  it('refuses an advocate served NO pack at all, even one on record', async () => {
    // A live grant, but the pack never left DRAFT: nothing has been disclosed yet.
    const caseDoc = await createCase();
    const exhibit = await uploadExhibit(caseDoc._id, 'CCTV clip', FULL_DEVICE);
    await as(io, request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)).send({
      excludedItems: [],
    });
    await as(io, request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)).send({});
    await as(
      registrar,
      request(server).post(`/api/disclosure/${caseDoc._id}/sync-representation`)
    ).send({});

    const cert = await as(io, request(server).post('/api/certificates/generate')).send({
      evidenceId: String(exhibit._id),
    });
    expect(cert.status, JSON.stringify(cert.body)).toBe(201);

    const res = await as(
      onRecord,
      request(server).get(`/api/certificates/${cert.body.certificate.certificateId}`)
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.NO_DISCLOSURE_PACK_SERVED);
  });
});

// ============================== the court can find the packs it must rule on ==

/**
 * REGRESSION — `approve` and `serve` both take a packId and there was no endpoint
 * that returned one. The registrar had to be told the id out of band, which made a
 * statutory step depend on copying a hex string by hand.
 *
 * The guard is APPROVE on the CASE, not READ, and that distinction is the test: a
 * READ gate would have handed the draft pack list — exclusion counts and all — to
 * the advocate the exclusions are directed against.
 */
describe('GET /api/disclosure/case/:caseId/packs', () => {
  /** Case → exhibits → IO prepares → chargesheet filed, which is what lists it. */
  async function preparedCase() {
    const caseDoc = await createCase();
    await uploadExhibit(caseDoc._id, 'CCTV clip');
    await uploadExhibit(caseDoc._id, 'Mobile video');
    const prepared = await as(
      io,
      request(server).post(`/api/disclosure/${caseDoc._id}/prepare`)
    ).send({ excludedItems: [] });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
    return { caseDoc, packId: prepared.body.pack.packId };
  }

  it('returns the pack the registrar has to act on, without being told its id', async () => {
    const { caseDoc, packId } = await preparedCase();
    const filed = await as(
      io,
      request(server).post(`/api/cases/${caseDoc._id}/file-chargesheet`)
    ).send({});
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);

    const res = await as(
      registrar,
      request(server).get(`/api/disclosure/case/${caseDoc._id}/packs`)
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.packs[0].packId).toBe(packId);
    expect(res.body.packs[0].exhibitCount).toBe(2);
    expect(res.body.packs[0].exclusionCount).toBe(0);
  });

  it('shows the court NOTHING until the case is actually listed before it', async () => {
    // Court scope comes from `Case.courtId`, which is set by filing the chargesheet.
    // A pack prepared during investigation is an investigative document and the
    // registry has no business in it yet — the same rule that governs the case.
    const { caseDoc } = await preparedCase();
    const res = await as(
      registrar,
      request(server).get(`/api/disclosure/case/${caseDoc._id}/packs`)
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.OUT_OF_COURT_SCOPE);
  });

  it('reports how many exclusions still await a ruling', async () => {
    const f = await fixture({ approveAllExclusions: false, exclude: 1 });
    const res = await as(
      registrar,
      request(server).get(`/api/disclosure/case/${f.caseId}/packs`)
    );
    expect(res.status).toBe(200);
    expect(res.body.packs[0].exclusionCount).toBe(1);
    expect(res.body.packs[0].unruledExclusionCount).toBe(1);
  });

  it('never returns a watermark token: that names one advocate’s copy', async () => {
    const f = await fixture();
    const res = await as(
      registrar,
      request(server).get(`/api/disclosure/case/${f.caseId}/packs`)
    );
    expect(res.status).toBe(200);
    expect(res.body.packs[0].recipientCount).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/watermarkToken/);

    // and no token VALUE leaks under some other key either
    const pack = await DisclosurePack.findById(f.packId).lean();
    for (const entry of pack.servedTo ?? []) {
      expect(JSON.stringify(res.body)).not.toContain(entry.watermarkToken);
    }
  });

  it('filters by status', async () => {
    const f = await fixture();
    const served = await as(
      registrar,
      request(server).get(
        `/api/disclosure/case/${f.caseId}/packs?status=${DISCLOSURE_STATUS.SERVED}`
      )
    );
    expect(served.status).toBe(200);
    expect(served.body.total).toBe(1);

    const drafts = await as(
      registrar,
      request(server).get(
        `/api/disclosure/case/${f.caseId}/packs?status=${DISCLOSURE_STATUS.DRAFT}`
      )
    );
    expect(drafts.status).toBe(200);
    expect(drafts.body.total).toBe(0);
  });

  it('rejects a status that is not a disclosure status', async () => {
    const f = await fixture();
    const res = await as(
      registrar,
      request(server).get(`/api/disclosure/case/${f.caseId}/packs?status=ANYTHING`)
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('REFUSES the advocate on record — APPROVE is a court action, not a party’s', async () => {
    const f = await fixture();
    const res = await as(onRecord, request(server).get(`/api/disclosure/case/${f.caseId}/packs`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.READ_ONLY_ROLE);
  });

  it('REFUSES the investigating officer who authored the pack', async () => {
    const f = await fixture();
    const res = await as(io, request(server).get(`/api/disclosure/case/${f.caseId}/packs`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(DENY_REASON.READ_ONLY_ROLE);
  });
});
