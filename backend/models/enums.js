/**
 * Single source of truth for every controlled vocabulary in the system.
 *
 * Terminology discipline matters here beyond ordinary tidiness: this system makes
 * legal claims. "Review Priority" is not "verification". A forensic opinion is not an
 * AI assessment. Keeping the words in one file keeps those distinctions from eroding
 * as the code grows.
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
 * The court is ONE role. There used to be a presiding-judge role and a court
 * evidence-room role, each scoped to a single bench, and a case filed before one bench
 * was invisible from every other court login — which is how a chargesheet could be
 * filed, verified and then appear on no court screen at all. Every court identity in
 * the court directory (a judge on the roster, or registry staff) now resolves to
 * `COURT`, scoped to the district court establishment its court belongs to.
 */
export const ROLE = Object.freeze({
  // POLICE
  IO: 'IO',
  SHO: 'SHO',
  DISTRICT_SP: 'DISTRICT_SP',
  // COURT
  COURT: 'COURT',
  // FSL
  FSL_EXAMINER: 'FSL_EXAMINER',
  // LEGAL
  DEFENCE_COUNSEL: 'DEFENCE_COUNSEL',
  VICTIM_COUNSEL: 'VICTIM_COUNSEL',
  LEGAL_AID_COUNSEL: 'LEGAL_AID_COUNSEL',
  PUBLIC_PROSECUTOR: 'PUBLIC_PROSECUTOR',
});

/** Court role values written by earlier versions. Migrated to ROLE.COURT at boot. */
export const LEGACY_COURT_ROLES = Object.freeze(['JUDGE', 'EVIDENCE_CUSTODIAN', 'REGISTRAR']);

/** Which authority may hold which role. Enforced at activation — never client-supplied. */
export const ROLES_BY_AUTHORITY = Object.freeze({
  [AUTHORITY.POLICE]: [ROLE.IO, ROLE.SHO, ROLE.DISTRICT_SP],
  [AUTHORITY.COURT]: [ROLE.COURT],
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
  /** Directed by the court after cognizance. Re-opens the police file; re-filing returns it. */
  FURTHER_INVESTIGATION: 'FURTHER_INVESTIGATION',
  /** Filed by the police and listed before a court. Waiting for the court to take it up. */
  CHARGESHEET_FILED: 'CHARGESHEET_FILED',
  /** The court has received and reviewed the chargesheet and taken cognizance. */
  COGNIZANCE_TAKEN: 'COGNIZANCE_TAKEN',
  /** Sessions-triable cases only: committed to the Court of Session for trial. */
  COMMITTED: 'COMMITTED',
  TRIAL: 'TRIAL',
  /** The court has closed the case. Nothing is deleted; the record is sealed as it stands. */
  CLOSED: 'CLOSED',
  DISPOSED: 'DISPOSED',
});

/** The lifecycle strip, in the order a person watching would expect to see it. */
export const CASE_LIFECYCLE = Object.freeze([
  CASE_STAGE.UNDER_INVESTIGATION,
  CASE_STAGE.CHARGESHEET_FILED,
  CASE_STAGE.COGNIZANCE_TAKEN,
  CASE_STAGE.COMMITTED,
  CASE_STAGE.TRIAL,
  CASE_STAGE.CLOSED,
]);

/**
 * The acts that move a case from one stage to the next. Each is performed through one
 * endpoint, by one authority, and validated against `services/caseWorkflow.js` —
 * there is no route that sets a stage directly.
 */
export const CASE_ACTION = Object.freeze({
  FILE_CHARGESHEET: 'FILE_CHARGESHEET',
  TAKE_COGNIZANCE: 'TAKE_COGNIZANCE',
  COMMIT_FOR_TRIAL: 'COMMIT_FOR_TRIAL',
  BEGIN_TRIAL: 'BEGIN_TRIAL',
  DIRECT_FURTHER_INVESTIGATION: 'DIRECT_FURTHER_INVESTIGATION',
  CLOSE_CASE: 'CLOSE_CASE',
});

/** Stages in which the case is finished and nothing further may be recorded against it. */
export const CLOSED_CASE_STAGES = Object.freeze([CASE_STAGE.CLOSED, CASE_STAGE.DISPOSED]);

/**
 * The signed document a court may attach when it closes a case. A PDF, hashed and
 * signed in the judge's browser with their registered device key.
 */
export const CLOSURE_DOCUMENT_KIND = Object.freeze({
  FINAL_JUDGMENT: 'FINAL_JUDGMENT',
  DECLARATION: 'DECLARATION',
  ORDER: 'ORDER',
});

export const CLOSURE_DOCUMENT_KIND_LABEL = Object.freeze({
  [CLOSURE_DOCUMENT_KIND.FINAL_JUDGMENT]: 'Final judgment',
  [CLOSURE_DOCUMENT_KIND.DECLARATION]: 'Declaration',
  [CLOSURE_DOCUMENT_KIND.ORDER]: 'Closing order',
});

/** Plain-English role names, for surfaces a member of the public reads. */
export const ROLE_LABEL = Object.freeze({
  [ROLE.IO]: 'Investigating Officer',
  [ROLE.SHO]: 'Station House Officer',
  [ROLE.DISTRICT_SP]: 'Superintendent of Police',
  [ROLE.COURT]: 'Court',
  [ROLE.FSL_EXAMINER]: 'Forensic Examiner',
  [ROLE.DEFENCE_COUNSEL]: 'Defence Counsel',
  [ROLE.VICTIM_COUNSEL]: 'Victim’s Counsel',
  [ROLE.LEGAL_AID_COUNSEL]: 'Legal Aid Counsel',
  [ROLE.PUBLIC_PROSECUTOR]: 'Public Prosecutor',
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

// ------------------------------------------------------------ AI analysis ----

/**
 * Where an exhibit's Gemini analysis stands. The UI shows each of these distinctly,
 * and a result is only ever shown for COMPLETED — a failed analysis never renders as
 * a score, and no score is ever invented to fill the gap.
 */
export const AI_ANALYSIS_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  /** The format or size cannot be sent for analysis. Nothing is assessed, nothing invented. */
  UNSUPPORTED: 'UNSUPPORTED',
});

/** Persisted for the record only. Never sent in an API response. */
export const AI_PROVIDER = Object.freeze({ GEMINI: 'GEMINI' });

/** Gemini's manipulation assessment. Never an authenticity finding — see FORENSIC_OPINION. */
export const DEEPFAKE_ASSESSMENT = Object.freeze({
  LIKELY_MANIPULATED: 'LIKELY_MANIPULATED',
  LIKELY_AUTHENTIC: 'LIKELY_AUTHENTIC',
  INCONCLUSIVE: 'INCONCLUSIVE',
});

/**
 * Review priority vocabulary. The value is chosen by Gemini and validated against this
 * enum before it is stored; the backend never derives it from a score.
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

export const AI_DISCLAIMER =
  'Automated preliminary assessment generated by an AI model. It orders the laboratory queue and is not expert opinion under BSA s.39 / IT Act s.79A; the FSL examiner’s verdict is the official forensic conclusion.';

/** Kept under its historical name for every surface that already imports it. */
export const TRIAGE_DISCLAIMER = AI_DISCLAIMER;

/** The label shown in every UI surface for the AI-recommended priority. */
export const TRIAGE_UI_LABEL = 'Review priority (AI)';

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

// ------------------------------------------------------------ certificates ----

/**
 * One ACTIVE certificate per exhibit, enforced by a partial unique index. SUPERSEDED
 * exists only for records written before that rule, which are kept (nothing is ever
 * deleted) and pointed at the certificate that replaced them.
 */
export const CERTIFICATE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUPERSEDED: 'SUPERSEDED',
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
 * Where an article may go next.
 *
 * Every movement is still a ledgered event with a reason and a seal check. What is
 * gone is the requirement that every move pass back through the station store and wait
 * on a second person scanning a handover token: an article seized at a scene can go
 * straight to the laboratory, and a laboratory can send it straight to court.
 * RETURNED and DESTROYED end the chain.
 */
export const CUSTODY_TRANSITIONS = Object.freeze({
  [CUSTODY_STATUS.SEIZED]: [CUSTODY_STATUS.IN_STORE, CUSTODY_STATUS.AT_FSL, CUSTODY_STATUS.IN_COURT],
  [CUSTODY_STATUS.IN_STORE]: [
    CUSTODY_STATUS.AT_FSL,
    CUSTODY_STATUS.IN_COURT,
    CUSTODY_STATUS.RETURNED,
    CUSTODY_STATUS.DESTROYED,
  ],
  [CUSTODY_STATUS.AT_FSL]: [CUSTODY_STATUS.IN_STORE, CUSTODY_STATUS.IN_COURT],
  [CUSTODY_STATUS.IN_COURT]: [
    CUSTODY_STATUS.IN_STORE,
    CUSTODY_STATUS.AT_FSL,
    CUSTODY_STATUS.RETURNED,
    CUSTODY_STATUS.DESTROYED,
  ],
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

/** The location a status implies. Location is derived, never typed, so the two cannot disagree. */
export const CUSTODY_LOCATION_FOR_STATUS = Object.freeze({
  [CUSTODY_STATUS.SEIZED]: CUSTODY_LOCATION.FIELD,
  [CUSTODY_STATUS.IN_STORE]: CUSTODY_LOCATION.MALKHANA,
  [CUSTODY_STATUS.AT_FSL]: CUSTODY_LOCATION.FSL,
  [CUSTODY_STATUS.IN_COURT]: CUSTODY_LOCATION.COURT,
  [CUSTODY_STATUS.RETURNED]: CUSTODY_LOCATION.FIELD,
  [CUSTODY_STATUS.DESTROYED]: CUSTODY_LOCATION.MALKHANA,
});

// ---------------------------------------------------------------- ledger ----

export const LEDGER_EVENT = Object.freeze({
  CASE_CREATED: 'CASE_CREATED',
  CASE_STAGE_CHANGED: 'CASE_STAGE_CHANGED',
  /** The court closing the case. Its own event because it is the end of the story. */
  CASE_CLOSED: 'CASE_CLOSED',
  EVIDENCE_UPLOADED: 'EVIDENCE_UPLOADED',
  CUSTODY_ITEM_CREATED: 'CUSTODY_ITEM_CREATED',
  /** Historical only: the two-scan handshake no longer exists. Kept for the ledger's past. */
  CUSTODY_TRANSFER_INITIATED: 'CUSTODY_TRANSFER_INITIATED',
  /** A physical movement of an article, recorded in one step. */
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
  /** The laboratory's filed opinion was written into Part B of the exhibit's certificate. */
  CERTIFICATE_PART_B_ATTACHED: 'CERTIFICATE_PART_B_ATTACHED',
  CERTIFICATE_SIGNED: 'CERTIFICATE_SIGNED',
  CERTIFICATE_SUPERSEDED: 'CERTIFICATE_SUPERSEDED',
  /** An authenticated user ran the one-click certificate verification. Carries the result. */
  CERTIFICATE_VERIFIED: 'CERTIFICATE_VERIFIED',
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
  /** A judicial act on a case — cognizance, committal, trial, closure, a recorded order. */
  ORDER: 'ORDER',
  /**
   * A court ruling on something another party prepared — a disclosure pack and its
   * exclusions, a vakalatnama. Distinct from WRITE (authorship, which belongs to the
   * investigation).
   */
  APPROVE: 'APPROVE',
  /**
   * RETIRED. A party acknowledging a served disclosure pack; no route uses it now that
   * counsel on record read the case file directly. Kept only so audit rows written
   * with it still validate against this enum.
   */
  ACKNOWLEDGE: 'ACKNOWLEDGE',
  /**
   * Signing one's own statement — the deponent's Part A, the examiner's Part B of a
   * s.63 certificate. It adds a signature over a record already collected and alters
   * nothing in it, so it is not WRITE. Who may attest is narrowed further by the
   * controller: only the person the certificate names.
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
 */
export const DENY_REASON = Object.freeze({
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  USER_NOT_ACTIVE: 'USER_NOT_ACTIVE',
  NOT_ASSIGNED_IO: 'NOT_ASSIGNED_IO',
  OUT_OF_JURISDICTION: 'OUT_OF_JURISDICTION',
  CASE_STAGE_CLOSED_TO_WRITES: 'CASE_STAGE_CLOSED_TO_WRITES',
  /** The court has closed the case. It stays readable forever; nothing new goes in. */
  CASE_IS_CLOSED: 'CASE_IS_CLOSED',
  READ_ONLY_ROLE: 'READ_ONLY_ROLE',
  CASE_NOT_LISTED_IN_YOUR_COURT: 'CASE_NOT_LISTED_IN_YOUR_COURT',
  NO_OPEN_REFERRAL_TO_YOUR_LAB: 'NO_OPEN_REFERRAL_TO_YOUR_LAB',
  NOT_ON_RECORD_FOR_THIS_CASE: 'NOT_ON_RECORD_FOR_THIS_CASE',
  GRANT_REVOKED: 'GRANT_REVOKED',
  GRANT_NOT_YET_VALID: 'GRANT_NOT_YET_VALID',
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  /**
   * RETIRED. Counsel on record read every exhibit of their case, so no decision
   * returns these any more. Kept because historical audit rows carry them.
   */
  NO_DISCLOSURE_PACK_SERVED: 'NO_DISCLOSURE_PACK_SERVED',
  EXHIBIT_NOT_IN_DISCLOSURE_SET: 'EXHIBIT_NOT_IN_DISCLOSURE_SET',
  CUSTODY_FROZEN: 'CUSTODY_FROZEN',
  /** A laboratory or court may only move an article that is currently with it. */
  ARTICLE_NOT_WITH_YOU: 'ARTICLE_NOT_WITH_YOU',
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
 * A vakalatnama filed through Lexx. PENDING until the court rules on it; only an
 * ACCEPTED filing puts the advocate on record, and only by way of the court register
 * recording it (see controllers/vakalatnama.js).
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
   * reported as ANCHOR_MATCH.
   */
  ANCHOR_LOCAL_ONLY: 'ANCHOR_LOCAL_ONLY',
});

// ---------------------------------------------------------------- realtime ----

/**
 * Change-feed event types that are not ledger events. Ledger event types travel on the
 * feed under their own names; these cover changes that have no ledger entry.
 */
export const REALTIME_EVENT = Object.freeze({
  /** An exhibit's AI analysis moved to PROCESSING, COMPLETED, FAILED or UNSUPPORTED. */
  AI_ANALYSIS_UPDATED: 'AI_ANALYSIS_UPDATED',
  /** Who may read a case changed without a ledger entry (e.g. representation sync). */
  CASE_ACCESS_CHANGED: 'CASE_ACCESS_CHANGED',
  /** A user-visible record changed without a ledger entry. */
  RECORD_UPDATED: 'RECORD_UPDATED',
});

export const values = (o) => Object.values(o);
