/**
 * Who is on record for a case, and on what basis.
 *
 * A grant is never invented by Lexx. It is created from an authority-directory fact:
 * a posting order, an accepted vakalatnama, a legal-aid order, a roster entry.
 * `grantRef` records the external document so the grant is traceable back to it.
 *
 * Revocation is `revokedAt`, not deletion — a withdrawn vakalatnama is part of the
 * case history and must stay auditable.
 */
import mongoose from 'mongoose';
import { ROLE, GRANT_BASIS, values } from './enums.js';

const { Schema } = mongoose;

const CaseAccessGrantSchema = new Schema(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },

    role: { type: String, enum: values(ROLE), required: true, immutable: true },
    grantBasis: { type: String, enum: values(GRANT_BASIS), required: true, immutable: true },
    /** External reference: vakalatnama no, posting order no, court order ref. */
    grantRef: { type: String, required: true, immutable: true },

    grantedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },

    validFrom: { type: Date, required: true, default: Date.now },
    validTo: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revocationReason: { type: String, default: null },
  },
  { collection: 'case_access_grants', timestamps: true, versionKey: false, strict: 'throw' }
);

// The resolver's hot path: "is this user on record for this case, right now?"
CaseAccessGrantSchema.index({ caseId: 1, userId: 1, revokedAt: 1 });
CaseAccessGrantSchema.index({ userId: 1, revokedAt: 1 });
// One live grant per (case, user, role) — prevents duplicate grants masking a revocation.
CaseAccessGrantSchema.index(
  { caseId: 1, userId: 1, role: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } }
);

/** True if the grant confers access at `at`. */
CaseAccessGrantSchema.methods.isLiveAt = function isLiveAt(at = new Date()) {
  if (this.revokedAt) return false;
  if (this.validFrom && this.validFrom > at) return false;
  if (this.validTo && this.validTo < at) return false;
  return true;
};

export const CaseAccessGrant = mongoose.model('CaseAccessGrant', CaseAccessGrantSchema);
export default CaseAccessGrant;
