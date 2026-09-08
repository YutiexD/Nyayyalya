/**
 * The components that carry this system's compliance rules.
 *
 * Three claims are rendered in this product and they must never look alike, because
 * they are not alike:
 *
 *   ReviewPriority   — machine triage. Labelled "Review Priority", HIGH/MEDIUM/LOW,
 *                      never "verified", never "confidence", never a percentage, and
 *                      never shown without the API's own disclaimer beside it.
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
 */
import { AlertTriangle, ShieldAlert, FlaskConical, Info } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { explain } from '@/lib/api';
import { cn, humanise, fmtDate } from '@/lib/utils';

// ------------------------------------------------------------ machine triage ----

const PRIORITY_STYLES = {
  HIGH: 'border-warn/40 bg-warn-muted text-warn',
  MEDIUM: 'border-border bg-muted text-muted-foreground',
  LOW: 'border-border bg-muted text-muted-foreground',
};

/**
 * Machine triage. Note what this is NOT allowed to say.
 *
 * @param {object} props
 * @param {string} props.priority HIGH | MEDIUM | LOW
 * @param {string} [props.disclaimer] the API's own wording, rendered verbatim
 */
export function ReviewPriority({ priority, disclaimer, className }) {
  if (!priority) return null;
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          Review Priority
        </span>
        <Badge variant="outline" className={cn('font-medium', PRIORITY_STYLES[priority])}>
          {priority}
        </Badge>
      </div>
      {disclaimer && (
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{disclaimer}</p>
      )}
    </div>
  );
}

// -------------------------------------------------------- forensic opinion ----

const OPINION_STYLES = {
  AUTHENTIC: 'border-ok/40 bg-ok-muted',
  MANIPULATED: 'border-bad/40 bg-bad-muted',
  INCONCLUSIVE: 'border-warn/40 bg-warn-muted',
};

/**
 * The laboratory's authenticity opinion — the only authenticity claim in the system.
 * Always attributed, always dated, always carrying the s.79A notification reference.
 */
export function ForensicOpinion({ forensic, className }) {
  if (!forensic?.opinion) return null;
  return (
    <Card className={cn('border', OPINION_STYLES[forensic.opinion], className)}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FlaskConical className="size-4" />
          Laboratory opinion — {humanise(forensic.opinion)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p className="text-muted-foreground">
          {forensic.labName ?? 'Forensic Science Laboratory'}
          {forensic.section79ARef ? ` · s.79A ${forensic.section79ARef}` : ''}
        </p>
        {forensic.reportedAt && (
          <p className="text-xs text-muted-foreground">Reported {fmtDate(forensic.reportedAt)}</p>
        )}
        <p className="pt-1 text-xs text-muted-foreground">
          This is the examining laboratory&rsquo;s finding, signed by the examiner. It is not
          produced by, and cannot be produced by, any automated step in this system.
        </p>
      </CardContent>
    </Card>
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
        <Badge variant="outline" className="font-mono text-[11px]">
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

/** A neutral note. Used where an empty result needs explaining rather than a blank box. */
export function Note({ children, tone = 'info', className }) {
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-md border p-3 text-sm',
        tone === 'warn' ? 'border-warn/40 bg-warn-muted' : 'border-border bg-muted/50',
        className
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}
