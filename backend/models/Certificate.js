/**
 * BSA s.63 certificate.
 *
 * Part A is the deponent's statement about the device and the manner of production.
 * Part B is the expert's statement, and it can only come from a filed FSL report —
 * Lexx never authors an expert opinion.
 *
 * The generator REFUSES to produce a certificate with missing Part A fields and
 * returns the missing list. Declining to generate an incomplete legal document is
 * the feature, not a limitation.
 */
import mongoose from 'mongoose';
import { SOURCE_TYPE, FORENSIC_OPINION, values } from './enums.js';

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

const SignatureSchema = new Schema(
  {
    role: { type: String, enum: ['PARTY', 'EXPERT'], required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    signerName: { type: String, required: true },
    pubKeyFingerprint: { type: String, required: true },
    /** ECDSA P-256 over the canonical certificate body hash. */
    signature: { type: String, required: true },
    signedPayloadHash: { type: String, required: true },
    signedAt: { type: Date, required: true },
  },
  { _id: false }
);

const CertificateSchema = new Schema(
  {
    evidenceId: { type: Schema.Types.ObjectId, ref: 'Evidence', required: true, immutable: true, index: true },
    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },

    partA: { type: PartASchema, required: true },
    partB: { type: PartBSchema, default: () => ({}) },

    templateVersion: { type: String, default: 'v1.0' },

    generatedAt: { type: Date, default: Date.now },
    generatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },

    pdfKey: { type: String, default: null },
    pdfSha256: { type: String, default: null },

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

CertificateSchema.methods.hasSignature = function hasSignature(role) {
  return this.signatures.some((s) => s.role === role);
};

export const Certificate = mongoose.model('Certificate', CertificateSchema);
export default Certificate;
