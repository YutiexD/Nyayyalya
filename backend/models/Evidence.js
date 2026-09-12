/**
 * An evidence record.
 *
 * Nothing here is ever deleted (spec §13: "Nothing is ever deleted. Status changes,
 * and every change is signed by whoever ordered it."). `courtStatus` and
 * `supersededById` carry what a DELETE would otherwise express.
 *
 * Two independent claims are kept strictly apart:
 *   `triage`   — machine review-prioritisation. Never a verdict, never on-chain.
 *   `forensic` — the ONLY authenticity opinion, produced by a s.79A-notified lab.
 * Collapsing those two is the single most dangerous thing this codebase could do,
 * so they are separate subdocuments with separate vocabularies.
 */
import mongoose from 'mongoose';
import {
  EVIDENCE_KIND,
  SOURCE_TYPE,
  TRIAGE_PRIORITY,
  TRIAGE_DISCLAIMER,
  FORENSIC_STATUS,
  FORENSIC_OPINION,
  COURT_STATUS,
  values,
} from './enums.js';

const { Schema } = mongoose;

const EncryptionSchema = new Schema(
  {
    algo: { type: String, default: 'AES-256-GCM' },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    /** DEK wrapped under the per-case KEK. Useless without MASTER_KEK. */
    wrappedDek: { type: String, required: true },
    wrapIv: { type: String, required: true },
    wrapTag: { type: String, required: true },
    kekId: { type: String, required: true },
  },
  { _id: false }
);

const SourceDeviceSchema = new Schema(
  {
    sourceType: { type: String, enum: values(SOURCE_TYPE), required: true },
    make: { type: String, default: null },
    model: { type: String, default: null },
    colour: { type: String, default: null },
    serialNumber: { type: String, default: null },
    imeiOrUid: { type: String, default: null },
    macAddress: { type: String, default: null },
  },
  { _id: false }
);

/**
 * The machine's review priority. Written once, at ingest, by the system itself.
 *
 * There is no route that sets this and no role that could reach one if there were:
 * a priority a station can raise is a priority that reflects who asked loudest. The
 * only way it changes is a re-ingest, which is a new exhibit.
 */
const TriageSchema = new Schema(
  {
    priority: { type: String, enum: values(TRIAGE_PRIORITY), index: true },
    /** What was observed about the file. Plain sentences, safe to read aloud in court. */
    indicators: { type: [String], default: [] },
    /**
     * The same list with the weight each reason contributed, and whether it is a
     * finding about this file or context about the case. This is the working behind
     * the band — not a confidence, not a probability, and never rendered as one.
     */
    reasons: {
      type: [
        new Schema(
          {
            label: { type: String, required: true },
            weight: { type: Number, required: true },
            kind: { type: String, enum: ['finding', 'context'], default: 'finding' },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    /** Whether a laboratory could say anything useful about this kind of exhibit. */
    examinationRecommended: { type: Boolean, default: false },
    modelName: { type: String },
    modelVersion: { type: String },
    generatedAt: { type: Date },
    /** Immutable text. Never edited, never omitted from a response. */
    disclaimer: { type: String, default: TRIAGE_DISCLAIMER },
  },
  { _id: false }
);

const ForensicSchema = new Schema(
  {
    status: {
      type: String,
      enum: values(FORENSIC_STATUS),
      default: FORENSIC_STATUS.NOT_REFERRED,
    },
    labId: { type: String, default: null },
    labName: { type: String, default: null },
    section79ARef: { type: String, default: null },
    examinerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    examinerName: { type: String, default: null },
    reportFileKey: { type: String, default: null },
    reportSha256: { type: String, default: null },
    reportSignature: { type: String, default: null },
    opinion: { type: String, enum: [...values(FORENSIC_OPINION), null], default: null },
    examinationSummary: { type: String, default: null },
    reportedAt: { type: Date, default: null },
    /**
     * How the opinion reached the register.
     *
     * `REFERRAL` — an exhibit formally referred to this laboratory, accepted, and
     *   reported on, with a signed report document behind it.
     * `DIRECT_REVIEW` — an examiner picked the exhibit off their own review queue,
     *   examined it and recorded a verdict. Same vocabulary, same examiner identity,
     *   same ledger entry; a report document is optional rather than required.
     *
     * The distinction is recorded because a court is entitled to know which one it
     * is reading, and shown on screen for the same reason.
     */
    basis: {
      type: String,
      enum: ['REFERRAL', 'DIRECT_REVIEW', null],
      default: null,
    },
  },
  { _id: false }
);

const AnchorRefSchema = new Schema(
  {
    batchId: { type: String, default: null },
    merkleRoot: { type: String, default: null },
    txHash: { type: String, default: null },
    anchoredAt: { type: Date, default: null },
  },
  { _id: false }
);

const EvidenceSchema = new Schema(
  {
    /** Human readable, printed on the QR label. */
    exhibitCode: { type: String, required: true, unique: true, immutable: true },

    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, default: '', maxlength: 5000 },
    kind: { type: String, enum: values(EVIDENCE_KIND), required: true, immutable: true },

    // ---- integrity: the heart of the system. All immutable after ingest. ----
    /** SHA-256 computed in the browser BEFORE upload. */
    sha256Client: { type: String, required: true, immutable: true },
    /** SHA-256 recomputed on the server from the received bytes. Must match. */
    sha256Server: { type: String, required: true, immutable: true, index: true },
    /** ECDSA P-256 (IEEE P1363) over the sha256Client hex string. */
    signature: { type: String, required: true, immutable: true },
    signerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    signerPubKeyFingerprint: { type: String, required: true, immutable: true },
    /**
     * Snapshot of the public key that ACTUALLY made this signature.
     *
     * Verification must not depend on the signer's *current* key: an officer who
     * replaces a lost device would otherwise invalidate every signature they had
     * ever made, and the system would report FILE_INTACT alongside
     * signatureValid:false on evidence that was never touched. A signature is a
     * statement made at a moment by a specific key, and it stays verifiable against
     * that key forever.
     */
    signerPublicKeyJwk: {
      type: new Schema(
        {
          kty: { type: String, required: true },
          crv: { type: String, required: true },
          x: { type: String, required: true },
          y: { type: String, required: true },
        },
        { _id: false }
      ),
      default: null,
      immutable: true,
    },
    hashMatchedOnIngest: { type: Boolean, required: true, immutable: true },
    signatureValidOnIngest: { type: Boolean, required: true, immutable: true },

    // ---- storage ----
    storageKey: { type: String, required: true, immutable: true },
    sizeBytes: { type: Number, required: true, immutable: true, min: 0 },
    mimeType: { type: String, required: true, immutable: true },
    originalFilename: { type: String, default: null, immutable: true },
    encryption: { type: EncryptionSchema, required: true, immutable: true },

    // ---- BSA s.63 Schedule Part A source fields ----
    sourceDevice: { type: SourceDeviceSchema, required: true },
    capturedAt: { type: Date, default: null },
    capturedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    geo: {
      type: new Schema(
        {
          lat: { type: Number, min: -90, max: 90 },
          lng: { type: Number, min: -180, max: 180 },
          accuracyM: { type: Number, min: 0 },
        },
        { _id: false }
      ),
      default: null,
    },

    triage: { type: TriageSchema, default: null },
    forensic: { type: ForensicSchema, default: () => ({}) },

    courtStatus: {
      type: String,
      enum: values(COURT_STATUS),
      default: COURT_STATUS.NOT_PRODUCED,
    },
    supersededById: { type: Schema.Types.ObjectId, ref: 'Evidence', default: null },

    anchor: { type: AnchorRefSchema, default: () => ({}) },

    /** There is no DELETE anywhere in this system. */
    status: { type: String, enum: ['ACTIVE'], default: 'ACTIVE', immutable: true },

    ledgerSeq: { type: Number, default: null },
    uploadedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  },
  { collection: 'evidence', timestamps: true, versionKey: false, strict: 'throw' }
);

EvidenceSchema.index({ caseId: 1, createdAt: -1 });
EvidenceSchema.index({ caseId: 1, 'triage.priority': 1 });
EvidenceSchema.index({ 'forensic.status': 1, 'forensic.labId': 1 });
EvidenceSchema.index({ 'anchor.batchId': 1 });
EvidenceSchema.index(
  { title: 'text', description: 'text', exhibitCode: 'text' },
  { name: 'evidence_text', weights: { exhibitCode: 10, title: 5, description: 1 } }
);

/** No delete path exists for evidence. Refuse it at the model, as with the ledger. */
const refuseDelete = function refuse(next) {
  const err = new Error(
    'Evidence is never deleted. Change courtStatus or set supersededById instead.'
  );
  err.code = 'EVIDENCE_IMMUTABLE';
  next(err);
};
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete']) {
  EvidenceSchema.pre(op, refuseDelete);
}

export const Evidence = mongoose.model('Evidence', EvidenceSchema);
export default Evidence;
