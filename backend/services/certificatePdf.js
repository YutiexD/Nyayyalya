/**
 * BSA s.63 certificate rendering and storage.
 *
 * # Determinism
 *
 * The rendered PDF is hashed and that hash is published on the public verifier, so
 * two renders of the same certificate must produce the same bytes. PDFKit stamps a
 * creation date into the document info by default, which would change the hash on
 * every render; we pin it to the certificate's own `generatedAt` instead. Re-rendering
 * after a signature is added legitimately changes the bytes — and the stored hash is
 * updated in the same operation, so the published hash always describes the PDF a
 * verifier would actually be handed.
 *
 * # Storage
 *
 * The PDF is encrypted at rest with the same envelope scheme as evidence: a fresh
 * DEK per write, wrapped under the case KEK (`services/envelope.js`). The
 * `certificates` collection has nowhere to put the IV, auth tag and wrapped DEK, so
 * the stored object is self-describing:
 *
 *     "LEXXPDF1" | uint32BE headerLength | JSON header | ciphertext
 *
 * The header holds only envelope parameters — no plaintext, no key material that is
 * usable without MASTER_KEK. A vault dump therefore yields no readable certificate,
 * exactly as with evidence.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import env from '../config/env.js';
import { sha256Hex } from '../config/crypto.js';
import { sealBuffer, openBuffer } from './envelope.js';
import { buildStorageKey, resolveObjectPath, ensureVault } from './storage.js';
import { SYSTEM_SIGNER_LABEL } from './systemSigner.js';
import { Internal } from '../utils/errors.js';

const SYSTEM_TEMPLATE_VERSION = 'v3.0';
const MAGIC = Buffer.from('LEXXPDF1', 'ascii');
const TEMPLATE_TITLE =
  'CERTIFICATE UNDER SECTION 63 OF THE BHARATIYA SAKSHYA ADHINIYAM, 2023';

/** Storage key for a certificate PDF. Stable across re-renders, unlike the hash. */
export const certificatePdfKey = (certificateId) =>
  buildStorageKey(sha256Hex(`certificate-pdf:${String(certificateId)}`), certificateId);

/**
 * The URL the QR on the certificate points at: the client's public verifier route.
 *
 * `/verify`, not `/verify.html`. The multi-page client served a `verify.html`; the
 * single-page client routes `/verify`, and a printed QR still pointing at the old file
 * landed a scanning phone on the front page with nothing verified.
 */
export const verificationUrlFor = (verificationToken) =>
  `${env.PUBLIC_WEB_URL}/verify?token=${encodeURIComponent(verificationToken)}`;

// ---------------------------------------------------------------- rendering ----

const NA = 'Not recorded';
const show = (v) => (v === null || v === undefined || v === '' ? NA : String(v));

const fmtDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : NA);

function heading(doc, text) {
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(text);
  doc
    .moveTo(doc.x, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor('#666666')
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.5);
}

/** One label/value row. Long values wrap under the label column. */
function field(doc, label, value) {
  const labelWidth = 150;
  const startX = doc.page.margins.left;
  const valueWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right - labelWidth;
  const y = doc.y;

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333333').text(label, startX, y, {
    width: labelWidth - 8,
  });
  const labelBottom = doc.y;

  doc.font('Helvetica').fontSize(9).fillColor('#000000').text(show(value), startX + labelWidth, y, {
    width: valueWidth,
  });

  doc.y = Math.max(labelBottom, doc.y) + 3;
  doc.x = startX;
}

function paragraph(doc, text) {
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#000000')
    .text(text, doc.page.margins.left, doc.y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'justify',
    });
  doc.moveDown(0.4);
}

/**
 * Render the certificate.
 *
 * @param {object} args
 * @param {object} args.certificate  a Certificate document or lean object
 * @param {object} [args.caseDoc]    the case, for the FIR / CNR header
 * @param {object} [args.evidence]   the exhibit, for its code
 * @returns {Promise<Buffer>} the PDF bytes
 */
export async function renderCertificatePdf({ certificate, caseDoc, evidence }) {
  const partA = certificate.partA ?? {};
  const partB = certificate.partB ?? {};
  const generatedAt = certificate.generatedAt ? new Date(certificate.generatedAt) : new Date();
  const verificationUrl = verificationUrlFor(certificate.verificationToken);

  const qrPng = await QRCode.toBuffer(verificationUrl, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });

  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: {
      Title: `BSA s.63 certificate — ${evidence?.exhibitCode ?? String(certificate._id)}`,
      Author: 'LEXX',
      Subject: TEMPLATE_TITLE,
      Producer: 'LEXX',
      Creator: 'LEXX',
      // Machine-readable copy of the verification token, in the document's own
      // metadata (ASCII, so it is stored as plain text, outside the compressed page
      // streams). The public verifier reads it when a holder drops the PDF on it, so
      // checking a copy handed over by another party needs nothing but the file.
      Keywords: `lexx-verify:${certificate.verificationToken}`,
      // Pinned, so the same content always hashes to the same bytes.
      CreationDate: generatedAt,
      ModDate: generatedAt,
    },
  });

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // ---- header ----
  doc.font('Helvetica-Bold').fontSize(13).text(TEMPLATE_TITLE, { align: 'center' });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#444444')
    .text('(Schedule — Part A and Part B)', { align: 'center' });
  doc.moveDown(0.8);
  doc.fillColor('#000000');

  const isSystem = certificate.templateVersion === SYSTEM_TEMPLATE_VERSION;
  field(doc, 'Certificate no.', String(certificate._id));
  field(doc, 'Template version', certificate.templateVersion ?? 'v1.0');
  field(doc, isSystem ? 'Issued at' : 'Generated at', fmtDate(generatedAt));
  field(doc, 'Exhibit', evidence?.exhibitCode ?? certificate.exhibitCode ?? null);
  field(doc, 'FIR number', caseDoc?.firNumber ?? null);
  field(doc, 'CNR number', caseDoc?.cnrNumber ?? null);

  if (isSystem) {
    renderSystemBody(doc, certificate);
  } else {
    renderLegacyBody(doc, certificate, partA, partB);
  }

  renderVerificationBlock(doc, qrPng, verificationUrl);

  doc.end();
  return finished;
}

/**
 * v3.0 — issued and signed by the system. Part B is the ingest hash attestation, and
 * nothing on the document depends on a forensic verdict.
 */
function renderSystemBody(doc, certificate) {
  const partA = certificate.partA ?? {};
  const partB = certificate.partB ?? {};
  const onBehalf = certificate.issuedOnBehalfOf ?? {};

  heading(doc, 'PART A — particulars of the electronic record');
  paragraph(
    doc,
    `Issued automatically by the ${SYSTEM_SIGNER_LABEL} when the electronic record was produced, on behalf of the officer who produced it. Particulars that were not recorded at upload are shown as "${NA}".`
  );
  field(doc, 'Issued on behalf of', onBehalf.name);
  field(doc, 'Designation', onBehalf.designation ?? partA.deponentDesignation);
  field(doc, 'Authority ID', onBehalf.authorityId);
  field(doc, 'Source type', partA.sourceType);
  field(doc, 'Make', partA.make);
  field(doc, 'Model', partA.model);
  field(doc, 'Colour', partA.colour);
  field(doc, 'Serial number', partA.serialNumber);
  field(doc, 'IMEI / UID', partA.imeiOrUid);
  field(doc, 'Hash algorithm', partA.hashAlgorithm ?? 'SHA-256');
  field(doc, 'Hash value', partA.hashValue);

  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(9).text('Manner of production');
  doc.moveDown(0.2);
  paragraph(doc, show(partA.mannerOfProduction));
  doc.font('Helvetica-Bold').fontSize(9).text('Conditions of operation');
  doc.moveDown(0.2);
  paragraph(doc, show(partA.conditionsStatement));

  heading(doc, 'PART B — hash values computed at ingest');
  field(doc, 'Attested by', partB.attestedBy);
  field(doc, 'Hash algorithm', partB.hashAlgorithm);
  field(doc, 'SHA-256 on device', partB.sha256Client);
  field(doc, 'SHA-256 on server', partB.sha256Server);
  field(doc, 'Values match', partB.hashesMatch === true ? 'Yes' : partB.hashesMatch === false ? 'No' : null);
  field(doc, 'Computed at', fmtDate(partB.hashComputedAt));
  paragraph(doc, show(partB.statement));

  heading(doc, 'SYSTEM SIGNATURE');
  field(doc, 'Signed by', SYSTEM_SIGNER_LABEL);
  field(doc, 'Algorithm', 'ECDSA P-256 over SHA-256');
  field(doc, 'Authority key', certificate.authorityFingerprint);
  field(doc, 'Certificate body hash', certificate.bodyHash);
  paragraph(
    doc,
    'The system signature covers the certificate body hash above together with the SHA-256 digest of this document and the authority key. It is recorded in the LEXX register and its append-only ledger, and it is checked — together with the evidence file itself — by the verification address below.'
  );
}

function renderVerificationBlock(doc, qrPng, verificationUrl) {
  heading(doc, 'INDEPENDENT VERIFICATION');
  const qrY = doc.y;
  doc.image(qrPng, doc.page.width - doc.page.margins.right - 96, qrY, { width: 96 });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .text(
      'Scan the code, or open the address below, to confirm this certificate against the issuing register. The verifier reports validity only: it discloses no case narrative, no party details and no evidence content.',
      doc.page.margins.left,
      qrY,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 112 }
    );
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(8).text(verificationUrl, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 112,
  });
}

/** v1.0 / v2.0 — kept so a legacy certificate still renders as it was issued. */
function renderLegacyBody(doc, certificate, partA, partB) {
  // ---- Part A ----
  heading(doc, 'PART A — to be filled in by the party producing the electronic record');

  field(doc, 'Deponent', partA.deponentName);
  field(doc, 'Designation', partA.deponentDesignation);
  field(doc, 'Authority ID', partA.deponentAuthorityId);
  field(doc, 'Source type', partA.sourceType);
  field(doc, 'Make', partA.make);
  field(doc, 'Model', partA.model);
  field(doc, 'Colour', partA.colour);
  field(doc, 'Serial number', partA.serialNumber);
  field(doc, 'IMEI / UID', partA.imeiOrUid);
  field(doc, 'Hash algorithm', partA.hashAlgorithm ?? 'SHA-256');
  field(doc, 'Hash value', partA.hashValue);

  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(9).text('Manner of production');
  doc.moveDown(0.2);
  paragraph(doc, show(partA.mannerOfProduction));

  doc.font('Helvetica-Bold').fontSize(9).text('Conditions of operation');
  doc.moveDown(0.2);
  paragraph(doc, show(partA.conditionsStatement));

  // ---- Part B ----
  heading(doc, 'PART B — to be filled in by the expert');

  if (certificate.partBComplete) {
    field(doc, 'Expert', partB.expertName);
    field(doc, 'Laboratory', partB.labName);
    field(doc, 'IT Act s.79A notification', partB.section79ARef);
    field(doc, 'Report SHA-256', partB.reportSha256);
    field(doc, 'Reported at', fmtDate(partB.reportedAt));
    field(doc, 'Opinion', partB.expertOpinion);
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(9).text('Examination summary');
    doc.moveDown(0.2);
    paragraph(doc, show(partB.examinationSummary));
  } else {
    // Lexx never authors an expert opinion. An empty Part B is the honest state of
    // the record, and saying so on the face of the certificate is the point.
    paragraph(
      doc,
      'Part B is not completed. No report from a laboratory notified under section 79A of the Information Technology Act, 2000 has been filed in respect of this exhibit. This certificate is therefore incomplete as to expert opinion, and no opinion as to authenticity is expressed or implied by it.'
    );
  }

  // ---- signatures ----
  heading(doc, 'SIGNATURES');
  const signatures = certificate.signatures ?? [];
  if (!signatures.length) {
    paragraph(doc, 'Unsigned. This certificate has not yet been executed by any deponent.');
  } else {
    for (const s of signatures) {
      field(doc, s.role === 'EXPERT' ? 'Part B (expert)' : 'Part A (party)', s.signerName);
      field(doc, '  signed at', fmtDate(s.signedAt));
      field(doc, '  key fingerprint', s.pubKeyFingerprint);
      field(doc, '  ECDSA P-256 sig', s.signature);
      field(doc, '  over body hash', s.signedPayloadHash);
      doc.moveDown(0.2);
    }
  }

}

// ---------------------------------------------------------------- storage ----

/**
 * Encrypt and store the rendered PDF.
 *
 * @returns {Promise<{pdfKey:string, pdfSha256:string, sizeBytes:number}>}
 */
export async function storeCertificatePdf(certificate, pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw Internal('CERTIFICATE_PDF_EMPTY', 'Certificate PDF rendering produced no bytes');
  }

  // The hash of the PLAINTEXT PDF: that is what a verifier can recompute from a
  // copy of the document they were handed.
  const pdfSha256 = sha256Hex(pdfBuffer);
  const pdfKey = certificatePdfKey(certificate._id);

  const { ciphertext, encryption } = sealBuffer(pdfBuffer, certificate.caseId);
  const header = Buffer.from(JSON.stringify(encryption), 'utf8');
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length, 0);

  await ensureVault();
  const target = resolveObjectPath(pdfKey);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  // Write-then-rename: a crash mid-write must not leave a truncated object that
  // would later read as "the certificate was altered".
  const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.part`;
  try {
    await fsp.writeFile(temp, Buffer.concat([MAGIC, headerLength, header, ciphertext]));
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw Internal('CERTIFICATE_PDF_WRITE_FAILED', `Could not store the certificate: ${err.message}`);
  }

  return { pdfKey, pdfSha256, sizeBytes: pdfBuffer.length };
}

/**
 * Read a stored certificate PDF back.
 * @returns {Promise<Buffer|null>} null when the object is missing
 */
export async function readCertificatePdf(certificate) {
  if (!certificate?.pdfKey) return null;

  let raw;
  try {
    raw = await fsp.readFile(resolveObjectPath(certificate.pdfKey));
  } catch {
    return null;
  }

  if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw Internal('CERTIFICATE_PDF_CORRUPT', 'Stored certificate object is not a Lexx PDF blob');
  }
  const headerLength = raw.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > raw.length) {
    throw Internal('CERTIFICATE_PDF_CORRUPT', 'Stored certificate object is truncated');
  }

  const encryption = JSON.parse(raw.subarray(headerStart, headerEnd).toString('utf8'));
  // A GCM tag failure throws here rather than returning altered bytes.
  return openBuffer(raw.subarray(headerEnd), encryption, certificate.caseId);
}

export default {
  renderCertificatePdf,
  storeCertificatePdf,
  readCertificatePdf,
  certificatePdfKey,
  verificationUrlFor,
};
