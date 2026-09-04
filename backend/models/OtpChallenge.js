/**
 * A one-time passcode challenge (ADR-004).
 *
 * Hardening beyond the spec sketch, all of it load-bearing:
 *   - the code is stored only as a SHA-256 hash, so a database read does not yield
 *     a usable OTP;
 *   - `purpose` binds a code to ACTIVATION or LOGIN, so an activation code cannot be
 *     replayed against login;
 *   - `consumedAt` makes it strictly single-use;
 *   - `attempts` caps brute force against a 6-digit space;
 *   - a TTL index removes expired rows without a cron job.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

export const OTP_PURPOSE = Object.freeze({ ACTIVATION: 'ACTIVATION', LOGIN: 'LOGIN' });

const OtpChallengeSchema = new Schema(
  {
    authorityId: { type: String, required: true, index: true },
    purpose: { type: String, enum: Object.values(OTP_PURPOSE), required: true },

    /** sha256(code). The plaintext exists only in the SMS (or the demo response). */
    codeHash: { type: String, required: true },

    /** Masked for display, e.g. "•••••3210". Never the full number. */
    maskedPhone: { type: String, default: null },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },

    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },

    ip: { type: String, default: null },
  },
  { collection: 'otp_challenges', timestamps: true, versionKey: false, strict: 'throw' }
);

// One live challenge per (authorityId, purpose): requesting a new code invalidates the old.
OtpChallengeSchema.index({ authorityId: 1, purpose: 1, consumedAt: 1 });
// MongoDB removes the document once expiresAt passes.
OtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

OtpChallengeSchema.methods.isUsable = function isUsable(at = new Date()) {
  return !this.consumedAt && this.expiresAt > at && this.attempts < this.maxAttempts;
};

export const OtpChallenge = mongoose.model('OtpChallenge', OtpChallengeSchema);
export default OtpChallenge;
