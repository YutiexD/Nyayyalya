/**
 * Model registry. Importing this file registers every schema with mongoose exactly
 * once, and gives the boot sequence a single list to build indexes from.
 */
export { User } from './User.js';
export { Case } from './Case.js';
export { Evidence } from './Evidence.js';
export { CustodyItem } from './CustodyItem.js';
export { Ledger, LedgerImmutableError } from './Ledger.js';
export { Counter } from './Counter.js';
export { CaseAccessGrant } from './CaseAccessGrant.js';
export { DisclosurePack } from './DisclosurePack.js';
export { AuditEvent } from './AuditEvent.js';
export { AnchorBatch } from './AnchorBatch.js';
export { Certificate } from './Certificate.js';
export { Referral } from './Referral.js';
export { OtpChallenge, OTP_PURPOSE } from './OtpChallenge.js';
export { RefreshToken } from './RefreshToken.js';
export { StreamToken, STREAM_PURPOSE } from './StreamToken.js';

import { User } from './User.js';
import { Case } from './Case.js';
import { Evidence } from './Evidence.js';
import { CustodyItem } from './CustodyItem.js';
import { Ledger } from './Ledger.js';
import { Counter } from './Counter.js';
import { CaseAccessGrant } from './CaseAccessGrant.js';
import { DisclosurePack } from './DisclosurePack.js';
import { AuditEvent } from './AuditEvent.js';
import { AnchorBatch } from './AnchorBatch.js';
import { Certificate } from './Certificate.js';
import { Referral } from './Referral.js';
import { OtpChallenge } from './OtpChallenge.js';
import { RefreshToken } from './RefreshToken.js';
import { StreamToken } from './StreamToken.js';

/** Every model, for explicit index creation at boot. */
export const allModels = [
  User,
  Case,
  Evidence,
  CustodyItem,
  Ledger,
  Counter,
  CaseAccessGrant,
  DisclosurePack,
  AuditEvent,
  AnchorBatch,
  Certificate,
  Referral,
  OtpChallenge,
  RefreshToken,
  StreamToken,
];
