/**
 * One-click certificate verification.
 *
 * Everything is recomputed server-side from what is stored — nobody uploads evidence,
 * proofs or hashes. Five independent checks, each in plain language:
 *
 *   documentUnchanged      the stored PDF decrypts and hashes to the recorded digest
 *   systemSignatureValid   the certificate content (incl. that digest) is what the
 *                          LEXX Certificate Authority signed, and the signature verifies
 *   evidenceFileUnchanged  the evidence file decrypts from the vault and re-hashes to
 *                          the SHA-256 the certificate records
 *   activeCertificate      this is the one ACTIVE certificate for the evidence
 *   ledgerRecordIntact     the ledger record of issue matches, and its hash-chain link
 *                          to the previous entry verifies
 *
 * The forensic verdict is NOT consulted. A certificate attests to the record and its
 * integrity; whether a laboratory later calls the content authentic is a separate fact.
 *
 * Details never name a person: they are also returned by the public verifier.
 */
import { Certificate } from '../models/Certificate.js';
import { Evidence } from '../models/Evidence.js';
import { Ledger } from '../models/Ledger.js';
import { CERTIFICATE_STATUS, LEDGER_EVENT } from '../models/enums.js';
import { sha256Hex, verifyEcdsaP256 } from '../config/crypto.js';
import { readCertificatePdf } from './certificatePdf.js';
import { objectExists, readDecryptedToHash } from './storage.js';
import { unwrapDek } from './envelope.js';
import { verifyChain } from './ledger.js';
import { authorityPublicKey } from './systemSigner.js';
import { certificateBodyHash, computeCertificateHash } from './certificateIssuer.js';

export const VERIFICATION_RESULT = Object.freeze({ VERIFIED: 'VERIFIED', FAILED: 'FAILED' });

export const CHECK_LABEL = Object.freeze({
  documentUnchanged: 'Certificate document is unchanged',
  systemSignatureValid: 'Certificate is signed by the LEXX Certificate Authority',
  evidenceFileUnchanged: 'Evidence file is unchanged since it was uploaded',
  activeCertificate: 'This is the current certificate for this evidence',
  ledgerRecordIntact: 'Ledger record of issue is intact',
});

const check = (key, ok, detail) => ({ key, label: CHECK_LABEL[key], ok: Boolean(ok), detail });

async function documentCheck(cert) {
  const key = 'documentUnchanged';
  let stored;
  try {
    stored = await readCertificatePdf(cert);
  } catch {
    return { pdfIntegrity: 'PDF_MODIFIED', check: check(key, false, 'The stored certificate document has been altered: it no longer decrypts.') };
  }
  if (!stored) {
    return { pdfIntegrity: 'PDF_MISSING', check: check(key, false, 'The stored certificate document is missing.') };
  }
  const digest = sha256Hex(stored);
  if (!cert.pdfSha256 || digest !== cert.pdfSha256) {
    return {
      pdfIntegrity: 'PDF_MODIFIED',
      check: check(key, false, 'The stored certificate document does not match its recorded SHA-256 fingerprint.'),
    };
  }
  return { pdfIntegrity: 'PDF_INTACT', check: check(key, true, `SHA-256 ${digest} matches the recorded fingerprint.`) };
}

function signatureCheck(cert) {
  const key = 'systemSignatureValid';
  const sig = cert.systemSignature;
  if (!sig?.signature) {
    return check(key, false, 'This certificate carries no system signature (it was issued under an earlier template).');
  }
  const certificateHash = computeCertificateHash({
    bodyHash: certificateBodyHash(cert),
    pdfSha256: cert.pdfSha256,
    keyFingerprint: sig.keyFingerprint,
  });
  if (certificateHash !== sig.signedPayloadHash) {
    return check(key, false, 'The certificate content has changed since it was signed.');
  }
  const authority = authorityPublicKey();
  if (sig.keyFingerprint !== authority.fingerprint) {
    return check(key, false, 'The certificate was signed with a key that is not the current authority key.');
  }
  if (!verifyEcdsaP256(authority.publicKeyJwk, sig.signature, certificateHash)) {
    return check(key, false, 'The signature does not verify against the authority key.');
  }
  return check(key, true, `The signature over ${certificateHash} verifies against authority key ${authority.fingerprint}.`);
}

async function evidenceFileCheck(cert, evidence) {
  const key = 'evidenceFileUnchanged';
  if (!evidence) return check(key, false, 'The evidence record could not be found.');
  const certified = cert.partA?.hashValue ?? null;
  if (!certified || certified !== evidence.sha256Server) {
    return check(key, false, 'The evidence record’s SHA-256 no longer matches the value on the certificate.');
  }
  if (!evidence.storageKey || !evidence.encryption || !objectExists(evidence.storageKey)) {
    return check(key, false, 'The stored evidence file is missing.');
  }
  let dek;
  try {
    dek = unwrapDek(evidence.encryption, evidence.caseId);
  } catch {
    return check(key, false, 'The evidence file could not be decrypted: its key record has been altered.');
  }
  try {
    const result = await readDecryptedToHash(evidence.storageKey, dek, evidence.encryption);
    if (result.missing) return check(key, false, 'The stored evidence file is missing.');
    if (!result.authTagValid) return check(key, false, 'The stored evidence file has been altered: it no longer decrypts.');
    if (result.sha256 !== certified) {
      return check(key, false, `The stored evidence file hashes to ${result.sha256}, not the certified ${certified}.`);
    }
    return check(key, true, `Re-computed SHA-256 ${result.sha256} matches the certificate.`);
  } finally {
    dek.fill(0);
  }
}

async function activeCheck(cert) {
  const key = 'activeCertificate';
  if ((cert.status ?? CERTIFICATE_STATUS.ACTIVE) !== CERTIFICATE_STATUS.ACTIVE) {
    return check(key, false, 'This certificate has been superseded by a newer certificate for the same evidence.');
  }
  const active = await Certificate.find({ evidenceId: cert.evidenceId, status: CERTIFICATE_STATUS.ACTIVE })
    .select('_id')
    .lean();
  if (active.length !== 1 || String(active[0]._id) !== String(cert._id)) {
    return check(key, false, 'This certificate is not the single active certificate for the evidence.');
  }
  return check(key, true, 'This is the one active certificate for the evidence.');
}

async function ledgerCheck(cert) {
  const key = 'ledgerRecordIntact';
  const seq = cert.issuanceLedgerSeq;
  if (!Number.isInteger(seq)) return check(key, false, 'No ledger record of issue was found for this certificate.');

  const entry = await Ledger.findOne({ seq }).lean();
  if (
    !entry ||
    entry.eventType !== LEDGER_EVENT.CERTIFICATE_GENERATED ||
    String(entry.subjectId) !== String(cert._id)
  ) {
    return check(key, false, `Ledger entry ${seq} is not the record of issue for this certificate.`);
  }
  if (!cert.systemSignature?.signedPayloadHash || entry.payload?.certificateHash !== cert.systemSignature.signedPayloadHash) {
    return check(key, false, `Ledger entry ${seq} records different certificate content.`);
  }

  const from = Math.max(1, seq - 1);
  const chain = await verifyChain({ from, to: seq });
  const expected = seq - from + 1;
  if (!chain.intact || chain.checked !== expected) {
    return check(key, false, `The ledger hash chain does not verify at entry ${chain.brokenAtSeq ?? seq}.`);
  }
  return check(
    key,
    true,
    seq > 1
      ? `Ledger entry ${seq} verifies and links to entry ${seq - 1}.`
      : `Ledger entry ${seq} verifies from the genesis of the chain.`
  );
}

/**
 * Run every check for one certificate.
 * @returns {Promise<null | {certificate, evidence, result, verifiedAt, checks, pdfIntegrity}>}
 */
export async function verifyCertificateRecord(certificateId) {
  const cert = await Certificate.findById(certificateId).lean();
  if (!cert) return null;
  const evidence = await Evidence.findById(cert.evidenceId).lean();

  const [document, evidenceFile, active, ledger] = await Promise.all([
    documentCheck(cert),
    evidenceFileCheck(cert, evidence),
    activeCheck(cert),
    ledgerCheck(cert),
  ]);
  const checks = [document.check, signatureCheck(cert), evidenceFile, active, ledger];

  return {
    certificate: cert,
    evidence,
    result: checks.every((c) => c.ok) ? VERIFICATION_RESULT.VERIFIED : VERIFICATION_RESULT.FAILED,
    verifiedAt: new Date(),
    checks,
    pdfIntegrity: document.pdfIntegrity,
  };
}

export default { verifyCertificateRecord, VERIFICATION_RESULT, CHECK_LABEL };
