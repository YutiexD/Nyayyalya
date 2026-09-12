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

/**
 * The roles this product has.
 *
 * Two roles that existed here are deliberately gone, and their absence is a design
 * decision rather than an omission:
 *
 *   MALKHANA_CUSTODIAN — a separate store-keeper account made every physical
 *     movement wait on a third person. The station store is still a place
 *     (CUSTODY_LOCATION.MALKHANA, shown as "Station store"), and every handover is
 *     still a two-scan, ledgered handshake; it is the station's own officers who
 *     keep it, so no workflow blocks on a role nobody has logged in as.
 *
 *   REGISTRAR — every registry act (ruling on disclosure, serving it, putting an
 *     advocate on record, issuing a certificate) is now the presiding judge's. One
 *     court identity, one queue, no approval hop that adds nothing but latency.
 */
export const ROLE = Object.freeze({
  // POLICE
  IO: 'IO',
  SHO: 'SHO',
  DISTRICT_SP: 'DISTRICT_SP',
  // COURT
  JUDGE: 'JUDGE',
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
  [AUTHORITY.POLICE]: [ROLE.IO, ROLE.SHO, ROLE.DISTRICT_SP],
  [AUTHORITY.COURT]: [ROLE.JUDGE, ROLE.EVIDENCE_CUSTODIAN],
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
  /** The court has closed the case. Nothing is deleted; the record is sealed as it stands. */
  CLOSED: 'CLOSED',
  DISPOSED: 'DISPOSED',
});

/**
 * The lifecycle, in the order a person watching would expect to see it.
 *
 * The UI draws this as one strip so the whole journey is legible at a glance. Note
 * what it does NOT claim: a case does not wait at a stage for the next one. Forensic
 * review runs alongside the investigation, and the court reads the file whether or
 * not a laboratory has reported.
 */
export const CASE_LIFECYCLE = Object.freeze([
  CASE_STAGE.UNDER_INVESTIGATION,
  CASE_STAGE.FURTHER_INVESTIGATION,
  CASE_STAGE.CHARGESHEET_FILED,
  CASE_STAGE.COMMITTED,
  CASE_STAGE.TRIAL,
  CASE_STAGE.CLOSED,
]);

/** Stages in which the case is finished and nothing further may be recorded against it. */
export const CLOSED_CASE_STAGES = Object.freeze([CASE_STAGE.CLOSED, CASE_STAGE.DISPOSED]);

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
 *
 * Four bands, not three. CRITICAL exists because "look at this first" and "look at
 * this before anything else" are genuinely different instructions to a laboratory
 * with a queue, and collapsing them made the top of the queue unreadable.
 */
export const TRIAGE_PRIORITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

/** Highest first. The one ordering every queue in the product sorts by. */
export const TRIAGE_PRIORITY_ORDER = Object.freeze([
  TRIAGE_PRIORITY.CRITICAL,
  TRIAGE_PRIORITY.HIGH,
  TRIAGE_PRIORITY.MEDIUM,
  TRIAGE_PRIORITY.LOW,
]);

/** Its rank, for a Mongo `$switch` or a client-side sort. Lower sorts first. */
export const TRIAGE_PRIORITY_RANK = Object.freeze(
  TRIAGE_PRIORITY_ORDER.reduce((acc, p, i) => ({ ...acc, [p]: i }), {})
);

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
 * Everything routes through the station store (IN_STORE) — that is the point of a
 * store. Who keeps it is the station's own officers; there is no separate custodian
 * account for a handover to wait on.
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

/**
 * Where an article physically is. `MALKHANA` is the station's own evidence store and
 * is labelled "Station store" everywhere a person reads it — the value is kept
 * because it is written into ledger entries that can never be rewritten.
 */
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
  /** The court closing the case. Its own event because it is the end of the story. */
  CASE_CLOSED: 'CASE_CLOSED',
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
  CUSTODY_FREEZE_LIFTED: 'CUSTODY_FREEZE_LIFTED',
  VAKALATNAMA_FILED: 'VAKALATNAMA_FILED',
  VAKALATNAMA_ACCEPTED: 'VAKALATNAMA_ACCEPTED',
  VAKALATNAMA_REJECTED: 'VAKALATNAMA_REJECTED',
});

export const SUBJECT_TYPE = Object.freeze({
  CASE: 'CASE',
  EVIDENCE: 'EVIDENCE',
  CUSTODY_ITEM: 'CUSTODY_ITEM',
  REFERRAL: 'REFERRAL',
  DISCLOSURE_PACK: 'DISCLOSURE_PACK',
  CERTIFICATE: 'CERTIFICATE',
  VAKALATNAMA: 'VAKALATNAMA',
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
  /**
   * Signing one's own statement — the deponent's Part A, the examiner's Part B of a
   * s.63 certificate. It adds a signature over a record already collected and alters
   * nothing in it, so it is not WRITE: treating it as WRITE locked the investigating
   * officer out of signing their own certificate the moment the chargesheet closed
   * the case, which is exactly when a certificate is needed. Who may attest is
   * narrowed further by the controller: only the person the certificate names.
   */
  ATTEST: 'ATTEST',
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
  VAKALATNAMA: 'VAKALATNAMA',
  /** A supervisor's decision lifting a seal-exception freeze on a custody item. */
  CUSTODY_RELEASE: 'CUSTODY_RELEASE',
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
  /** The court has closed the case. It stays readable forever; nothing new goes in. */
  CASE_IS_CLOSED: 'CASE_IS_CLOSED',
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

/**
 * A vakalatnama filed through Lexx. PENDING until the court registry rules on it;
 * only an ACCEPTED filing puts the advocate on record, and only by way of the court
 * registry recording it (see controllers/vakalatnama.js).
 */
export const VAKALATNAMA_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
});

/** Which side an advocate appears for. Mirrors the court directory's vocabulary. */
export const APPEARING_FOR = Object.freeze({ ACCUSED: 'ACCUSED', VICTIM: 'VICTIM' });

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
