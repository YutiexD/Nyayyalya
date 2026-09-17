/**
 * Single-use evidence download tokens (ADR-010).
 *
 * The spec called for a "signed 60s URL". A signed URL is a bearer credential: within
 * its window, anyone holding it can use it, and URLs leak through logs, referrer
 * headers, browser history and shared screens.
 *
 * These tokens are instead bound server-side to one user, one evidence record and one
 * purpose, and are consumed atomically on first use.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

export const STREAM_PURPOSE = Object.freeze({
  EVIDENCE: 'EVIDENCE',
  FSL_REPORT: 'FSL_REPORT',
  CERTIFICATE_PDF: 'CERTIFICATE_PDF',
});

const StreamTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },

    /** The token is valid for this user alone. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    purpose: { type: String, enum: Object.values(STREAM_PURPOSE), required: true },

    /** Carried through to the audit row written when the token is redeemed. */
    caseId: { type: Schema.Types.ObjectId, ref: 'Case', default: null },

    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    issuedIp: { type: String, default: null },
  },
  { collection: 'stream_tokens', timestamps: true, versionKey: false, strict: 'throw' }
);

StreamTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StreamToken = mongoose.model('StreamToken', StreamTokenSchema);
export default StreamToken;
