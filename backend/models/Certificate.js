/**
 * BSA s.63 certificate.
 *
 * Since template v3.0 the certificate is issued AUTOMATICALLY when an electronic record
 * is uploaded, and signed by the LEXX Certificate Authority (a server-held ECDSA P-256
 * key — services/systemSigner.js). Nobody generates, signs or manages it by hand.
 *
 *   Part A — particulars of the record, filled from the evidence record and the
 *            uploading officer, on whose behalf the certificate is issued. Particulars
 *            not recorded at upload are rendered "Not recorded" and never block issue.
 *   Part B — the hash values computed at ingest, attested by the system. It carries no
 *            forensic verdict; a laboratory opinion is a separate record.
 *
 * Earlier templates (v1.0, v2.0 — deponent and examiner signatures collected in the
 * browser) are kept for history. The boot migration supersedes any that were still
 * ACTIVE and issues a v3.0 certificate in their place.
 */
import mongoose from 'mongoose';
import { SOURCE_TYPE, FORENSIC_OPINION, CERTIFICATE_STATUS, values } from './enums.js';

const { Schema } = mongoose;

const PartASchema = new Schema(
  {
    deponentName: { type: String, default: null },
    deponentDesignation: { type: String, default: null },
    deponentAuthorityId: { type: String, default: null },
    sourceType: { type: String, enum: [...values(SOURCE_TYPE), null], default: null },
    make: { type: String, default: null },
    model: { type: String, default: null },
    colour: { type: String, default: null },
    serialNumber: { type: String, default: null },
    imeiOrUid: { type: String, default: null },
    hashValue: { type: String, default: null },
    hashAlgorithm: { type: String, default: 'SHA-256' },
    /** Prose rendered from the ledger timeline — not free text typed by a user. */
    mannerOfProduction: { type: String, default: null },
    conditionsStatement: { type: String, default: null },
  },
  { _id: false }
);

const PartBSchema = new Schema(
  {
    // ---- v3.0: hash attestation by the system ----
    attestedBy: { type: String, default: null },
    hashAlgorithm: { type: String, default: null },
    sha256Client: { type: String, default: null },
    sha256Server: { type: String, default: null },
    hashesMatch: { type: Boolean, default: null },
    hashComputedAt: { type: Date, default: null },
    statement: { type: String, default: null },

    // ---- v1.0 / v2.0 only: an expert's statement reproduced from a filed report ----
    expertName: { type: String, default: null },
    labName: { type: String, default: null },
    section79ARef: { type: String, default: null },
    examinationSummary: { type: String, default: null },
    expertOpinion: { type: String, enum: [...values(FORENSIC_OPINION), null], default: null },
    reportSha256: { type: String, default: null },
    reportedAt: { type: Date, default: null },
  },
  { _id: false }
);

const JwkSchema = new Schema({ kty: String, crv: String, x: String, y: String }, { _id: false });

/** Legacy (v1.0 / v2.0) user signatures. Never written by v3.0. */
const SignatureSchema = new Schema(
  {
    role: { type: String, enum: ['PARTY', 'EXPERT'], required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    signerName: { type: String, required: true },
    pubKeyFingerprint: { type: String, required: true },
    signature: { type: String, required: true },
    signedPayloadHash: { type: String, required: true },
    signedAt: { type: Date, required: true },
    publicKeyJwk: { type: JwkSchema, default: null },
  },
  { _id: false }
);

/** The LEXX Certificate Authority's signature over `certificateHash`. */
const SystemSignatureSchema = new Schema(
  {
    signerLabel: { type: String, required: true },
    algorithm: { type: String, required: true },
    keyFingerprint: { type: String, required: true },
    publicKeyJwk: { type: JwkSchema, required: true },
    signedPayloadHash: { type: String, required: true },
    signature: { type: String, required: true },
    signedAt: { type: Date, required: true },
  },
  { _id: false }
);

const IssuedOnBehalfOfSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: null },
    authorityId: { type: String, default: null },
    role: { type: String, default: null },
    designation: { type: String, default: null },
  },
  { _id: false }
);

const LastVerificationSchema = new Schema(
  {
    result: { type: String, enum: ['VERIFIED', 'FAILED'], required: true },
    at: { type: Date, required: true },
    byRole: { type: String, default: null },
  },
  { _id: false }
);

const CertificateSchema = new Schema(
  {
    evidenceId: { type: Schema.Types.ObjectId, ref: 'Evidence', required: true, immutable: true, index: true },
    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },
    exhibitCode: { type: String, default: null },

    partA: { type: PartASchema, required: true },
    partB: { type: PartBSchema, default: () => ({}) },

    /**
     * v1.0 / v2.0 — signed in the browser by the deponent (Part A) and examiner (Part B).
     * v3.0        — issued on upload and signed by the LEXX Certificate Authority.
     */
    templateVersion: { type: String, default: 'v3.0' },

    /** One ACTIVE certificate per exhibit — see the partial unique index below. */
    status: {
      type: String,
      enum: values(CERTIFICATE_STATUS),
      default: CERTIFICATE_STATUS.ACTIVE,
      index: true,
    },
    supersededById: { type: Schema.Types.ObjectId, ref: 'Certificate', default: null },
    supersededAt: { type: Date, default: null },
    supersededReason: { type: String, default: null },

    generatedAt: { type: Date, default: Date.now },
    generatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },

    /** v3.0: the uploading officer, on whose behalf the system issued the certificate. */
    issuedOnBehalfOf: { type: IssuedOnBehalfOfSchema, default: null },
    /** v3.0: when the system signature and the ledger record of issue were both written. */
    issuedAt: { type: Date, default: null },
    /** v3.0: canonical hash of (body hash, PDF SHA-256, authority key) — what is signed. */
    certificateHash: { type: String, default: null },
    systemSignature: { type: SystemSignatureSchema, default: null },
    /** v3.0: ledger sequence of the CERTIFICATE_GENERATED entry. */
    issuanceLedgerSeq: { type: Number, default: null },
    /** v3.0: short lease so two processes never finish issuing the same certificate twice. */
    issuanceLockedUntil: { type: Date, default: null },
    lastVerification: { type: LastVerificationSchema, default: null },

    pdfKey: { type: String, default: null },
    pdfSha256: { type: String, default: null },
    /** Legacy: digests of earlier renders of a v1.0/v2.0 certificate. */
    pdfHistory: {
      type: [
        new Schema(
          { sha256: { type: String, required: true }, supersededAt: { type: Date, required: true } },
          { _id: false }
        ),
      ],
      default: [],
    },

    signatures: { type: [SignatureSchema], default: [] },

    /**
     * Goes in the QR printed on the PDF. High-entropy and unguessable, because it is
     * the sole credential on the public verification endpoint.
     */
    verificationToken: { type: String, required: true, unique: true, immutable: true },

    partAComplete: { type: Boolean, default: false },
    partBComplete: { type: Boolean, default: false },
  },
  { collection: 'certificates', timestamps: true, versionKey: false, strict: 'throw' }
);

CertificateSchema.index({ evidenceId: 1, createdAt: -1 });
/**
 * THE rule: one active s.63 certificate per exhibit. Enforced by the database, so two
 * simultaneous issuance attempts cannot both succeed — the losing insert fails with a
 * duplicate-key error and the issuer returns the certificate that already exists.
 */
CertificateSchema.index(
  { evidenceId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: CERTIFICATE_STATUS.ACTIVE },
    name: 'one_active_certificate_per_evidence',
  }
);

CertificateSchema.methods.hasSignature = function hasSignature(role) {
  return this.signatures.some((s) => s.role === role);
};

export const Certificate = mongoose.model('Certificate', CertificateSchema);
export default Certificate;
