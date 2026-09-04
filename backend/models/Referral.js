/**
 * A referral of an exhibit to a forensic science laboratory.
 *
 * This document is what scopes an FSL examiner's world: an examiner sees an exhibit
 * if, and only if, there is a live referral of it to *their* lab. No referral, no
 * visibility — that is the whole inter-departmental boundary.
 */
import mongoose from 'mongoose';
import { REFERRAL_STATUS, FSL_DISCIPLINE, values } from './enums.js';

const { Schema } = mongoose;

const ReferralSchema = new Schema(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },
    evidenceId: { type: Schema.Types.ObjectId, ref: 'Evidence', required: true, immutable: true, index: true },
    exhibitCode: { type: String, required: true, immutable: true },

    /** Lab code from the FSL directory, e.g. UP-FSL-LKO. Scoping key for examiners. */
    labId: { type: String, required: true, immutable: true, index: true },
    labName: { type: String, required: true },
    section79ARef: { type: String, default: null },

    discipline: { type: String, enum: values(FSL_DISCIPLINE), required: true },
    /** What the investigator actually wants answered. */
    questionsPosed: { type: String, default: '', maxlength: 2000 },

    referredByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    referredAt: { type: Date, default: Date.now, immutable: true },

    status: {
      type: String,
      enum: values(REFERRAL_STATUS),
      default: REFERRAL_STATUS.OPEN,
      index: true,
    },

    acceptedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    acceptedAt: { type: Date, default: null },

    reportedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    withdrawalReason: { type: String, default: null },
  },
  { collection: 'referrals', timestamps: true, versionKey: false, strict: 'throw' }
);

// The examiner's dashboard query, and the resolver's FSL branch.
ReferralSchema.index({ labId: 1, status: 1, referredAt: -1 });
ReferralSchema.index({ evidenceId: 1, status: 1 });
// One live referral per exhibit per lab — re-referring must not silently fork the workflow.
ReferralSchema.index(
  { evidenceId: 1, labId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: [REFERRAL_STATUS.OPEN, REFERRAL_STATUS.ACCEPTED] } },
    name: 'unique_live_referral',
  }
);

ReferralSchema.methods.isLive = function isLive() {
  return this.status === REFERRAL_STATUS.OPEN || this.status === REFERRAL_STATUS.ACCEPTED;
};

export const Referral = mongoose.model('Referral', ReferralSchema);
export default Referral;
