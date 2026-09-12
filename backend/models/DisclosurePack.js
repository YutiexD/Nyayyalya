/**
 * A disclosure pack: exactly what has been served on a party, and to whom.
 *
 * This is the document the advocate-scoping decision reads. An exhibit that is not
 * in `exhibitIds` of a SERVED pack is not visible to defence counsel, and the
 * attempt is logged. That denial is the confidentiality guarantee made concrete.
 */
import mongoose from 'mongoose';
import { DISCLOSURE_STATUS, values } from './enums.js';

const { Schema } = mongoose;

const ExcludedItemSchema = new Schema(
  {
    itemId: { type: Schema.Types.ObjectId, required: true },
    itemType: { type: String, enum: ['EVIDENCE', 'DOCUMENT'], default: 'EVIDENCE' },
    reason: { type: String, required: true, maxlength: 1000 },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedByRegistrarId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    /**
     * The other ruling. A court that disagrees with a withholding request must be
     * able to say so — otherwise the only way to serve a pack is to agree with every
     * exclusion in it. A refused exclusion puts the exhibit back into the served set.
     */
    refusedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    refusedAt: { type: Date, default: null },
    refusalNote: { type: String, default: null, maxlength: 1000 },
  },
  { _id: false }
);

const ServedToSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    servedAt: { type: Date, required: true },
    /**
     * Per-recipient watermark identity. Rendered onto served pages, so a leaked
     * document points back to the recipient it was served to.
     */
    watermarkToken: { type: String, required: true },
    watermarkLabel: { type: String, required: true },
    acknowledgedAt: { type: Date, default: null },
  },
  { _id: false }
);

const DisclosurePackSchema = new Schema(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },
    cnrNumber: { type: String, default: null },

    exhibitIds: { type: [Schema.Types.ObjectId], default: [] },
    documentIds: { type: [Schema.Types.ObjectId], default: [] },

    excludedItems: { type: [ExcludedItemSchema], default: [] },

    redactionVariant: { type: String, default: 'DEFENCE_V1' },
    maskVictimIdentity: { type: Boolean, default: false },

    preparedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    approvedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    servedTo: { type: [ServedToSchema], default: [] },

    status: {
      type: String,
      enum: values(DISCLOSURE_STATUS),
      default: DISCLOSURE_STATUS.DRAFT,
      index: true,
    },

    /** BNSS s.230 clock. */
    dueOn: { type: Date, default: null },
    servedOn: { type: Date, default: null },
  },
  { collection: 'disclosure_packs', timestamps: true, versionKey: false, strict: 'throw' }
);

DisclosurePackSchema.index({ caseId: 1, status: 1 });
DisclosurePackSchema.index({ 'servedTo.userId': 1 });
DisclosurePackSchema.index({ 'servedTo.watermarkToken': 1 }, { sparse: true });

/** The served exhibit set for a specific recipient, or null if not served to them. */
DisclosurePackSchema.methods.servedEntryFor = function servedEntryFor(userId) {
  const id = String(userId);
  return this.servedTo.find((s) => String(s.userId) === id) ?? null;
};

export const DisclosurePack = mongoose.model('DisclosurePack', DisclosurePackSchema);
export default DisclosurePack;
