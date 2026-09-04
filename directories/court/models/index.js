/**
 * Court directory schemas — the eCourts stand-in (db `dir_court`).
 *
 * Field names follow §3.2 of the technical design exactly.
 *
 * Two collections here answer questions Lexx must never answer for itself:
 *   roster       — who sits in which court. Lexx reads it; it never assigns a judge.
 *   vakalatnamas — which advocate is on record for which case. Lexx reads it; it
 *                  never grants case access to a lawyer on its own authority.
 */
import { mongoose } from '../../../shared/mongo.js';

const { Schema } = mongoose;

const opts = { versionKey: false, timestamps: true };

export const COURT_TYPES = ['MAGISTRATE', 'SESSIONS', 'SPECIAL'];
export const SERVICE_STATUSES = ['ACTIVE', 'SUSPENDED', 'RETIRED', 'TRANSFERRED'];
export const REGISTRY_ROLES = ['REGISTRAR', 'EVIDENCE_CUSTODIAN'];
export const APPEARING_FOR = ['ACCUSED', 'VICTIM'];
export const VAKALATNAMA_STATUSES = ['ACCEPTED', 'WITHDRAWN'];
export const LEGAL_AID_STATUSES = ['ACTIVE', 'CLOSED'];
export const CASE_STAGES = ['FILED', 'COMMITTED', 'TRIAL', 'DISPOSED'];

const courtSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    courtType: { type: String, enum: COURT_TYPES, required: true, index: true },
    designations: { type: [String], default: [] },
    districtCode: { type: String, required: true, index: true },
    stateCode: { type: String, required: true },
  },
  { ...opts, collection: 'courts' }
);
courtSchema.index({ districtCode: 1, courtType: 1 });

const judgeSchema = new Schema(
  {
    judgeCode: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    designation: { type: String, required: true },
    serviceStatus: { type: String, enum: SERVICE_STATUSES, required: true },
    phone: { type: String, required: true },
  },
  { ...opts, collection: 'judges' }
);

/**
 * The roster. A judge's court is not a property of the judge — it is a property of
 * the roster order that is current today. `GET /directory/judge/:code/court` reads
 * exactly this, which is why a rotated judge loses their court scope on next login.
 */
const rosterSchema = new Schema(
  {
    courtId: { type: Schema.Types.ObjectId, ref: 'Court', required: true, index: true },
    judgeId: { type: Schema.Types.ObjectId, ref: 'Judge', required: true, index: true },
    caseCategories: { type: [String], default: [] },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, default: null },
    rosterOrderRef: { type: String, required: true },
  },
  { ...opts, collection: 'roster' }
);
// The validity-window lookup for one judge.
rosterSchema.index({ judgeId: 1, validFrom: -1, validTo: 1 });
rosterSchema.index({ rosterOrderRef: 1, judgeId: 1, courtId: 1 }, { unique: true });

const caseListingSchema = new Schema(
  {
    cnrNumber: { type: String, required: true, unique: true, index: true },
    firNumber: { type: String, required: true, index: true },
    stationCode: { type: String, required: true, index: true },
    courtId: { type: Schema.Types.ObjectId, ref: 'Court', required: true, index: true },
    caseCategory: { type: String, required: true },
    listedOn: { type: Date, required: true },
    stage: { type: String, enum: CASE_STAGES, required: true },
  },
  { ...opts, collection: 'case_listings' }
);

const registryStaffSchema = new Schema(
  {
    staffCode: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    courtId: { type: Schema.Types.ObjectId, ref: 'Court', required: true, index: true },
    role: { type: String, enum: REGISTRY_ROLES, required: true },
    serviceStatus: { type: String, enum: SERVICE_STATUSES, required: true },
    phone: { type: String, required: true },
  },
  { ...opts, collection: 'registry_staff' }
);

const vakalatnamaSchema = new Schema(
  {
    cnrNumber: { type: String, required: true, index: true },
    advocateEnrolmentNo: { type: String, required: true, index: true },
    appearingFor: { type: String, enum: APPEARING_FOR, required: true },
    partyName: { type: String, required: true },
    filedOn: { type: Date, required: true },
    acceptedByRegistrar: { type: String, default: null },
    acceptedOn: { type: Date, default: null },
    status: { type: String, enum: VAKALATNAMA_STATUSES, required: true, index: true },
  },
  { ...opts, collection: 'vakalatnamas' }
);
// One advocate can be on record once per party side per case.
vakalatnamaSchema.index(
  { cnrNumber: 1, advocateEnrolmentNo: 1, appearingFor: 1 },
  { unique: true }
);

const legalAidAssignmentSchema = new Schema(
  {
    cnrNumber: { type: String, required: true, index: true },
    advocateEnrolmentNo: { type: String, required: true, index: true },
    courtOrderRef: { type: String, required: true, unique: true },
    dlsaRef: { type: String, required: true },
    assignedOn: { type: Date, required: true },
    status: { type: String, enum: LEGAL_AID_STATUSES, required: true },
  },
  { ...opts, collection: 'legal_aid_assignments' }
);

export const Court = mongoose.model('Court', courtSchema);
export const Judge = mongoose.model('Judge', judgeSchema);
export const Roster = mongoose.model('Roster', rosterSchema);
export const CaseListing = mongoose.model('CaseListing', caseListingSchema);
export const RegistryStaff = mongoose.model('RegistryStaff', registryStaffSchema);
export const Vakalatnama = mongoose.model('Vakalatnama', vakalatnamaSchema);
export const LegalAidAssignment = mongoose.model('LegalAidAssignment', legalAidAssignmentSchema);

export const models = [
  Court,
  Judge,
  Roster,
  CaseListing,
  RegistryStaff,
  Vakalatnama,
  LegalAidAssignment,
];
