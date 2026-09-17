/**
 * A disclosure pack — LEGACY RECORD.
 *
 * Packs used to decide which exhibits counsel could see. They no longer decide
 * anything: counsel on record read every exhibit of their case directly (see
 * services/accessResolver.js). Existing packs are kept because nothing is deleted and
 * because older ledger entries refer to them; no route creates or serves one.
 *
 * The per-recipient watermark fields that used to live on `servedTo` were removed, and
 * the boot migration strips them from existing documents.
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

    /** BNSS s.230 clock, as recorded when packs were still served. */
    dueOn: { type: Date, default: null },
    servedOn: { type: Date, default: null },
  },
  { collection: 'disclosure_packs', timestamps: true, versionKey: false, strict: 'throw' }
);

DisclosurePackSchema.index({ caseId: 1, status: 1 });

export const DisclosurePack = mongoose.model('DisclosurePack', DisclosurePackSchema);
export default DisclosurePack;
