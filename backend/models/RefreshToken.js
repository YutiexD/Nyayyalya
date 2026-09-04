/**
 * Refresh token records.
 *
 * Stored as a hash, single-use, and rotated on every refresh. Rotation matters:
 * if a stolen refresh token is used, the legitimate holder's next refresh presents
 * an already-consumed token, which we treat as evidence of compromise and use to
 * revoke the whole family. That converts silent theft into a detectable event.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

const RefreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** sha256(token). Plaintext is returned to the client exactly once. */
    tokenHash: { type: String, required: true, unique: true },

    /** Rotation lineage. All members are revoked together on reuse detection. */
    familyId: { type: String, required: true, index: true },

    consumedAt: { type: Date, default: null },
    /** Set when this token is rotated; points at its successor. */
    replacedByHash: { type: String, default: null },

    revokedAt: { type: Date, default: null },
    revocationReason: { type: String, default: null },

    expiresAt: { type: Date, required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 400 },
  },
  { collection: 'refresh_tokens', timestamps: true, versionKey: false, strict: 'throw' }
);

RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
RefreshTokenSchema.index({ userId: 1, revokedAt: 1 });

RefreshTokenSchema.methods.isUsable = function isUsable(at = new Date()) {
  return !this.consumedAt && !this.revokedAt && this.expiresAt > at;
};

export const RefreshToken = mongoose.model('RefreshToken', RefreshTokenSchema);
export default RefreshToken;
