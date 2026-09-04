/**
 * Police directory schemas — the CCTNS stand-in (db `dir_police`).
 *
 * Field names follow §3.1 of the technical design exactly. Nothing here is ever
 * written by Lexx; these documents are created by the seed only, which is how a
 * real CCTNS extract would arrive.
 *
 * Indexes are declared here and built explicitly at boot by syncIndexes(), because
 * shared/mongo.js turns autoIndex off.
 */
import { mongoose } from '../../../shared/mongo.js';

const { Schema } = mongoose;

const opts = { versionKey: false, timestamps: true };

export const RANKS = ['CONSTABLE', 'HEAD_CONSTABLE', 'SUB_INSPECTOR', 'INSPECTOR', 'DSP', 'SP'];
export const SERVICE_STATUSES = ['ACTIVE', 'SUSPENDED', 'RETIRED', 'TRANSFERRED'];
export const POSTING_ROLES = ['IO', 'SHO', 'MALKHANA_CUSTODIAN', 'DISTRICT_SP'];
export const SENSITIVITY_CLASSES = [
  'ORDINARY',
  'POCSO',
  'SEXUAL_OFFENCE',
  'SC_ST',
  'NDPS',
  'JUVENILE',
];

const officerSchema = new Schema(
  {
    // The login identifier. Unique — this is what Lexx verifies against.
    pisId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    rank: { type: String, enum: RANKS, required: true },
    currentPostingId: { type: Schema.Types.ObjectId, ref: 'Posting', default: null },
    serviceStatus: { type: String, enum: SERVICE_STATUSES, required: true, index: true },
    // Phone on record: the OTP in the Lexx activation flow goes here, never to a
    // number supplied in the request body.
    phone: { type: String, required: true },
    aadhaarLast4: { type: String, required: true },
  },
  { ...opts, collection: 'officers' }
);

const stationSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    districtCode: { type: String, required: true, index: true },
    districtName: { type: String, required: true },
    rangeCode: { type: String, required: true },
    stateCode: { type: String, required: true, index: true },
    jurisdictionPolygon: { type: Schema.Types.Mixed, default: null },
  },
  { ...opts, collection: 'stations' }
);

/**
 * Postings are what make Lexx access expire on its own. A transferred officer's
 * posting gets a validTo; the next login re-reads this collection and the officer
 * loses their station scope without anyone in Lexx doing anything.
 */
const postingSchema = new Schema(
  {
    officerId: { type: Schema.Types.ObjectId, ref: 'Officer', required: true, index: true },
    stationId: { type: Schema.Types.ObjectId, ref: 'Station', required: true, index: true },
    role: { type: String, enum: POSTING_ROLES, required: true },
    orderNumber: { type: String, required: true, unique: true },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, default: null },
  },
  { ...opts, collection: 'postings' }
);

// The "current posting" lookup: newest validity window for one officer.
postingSchema.index({ officerId: 1, validFrom: -1 });
postingSchema.index({ officerId: 1, validTo: 1 });

const firSchema = new Schema(
  {
    firNumber: { type: String, required: true, unique: true, index: true },
    firDate: { type: Date, required: true },
    stationId: { type: Schema.Types.ObjectId, ref: 'Station', required: true, index: true },
    districtCode: { type: String, required: true, index: true },
    stateCode: { type: String, required: true },
    bnsSections: { type: [String], default: [] },
    // Precomputed so the jurisdiction router never has to interpret a statute.
    maxPunishmentYears: { type: Number, required: true },
    complainantName: { type: String, required: true },
    accusedNames: { type: [String], default: [] },
    ioOfficerId: { type: Schema.Types.ObjectId, ref: 'Officer', required: true, index: true },
    isVictimProtected: { type: Boolean, default: false },
    sensitivityClass: { type: String, enum: SENSITIVITY_CLASSES, default: 'ORDINARY' },
  },
  { ...opts, collection: 'firs' }
);

firSchema.index({ stationId: 1, firDate: -1 });
firSchema.index({ ioOfficerId: 1, firDate: -1 });

export const Officer = mongoose.model('Officer', officerSchema);
export const Station = mongoose.model('Station', stationSchema);
export const Posting = mongoose.model('Posting', postingSchema);
export const Fir = mongoose.model('Fir', firSchema);

export const models = [Officer, Station, Posting, Fir];
