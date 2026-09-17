#!/usr/bin/env node
/**
 * Print every value a presenter might need to paste, read-only.
 *
 * The client now shows each of these where it belongs — the certificate's verify link
 * and QR on the exhibit panels, the custody label's QR and text on the register, the
 * receipt check on the officer's exhibit panel. This script is the backstop for a
 * rehearsal: one command that lists them all from lexx_core. It writes nothing.
 *
 *   node scripts/demo-lookup.js
 */
import mongoose from 'mongoose';

// env loads .env relative to itself, so this works from any working directory.
const { default: env } = await import('../backend/config/env.js');

if (env.NODE_ENV === 'production') {
  console.error('[lookup] Refusing to run with NODE_ENV=production.');
  process.exit(1);
}

await mongoose.connect(env.MONGO_URI, {
  dbName: env.MONGO_DB_CORE,
  serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_MS,
});
const db = mongoose.connection.db;
const WEB = env.PUBLIC_WEB_URL;

const heading = (text, where) => {
  console.log(`\n${text}`);
  if (where) console.log(`  (${where})`);
};

const evidence = await db.collection('evidence').find().sort({ exhibitCode: 1 }).toArray();
const codeOf = new Map(evidence.map((e) => [String(e._id), e.exhibitCode]));
const users = await db.collection('users').find().project({ authorityId: 1, name: 1 }).toArray();
const userById = new Map(users.map((u) => [String(u._id), u]));

// ---- certificates ----
heading('S.63 certificates → Public verifier, "Verify a section 63 certificate"', 'paste the link or just the token');
const certs = await db.collection('certificates').find().sort({ generatedAt: 1 }).toArray();
if (!certs.length) console.log('  none issued yet — Officer → Evidence → open an exhibit → Generate s.63 certificate');
for (const c of certs) {
  console.log(`  ${codeOf.get(String(c.evidenceId)) ?? '?'}`);
  console.log(`    ${WEB}/verify?token=${c.verificationToken}`);
}

// ---- exhibit QR labels ----
heading(
  'Exhibit QR labels → print and stick on the article; a scan opens the public lifecycle page',
  'phones can open these only if PUBLIC_WEB_URL is a LAN or tunnel address, not localhost'
);
if (!evidence.length) console.log('  no exhibits yet');
for (const e of evidence) {
  console.log(`  ${e.exhibitCode}`);
  console.log(
    e.labelToken
      ? `    ${WEB}/verify?label=${encodeURIComponent(e.labelToken)}`
      : '    (no label token yet — start the API once so the boot migration assigns one)'
  );
}

// ---- upload receipts ----
heading('Upload receipts → Public verifier, "Verify an upload receipt"', 'ledger sequence + entry hash');
const uploads = await db
  .collection('ledger')
  .find({ eventType: 'EVIDENCE_UPLOADED' })
  .sort({ seq: 1 })
  .toArray();
for (const u of uploads) {
  console.log(`  ${u.payload?.exhibitCode ?? '?'}  seq ${u.seq}`);
  console.log(`    ${WEB}/verify?seq=${u.seq}&entry=${u.entryHash}`);
}

// ---- custody labels ----
heading('Custody labels → Station → Custody → "Resolve a label", or /scan', 'the QR on the printed label encodes the /scan link');
const items = await db.collection('custody_items').find().sort({ itemCode: 1 }).toArray();
if (!items.length) console.log('  none booked yet');
for (const i of items) {
  console.log(`  ${i.itemCode}  (${i.status})  ${i.qrPayload}`);
  console.log(`    ${WEB}/scan?label=${encodeURIComponent(i.qrPayload)}`);
}

// ---- counsel on record ----
heading('Counsel on record → Counsel → Your cases', 'on record = the case and every exhibit in it, read-only; nothing to share');
const grants = await db.collection('case_access_grants').find({ revokedAt: null }).sort({ createdAt: 1 }).toArray();
const cases = await db.collection('cases').find().project({ firNumber: 1, cnrNumber: 1 }).toArray();
const caseById = new Map(cases.map((c) => [String(c._id), c]));
if (!grants.length) console.log('  nobody on record yet — Counsel files a vakalatnama, the Court accepts it');
for (const g of grants) {
  const u = userById.get(String(g.userId));
  const c = caseById.get(String(g.caseId));
  const n = evidence.filter((e) => String(e.caseId) === String(g.caseId)).length;
  console.log(`  ${u?.authorityId ?? g.userId}  ${g.role}  FIR ${c?.firNumber ?? '?'}  ${c?.cnrNumber ?? ''}  (${n} exhibit${n === 1 ? '' : 's'} readable)`);
}

// ---- representation ----
heading('Vakalatnama filings (advocate → registrar)');
const filings = await db.collection('vakalatnama_filings').find().sort({ filedAt: 1 }).toArray();
if (!filings.length) console.log('  none filed yet');
for (const f of filings) {
  console.log(`  ${f.advocateAuthorityId}  ${f.appearingFor}  ${f.cnrNumber}  ${f.status}${f.decisionNote ? `  "${f.decisionNote}"` : ''}`);
}

// ---- referrals ----
heading('FSL referrals');
const referrals = await db.collection('referrals').find().sort({ referredAt: 1 }).toArray();
if (!referrals.length) console.log('  none');
for (const r of referrals) console.log(`  ${r.exhibitCode}  ${r.labId}  ${r.status}`);

// ---- anchoring ----
heading('Anchor batches (Monad Testnet)');
const batches = await db.collection('anchor_batches').find().sort({ fromSeq: 1 }).toArray();
if (!batches.length) console.log('  none yet');
for (const b of batches) {
  const link = b.txHash ? `${env.ANCHOR_EXPLORER_BASE}/tx/${b.txHash}` : '(not submitted)';
  console.log(`  seq ${b.fromSeq}-${b.toSeq}  ${b.status.padEnd(9)} ${link}`);
}
if (env.ANCHOR_CONTRACT_ADDRESS) {
  console.log(`  contract: ${env.ANCHOR_EXPLORER_BASE}/address/${env.ANCHOR_CONTRACT_ADDRESS}`);
}

// ---- exhibit ids ----
heading('Exhibit database ids (only needed if typing ids by hand)');
for (const e of evidence) console.log(`  ${e.exhibitCode}  ${e._id}  ${e.title ?? ''}`);

console.log('');
await mongoose.disconnect();
