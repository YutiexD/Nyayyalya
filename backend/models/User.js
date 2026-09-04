/**
 * A Lexx user account.
 *
 * Lexx holds no identities of its own. Every field that confers authority —
 * `authority`, `role`, `scope` — is written from an authority directory response and
 * is NEVER accepted from a request body. The `select: false` on secrets means an
 * accidental `res.json(user)` cannot leak them.
 */
import mongoose from 'mongoose';
import {
  AUTHORITY,
  ROLE,
  USER_STATUS,
  CREATED_VIA,
  ROLES_BY_AUTHORITY,
  values,
} from './enums.js';

const { Schema } = mongoose;

const ScopeSchema = new Schema(
  {
    stationCode: { type: String, default: null },
    districtCode: { type: String, default: null },
    stateCode: { type: String, default: null },
    courtId: { type: String, default: null },
    labId: { type: String, default: null },
  },
  { _id: false }
);

const PublicKeySchema = new Schema(
  {
    kty: { type: String, required: true },
    crv: { type: String, required: true },
    x: { type: String, required: true },
    y: { type: String, required: true },
  },
  { _id: false }
);

const UserSchema = new Schema(
  {
    /** PIS id / judge code / enrolment no / examiner code. The login identifier. */
    authorityId: { type: String, required: true, unique: true, immutable: true, trim: true },

    authority: { type: String, required: true, enum: values(AUTHORITY) },
    role: { type: String, required: true, enum: values(ROLE) },
    name: { type: String, required: true, trim: true },

    passwordHash: { type: String, required: true, select: false },

    /** ECDSA P-256 public key registered at activation. Private key never leaves the browser. */
    publicKeyJwk: { type: PublicKeySchema, default: null },
    publicKeyFingerprint: { type: String, default: null, index: true },

    scope: { type: ScopeSchema, required: true, default: () => ({}) },

    /** Last successful live directory re-verification. Spec §4.2 step 4. */
    directoryLastVerifiedAt: { type: Date, default: null },

    status: { type: String, enum: values(USER_STATUS), default: USER_STATUS.ACTIVE, index: true },

    createdVia: { type: String, enum: values(CREATED_VIA), required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /** Contact on record in the directory. Stored masked-safe; used for OTP delivery. */
    phone: { type: String, default: null, select: false },

    lastLoginAt: { type: Date, default: null },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { collection: 'users', timestamps: true, versionKey: false, strict: 'throw' }
);

UserSchema.index({ authority: 1, role: 1 });
UserSchema.index({ 'scope.stationCode': 1 });
UserSchema.index({ 'scope.districtCode': 1 });
UserSchema.index({ 'scope.courtId': 1 });
UserSchema.index({ 'scope.labId': 1 });

/** Role must be legal for the authority. Defence in depth behind the auth controller. */
UserSchema.pre('validate', function validateRoleAuthority(next) {
  const allowed = ROLES_BY_AUTHORITY[this.authority] ?? [];
  if (!allowed.includes(this.role)) {
    return next(
      new Error(`Role '${this.role}' is not valid for authority '${this.authority}'`)
    );
  }
  next();
});

UserSchema.methods.isActive = function isActive() {
  return this.status === USER_STATUS.ACTIVE;
};

UserSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

/** Safe projection for API responses and JWT construction. */
UserSchema.methods.toSessionContext = function toSessionContext() {
  return {
    userId: String(this._id),
    authorityId: this.authorityId,
    authority: this.authority,
    role: this.role,
    name: this.name,
    scope: {
      stationCode: this.scope?.stationCode ?? null,
      districtCode: this.scope?.districtCode ?? null,
      stateCode: this.scope?.stateCode ?? null,
      courtId: this.scope?.courtId ?? null,
      labId: this.scope?.labId ?? null,
    },
    status: this.status,
    publicKeyFingerprint: this.publicKeyFingerprint,
    directoryLastVerifiedAt: this.directoryLastVerifiedAt,
  };
};

export const User = mongoose.model('User', UserSchema);
export default User;
