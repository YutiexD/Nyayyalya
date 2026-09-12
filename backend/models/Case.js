/**
 * A case. Created only from an FIR that already exists in the police directory —
 * there is no free-text case creation (spec §7).
 *
 * `courtId` / `cnrNumber` are null until the chargesheet is filed; a judge therefore
 * has no access to a case still under investigation (ADR-015), which is the legally
 * correct posture rather than an oversight.
 */
import mongoose from 'mongoose';
import { CASE_STAGE, SENSITIVITY_CLASS, COURT_TYPE, values } from './enums.js';

const { Schema } = mongoose;

const JurisdictionSchema = new Schema(
  {
    courtType: { type: String, enum: values(COURT_TYPE) },
    requiredDesignation: { type: String, default: null },
    requiresCommittal: { type: Boolean, default: false },
    /** Human-readable reasoning, shown on screen. This is the "we did the homework" bit. */
    reasons: { type: [String], default: [] },
    computedAt: { type: Date },
  },
  { _id: false }
);

const ClocksSchema = new Schema(
  {
    accusedProducedOn: { type: Date, default: null },
    /** producedOn + 14 days (BNSS s.230) */
    disclosureDueOn: { type: Date, default: null },
    disclosureServedOn: { type: Date, default: null },
    /** maxPunishmentYears >= 7 (BNSS s.176(3)) */
    forensicVisitRequired: { type: Boolean, default: false },
    forensicVisitDoneOn: { type: Date, default: null },
  },
  { _id: false }
);

const CaseSchema = new Schema(
  {
    firNumber: { type: String, required: true, immutable: true, trim: true },
    firDate: { type: Date, required: true, immutable: true },

    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, default: '', maxlength: 5000 },

    // Jurisdiction anchors — copied from the directory FIR, never client-supplied.
    stationCode: { type: String, required: true, immutable: true, index: true },
    districtCode: { type: String, required: true, immutable: true, index: true },
    stateCode: { type: String, required: true, immutable: true },

    bnsSections: { type: [String], default: [] },
    maxPunishmentYears: { type: Number, required: true, min: 0, max: 200 },

    sensitivityClass: {
      type: String,
      enum: values(SENSITIVITY_CLASS),
      default: SENSITIVITY_CLASS.ORDINARY,
    },
    isVictimProtected: { type: Boolean, default: false },

    /** The investigating officer's Lexx user id. Authority to write flows from this. */
    ioUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ioAuthorityId: { type: String, required: true },

    stage: {
      type: String,
      enum: values(CASE_STAGE),
      default: CASE_STAGE.UNDER_INVESTIGATION,
      index: true,
    },

    // ---- court binding: populated only when the chargesheet is filed ----
    cnrNumber: { type: String, default: null, index: true, sparse: true },
    courtId: { type: String, default: null, index: true },
    courtName: { type: String, default: null },
    chargesheetFiledOn: { type: Date, default: null },

    // ---- the end: set when the court closes the case. Nothing is removed. ----
    closedOn: { type: Date, default: null },
    closedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    jurisdictionComputed: { type: JurisdictionSchema, default: null },
    clocks: { type: ClocksSchema, default: () => ({}) },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  },
  { collection: 'cases', timestamps: true, versionKey: false, strict: 'throw' }
);

// One case per FIR. Prevents a second officer creating a duplicate case for one crime.
CaseSchema.index({ firNumber: 1, stationCode: 1 }, { unique: true });
CaseSchema.index({ stationCode: 1, stage: 1 });
CaseSchema.index({ districtCode: 1, stage: 1 });
CaseSchema.index({ ioUserId: 1, stage: 1 });
CaseSchema.index({ createdAt: -1 });
// Full-text search (F12). Always intersected with the resolver's scope filter.
CaseSchema.index(
  { title: 'text', description: 'text', firNumber: 'text' },
  { name: 'case_text', weights: { firNumber: 10, title: 5, description: 1 } }
);

export const Case = mongoose.model('Case', CaseSchema);
export default Case;
