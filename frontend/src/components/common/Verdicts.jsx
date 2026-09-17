/**
 * The components that carry this system's compliance rules.
 *
 * Three claims are rendered in this product and they must never look alike, because
 * they are not alike:
 *
 *   ReviewPriority   — machine triage. Labelled "Review Priority", one of four bands,
 *                      never "verified", never "confidence", never a percentage, and
 *                      never shown without the API's own disclaimer within reach.
 *   ForensicOpinion  — a s.79A laboratory's authenticity opinion. Deliberately a
 *                      different shape and weight, attributed to the lab and its
 *                      notification reference, because it is the only authenticity
 *                      finding the system carries.
 *   Denial           — a refusal. Always the machine code AND a plain sentence: a
 *                      denial the user cannot understand is a bug, not a security
 *                      feature.
 *
 * If these ever start looking similar, the product has begun claiming that an
 * automated score is a forensic finding, which is the single thing it must not do.
 *
 * ## The one change this redesign made to that rule
 *
 * The disclaimer used to be a paragraph printed under every priority badge, including
 * in table cells — so it appeared eight times on a screen, and by the third time
 * nobody was reading any of them. It is now attached to the badge as a tooltip and
 * stated once, in full, wherever a priority is the subject of the screen
 * (`PriorityLegend`). It is not optional in either place.
 */
import { AlertTriangle, FlaskConical, Info, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { explain } from '@/lib/api';
import { cn, humanise, fmtDate } from '@/lib/utils';

// ------------------------------------------------------------ machine triage ----

/** Highest first. The one ordering every queue in the client sorts by. */
export const PRIORITY_ORDER = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

/**
 * The wording that must accompany every priority.
 *
 * A fallback, not a substitute: the API sends its own text and that is what renders.
 * This exists so a response that somehow arrives without it still cannot put a
 * machine priority on screen unqualified.
 */
export const TRIAGE_DISCLAIMER =
  'Automated triage only. Not expert opinion under BSA s.39 / IT Act s.79A.';

const PRIORITY_STYLES = {
  CRITICAL: 'border-priority-critical/35 bg-priority-critical-muted text-priority-critical',
  HIGH: 'border-priority-high/35 bg-priority-high-muted text-priority-high',
  MEDIUM: 'border-priority-medium/35 bg-priority-medium-muted text-priority-medium',
  LOW: 'border-priority-low/30 bg-priority-low-muted text-priority-low',
};

/** What each band is actually telling a human to do. */
export const PRIORITY_MEANING = {
  CRITICAL: 'Look at this before anything else.',
  HIGH: 'Look at this first.',
  MEDIUM: 'Worth a look.',
  LOW: 'Nothing stood out.',
};

/**
 * Machine triage, as a badge. Note what this is NOT allowed to say.
 *
 * @param {object} props
 * @param {string} props.priority CRITICAL | HIGH | MEDIUM | LOW
 * @param {string} [props.disclaimer] the API's own wording, rendered verbatim
 */
export function PriorityBadge({ priority, disclaimer, className }) {
  if (!priority) {
    return <span className="text-[13px] text-muted-foreground">—</span>;
  }
  const style = PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.LOW;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            'rounded-full px-2.5 py-0 text-[11px] font-semibold uppercase tracking-wide',
            style,
            className
          )}
        >
          {priority}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-medium">Review Priority — {humanise(priority)}</p>
        <p className="mt-0.5">{PRIORITY_MEANING[priority]}</p>
        <p className="mt-1.5 text-muted-foreground">{disclaimer ?? TRIAGE_DISCLAIMER}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The standing statement about what a review priority is, for the screens where it is
 * the subject. Printed once per screen, in full, and never abbreviated.
 */
export function PriorityLegend({ disclaimer, className }) {
  return (
    <p className={cn('text-[13px] leading-relaxed text-muted-foreground text-pretty', className)}>
      <span className="font-medium text-foreground">Review Priority</span> is computed
      automatically for every exhibit at the moment it is registered, from its own metadata,
      the integrity of its upload, its media type and the gravity of the case. Nobody sets it
      and nobody can raise their own work up the queue.{' '}
      {disclaimer ?? TRIAGE_DISCLAIMER}
    </p>
  );
}

/**
 * Why an exhibit landed in its band, in the system's own words.
 *
 * The working, shown. A band on its own is a number to be argued with; a band with
 * "container and stream durations disagree by 19s" underneath it is a statement an
 * examiner — or a judge — can evaluate.
 */
export function PriorityReasons({ triage, limit = 4, className }) {
  const findings = triage?.indicators ?? [];
  if (!findings.length) {
    return (
      <p className={cn('text-[13px] text-muted-foreground', className)}>
        Nothing was observed about this file: its capture timestamp, device and content
        credentials are all present and consistent.
      </p>
    );
  }
  const shown = findings.slice(0, limit);
  const rest = findings.length - shown.length;

  return (
    <ul className={cn('space-y-1.5', className)}>
      {shown.map((text) => (
        <li key={text} className="flex gap-2 text-[13px] leading-relaxed">
          <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground" />
          <span>{text}</span>
        </li>
      ))}
      {rest > 0 && (
        <li className="pl-3 text-[13px] text-muted-foreground">and {rest} more</li>
      )}
    </ul>
  );
}

// -------------------------------------------------------- forensic opinion ----

const OPINION_STYLES = {
  AUTHENTIC: 'border-ok/35 bg-ok-muted',
  MANIPULATED: 'border-bad/35 bg-bad-muted',
  INCONCLUSIVE: 'border-warn/35 bg-warn-muted',
};

const OPINION_TEXT = {
  AUTHENTIC: 'text-ok',
  MANIPULATED: 'text-bad',
  INCONCLUSIVE: 'text-warn',
};

/**
 * The laboratory's authenticity opinion — the only authenticity claim in the system.
 * Always attributed, always dated, always carrying the s.79A notification reference.
 */
export function ForensicOpinion({ forensic, className }) {
  if (!forensic?.opinion) return null;

  return (
    <div className={cn('rounded-xl border p-4', OPINION_STYLES[forensic.opinion], className)}>
      <div className="flex items-center gap-2">
        <FlaskConical aria-hidden className={cn('size-4', OPINION_TEXT[forensic.opinion])} />
        <p className="text-sm font-semibold">
          Laboratory opinion — {humanise(forensic.opinion)}
        </p>
      </div>
      <p className="mt-1.5 text-[13px] text-muted-foreground">
        {forensic.labName ?? 'Forensic Science Laboratory'}
        {forensic.examinerName ? ` · ${forensic.examinerName}` : ''}
        {forensic.section79ARef ? ` · s.79A ${forensic.section79ARef}` : ''}
        {forensic.reportedAt ? ` · ${fmtDate(forensic.reportedAt)}` : ''}
      </p>
      {forensic.examinationSummary && (
        <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed">
          {forensic.examinationSummary}
        </p>
      )}
      <p className="mt-2.5 text-[12px] leading-relaxed text-muted-foreground">
        Signed by the examining laboratory. It is not produced by, and cannot be produced by,
        any automated step in this system.
      </p>
    </div>
  );
}

/** The forensic state of an exhibit as a single word, for a list row. */
const FORENSIC_BADGE = {
  AUTHENTIC: 'border-ok/35 bg-ok-muted text-ok',
  MANIPULATED: 'border-bad/35 bg-bad-muted text-bad',
  INCONCLUSIVE: 'border-warn/35 bg-warn-muted text-warn',
};

export function ForensicBadge({ forensic, className }) {
  const opinion = forensic?.opinion ?? null;
  const label = opinion ? humanise(opinion) : 'Awaiting review';

  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full px-2.5 py-0 text-[11px] font-medium',
        opinion ? FORENSIC_BADGE[opinion] : 'border-border bg-muted text-muted-foreground',
        className
      )}
    >
      {label}
    </Badge>
  );
}

// -------------------------------------------------------------- refusals ----

/**
 * A refusal, rendered so a human can act on it.
 *
 * The machine code stays visible because it is what an auditor cites; the sentence
 * underneath is what the user actually reads.
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

/** A neutral note. Used where an empty result or a constraint needs explaining. */
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
