/**
 * A vakalatnama filed with the court THROUGH Lexx.
 *
 * Filing is not access. A filing is a request put before the court registry, and it
 * grants its author nothing: the advocate still cannot see the case, a single exhibit,
 * or even whether the registry has looked at it yet beyond the status on their own
 * filing. Only a registrar's acceptance puts them on record, and that acceptance is
 * recorded in the court's own register first (see controllers/vakalatnama.js) so the
 * court directory stays the source of truth for who represents whom.
 *
 * Nothing is ever deleted. A refused filing stays here with the registrar's reason.
 */
import mongoose from 'mongoose';
import { VAKALATNAMA_STATUS, APPEARING_FOR, values } from './enums.js';

const { Schema } = mongoose;

const VakalatnamaFilingSchema = new Schema(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },
    /** Public court identifiers, copied from the case at filing so the registry can read them. */
    cnrNumber: { type: String, required: true, immutable: true, index: true },
    firNumber: { type: String, default: null, immutable: true },
    courtId: { type: String, required: true, immutable: true, index: true },

    advocateUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
    /** Bar Council enrolment number — the key the court register is written under. */
    advocateAuthorityId: { type: String, required: true, immutable: true },
    advocateName: { type: String, default: null, immutable: true },

    appearingFor: { type: String, enum: values(APPEARING_FOR), required: true, immutable: true },
    /** The party executing the vakalatnama, as named in the document. */
    partyName: { type: String, required: true, immutable: true, maxlength: 120 },

    // ---- the signed document ----
    documentKey: { type: String, required: true, immutable: true },
    documentSha256: { type: String, required: true, immutable: true },
    documentSignature: { type: String, required: true, immutable: true },
    documentSizeBytes: { type: Number, required: true, immutable: true },
    signerPubKeyFingerprint: { type: String, default: null, immutable: true },

    filedAt: { type: Date, default: Date.now, immutable: true },

    status: {
      type: String,
      enum: values(VAKALATNAMA_STATUS),
      default: VAKALATNAMA_STATUS.PENDING,
      index: true,
    },

    decidedAt: { type: Date, default: null },
    decidedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedByAuthorityId: { type: String, default: null },
    /** Required on refusal: an advocate is entitled to know why they were not taken on record. */
    decisionNote: { type: String, default: null, maxlength: 1000 },
    /** The access grant an acceptance produced. */
    grantId: { type: Schema.Types.ObjectId, ref: 'CaseAccessGrant', default: null },
  },
  { collection: 'vakalatnama_filings', timestamps: true, versionKey: false, strict: 'throw' }
);

VakalatnamaFilingSchema.index({ courtId: 1, status: 1, filedAt: -1 });
// One live filing per advocate, per side, per case. A second PENDING filing for the
// same appearance would put two competing documents before the registry.
VakalatnamaFilingSchema.index(
  { caseId: 1, advocateUserId: 1, appearingFor: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [VAKALATNAMA_STATUS.PENDING, VAKALATNAMA_STATUS.ACCEPTED] },
    },
    name: 'unique_live_vakalatnama',
  }
);

export const VakalatnamaFiling = mongoose.model('VakalatnamaFiling', VakalatnamaFilingSchema);
export default VakalatnamaFiling;
