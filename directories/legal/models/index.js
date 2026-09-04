/**
 * Legal & FSL directory schemas — the Bar Council + FSL LIMS stand-in
 * (db `dir_legal`).
 *
 * Field names follow §3.3 of the technical design exactly, with two additions,
 * both forced by requirements elsewhere in the spec and both documented here:
 *
 *   advocates.districtCode / districtName
 *       §3.3 lists `/directory/legal-aid-panel?district=` but the advocate schema
 *       carries no district. A panel is empanelled with a District Legal Services
 *       Authority, so the district belongs on the advocate.
 *
 *   phone (advocates, examiners)
 *       §4.1 sends the activation OTP to "the phone on record in the directory".
 *       Every person in every directory therefore has one.
 */
import { mongoose } from '../../../shared/mongo.js';

const { Schema } = mongoose;

const opts = { versionKey: false, timestamps: true };

export const ADVOCATE_STATUSES = ['ACTIVE', 'SUSPENDED'];
export const EXAMINER_STATUSES = ['ACTIVE', 'SUSPENDED', 'RETIRED'];
export const DISCIPLINES = ['MOBILE_FORENSICS', 'MEDIA_FORENSICS', 'COMPUTER_FORENSICS'];

const advocateSchema = new Schema(
  {
    enrolmentNo: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    barCouncil: { type: String, required: true },
    enrolmentDate: { type: Date, required: true },
    // Certificate of practice. An advocate whose COP has lapsed is still a real
    // advocate — they are returned with 200 and the real date, and Lexx refuses
    // the login. The directory reports; it does not decide.
    copValidTill: { type: Date, required: true },
    status: { type: String, enum: ADVOCATE_STATUSES, required: true, index: true },
    isLegalAidPanel: { type: Boolean, default: false, index: true },
    districtCode: { type: String, required: true, index: true },
    districtName: { type: String, required: true },
    phone: { type: String, required: true },
  },
  { ...opts, collection: 'advocates' }
);
advocateSchema.index({ isLegalAidPanel: 1, districtCode: 1 });

const fslLabSchema = new Schema(
  {
    labCode: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    // The legitimacy anchor: IT Act s.79A notification of this lab as an examiner
    // of electronic evidence. It ends up in Part B of the s.63 certificate.
    section79ANotificationRef: { type: String, required: true },
    disciplines: { type: [String], default: [] },
    stateCode: { type: String, required: true, index: true },
  },
  { ...opts, collection: 'fsl_labs' }
);

const fslExaminerSchema = new Schema(
  {
    examinerCode: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    labId: { type: Schema.Types.ObjectId, ref: 'FslLab', required: true, index: true },
    disciplines: { type: [String], default: [] },
    status: { type: String, enum: EXAMINER_STATUSES, required: true },
    phone: { type: String, required: true },
  },
  { ...opts, collection: 'fsl_examiners' }
);

export const Advocate = mongoose.model('Advocate', advocateSchema);
export const FslLab = mongoose.model('FslLab', fslLabSchema);
export const FslExaminer = mongoose.model('FslExaminer', fslExaminerSchema);

export const models = [Advocate, FslLab, FslExaminer];
