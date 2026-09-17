/**
 * The shape of an AI deepfake analysis, stated twice on purpose.
 *
 *   RESPONSE_SCHEMA — sent TO the model, so its output is constrained to this shape.
 *   validateAnalysis — applied to what comes BACK, before anything is stored.
 *
 * Structured output makes a well-formed response very likely; it does not make one
 * certain, and it says nothing about whether the content is coherent. So the backend
 * validates both: the schema (types, enums, ranges, lengths) and a small set of
 * business rules that catch an analysis contradicting itself. An analysis that fails
 * either is refused — the evidence is marked FAILED and can be retried — rather than
 * stored as though it were a result.
 *
 * None of these rules derive a value. They accept or refuse what the model produced.
 */
import { z } from 'zod';
import { DEEPFAKE_ASSESSMENT, TRIAGE_PRIORITY, values } from '../../models/enums.js';

/** Response schema (OpenAPI 3.0 subset, as the generateContent API expects). */
export const RESPONSE_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    deepfakeAssessment: { type: 'STRING', enum: values(DEEPFAKE_ASSESSMENT) },
    deepfakeScore: { type: 'INTEGER', minimum: 0, maximum: 100 },
    analysisDescription: { type: 'STRING' },
    detectedIndicators: { type: 'ARRAY', items: { type: 'STRING' } },
    triagePriority: { type: 'STRING', enum: values(TRIAGE_PRIORITY) },
    priorityReason: { type: 'STRING' },
    fslReviewRecommended: { type: 'BOOLEAN' },
    fslReviewReason: { type: 'STRING' },
    evidenceSummary: { type: 'STRING' },
  },
  required: [
    'deepfakeAssessment',
    'deepfakeScore',
    'analysisDescription',
    'detectedIndicators',
    'triagePriority',
    'priorityReason',
    'fslReviewRecommended',
    'fslReviewReason',
    'evidenceSummary',
  ],
  propertyOrdering: [
    'deepfakeAssessment',
    'deepfakeScore',
    'analysisDescription',
    'detectedIndicators',
    'triagePriority',
    'priorityReason',
    'fslReviewRecommended',
    'fslReviewReason',
    'evidenceSummary',
  ],
});

const text = (min, max) => z.string().trim().min(min).max(max);

const analysisZod = z.object({
  deepfakeAssessment: z.enum(values(DEEPFAKE_ASSESSMENT)),
  deepfakeScore: z.number().int().min(0).max(100),
  analysisDescription: text(20, 2000),
  detectedIndicators: z.array(text(3, 300)).max(20),
  triagePriority: z.enum(values(TRIAGE_PRIORITY)),
  priorityReason: text(10, 1000),
  fslReviewRecommended: z.boolean(),
  fslReviewReason: z.string().trim().max(1000),
  evidenceSummary: text(5, 500),
});

export class AnalysisValidationError extends Error {
  constructor(code, message, issues = []) {
    super(message);
    this.name = 'AnalysisValidationError';
    this.code = code;
    this.issues = issues;
    // A model can answer differently the second time; a refused analysis is retryable.
    this.retryable = true;
  }
}

const zodIssues = (error) =>
  error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 10);

/**
 * Validate a parsed analysis response. Returns the clean object or throws.
 *
 * @param {unknown} raw
 * @returns {z.infer<typeof analysisZod>}
 */
export function validateAnalysis(raw) {
  const parsed = analysisZod.safeParse(raw);
  if (!parsed.success) {
    throw new AnalysisValidationError(
      'AI_RESPONSE_SCHEMA_INVALID',
      'The AI service returned an analysis that does not match the required schema',
      zodIssues(parsed.error)
    );
  }
  const a = parsed.data;
  const problems = [];

  // The two statements about manipulation must not contradict each other. The score is
  // defined to the model as "how likely it is manipulated", so an assessment pointing
  // one way with a score pointing the other is an incoherent answer, not a borderline one.
  if (a.deepfakeAssessment === DEEPFAKE_ASSESSMENT.LIKELY_MANIPULATED && a.deepfakeScore < 50) {
    problems.push('LIKELY_MANIPULATED with a score below the midpoint');
  }
  if (a.deepfakeAssessment === DEEPFAKE_ASSESSMENT.LIKELY_AUTHENTIC && a.deepfakeScore > 50) {
    problems.push('LIKELY_AUTHENTIC with a score above the midpoint');
  }
  // A manipulation claim with nothing observed behind it is not an analysis.
  if (a.deepfakeAssessment === DEEPFAKE_ASSESSMENT.LIKELY_MANIPULATED && a.detectedIndicators.length === 0) {
    problems.push('LIKELY_MANIPULATED without any detected indicator');
  }
  // A recommendation to spend a laboratory's time must say why.
  if (a.fslReviewRecommended && a.fslReviewReason.length < 10) {
    problems.push('FSL review recommended without a reason');
  }

  if (problems.length) {
    throw new AnalysisValidationError(
      'AI_RESPONSE_INCOHERENT',
      'The AI service returned an analysis that contradicts itself, so it was not stored',
      problems
    );
  }

  return {
    ...a,
    detectedIndicators: a.detectedIndicators.filter(Boolean),
  };
}

export default {
  RESPONSE_SCHEMA,
  validateAnalysis,
  AnalysisValidationError,
};
