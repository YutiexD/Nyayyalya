/**
 * Every authorization decision — allow AND deny — lands here.
 *
 * The denials are the interesting ones. A system that only logs successes cannot
 * show you the advocate who tried to read an exhibit outside their disclosure set.
 *
 * Audit rows are written on the request path, so they are deliberately cheap: no
 * joins, denormalised actor fields, and a capped-size payload.
 */
import mongoose from 'mongoose';
import { ACTION, DECISION, RESOURCE_TYPE, values } from './enums.js';

const { Schema } = mongoose;

const AuditEventSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    /** Denormalised so the feed renders without a join, and survives user changes. */
    authorityId: { type: String, default: null },
    authority: { type: String, default: null },
    role: { type: String, default: null },
    actorName: { type: String, default: null },

    action: { type: String, enum: values(ACTION), required: true },
    resourceType: { type: String, enum: values(RESOURCE_TYPE), default: null },
    resourceId: { type: Schema.Types.ObjectId, default: null },
    resourceLabel: { type: String, default: null },
    caseId: { type: Schema.Types.ObjectId, ref: 'Case', default: null, index: true },

    decision: { type: String, enum: values(DECISION), required: true, index: true },
    /** Safe reason code from DENY_REASON. Never free-form detail about the resource. */
    reason: { type: String, default: null },

    method: { type: String, default: null },
    path: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 400 },

    at: { type: Date, default: Date.now, index: true },
  },
  { collection: 'audit_events', versionKey: false, strict: 'throw' }
);

// Dashboard queries: denials for a case, newest first.
AuditEventSchema.index({ caseId: 1, decision: 1, at: -1 });
AuditEventSchema.index({ decision: 1, at: -1 });
AuditEventSchema.index({ userId: 1, at: -1 });

/** Audit rows are evidence about the system itself: never editable, never deletable. */
const refuse = function refuseMutation(next) {
  const err = new Error('Audit events are append-only.');
  err.code = 'AUDIT_IMMUTABLE';
  next(err);
};
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findByIdAndUpdate',
  'findByIdAndDelete',
]) {
  AuditEventSchema.pre(op, refuse);
}

export const AuditEvent = mongoose.model('AuditEvent', AuditEventSchema);
export default AuditEvent;
