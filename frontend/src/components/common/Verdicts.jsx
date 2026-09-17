/**
 * Verdicts, AI analysis and refusals.
 *
 *   AiAnalysisPanel, AiAnalysisBadge, PriorityBadge, AiStatusBadge
 *        The AI analysis of an exhibit. FOR THE LABORATORY ONLY: the server sends
 *        `aiAnalysis` to FSL and to nobody else, and no other role's screen may render
 *        these. Dashed and secondary, always called "AI analysis".
 *   ForensicOpinion, ForensicBadge
 *        The laboratory's verdict: the official finding. Solid and attributed, so it can
 *        never be mistaken for the AI analysis.
 *   Denial, Note
 *        A refusal (code and a plain sentence) and a neutral note.
 */
import { useState } from 'react';
import {
  AlertTriangle, ChevronDown, FlaskConical, Info, Loader2, RotateCcw, ShieldAlert, Sparkles,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { REASON_TEXT, explain } from '@/lib/api';
import { cn, fmtDate, humanise } from '@/lib/utils';

// ------------------------------------------------------------ AI analysis ----

/** Highest first. The one ordering every queue in the client sorts by. */
export const PRIORITY_ORDER = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

/** The one disclaimer line every AI result carries. */
export const AI_DISCLAIMER = 'AI analysis is a preliminary aid, not a forensic finding.';

export const PRIORITY_LABEL = Object.freeze({
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
});

const PRIORITY_VARIANT = { CRITICAL: 'danger', HIGH: 'warning', MEDIUM: 'info', LOW: 'muted' };

/** How each analysis state reads on screen. */
export const AI_STATUS_LABEL = Object.freeze({
  PENDING: 'AI queued',
  PROCESSING: 'AI analysing',
  COMPLETED: 'AI complete',
  FAILED: 'AI failed',
  UNSUPPORTED: 'AI not applicable',
});

const AI_STATUS_VARIANT = {
  PENDING: 'muted',
  PROCESSING: 'info',
  COMPLETED: 'success',
  FAILED: 'danger',
  UNSUPPORTED: 'muted',
};

const ASSESSMENT = {
  LIKELY_MANIPULATED: { label: 'Likely manipulated', variant: 'danger' },
  LIKELY_AUTHENTIC: { label: 'Likely authentic', variant: 'success' },
  INCONCLUSIVE: { label: 'Inconclusive', variant: 'warning' },
};

/** Review priority as a badge; a dash when there is none. FSL screens only. */
export function PriorityBadge({ priority, size = 'sm', className }) {
  if (!priority) return <span className="text-meta text-muted-foreground">—</span>;
  return (
    <Badge variant={PRIORITY_VARIANT[priority] ?? 'neutral'} size={size} dot className={className}>
      {PRIORITY_LABEL[priority] ?? humanise(priority)} priority
    </Badge>
  );
}

/** Where an analysis stands. FSL screens only. */
export function AiStatusBadge({ status, size = 'sm', className }) {
  const s = status ?? 'PENDING';
  return (
    <Badge variant={AI_STATUS_VARIANT[s] ?? 'neutral'} size={size} className={className}>
      {s === 'PROCESSING' ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
      {AI_STATUS_LABEL[s] ?? humanise(s)}
    </Badge>
  );
}

/**
 * One badge for a row: the review priority once the analysis is complete, otherwise
 * where the analysis stands. Renders nothing without an analysis — which is what every
 * non-laboratory response looks like.
 */
export function AiAnalysisBadge({ analysis, size = 'sm', className }) {
  if (!analysis) return null;
  if (analysis.status === 'COMPLETED' && analysis.triagePriority) {
    return <PriorityBadge priority={analysis.triagePriority} size={size} className={className} />;
  }
  return <AiStatusBadge status={analysis.status} size={size} className={className} />;
}

function FieldLabel({ children }) {
  return <p className="text-label font-medium text-muted-foreground">{children}</p>;
}

function IndicatorList({ items }) {
  const list = (Array.isArray(items) ? items : []).filter((x) => typeof x === 'string' && x.trim());
  if (!list.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {list.map((text, i) => (
        <li key={`${i}-${text}`} className="max-w-full">
          <Badge variant="neutral" size="sm" className="whitespace-normal text-left font-normal leading-snug">
            {text}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * The AI analysis of one exhibit, for the laboratory. Formats what the server stored;
 * computes nothing. Render it ONLY for an FSL session.
 *
 * @param {object} props
 * @param {object} props.analysis        `evidence.aiAnalysis`
 * @param {() => void} [props.onRetry]   FSL retry for a failed analysis
 * @param {boolean} [props.retrying]
 * @param {Error} [props.retryError]
 * @param {boolean} [props.compact]      hide indicators and summary
 */
export function AiAnalysisPanel({ analysis, onRetry, retrying = false, retryError = null, compact = false, className }) {
  const status = analysis?.status ?? null;

  return (
    <section className={cn('space-y-4 rounded-lg border border-dashed p-4', className)} aria-label="AI analysis">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-section text-foreground">
          <Sparkles aria-hidden className="size-4 text-muted-foreground" />
          AI analysis
        </h3>
        {status && <AiStatusBadge status={status} />}
      </div>

      {!analysis && <p className="text-meta text-muted-foreground">Not requested.</p>}

      {(status === 'PENDING' || status === 'PROCESSING') && (
        <p className="text-meta text-muted-foreground">{status === 'PENDING' ? 'Queued.' : 'Analysing…'}</p>
      )}

      {(status === 'FAILED' || status === 'UNSUPPORTED') && (
        <AiFailure analysis={analysis} onRetry={onRetry} retrying={retrying} retryError={retryError} />
      )}

      {status === 'COMPLETED' && <AiResult analysis={analysis} compact={compact} />}

      {analysis && <p className="border-t pt-3 text-label text-muted-foreground">{AI_DISCLAIMER}</p>}
    </section>
  );
}

function AiFailure({ analysis, onRetry, retrying, retryError }) {
  const failed = analysis.status === 'FAILED';
  const code = analysis.error?.code;
  // Our own sentence for a known code first: a stored message could name a vendor.
  const message =
    (code && REASON_TEXT[code]) ||
    (failed ? 'The analysis did not complete.' : 'This file type cannot be analysed.');
  const canRetry = Boolean(onRetry) && (failed || analysis.error?.retryable === true);

  return (
    <div className="space-y-3">
      <p className="text-meta text-foreground">{message}</p>
      {code && <p className="font-mono text-[11px] text-muted-foreground">{code}</p>}
      {canRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Retry
        </Button>
      )}
      {retryError && <Denial error={retryError} heading="Retry not accepted" />}
    </div>
  );
}

function AiResult({ analysis, compact }) {
  const [showSummary, setShowSummary] = useState(false);
  const score = Number.isFinite(analysis.deepfakeScore)
    ? Math.max(0, Math.min(100, Math.round(analysis.deepfakeScore)))
    : null;
  const assessment =
    ASSESSMENT[analysis.deepfakeAssessment] ??
    (analysis.deepfakeAssessment ? { label: humanise(analysis.deepfakeAssessment), variant: 'neutral' } : null);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Assessment</FieldLabel>
          {assessment ? (
            <Badge variant={assessment.variant} dot>
              {assessment.label}
            </Badge>
          ) : (
            <span className="text-meta text-muted-foreground">—</span>
          )}
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Manipulation score</FieldLabel>
          {score === null ? (
            <span className="text-meta text-muted-foreground">—</span>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold tabular text-foreground">{score}/100</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${score}%` }} />
              </span>
            </div>
          )}
        </div>
      </div>

      {analysis.analysisDescription && (
        <div className="space-y-1">
          <FieldLabel>Reasoning</FieldLabel>
          <p className="text-meta text-foreground/90">{analysis.analysisDescription}</p>
        </div>
      )}

      {!compact && Array.isArray(analysis.detectedIndicators) && analysis.detectedIndicators.length > 0 && (
        <div className="space-y-1.5">
          <FieldLabel>Indicators</FieldLabel>
          <IndicatorList items={analysis.detectedIndicators} />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Review priority</FieldLabel>
          <PriorityBadge priority={analysis.triagePriority} />
          {analysis.priorityReason && <p className="text-meta text-muted-foreground">{analysis.priorityReason}</p>}
        </div>
        <div className="space-y-1.5">
          <FieldLabel>FSL review</FieldLabel>
          {typeof analysis.fslReviewRecommended === 'boolean' ? (
            <Badge variant={analysis.fslReviewRecommended ? 'warning' : 'muted'} size="sm" dot>
              {analysis.fslReviewRecommended ? 'Recommended' : 'Not required'}
            </Badge>
          ) : (
            <span className="text-meta text-muted-foreground">—</span>
          )}
          {analysis.fslReviewReason && <p className="text-meta text-muted-foreground">{analysis.fslReviewReason}</p>}
        </div>
      </div>

      {!compact && analysis.evidenceSummary && (
        <div>
          <button
            type="button"
            onClick={() => setShowSummary((v) => !v)}
            aria-expanded={showSummary}
            className="flex items-center gap-1 text-label font-medium text-muted-foreground hover:text-foreground"
          >
            Summary
            <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', showSummary && 'rotate-180')} />
          </button>
          {showSummary && <p className="mt-1 text-meta text-muted-foreground">{analysis.evidenceSummary}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------- FSL verdict ----

const OPINION = {
  AUTHENTIC: { label: 'Authentic', variant: 'success', box: 'border-ok/30 bg-ok-muted', icon: 'text-ok' },
  MANIPULATED: { label: 'Manipulated', variant: 'danger', box: 'border-bad/30 bg-bad-muted', icon: 'text-bad' },
  INCONCLUSIVE: { label: 'Inconclusive', variant: 'warning', box: 'border-warn/30 bg-warn-muted', icon: 'text-warn' },
};

/** The laboratory's verdict — the official finding. Attributed and dated. */
export function ForensicOpinion({ forensic, className }) {
  if (!forensic?.opinion) return null;
  const o = OPINION[forensic.opinion] ?? {
    label: humanise(forensic.opinion),
    box: 'border-border bg-muted/50',
    icon: 'text-muted-foreground',
  };

  return (
    <section className={cn('space-y-1.5 rounded-lg border p-4', o.box, className)} aria-label="FSL verdict">
      <p className="flex items-center gap-2 text-section text-foreground">
        <FlaskConical aria-hidden className={cn('size-4', o.icon)} />
        FSL verdict · {o.label}
      </p>
      <p className="text-meta text-muted-foreground">
        {[
          forensic.labName ?? 'Forensic Science Laboratory',
          forensic.examinerName,
          forensic.section79ARef && `s.79A ${forensic.section79ARef}`,
          forensic.reportedAt && fmtDate(forensic.reportedAt),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {forensic.examinationSummary && (
        <p className="whitespace-pre-line pt-1 text-meta text-foreground/90">{forensic.examinationSummary}</p>
      )}
    </section>
  );
}

/** The FSL verdict as a single badge, for a list row. */
export function ForensicBadge({ forensic, size = 'sm', className }) {
  const opinion = forensic?.opinion ?? null;
  if (!opinion) {
    return (
      <Badge variant="muted" size={size} className={className}>
        Not examined
      </Badge>
    );
  }
  const o = OPINION[opinion];
  return (
    <Badge variant={o?.variant ?? 'neutral'} size={size} dot className={className}>
      FSL: {o?.label ?? humanise(opinion)}
    </Badge>
  );
}

// -------------------------------------------------------------- refusals ----

/**
 * A refusal, rendered so a human can act on it: the machine code (what an auditor
 * cites) and a plain sentence (what the user reads).
 */
export function Denial({ error, heading = 'Access denied', className }) {
  if (!error) return null;
  const code = error.code ?? 'REQUEST_FAILED';
  const details = error.details ?? null;

  return (
    <Alert variant="destructive" className={className}>
      <ShieldAlert className="size-4" />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        {heading}
        <Badge variant="outline" className="font-mono text-[11px] font-normal">
          {code}
        </Badge>
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{explain(code, error.message)}</p>
        {Array.isArray(details?.fields) && details.fields.length > 0 && (
          <p className="text-xs">Fields: {details.fields.join(', ')}</p>
        )}
        {Array.isArray(details?.itemIds) && details.itemIds.length > 0 && (
          <p className="font-mono text-xs">{details.itemIds.join(', ')}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** A neutral note. */
export function Note({ children, tone = 'info', className }) {
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  const tones = {
    info: 'border-border bg-muted/50 text-muted-foreground',
    warn: 'border-warn/35 bg-warn-muted text-warn',
  };

  return (
    <div className={cn('flex gap-2.5 rounded-xl border p-3 text-[13px]', tones[tone], className)}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}
