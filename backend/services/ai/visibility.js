/**
 * Who may see the AI analysis, and what they are shown.
 *
 * The analysis — the manipulation assessment, the score, the review priority, and
 * anything derived from them (counts, "highest priority",
 * AI-ordered lists) — exists to order a forensic laboratory's queue. It is shown to
 * FSL examiners and to nobody else: not the investigating officer, not the station,
 * not the court, not counsel. One rule, here, for every response that could carry it.
 *
 * `aiAnalysisView` is the only shape in which an analysis leaves the API. It drops the
 * persisted `provider` and `model` (kept in the database for the record) and removes
 * provider names from stored text, including records written before that rule.
 */
import { AUTHORITY, AI_DISCLAIMER } from '../../models/enums.js';
import { neutralText } from './geminiClient.js';

/** True only for a laboratory session. */
export const seesAiAnalysis = (user) => Boolean(user) && user.authority === AUTHORITY.FSL;

/** Error codes persisted by earlier versions under the provider's name. */
const neutralCode = (code) => (typeof code === 'string' ? code.replace(/^GEMINI_/, 'AI_') : code);

const neutralStrings = (arr) => (Array.isArray(arr) ? arr.map(neutralText) : []);

const errorView = (err) =>
  err
    ? {
        code: neutralCode(err.code),
        message: neutralText(err.message ?? null),
        retryable: Boolean(err.retryable),
        issues: neutralStrings(err.issues),
        at: err.at ?? null,
      }
    : null;

/** The analysis as an FSL examiner receives it. */
export function aiAnalysisView(ai) {
  if (!ai) return null;
  return {
    status: ai.status,
    requestedAt: ai.requestedAt ?? null,
    startedAt: ai.startedAt ?? null,
    completedAt: ai.completedAt ?? null,
    attempts: ai.attempts ?? 0,
    deepfakeAssessment: ai.deepfakeAssessment ?? null,
    deepfakeScore: ai.deepfakeScore ?? null,
    analysisDescription: neutralText(ai.analysisDescription ?? null),
    detectedIndicators: neutralStrings(ai.detectedIndicators),
    triagePriority: ai.triagePriority ?? null,
    priorityReason: neutralText(ai.priorityReason ?? null),
    fslReviewRecommended: ai.fslReviewRecommended ?? null,
    fslReviewReason: neutralText(ai.fslReviewReason ?? null),
    evidenceSummary: neutralText(ai.evidenceSummary ?? null),
    error: errorView(ai.error),
    // Always the current, provider-neutral text — never a stale stored copy.
    disclaimer: AI_DISCLAIMER,
  };
}

/** `aiAnalysis` for this viewer: the view for a laboratory, `undefined` for everyone else. */
export const aiAnalysisFor = (user, ai) => (seesAiAnalysis(user) ? aiAnalysisView(ai) : undefined);

export default { seesAiAnalysis, aiAnalysisView, aiAnalysisFor };
