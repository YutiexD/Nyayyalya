/**
 * A physical exhibit tracked through the malkhana by QR.
 *
 * The custody *history* is not stored here — it lives in the ledger, so that it
 * inherits the hash chain and cannot be quietly rewritten. This document holds only
 * current state plus the in-flight transfer handshake.
 */
import mongoose from 'mongoose';
import { CUSTODY_STATUS, CUSTODY_LOCATION, values } from './enums.js';

const { Schema } = mongoose;

const PendingTransferSchema = new Schema(
  {
    /** SHA-256 of the transfer token. The plaintext is shown once, never stored. */
    tokenHash: { type: String, required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toStatus: { type: String, enum: values(CUSTODY_STATUS), required: true },
    toLocation: { type: String, enum: values(CUSTODY_LOCATION), required: true },
    reason: { type: String, default: null, maxlength: 500 },
    initiatedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    initiatorSignature: { type: String, default: null },
  },
  { _id: false }
);

const CustodyItemSchema = new Schema(
  {
    itemCode: { type: String, required: true, unique: true, immutable: true },

    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },
    /** Link to the digital record, if this physical item also has one. */
    evidenceId: { type: Schema.Types.ObjectId, ref: 'Evidence', default: null },

    description: { type: String, required: true, maxlength: 1000 },
    identifiers: {
      type: new Schema(
        {
          imei: { type: String, default: null },
          serialNumber: { type: String, default: null },
        },
        { _id: false }
      ),
      default: () => ({}),
    },

    sealNumber: { type: String, required: true },
    sealIntact: { type: Boolean, default: true },

    /** `LEXX:v1:<itemCode>:<HMAC>` — proves the label is genuine, grants no authority (ADR-011). */
    qrPayload: { type: String, required: true, immutable: true },

    /** Denormalised from the case for scope checks without a join. */
    stationCode: { type: String, required: true, immutable: true, index: true },
    districtCode: { type: String, required: true, immutable: true },

    currentHolderUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    currentLocation: {
      type: String,
      enum: values(CUSTODY_LOCATION),
      default: CUSTODY_LOCATION.FIELD,
    },
    currentLocationDetail: { type: String, default: null },

    status: {
      type: String,
      enum: values(CUSTODY_STATUS),
      default: CUSTODY_STATUS.SEIZED,
      index: true,
    },

    /**
     * Set when a seal is reported broken. A frozen item refuses further transfers
     * until an SHO records a decision — a broken seal is a chain-of-custody event,
     * not a paperwork inconvenience.
     */
    frozen: { type: Boolean, default: false },
    frozenReason: { type: String, default: null },
    frozenAt: { type: Date, default: null },

    pendingTransfer: { type: PendingTransferSchema, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  },
  { collection: 'custody_items', timestamps: true, versionKey: false, strict: 'throw' }
);

CustodyItemSchema.index({ caseId: 1, status: 1 });
CustodyItemSchema.index({ stationCode: 1, status: 1 });
// A District SP's scope filter is `{ districtCode }`, and it had no index behind it —
// so the supervisory custody view was a collection scan on every request.
CustodyItemSchema.index({ districtCode: 1, status: 1 });
CustodyItemSchema.index({ 'pendingTransfer.expiresAt': 1 }, { sparse: true });

export const CustodyItem = mongoose.model('CustodyItem', CustodyItemSchema);
export default CustodyItem;
