/**
 * AI triage — REVIEW PRIORITISATION ONLY.
 *
 * ## What this is
 * A heuristic that decides what a human should look at first.
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
 * If an LLM is ever put in this loop, it receives EXTRACTED METADATA ONLY — never
 * the file bytes, which would send evidence to a third party.
 */
import { TRIAGE_PRIORITY, TRIAGE_DISCLAIMER } from '../models/enums.js';

const MODEL_NAME = 'lexx-triage-heuristic';
const MODEL_VERSION = '0.1';

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

/**
 * Compute review priority from file metadata.
 *
 * Deliberately metadata-only: it is fast, it is explainable to a court, and every
 * indicator can be stated in one sentence a judge can evaluate. A black-box score
 * would be both less useful and less defensible.
 *
 * @param {object} input
 * @param {string} input.mimeType
 * @param {number} input.sizeBytes
 * @param {object} [input.metadata]  extracted EXIF/container metadata
 * @param {string} [input.originalFilename]
 * @param {Date}   [input.capturedAt]
 * @returns {{priority:string, indicators:string[], modelName:string, modelVersion:string, generatedAt:Date, disclaimer:string}}
 */
export function triageEvidence({
  mimeType,
  sizeBytes,
  metadata = {},
  originalFilename = null,
  capturedAt = null,
} = {}) {
  const indicators = [];

  if (isImage(mimeType) || isVideo(mimeType)) {
    if (!metadata.dateTimeOriginal && !capturedAt) {
      indicators.push('EXIF capture timestamp missing');
    }

    const software = String(metadata.software ?? metadata.encoder ?? '').toLowerCase();
    if (software && EDITOR_SIGNATURES.some((sig) => software.includes(sig))) {
      indicators.push('Editing software tag present');
    }

    if (!metadata.make && !metadata.model) {
      indicators.push('No capture device make or model recorded');
    }

    // Content credentials (C2PA) would positively attest provenance; their absence is
    // not suspicious on its own, which is exactly why it is an indicator and not a verdict.
    if (!metadata.hasC2PA) {
      indicators.push('No content credentials (C2PA) present');
    }
  }

  if (isVideo(mimeType)) {
    const { containerDurationSec, streamDurationSec } = metadata;
    if (
      Number.isFinite(containerDurationSec) &&
      Number.isFinite(streamDurationSec) &&
      Math.abs(containerDurationSec - streamDurationSec) > 1
    ) {
      indicators.push('Container and stream duration mismatch');
    }
  }

  if (metadata.compressionVarianceHigh === true) {
    indicators.push('Compression inconsistency across regions');
  }

  if (originalFilename && /(copy|edited|final|whatsapp|screenshot)/i.test(originalFilename)) {
    indicators.push('Filename suggests a derived or re-shared copy');
  }

  if (Number.isFinite(sizeBytes) && sizeBytes > 0 && sizeBytes < 32 * 1024 && isImage(mimeType)) {
    indicators.push('Unusually small file for a camera original');
  }

  const priority =
    indicators.length >= 3
      ? TRIAGE_PRIORITY.HIGH
      : indicators.length >= 1
        ? TRIAGE_PRIORITY.MEDIUM
        : TRIAGE_PRIORITY.LOW;

  return {
    priority,
    indicators,
    modelName: MODEL_NAME,
    modelVersion: MODEL_VERSION,
    generatedAt: new Date(),
    // Not optional, not configurable, not omitted from any response.
    disclaimer: TRIAGE_DISCLAIMER,
  };
}

export default { triageEvidence };
