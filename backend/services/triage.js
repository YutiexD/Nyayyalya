/**
 * Automatic review prioritisation — REVIEW PRIORITY ONLY.
 *
 * ## What this is
 * A heuristic that decides what a human should look at first. It runs on EVERY piece
 * of evidence at the moment it enters the system. No officer, supervisor, examiner or
 * administrator sets a priority by hand, and there is no endpoint by which they could:
 * a queue people can reorder is a queue that reflects who shouted, not what matters.
 *
 * ## What this is emphatically NOT
 * It is not authenticity verification. It does not produce a verdict, a confidence
 * percentage, or an opinion. Only a s.79A-notified forensic laboratory decides
 * whether evidence is authentic, and that lives in `evidence.forensic`.
 *
 * Rules enforced here and asserted by tests:
 *   - never persist a percentage or a score
 *   - never write triage to the ledger or to the blockchain
 *   - the disclaimer travels with every result, and cannot be omitted
 *   - the UI label is always "Review Priority"
 *
 * ## Why a weighted model rather than "count the indicators"
 *
 * The previous version banded on the NUMBER of indicators, which made every finding
 * worth the same. "The received bytes did not match the officer's hash" and "no C2PA
 * content credentials" then counted equally — and the second is true of almost every
 * file a police station will ever handle, so noise outvoted the one signal that
 * actually means something. Weights fix that: a single integrity failure reaches
 * CRITICAL on its own, and three weak provenance gaps still only reach MEDIUM.
 *
 * Every weight is attached to a sentence a person can evaluate. That is the point —
 * an opaque score would be both less useful to an examiner and less defensible in
 * front of a court than a list of reasons with their contributions shown.
 *
 * If an LLM is ever put in this loop, it receives EXTRACTED METADATA ONLY — never
 * the file bytes, which would send evidence to a third party.
 */
import { TRIAGE_PRIORITY, TRIAGE_DISCLAIMER } from '../models/enums.js';

const MODEL_NAME = 'lexx-triage-heuristic';
const MODEL_VERSION = '1.0';

/**
 * The bands. A score at or above the threshold lands in that band.
 *
 * CRITICAL is set at 60 so that exactly one class of finding reaches it unaided —
 * an integrity failure on ingest — and otherwise it takes a genuine pile-up of
 * manipulation indicators on a serious case.
 */
const BANDS = Object.freeze([
  [60, TRIAGE_PRIORITY.CRITICAL],
  [30, TRIAGE_PRIORITY.HIGH],
  [10, TRIAGE_PRIORITY.MEDIUM],
  [0, TRIAGE_PRIORITY.LOW],
]);

/**
 * How much context it takes to move an exhibit up one band, and where each band goes
 * when it does. CRITICAL is absent from the target side on purpose: it is only ever
 * reached by what was observed about the file itself.
 */
const CONTEXT_PROMOTES_AT = 12;
const PROMOTE = Object.freeze({
  [TRIAGE_PRIORITY.LOW]: TRIAGE_PRIORITY.MEDIUM,
  [TRIAGE_PRIORITY.MEDIUM]: TRIAGE_PRIORITY.HIGH,
  [TRIAGE_PRIORITY.HIGH]: TRIAGE_PRIORITY.HIGH,
  [TRIAGE_PRIORITY.CRITICAL]: TRIAGE_PRIORITY.CRITICAL,
});

/** Editing-software signatures that commonly appear in re-encoded media. */
const EDITOR_SIGNATURES = [
  'photoshop',
  'gimp',
  'lightroom',
  'snapseed',
  'picsart',
  'facetune',
  'ffmpeg',
  'handbrake',
  'premiere',
  'after effects',
  'canva',
];

const isImage = (mimeType) => /^image\//i.test(mimeType ?? '');
const isVideo = (mimeType) => /^video\//i.test(mimeType ?? '');
const isAudio = (mimeType) => /^audio\//i.test(mimeType ?? '');

/** Media types where a forensic examination is a realistic question to ask. */
const isSynthesisable = (mimeType) => isImage(mimeType) || isVideo(mimeType) || isAudio(mimeType);

/**
 * Case classes where the consequence of missing a manipulated exhibit is highest.
 * This nudges the ORDER of the queue; it never changes what an exhibit is.
 */
const GRAVE_SENSITIVITY = new Set(['POCSO', 'SEXUAL_OFFENCE', 'SC_ST', 'NDPS', 'JUVENILE']);

/**
 * Compute review priority from the signals available at ingest.
 *
 * Deliberately metadata-only on the file itself: it is fast, it is explainable to a
 * court, and every indicator can be stated in one sentence a judge can evaluate.
 *
 * @param {object} input
 * @param {string} input.mimeType
 * @param {number} input.sizeBytes
 * @param {object} [input.metadata]           extracted EXIF/container metadata
 * @param {string} [input.originalFilename]
 * @param {Date}   [input.capturedAt]
 * @param {string} [input.kind]               DIGITAL | PHYSICAL
 * @param {string} [input.sourceType]         SOURCE_TYPE value
 * @param {boolean}[input.hashMatched]        did the received bytes hash to the officer's digest
 * @param {boolean}[input.signatureValid]     did the officer's device signature verify
 * @param {string} [input.sensitivityClass]   the CASE's sensitivity class
 * @param {number} [input.maxPunishmentYears] the CASE's maximum punishment
 * @returns {{priority:string, indicators:string[], reasons:Array<{label:string,weight:number}>,
 *            examinationRecommended:boolean, modelName:string, modelVersion:string,
 *            generatedAt:Date, disclaimer:string}}
 */
export function triageEvidence({
  mimeType,
  sizeBytes,
  metadata = {},
  originalFilename = null,
  capturedAt = null,
  kind = null,
  sourceType = null,
  hashMatched = true,
  signatureValid = true,
  sensitivityClass = null,
  maxPunishmentYears = null,
} = {}) {
  /**
   * Two kinds of reason, kept apart on purpose.
   *
   *   'finding' — something observed ABOUT THIS FILE that a person should look at.
   *   'context' — what kind of exhibit it is and how grave the case is. These move a
   *               file up the queue; they are not observations about it, and calling
   *               them indicators would put "this is an image" on screen beside
   *               "the durations disagree" as though the two were comparable.
   *
   * `indicators` therefore holds findings only, and an exhibit with clean metadata
   * has none — which is the honest answer.
   */
  const reasons = [];
  const note = (weight, label, kind = 'finding') => reasons.push({ label, weight, kind });

  // ---- 1. integrity of the ingest itself -------------------------------------
  // The strongest signal the system has, and the only one that reaches CRITICAL by
  // itself. It says nothing about whether the file is authentic — it says the copy
  // that arrived is not provably the copy the officer hashed, which is a question a
  // human must answer before anything else happens to this exhibit.
  if (hashMatched === false) {
    note(70, 'The bytes received did not hash to the digest the officer recorded');
  }
  if (signatureValid === false) {
    note(65, "The officer's device signature over the digest did not verify");
  }

  // ---- 2. manipulation indicators in the file's own metadata -----------------
  if (isSynthesisable(mimeType)) {
    const software = String(metadata.software ?? metadata.encoder ?? '').toLowerCase();
    if (software && EDITOR_SIGNATURES.some((sig) => software.includes(sig))) {
      note(22, `Editing software tag present (${metadata.software ?? metadata.encoder})`);
    }

    if (!metadata.dateTimeOriginal && !capturedAt) {
      note(10, 'No capture timestamp in the file or on the record');
    }

    if (!metadata.make && !metadata.model) {
      note(8, 'No capture device make or model recorded');
    }

    // Content credentials (C2PA) would positively attest provenance. Their absence is
    // not suspicious on its own — which is exactly why it is worth very little here
    // and is never, alone, a reason to look at something.
    if (!metadata.hasC2PA) {
      note(4, 'No content credentials (C2PA) present');
    }
  }

  if (isVideo(mimeType) || isAudio(mimeType)) {
    const { containerDurationSec, streamDurationSec } = metadata;
    if (
      Number.isFinite(containerDurationSec) &&
      Number.isFinite(streamDurationSec) &&
      Math.abs(containerDurationSec - streamDurationSec) > 1
    ) {
      const drift = Math.round(Math.abs(containerDurationSec - streamDurationSec));
      note(26, `Container and stream durations disagree by ${drift}s`);
    }
  }

  if (metadata.compressionVarianceHigh === true) {
    note(24, 'Compression inconsistency across regions of the image');
  }

  if (metadata.doubleEncoded === true) {
    note(18, 'Evidence of a second encoding pass');
  }

  if (originalFilename && /(copy|edited|final|whatsapp|screenshot|forward)/i.test(originalFilename)) {
    note(12, 'Filename suggests a derived or re-shared copy rather than an original');
  }

  if (Number.isFinite(sizeBytes) && sizeBytes > 0 && sizeBytes < 32 * 1024 && isImage(mimeType)) {
    note(9, 'Unusually small file for a camera original');
  }

  // ---- 3. what kind of exhibit this is ---------------------------------------
  // Synthetic media is the class where a deepfake is a live possibility, so it starts
  // marginally above a scanned document. This is a floor, not a finding.
  if (isVideo(mimeType) || isAudio(mimeType)) {
    note(8, 'Video or audio — the classes where synthetic media is a live risk', 'context');
  } else if (isImage(mimeType)) {
    note(5, 'Image — open to editing and to synthesis', 'context');
  }

  if (sourceType === 'CLOUD' || sourceType === 'OTHER') {
    note(
      7,
      `Source is ${String(sourceType).toLowerCase()} rather than a device held in evidence`,
      'context'
    );
  }

  // ---- 4. what the case is ---------------------------------------------------
  // Gravity does not make an exhibit more suspect. It makes getting it wrong cost
  // more, which is a reason to look sooner.
  if (sensitivityClass && GRAVE_SENSITIVITY.has(sensitivityClass)) {
    note(10, `Case is classified ${sensitivityClass.replace(/_/g, ' ').toLowerCase()}`, 'context');
  }
  if (Number.isFinite(maxPunishmentYears) && maxPunishmentYears >= 7) {
    note(6, `Offence carries up to ${maxPunishmentYears} years`, 'context');
  }

  // ---- band it --------------------------------------------------------------
  /**
   * Findings decide the band. Context can promote it by ONE, and no more.
   *
   * This is the rule that keeps the bands meaning something. Gravity and media type
   * are true of a whole class of exhibits — every photograph on a POCSO case shares
   * them — so if they counted towards the band directly, every exhibit on a serious
   * case would arrive pre-elevated and LOW would stop existing. An examiner reading a
   * queue where everything is HIGH is reading an unordered queue.
   *
   * So: what was OBSERVED about this file sets the band. What the file IS, and how
   * grave the case is, moves it up one place when there was something to observe in
   * the first place — and never into CRITICAL, which stays reserved for findings.
   */
  const sum = (kind) =>
    reasons.filter((r) => r.kind === kind).reduce((total, r) => total + r.weight, 0);

  const findings = sum('finding');
  const context = sum('context');

  let priority = BANDS.find(([floor]) => findings >= floor)?.[1] ?? TRIAGE_PRIORITY.LOW;

  if (findings > 0 && context >= CONTEXT_PROMOTES_AT) {
    priority = PROMOTE[priority] ?? priority;
  }

  // Strongest reasons first: an examiner reads the top two and stops.
  reasons.sort((a, b) => b.weight - a.weight);

  return {
    priority,
    /**
     * What was observed about this file, as plain sentences. Kept under the name
     * `indicators` because that is the field already on the record and in the API;
     * `reasons` carries everything — findings and context — with the weight each
     * contributed, for a screen that wants to show the working.
     */
    indicators: reasons.filter((r) => r.kind === 'finding').map((r) => r.label),
    reasons,
    /**
     * Whether this is the kind of exhibit a laboratory could say something useful
     * about. A scanned witness statement is not, however high its priority.
     */
    examinationRecommended: isSynthesisable(mimeType) && kind !== 'PHYSICAL',
    modelName: MODEL_NAME,
    modelVersion: MODEL_VERSION,
    generatedAt: new Date(),
    // Not optional, not configurable, not omitted from any response.
    disclaimer: TRIAGE_DISCLAIMER,
  };
}

export default { triageEvidence };
