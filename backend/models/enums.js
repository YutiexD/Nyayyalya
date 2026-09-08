/**
 * Single source of truth for every controlled vocabulary in the system.
 *
 * Terminology discipline matters here beyond ordinary tidiness: this system makes
 * legal claims. "Review Priority" is not "verification". A forensic opinion is not a
 * triage indicator. Keeping the words in one file keeps those distinctions from
 * eroding as the code grows.
 */

// ---------------------------------------------------------------- identity ----

export const AUTHORITY = Object.freeze({
  POLICE: 'POLICE',
  COURT: 'COURT',
  FSL: 'FSL',
  LEGAL: 'LEGAL',
});

export const ROLE = Object.freeze({
  // POLICE
  IO: 'IO',
  SHO: 'SHO',
  MALKHANA_CUSTODIAN: 'MALKHANA_CUSTODIAN',
  DISTRICT_SP: 'DISTRICT_SP',
  // COURT
  JUDGE: 'JUDGE',
  REGISTRAR: 'REGISTRAR',
  EVIDENCE_CUSTODIAN: 'EVIDENCE_CUSTODIAN',
  // FSL
  FSL_EXAMINER: 'FSL_EXAMINER',
  // LEGAL
  DEFENCE_COUNSEL: 'DEFENCE_COUNSEL',
  VICTIM_COUNSEL: 'VICTIM_COUNSEL',
  LEGAL_AID_COUNSEL: 'LEGAL_AID_COUNSEL',
  PUBLIC_PROSECUTOR: 'PUBLIC_PROSECUTOR',
});

/** Which authority may hold which role. Enforced at activation — never client-supplied. */
export const ROLES_BY_AUTHORITY = Object.freeze({
  [AUTHORITY.POLICE]: [ROLE.IO, ROLE.SHO, ROLE.MALKHANA_CUSTODIAN, ROLE.DISTRICT_SP],
  [AUTHORITY.COURT]: [ROLE.JUDGE, ROLE.REGISTRAR, ROLE.EVIDENCE_CUSTODIAN],
  [AUTHORITY.FSL]: [ROLE.FSL_EXAMINER],
  [AUTHORITY.LEGAL]: [
    ROLE.DEFENCE_COUNSEL,
    ROLE.VICTIM_COUNSEL,
    ROLE.LEGAL_AID_COUNSEL,
    ROLE.PUBLIC_PROSECUTOR,
  ],
});

export const ADVOCATE_ROLES = Object.freeze([
  ROLE.DEFENCE_COUNSEL,
  ROLE.VICTIM_COUNSEL,
  ROLE.LEGAL_AID_COUNSEL,
]);

export const USER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DEACTIVATED: 'DEACTIVATED',
});

export const CREATED_VIA = Object.freeze({
  DIRECTORY_FIRST_LOGIN: 'DIRECTORY_FIRST_LOGIN',
  INVITE: 'INVITE',
});

// ---------------------------------------------------------------- cases ----

export const CASE_STAGE = Object.freeze({
  UNDER_INVESTIGATION: 'UNDER_INVESTIGATION',
  FURTHER_INVESTIGATION: 'FURTHER_INVESTIGATION',
  CHARGESHEET_FILED: 'CHARGESHEET_FILED',
  COMMITTED: 'COMMITTED',
  TRIAL: 'TRIAL',
  DISPOSED: 'DISPOSED',
});

/** Stages in which an investigating officer may still write. Spec §5. */
export const WRITABLE_CASE_STAGES = Object.freeze([
  CASE_STAGE.UNDER_INVESTIGATION,
  CASE_STAGE.FURTHER_INVESTIGATION,
]);

export const SENSITIVITY_CLASS = Object.freeze({
  ORDINARY: 'ORDINARY',
  POCSO: 'POCSO',
  SEXUAL_OFFENCE: 'SEXUAL_OFFENCE',
  SC_ST: 'SC_ST',
  NDPS: 'NDPS',
  JUVENILE: 'JUVENILE',
});

export const COURT_TYPE = Object.freeze({
  MAGISTRATE: 'MAGISTRATE',
  SESSIONS: 'SESSIONS',
  SPECIAL: 'SPECIAL',
});

// ---------------------------------------------------------------- evidence ----

export const EVIDENCE_KIND = Object.freeze({ DIGITAL: 'DIGITAL', PHYSICAL: 'PHYSICAL' });

export const SOURCE_TYPE = Object.freeze({
  MOBILE: 'MOBILE',
  COMPUTER: 'COMPUTER',
  DVR: 'DVR',
  CD_DVD: 'CD_DVD',
  FLASH_DRIVE: 'FLASH_DRIVE',
  SERVER: 'SERVER',
  CLOUD: 'CLOUD',
  OTHER: 'OTHER',
});

/**
 * AI output vocabulary. Deliberately small and deliberately not a verdict.
 * There is no "AUTHENTIC" here and there never will be — see FORENSIC_OPINION.
 */
export const TRIAGE_PRIORITY = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });

export const TRIAGE_DISCLAIMER =
  'Automated triage only. Not expert opinion under BSA s.39 / IT Act s.79A.';

/** The label shown in every UI surface for triage. Never "verified", never a percentage. */
export const TRIAGE_UI_LABEL = 'Review Priority';

export const FORENSIC_STATUS = Object.freeze({
  NOT_REFERRED: 'NOT_REFERRED',
  REFERRED: 'REFERRED',
  UNDER_EXAMINATION: 'UNDER_EXAMINATION',
  REPORT_FILED: 'REPORT_FILED',
});

/** The ONLY authenticity vocabulary in the system. Produced by an FSL examiner alone. */
export const FORENSIC_OPINION = Object.freeze({
  AUTHENTIC: 'AUTHENTIC',
  MANIPULATED: 'MANIPULATED',
  INCONCLUSIVE: 'INCONCLUSIVE',
});

export const COURT_STATUS = Object.freeze({
  NOT_PRODUCED: 'NOT_PRODUCED',
  PRODUCED: 'PRODUCED',
  MARKED_EXHIBIT: 'MARKED_EXHIBIT',
  INADMISSIBLE: 'INADMISSIBLE',
  SEALED: 'SEALED',
  DISPOSED: 'DISPOSED',
});

// ---------------------------------------------------------------- custody ----

export const CUSTODY_STATUS = Object.freeze({
  SEIZED: 'SEIZED',
  IN_STORE: 'IN_STORE',
  AT_FSL: 'AT_FSL',
  IN_COURT: 'IN_COURT',
  RETURNED: 'RETURNED',
  DESTROYED: 'DESTROYED',
});

/**
 * Legal custody state machine. A jump that is not in this map is a chain gap.
 * Everything routes through the malkhana (IN_STORE) — that is the point of a malkhana.
 */
export const CUSTODY_TRANSITIONS = Object.freeze({
  [CUSTODY_STATUS.SEIZED]: [CUSTODY_STATUS.IN_STORE],
  [CUSTODY_STATUS.IN_STORE]: [
    CUSTODY_STATUS.AT_FSL,
    CUSTODY_STATUS.IN_COURT,
    CUSTODY_STATUS.RETURNED,
    CUSTODY_STATUS.DESTROYED,
  ],
  [CUSTODY_STATUS.AT_FSL]: [CUSTODY_STATUS.IN_STORE],
  [CUSTODY_STATUS.IN_COURT]: [CUSTODY_STATUS.IN_STORE, CUSTODY_STATUS.RETURNED],
  [CUSTODY_STATUS.RETURNED]: [],
  [CUSTODY_STATUS.DESTROYED]: [],
});

export const CUSTODY_LOCATION = Object.freeze({
  MALKHANA: 'MALKHANA',
  FSL: 'FSL',
  COURT: 'COURT',
  FIELD: 'FIELD',
});

// ---------------------------------------------------------------- ledger ----

export const LEDGER_EVENT = Object.freeze({
  CASE_CREATED: 'CASE_CREATED',
  CASE_STAGE_CHANGED: 'CASE_STAGE_CHANGED',
  EVIDENCE_UPLOADED: 'EVIDENCE_UPLOADED',
  CUSTODY_ITEM_CREATED: 'CUSTODY_ITEM_CREATED',
  CUSTODY_TRANSFER_INITIATED: 'CUSTODY_TRANSFER_INITIATED',
  CUSTODY_TRANSFERRED: 'CUSTODY_TRANSFERRED',
  REFERRED_TO_FSL: 'REFERRED_TO_FSL',
  FSL_EXAMINATION_STARTED: 'FSL_EXAMINATION_STARTED',
  FSL_REPORT_FILED: 'FSL_REPORT_FILED',
  REPRESENTATION_SYNCED: 'REPRESENTATION_SYNCED',
  DISCLOSURE_PREPARED: 'DISCLOSURE_PREPARED',
  DISCLOSURE_APPROVED: 'DISCLOSURE_APPROVED',
  DISCLOSURE_SERVED: 'DISCLOSURE_SERVED',
  DISCLOSURE_ACKNOWLEDGED: 'DISCLOSURE_ACKNOWLEDGED',
  CERTIFICATE_GENERATED: 'CERTIFICATE_GENERATED',
  CERTIFICATE_SIGNED: 'CERTIFICATE_SIGNED',
  EXHIBIT_MARKED: 'EXHIBIT_MARKED',
  JUDICIAL_ORDER: 'JUDICIAL_ORDER',
  INTEGRITY_EXCEPTION: 'INTEGRITY_EXCEPTION',
});

export const SUBJECT_TYPE = Object.freeze({
  CASE: 'CASE',
  EVIDENCE: 'EVIDENCE',
  CUSTODY_ITEM: 'CUSTODY_ITEM',
  REFERRAL: 'REFERRAL',
  DISCLOSURE_PACK: 'DISCLOSURE_PACK',
  CERTIFICATE: 'CERTIFICATE',
});

// ---------------------------------------------------------------- access ----

export const ACTION = Object.freeze({
  READ: 'READ',
  WRITE: 'WRITE',
  DOWNLOAD: 'DOWNLOAD',
  LOGIN: 'LOGIN',
  VERIFY: 'VERIFY',
  ORDER: 'ORDER',
  /**
   * A judicial or registry ruling on something another party prepared — approving a
   * disclosure pack and its exclusions. Distinct from WRITE (which is authorship,
   * and belongs to the investigation) and from ORDER (which is a judge alone).
   * Spec §7 gives approval to "REGISTRAR / JUDGE", and neither WRITE nor ORDER can
   * express that pair.
   */
  APPROVE: 'APPROVE',
  /**
   * A party confirming receipt. It mutates one field the party owns — their own
   * acknowledgement timestamp — so it is not READ, but it is emphatically not the
   * general WRITE that advocates must never hold.
   */
  ACKNOWLEDGE: 'ACKNOWLEDGE',
});

export const DECISION = Object.freeze({ ALLOW: 'ALLOW', DENY: 'DENY' });

export const RESOURCE_TYPE = Object.freeze({
  CASE: 'CASE',
  EVIDENCE: 'EVIDENCE',
  CUSTODY_ITEM: 'CUSTODY_ITEM',
  REFERRAL: 'REFERRAL',
  DISCLOSURE_PACK: 'DISCLOSURE_PACK',
  CERTIFICATE: 'CERTIFICATE',
  CASE_ACCESS_GRANT: 'CASE_ACCESS_GRANT',
  LEDGER: 'LEDGER',
  AUDIT: 'AUDIT',
  SEARCH: 'SEARCH',
});

/**
 * Denial reason codes. These are shown to users, so each must be safe on its own:
 * it may reveal *why the caller is not entitled*, never anything about the resource.
 * "EXHIBIT_NOT_IN_DISCLOSURE_SET" is safe — the advocate already knows the case exists.
 */
export const DENY_REASON = Object.freeze({
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  USER_NOT_ACTIVE: 'USER_NOT_ACTIVE',
  NOT_ASSIGNED_IO: 'NOT_ASSIGNED_IO',
  OUT_OF_JURISDICTION: 'OUT_OF_JURISDICTION',
  CASE_STAGE_CLOSED_TO_WRITES: 'CASE_STAGE_CLOSED_TO_WRITES',
  CUSTODIAN_SCOPE: 'CUSTODIAN_SCOPE',
  READ_ONLY_ROLE: 'READ_ONLY_ROLE',
  CASE_NOT_LISTED_IN_YOUR_COURT: 'CASE_NOT_LISTED_IN_YOUR_COURT',
  OUT_OF_COURT_SCOPE: 'OUT_OF_COURT_SCOPE',
  NO_OPEN_REFERRAL_TO_YOUR_LAB: 'NO_OPEN_REFERRAL_TO_YOUR_LAB',
  NOT_ON_RECORD_FOR_THIS_CASE: 'NOT_ON_RECORD_FOR_THIS_CASE',
  GRANT_REVOKED: 'GRANT_REVOKED',
  GRANT_NOT_YET_VALID: 'GRANT_NOT_YET_VALID',
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  NO_DISCLOSURE_PACK_SERVED: 'NO_DISCLOSURE_PACK_SERVED',
  EXHIBIT_NOT_IN_DISCLOSURE_SET: 'EXHIBIT_NOT_IN_DISCLOSURE_SET',
  NOT_CURRENT_HOLDER: 'NOT_CURRENT_HOLDER',
  CUSTODY_FROZEN: 'CUSTODY_FROZEN',
  IO_CANNOT_HOLD_OWN_CASE_EVIDENCE: 'IO_CANNOT_HOLD_OWN_CASE_EVIDENCE',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  NO_MATCHING_POLICY: 'NO_MATCHING_POLICY',
});

// ---------------------------------------------------------------- disclosure ----

export const GRANT_BASIS = Object.freeze({
  POSTING_ORDER: 'POSTING_ORDER',
  VAKALATNAMA: 'VAKALATNAMA',
  LEGAL_AID_ORDER: 'LEGAL_AID_ORDER',
  ROSTER: 'ROSTER',
  PROSECUTION_ASSIGNMENT: 'PROSECUTION_ASSIGNMENT',
});

export const DISCLOSURE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  APPROVED: 'APPROVED',
  SERVED: 'SERVED',
});

export const REFERRAL_STATUS = Object.freeze({
  OPEN: 'OPEN',
  ACCEPTED: 'ACCEPTED',
  REPORTED: 'REPORTED',
  WITHDRAWN: 'WITHDRAWN',
});

export const FSL_DISCIPLINE = Object.freeze({
  MOBILE_FORENSICS: 'MOBILE_FORENSICS',
  MEDIA_FORENSICS: 'MEDIA_FORENSICS',
  COMPUTER_FORENSICS: 'COMPUTER_FORENSICS',
});

// ---------------------------------------------------------------- anchoring ----

export const ANCHOR_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SUBMITTED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  DRY_RUN: 'DRY_RUN',
});

/** Monad Testnet. The only network identifier this system uses. */
export const ANCHOR_NETWORK = 'monad-testnet';
export const ANCHOR_CHAIN_ID = 10143;

// ---------------------------------------------------------------- verification ----

export const FILE_INTEGRITY = Object.freeze({
  FILE_INTACT: 'FILE_INTACT',
  FILE_MODIFIED: 'FILE_MODIFIED',
  FILE_MISSING: 'FILE_MISSING',
});

export const CHAIN_INTEGRITY = Object.freeze({
  CHAIN_INTACT: 'CHAIN_INTACT',
  CHAIN_BROKEN: 'CHAIN_BROKEN',
});

export const ANCHOR_INTEGRITY = Object.freeze({
  ANCHOR_MATCH: 'ANCHOR_MATCH',
  ANCHOR_MISMATCH: 'ANCHOR_MISMATCH',
  NOT_ANCHORED: 'NOT_ANCHORED',
  ANCHOR_UNAVAILABLE: 'ANCHOR_UNAVAILABLE',
  /**
   * The batch exists, the recomputed root matches it and this entry proves as a
   * member — but the batch was never submitted to a chain (DRY_RUN). That is a
   * self-consistency check, NOT external corroboration, and it must never be
   * reported as ANCHOR_MATCH: the whole value of anchoring is that the root is
   * held somewhere we cannot rewrite.
   */
  ANCHOR_LOCAL_ONLY: 'ANCHOR_LOCAL_ONLY',
});

export const values = (o) => Object.values(o);
