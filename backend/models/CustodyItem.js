/**
 * A physical article, tracked by QR label, linked to its case and — where there is
 * one — to the digital exhibit it is the source of.
 *
 * The custody *history* is not stored here — it lives in the ledger, so that it
 * inherits the hash chain and cannot be quietly rewritten. This document holds only
 * the current state: where the article is, who recorded that, and whether its seal
 * is intact.
 *
 * The journey is deliberately short:
 *
 *   Registered (SEIZED) → Movement recorded (IN_STORE / AT_FSL / IN_COURT) → … →
 *   RETURNED or DESTROYED
 *
 * Every movement is one ledgered act by an officer entitled to record it. There is no
 * pending handshake and no second person whose scan the article waits on.
 */
import mongoose from 'mongoose';
import { CUSTODY_STATUS, CUSTODY_LOCATION, values } from './enums.js';

const { Schema } = mongoose;

const CustodyItemSchema = new Schema(
  {
    itemCode: { type: String, required: true, unique: true, immutable: true },

    caseId: { type: Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true, index: true },
    /**
     * The digital exhibit this article is the source of, if any. Validated to belong
     * to the same case at registration, and at most one article per exhibit.
     */
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
    /**
     * Set on records written before seal numbers were unique within a case. Such a
     * record is kept (nothing is deleted) but excluded from the uniqueness rule, and
     * flagged on screen as a duplicate of an earlier registration.
     */
    duplicateLegacy: { type: Boolean, default: false },

    /** `LEXX:v1:<itemCode>:<HMAC>` — proves the label is genuine, grants no authority (ADR-011). */
    qrPayload: { type: String, required: true, immutable: true },

    /** Denormalised from the case for scope checks without a join. */
    stationCode: { type: String, required: true, immutable: true, index: true },
    districtCode: { type: String, required: true, immutable: true },

    /** The officer who recorded the latest movement — accountable for that entry. */
    currentHolderUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Who physically has it now, as recorded: "Station store, Kavi Nagar", "State FSL, Lucknow". */
    custodian: { type: String, default: null, maxlength: 200 },
    currentLocation: {
      type: String,
      enum: values(CUSTODY_LOCATION),
      default: CUSTODY_LOCATION.FIELD,
    },
    currentLocationDetail: { type: String, default: null },
    lastMovedAt: { type: Date, default: null },

    status: {
      type: String,
      enum: values(CUSTODY_STATUS),
      default: CUSTODY_STATUS.SEIZED,
      index: true,
    },

    /**
     * Set when a seal is reported broken. A frozen item refuses further movement
     * until an SHO records a decision — a broken seal is a chain-of-custody event,
     * not a paperwork inconvenience.
     */
    frozen: { type: Boolean, default: false },
    frozenReason: { type: String, default: null },
    frozenAt: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  },
  { collection: 'custody_items', timestamps: true, versionKey: false, strict: 'throw' }
);

CustodyItemSchema.index({ caseId: 1, status: 1 });
CustodyItemSchema.index({ stationCode: 1, status: 1 });
CustodyItemSchema.index({ districtCode: 1, status: 1 });
// One registration per seal within a case: the same sealed bag booked three times is
// three records of one article, and a chain of custody cannot be told about all three.
CustodyItemSchema.index(
  { caseId: 1, sealNumber: 1 },
  { unique: true, partialFilterExpression: { duplicateLegacy: false }, name: 'unique_seal_per_case' }
);
// At most one physical article is the source of a given digital exhibit.
CustodyItemSchema.index(
  { evidenceId: 1 },
  { unique: true, partialFilterExpression: { evidenceId: { $type: 'objectId' } }, name: 'one_article_per_exhibit' }
);

export const CustodyItem = mongoose.model('CustodyItem', CustodyItemSchema);
export default CustodyItem;
