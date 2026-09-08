#!/usr/bin/env node
/**
 * Build the complete demo state.
 *
 * This drives the REAL API over HTTP rather than writing to MongoDB directly. That is
 * deliberate and it is worth the extra complexity: a seed that inserts documents
 * proves nothing, while a seed that has to authenticate, pass the access resolver,
 * satisfy the hash-and-signature checks and append to the hash chain is an end-to-end
 * test of the demo path that runs every time you rehearse.
 *
 * If this script completes, the demo works. If it fails, it fails at the exact step
 * that is broken.
 *
 * Prerequisites (see README):
 *   1. MongoDB              — `npm run mongo:dev` in its own terminal
 *   2. all four services    — `npm run dev` in another
 *
 *   node seed/seed-all.js
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: env } = await import('../backend/config/env.js');
const { connectMongo, mongoose: sharedMongoose } = await import('../shared/mongo.js');
await import('../backend/models/index.js');
const { appendEvent } = await import('../backend/services/ledger.js');
const {
  LEDGER_EVENT,
  SUBJECT_TYPE,
  CUSTODY_STATUS,
  CUSTODY_LOCATION,
  ROLE,
} = await import('../backend/models/enums.js');

/**
 * One direct connection, used ONLY to manufacture the gap-detection demo item below.
 *
 * Every other write in this script goes through the real HTTP API, on purpose — see
 * the file header. This is the one deliberate exception, and it exists for the same
 * reason `custody.test.js` uses it: the two-scan transfer API *correctly* refuses to
 * produce an illegal state jump, so the only way such a record exists is the way it
 * would in reality — data that arrived some other way (a migration, a direct write,
 * an event that never got entered). Manufacturing that is the whole point of this
 * step; going through the API cannot do it.
 */
await connectMongo({ uri: env.MONGO_URI, dbName: env.MONGO_DB_CORE, logger: { info() {}, warn() {}, error: console.error } });

const API = env.PUBLIC_BASE_URL;
const PASSWORD = 'LexxDemo!2026#Seed';
const IDENTITY_FILE = path.join(ROOT, 'seed', '.demo-identities.json');

// ---------------------------------------------------------------- plumbing ----

let step = 0;
const say = (msg) => console.log(`[seed] ${msg}`);
const stage = (msg) => console.log(`\n[seed] ${++step}. ${msg}`);
const fail = (msg, detail) => {
  console.error(`\n[seed] FAILED: ${msg}`);
  if (detail) console.error(`[seed]   ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  process.exit(1);
};

async function api(method, endpoint, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (form) {
    payload = form;
  } else if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${API}${endpoint}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: json };
}

/**
 * `want` may be a single status or a list. Several modules legitimately answer 200 or
 * 201 depending on whether the call created something, and the seed should not be a
 * second, stricter specification of the API.
 */
const expect = (res, want, what) => {
  const accepted = Array.isArray(want) ? want : [want];
  if (!accepted.includes(res.status)) {
    fail(`${what} — expected ${accepted.join(' or ')}, got ${res.status}`, res.body);
  }
  return res.body;
};

const OK = [200, 201];

/** A simulated browser device: P-256, P1363 signatures over the hex hash string. */
function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  return {
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y },
    privateKeyJwk: privateKey.export({ format: 'jwk' }),
    sign: (message) =>
      crypto
        .sign('sha256', Buffer.from(message, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' })
        .toString('hex'),
  };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Read an object's identifier whatever the module chose to call it.
 *
 * Modules currently disagree: cases and evidence return `_id`, custody and FSL return
 * `id`, disclosure returns `packId`, certificates return `certificateId`. That is a
 * real API-consistency defect (recorded in docs/PRODUCTION_READINESS.md) rather than
 * something a client should have to know — but normalising the responses now would
 * ripple through four test suites for cosmetic gain, so the seed is tolerant and the
 * defect is written down.
 */
const idOf = (o) =>
  o?._id ?? o?.id ?? o?.packId ?? o?.certificateId ?? o?.referralId ?? null;

/** A minimal, valid JPEG — the server sniffs magic bytes, so this must be real. */
const jpeg = (marker) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
    Buffer.from(marker.padEnd(512, ' ')),
    Buffer.from([0xff, 0xd9]),
  ]);

const pdf = (marker) =>
  Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(marker.padEnd(400, ' ')), Buffer.from('\n%%EOF')]);

/** Activate an account through the real three-step provisioning flow. */
async function provision(authorityId) {
  const device = makeDevice();

  const identity = await api('POST', '/api/auth/verify-identity', { body: { authorityId } });
  if (identity.status !== 200) {
    fail(`directory refused ${authorityId}`, identity.body);
  }

  const otp = expect(
    await api('POST', '/api/auth/request-otp', { body: { authorityId, purpose: 'ACTIVATION' } }),
    200,
    `OTP for ${authorityId}`
  );
  if (!otp.demoOtp) {
    fail(
      'The API did not return the OTP.',
      'Set DEMO_ECHO_OTP=true in .env — the seed cannot read an SMS.'
    );
  }

  const session = expect(
    await api('POST', '/api/auth/activate', {
      body: {
        authorityId,
        otp: otp.demoOtp,
        password: PASSWORD,
        publicKeyJwk: device.publicKeyJwk,
      },
    }),
    201,
    `activate ${authorityId}`
  );

  say(`   activated ${authorityId.padEnd(16)} ${session.user.role.padEnd(20)} ${identity.body.name ?? ''}`);
  return { authorityId, device, token: session.accessToken, user: session.user };
}

/** Upload as a browser would: hash locally, sign the hash, send both. */
async function upload(actor, caseId, { title, bytes, sourceType = 'MOBILE', metadata, filename, contentType }) {
  const hash = sha256(bytes);
  const form = new FormData();
  form.set('caseId', caseId);
  form.set('title', title);
  form.set('sha256Client', hash);
  form.set('signature', actor.device.sign(hash));
  form.set('sourceType', sourceType);
  form.set('make', 'Samsung');
  form.set('model', 'Galaxy A54');
  form.set('colour', 'Black');
  form.set('serialNumber', 'R58T90ABCD');
  form.set('imeiOrUid', '354820100123456');
  if (metadata) form.set('metadata', JSON.stringify(metadata));
  form.set('file', new Blob([bytes], { type: contentType ?? 'image/jpeg' }), filename ?? 'exhibit.jpg');

  const res = await api('POST', '/api/evidence/upload', { token: actor.token, form });
  return expect(res, 201, `upload "${title}"`);
}

// ================================================================== preflight ==

console.log('\nLEXX 2.0 — demo seed\n' + '='.repeat(70));

stage('Checking services');
{
  const health = await api('GET', '/healthz').catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    fail(
      `The core API is not responding at ${API}`,
      'Start it with:  npm run mongo:dev   (one terminal)  and  npm run dev  (another)'
    );
  }
  const ready = await api('GET', '/readyz');
  if (ready.status !== 200) {
    fail('A dependency is down', ready.body);
  }
  say(`   API ${API} · db connected · directories up`);
  say(`   anchoring network: ${env.ANCHOR_NETWORK} (chain ${env.ANCHOR_CHAIN_ID})`);
}

// ------------------------------------------------------------------ directories

stage('Seeding the three authority directories');
for (const script of [
  'directories/police/seed.js',
  'directories/court/seed.js',
  'directories/legal/seed.js',
]) {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, script)], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d;
    });
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${script}: ${stderr.slice(0, 400)}`))
    );
    p.on('error', reject);
  }).catch((err) => fail('directory seed failed', err.message));
  say(`   ${script}`);
}

// -------------------------------------------------------------------- accounts

stage('Provisioning Lexx accounts from the directories');
{
  const existing = await api('POST', '/api/auth/verify-identity', {
    body: { authorityId: 'UP-GZB-4471' },
  });
  if (existing.body?.accountExists) {
    fail(
      'Demo accounts already exist.',
      'Run `npm run reset` first — seeding on top of existing state produces a confusing demo.'
    );
  }
}

const io = await provision('UP-GZB-4471');
const sho = await provision('UP-GZB-4402');
const malkhana = await provision('UP-GZB-4455');
const sp = await provision('UP-GZB-9001');
const examiner = await provision('FSL-LKO-0091');
const judge = await provision('UP-JUD-2291');
const registrar = await provision('UP-GZB-REG-01');
const advocateOnRecord = await provision('UP/1234/2015');
const advocateNotOnRecord = await provision('UP/9876/2019');

// ------------------------------------------------------------------------ case

stage('Creating the case from FIR 0123/2026');
const demoCase = expect(
  await api('POST', '/api/cases/from-fir', { token: io.token, body: { firNumber: '0123/2026' } }),
  201,
  'create case from FIR'
).case;
const caseId = idOf(demoCase);
say(`   ${demoCase.firNumber} · ${demoCase.stationCode} · ${demoCase.sensitivityClass} · max ${demoCase.maxPunishmentYears}y`);

stage('Computing jurisdiction');
{
  const j = expect(
    await api('POST', `/api/cases/${caseId}/compute-jurisdiction`, { token: io.token }),
    OK,
    'compute jurisdiction'
  );
  say(`   → ${j.jurisdiction.courtType}${j.jurisdiction.requiredDesignation ? ` (${j.jurisdiction.requiredDesignation})` : ''}`);
  for (const reason of j.jurisdiction.reasons) say(`     · ${reason}`);
}

// -------------------------------------------------------------------- exhibits

stage('Uploading exhibits (browser hash + ECDSA signature, verified server-side)');

const ex1 = await upload(io, caseId, {
  title: 'CCTV still — approach corridor',
  bytes: jpeg('EX-001 CCTV still, clean provenance'),
  sourceType: 'DVR',
  metadata: { dateTimeOriginal: '2026-01-04T21:14:02Z', make: 'Hikvision', model: 'DS-2CD', hasC2PA: true },
});
say(`   ${ex1.evidence.exhibitCode}  triage ${ex1.evidence.triage.priority.padEnd(6)} CCTV still`);

const ex2 = await upload(io, caseId, {
  title: 'Mobile video — recovered from handset',
  bytes: jpeg('EX-002 mobile video, several triage indicators'),
  sourceType: 'MOBILE',
  // No capture timestamp, an editor tag, no content credentials → HIGH priority.
  metadata: { software: 'Adobe Photoshop 25.0', containerDurationSec: 31, streamDurationSec: 12 },
});
say(`   ${ex2.evidence.exhibitCode}  triage ${ex2.evidence.triage.priority.padEnd(6)} mobile video  → will go to FSL`);

const ex3 = await upload(io, caseId, {
  title: 'Witness statement',
  bytes: pdf('EX-003 witness statement'),
  sourceType: 'COMPUTER',
  filename: 'statement.pdf',
  contentType: 'application/pdf',
  metadata: { dateTimeOriginal: '2026-01-05T10:00:00Z', hasC2PA: true, make: 'HP', model: 'ScanJet' },
});
say(`   ${ex3.evidence.exhibitCode}  triage ${ex3.evidence.triage.priority.padEnd(6)} witness statement`);

const ex4 = await upload(io, caseId, {
  title: 'Seized phone — photograph of device',
  bytes: jpeg('EX-004 THE TAMPER TARGET — modify this file on stage'),
  sourceType: 'MOBILE',
  metadata: { dateTimeOriginal: '2026-01-04T22:40:00Z', make: 'Samsung', model: 'A54', hasC2PA: true },
});
say(`   ${ex4.evidence.exhibitCode}  triage ${ex4.evidence.triage.priority.padEnd(6)} seized phone  ← THE TAMPER TARGET`);

// --------------------------------------------------------------------- custody

stage('Creating physical custody items');
const goodItem = expect(
  await api('POST', '/api/custody/items', {
    token: io.token,
    body: {
      caseId,
      evidenceId: idOf(ex4.evidence),
      description: 'Samsung Galaxy A54, black',
      sealNumber: 'SEAL-GZB-88231',
      identifiers: { imei: '354820100123456', serialNumber: 'R58T90ABCD' },
      location: 'FIELD',
    },
  }),
  201,
  'create custody item'
);
say(`   ${goodItem.item.itemCode}  Samsung A54  seal SEAL-GZB-88231`);

// Move it SEIZED → IN_STORE through the real two-scan handshake.
{
  const initiated = expect(
    await api('POST', `/api/custody/items/${idOf(goodItem.item)}/initiate-transfer`, {
      token: io.token,
      body: {
        toUserId: malkhana.user.userId,
        reason: 'Deposit to malkhana after seizure',
        toStatus: 'IN_STORE',
        toLocation: 'MALKHANA',
      },
    }),
    OK,
    'initiate custody transfer'
  );

  expect(
    await api('POST', `/api/custody/items/${idOf(goodItem.item)}/accept-transfer`, {
      token: malkhana.token,
      body: { transferToken: initiated.transferToken, sealIntact: true },
    }),
    OK,
    'accept custody transfer'
  );
  say('   transferred SEIZED → IN_STORE (two-scan handshake, seal intact)');
}

const brokenItem = expect(
  await api('POST', '/api/custody/items', {
    token: io.token,
    body: {
      caseId,
      description: 'SanDisk 64GB USB drive — chain deliberately incomplete',
      sealNumber: 'SEAL-GZB-88245',
      identifiers: { serialNumber: 'SDCZ48-064G' },
      location: 'FIELD',
    },
  }),
  201,
  'create second custody item'
);
say(`   ${brokenItem.item.itemCode}  USB drive  ← seized, then an out-of-band FSL move (the gap demo)`);

// Manufacture the actual gap. The two-scan transfer API correctly REFUSES an illegal
// SEIZED → AT_FSL jump — that refusal is itself tested — so this writes the same kind
// of out-of-band ledger event `custody.test.js` uses to prove the detector works: one
// that arrived some other way, skipping the malkhana deposit and leaving a custody
// sequence gap. The CustodyItem document is deliberately left untouched (still
// SEIZED), so its own record and the ledger's account of it disagree — which is
// itself a finding (STATE_DIVERGENCE).
await appendEvent({
  eventType: LEDGER_EVENT.CUSTODY_TRANSFERRED,
  caseId,
  subjectId: new sharedMongoose.Types.ObjectId(idOf(brokenItem.item)),
  subjectType: SUBJECT_TYPE.CUSTODY_ITEM,
  actorUserId: new sharedMongoose.Types.ObjectId(io.user.userId),
  actorRole: ROLE.IO,
  payload: {
    // custodySeq 4 where 2 was due: two events for this item are unaccounted for.
    custodySeq: 4,
    itemCode: brokenItem.item.itemCode,
    fromStatus: CUSTODY_STATUS.SEIZED,
    toStatus: CUSTODY_STATUS.AT_FSL,
    toLocation: CUSTODY_LOCATION.FSL,
  },
});
say('   out-of-band ledger event written: SEIZED → AT_FSL, skipping IN_STORE and the malkhana deposit');

// ------------------------------------------------------------------------- FSL

stage('Referring the mobile video to the forensic laboratory');
const referral = expect(
  await api('POST', `/api/evidence/${idOf(ex2.evidence)}/refer-fsl`, {
    token: sho.token,
    body: {
      labCode: 'UP-FSL-LKO',
      discipline: 'MEDIA_FORENSICS',
      questionsPosed: 'Is the recording continuous? Are there signs of re-encoding or splicing?',
    },
  }),
  201,
  'refer to FSL'
).referral;
say(`   referral to ${referral.labName} · ${referral.discipline}`);

stage('FSL examiner accepts and files a report');
expect(
  await api('POST', `/api/fsl/referrals/${idOf(referral)}/accept`, { token: examiner.token }),
  200,
  'accept referral'
);

{
  const reportBytes = pdf('FSL examination report — media forensics — UP-FSL-LKO');
  const reportHash = sha256(reportBytes);

  const form = new FormData();
  form.set('opinion', 'MANIPULATED');
  form.set(
    'examinationSummary',
    'Container and stream durations disagree by 19 seconds. Re-encoding artefacts are ' +
      'present at frame boundaries consistent with a splice. The recording is not continuous.'
  );
  form.set('reportSha256', reportHash);
  form.set('reportSignature', examiner.device.sign(reportHash));
  // The FSL route takes the file as `report`, not `file`.
  form.set('report', new Blob([reportBytes], { type: 'application/pdf' }), 'fsl-report.pdf');

  expect(
    await api('POST', `/api/fsl/referrals/${idOf(referral)}/report`, { token: examiner.token, form }),
    OK,
    'file FSL report'
  );
  say('   opinion filed: MANIPULATED (signed by the examiner — the ONLY authenticity finding in the system)');
}

// ------------------------------------------------------------------ disclosure

stage('Preparing the disclosure pack');
const pack = expect(
  await api('POST', `/api/disclosure/${caseId}/prepare`, {
    token: io.token,
    body: {
      excludedItems: [
        {
          itemId: idOf(ex3.evidence),
          reason: 'Witness statement withheld pending a protection application under BNSS s.398.',
        },
      ],
      maskVictimIdentity: true,
    },
  }),
  201,
  'prepare disclosure pack'
).pack;
say(`   pack prepared · ${pack.exhibitIds.length} exhibits · 1 exclusion requested`);

stage('Filing the chargesheet (binds the case to a court)');
{
  const filed = expect(
    await api('POST', `/api/cases/${caseId}/file-chargesheet`, { token: io.token }),
    OK,
    'file chargesheet'
  );
  say(`   CNR ${filed.case.cnrNumber} · ${filed.case.courtName ?? filed.case.courtId}`);
}

stage('Registrar mirrors representation from the court directory');
{
  const synced = await api('POST', `/api/disclosure/${caseId}/sync-representation`, {
    token: registrar.token,
  });
  if (synced.status === 200 || synced.status === 201) {
    const n =
      synced.body.grantsCreated ??
      (Array.isArray(synced.body.grants) ? synced.body.grants.length : null) ??
      (Array.isArray(synced.body.granted) ? synced.body.granted.length : null) ??
      (typeof synced.body.granted === 'number' ? synced.body.granted : 0);
    say(`   ${n} advocate(s) placed on record from accepted vakalatnamas`);
  } else {
    say(`   (representation sync returned ${synced.status} — advocate access may need a vakalatnama in the court directory)`);
  }
}

stage('Registrar approves and serves the disclosure pack');
expect(
  await api('POST', `/api/disclosure/${idOf(pack)}/approve`, {
    token: registrar.token,
    body: { approvedExclusions: [idOf(ex3.evidence)], redactionVariant: 'DEFENCE_V1' },
  }),
  200,
  'approve disclosure pack'
);

{
  const served = await api('POST', `/api/disclosure/${idOf(pack)}/serve`, { token: registrar.token });
  if (served.status === 200) {
    say(`   served on ${served.body.pack?.servedTo?.length ?? 0} recipient(s), each with a unique watermark`);
  } else {
    say(`   (serve returned ${served.status} — check that an advocate is on record)`);
  }
}

// ----------------------------------------------------------------- certificate

stage('Generating a BSA s.63 certificate for the CCTV still');
{
  const cert = await api('POST', '/api/certificates/generate', {
    token: io.token,
    body: { evidenceId: idOf(ex1.evidence) },
  });

  if (cert.status === 201) {
    say(`   certificate generated · Part A complete · token ${String(cert.body.certificate?.verificationToken ?? '').slice(0, 12)}…`);
  } else if (cert.status === 400) {
    // Refusing to generate an incomplete certificate is a feature, not a failure.
    say(`   certificate REFUSED (by design) — missing: ${JSON.stringify(cert.body.error?.details ?? {})}`);
  } else {
    say(`   (certificate returned ${cert.status})`);
  }
}

// --------------------------------------------------------------- denial + anchor

stage('Recording the denial that the audit demo shows');
{
  const denied = await api('GET', `/api/cases/${caseId}`, { token: advocateNotOnRecord.token });
  say(`   advocate UP/9876/2019 → ${denied.status} ${denied.body.error?.code ?? ''}  (logged in the audit feed)`);
}

stage('Anchoring the ledger to Monad Testnet');
{
  // Run a cycle here rather than reporting on one that has not happened.
  //
  // The scheduler batches on an interval, and the seed has just written ~20 ledger
  // entries in the seconds since the last tick — so a demo starting immediately after
  // the seed used to find "No batch has been anchored yet" and beat 11, the whole
  // blockchain beat, had nothing to show. Anchoring what we just created is both
  // faster and more honest than telling the operator to wait five minutes.
  const { runAnchorCycle, latestAnchor } = await import('../backend/services/anchor.js');
  const result = await runAnchorCycle();

  if (result.batched) {
    const b = result.batch;
    say(`   root ${b.merkleRoot.slice(0, 18)}… · seq ${b.fromSeq}–${b.toSeq} · ${b.leafCount} entries · status ${b.status}`);
    if (b.status === 'DRY_RUN') {
      say('   DRY RUN — the root was computed and stored, NOT submitted to any chain.');
      say('   To anchor for real: deploy the contract, then set ANCHOR_ENABLED=true,');
      say('   ANCHOR_CONTRACT_ADDRESS and a funded ANCHOR_PRIVATE_KEY in .env.');
    }
  } else {
    const latest = await latestAnchor();
    if (latest) {
      say(`   already anchored · root ${latest.merkleRoot.slice(0, 18)}… · status ${latest.status}`);
    } else {
      say(`   nothing to anchor (${result.reason ?? 'no new ledger entries'})`);
    }
  }
}

// ------------------------------------------------- a case left open for beat 3

stage('Opening a second case, left under investigation');
let openCase = null;
{
  // The main case finishes at CHARGESHEET_FILED, which correctly closes it to
  // investigative writes — so after seeding there was nowhere the officer could
  // legitimately upload, and beat 3 (browser hash + signature, the core of the
  // demo) could not be performed at all on seeded data. This one stays open.
  const res = await api('POST', '/api/cases/from-fir', {
    token: io.token,
    body: { firNumber: '0124/2026' },
  });
  if (res.status === 201) {
    openCase = res.body.case;
    say(`   FIR ${openCase.firNumber} · ${openCase.stationCode} · stage ${openCase.stage}`);
    say('   no exhibits — this is the case to upload into during beat 3');
  } else {
    say(`   could not open the second case (HTTP ${res.status}) — beat 3 will have no writable case`);
  }
}

// ------------------------------------------------------------------- identities

stage('Writing demo identities');
{
  const identities = {
    warning:
      'DEVELOPMENT ONLY. Contains private signing keys. Never commit. Never use outside a demo.',
    password: PASSWORD,
    note:
      'Signing keys normally never leave the browser. They are written here so a demo ' +
      'operator can sign from any machine. In a real deployment an officer on a new ' +
      'device uses POST /api/auth/rotate-key instead.',
    accounts: [io, sho, malkhana, sp, examiner, judge, registrar, advocateOnRecord, advocateNotOnRecord].map(
      (a) => ({
        authorityId: a.authorityId,
        role: a.user.role,
        authority: a.user.authority,
        password: PASSWORD,
        publicKeyJwk: a.device.publicKeyJwk,
        privateKeyJwk: a.device.privateKeyJwk,
      })
    ),
  };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identities, null, 2), { mode: 0o600 });
  say(`   ${path.relative(ROOT, IDENTITY_FILE)} (gitignored, mode 600)`);
}

// ------------------------------------------------------------------- summary

console.log('\n' + '='.repeat(70));
console.log('Demo state ready.\n');
console.log(`  Case          FIR ${demoCase.firNumber} · ${demoCase.stationCode}`);
console.log(`  Exhibits      ${ex1.evidence.exhibitCode}  ${ex2.evidence.exhibitCode}  ${ex3.evidence.exhibitCode}  ${ex4.evidence.exhibitCode}`);
if (openCase) {
  console.log(`  Upload into   FIR ${openCase.firNumber} — still under investigation (beat 3)`);
}
console.log(`  Tamper target ${ex4.evidence.exhibitCode}  storage key:`);
console.log(`                ${ex4.evidence.storageKey}`);
console.log(`  Custody       ${goodItem.item.itemCode} (complete)   ${brokenItem.item.itemCode} (gap)`);
console.log(`\n  Password for every demo account:  ${PASSWORD}`);
console.log('  OTPs are returned by the API while DEMO_ECHO_OTP=true.\n');
console.log('  Next:  see docs/DEMO_SCRIPT.md for the eleven beats.');
console.log('='.repeat(70) + '\n');

await sharedMongoose.disconnect();
process.exit(0);
