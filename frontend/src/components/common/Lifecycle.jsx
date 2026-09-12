/**
 * The case lifecycle, drawn.
 *
 * ## Why this component exists
 *
 * Somebody watching this product for five minutes has to understand a journey that
 * crosses four authorities and a dozen screens. No amount of tidy dashboards conveys
 * that, because each dashboard only ever shows its own slice. One strip, on every
 * case, showing where this case is and what is still ahead of it, does.
 *
 * ## The claim it is careful NOT to make
 *
 * A row of connected steps reads as a pipeline: each stage waiting on the one before
 * it. Most of this journey is not like that, and pretending otherwise would misstate
 * the product:
 *
 *   - Forensic review runs ALONGSIDE the investigation. A laboratory picks work off
 *     a priority queue; it does not wait for a stage to be reached.
 *   - The court reads the whole case file whether or not a laboratory has reported.
 *     Nothing about the court's access is gated on a forensic verdict.
 *
 * So forensic review is drawn as a parallel track under the spine rather than as a
 * link in it, and the strip says so in words underneath. A diagram that implied the
 * court was blocked waiting for the FSL would be the single most misleading thing on
 * screen.
 */
import { Check } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, humanise } from '@/lib/utils';

/**
 * The spine. These are CASE_STAGE values from the server, in order, with the words a
 * person would use for them rather than the enum's.
 */
const STAGES = [
  {
    key: 'UNDER_INVESTIGATION',
    label: 'Investigation',
    also: ['FURTHER_INVESTIGATION'],
    detail: 'The case is open. Evidence can be registered and articles booked into custody.',
  },
  {
    key: 'CHARGESHEET_FILED',
    label: 'Chargesheet filed',
    detail:
      'The police report is before a court, which allots the CNR. The investigative record is fixed from this moment.',
  },
  {
    key: 'COMMITTED',
    label: 'Committed',
    detail: 'The case is committed to the court that will try it.',
  },
  {
    key: 'TRIAL',
    label: 'Trial',
    detail: 'Counsel are on record and the case file has been shared with them.',
  },
  {
    key: 'CLOSED',
    label: 'Closed',
    also: ['DISPOSED'],
    detail:
      'The court has closed the case. Every exhibit, opinion and ledger entry stays exactly where it is.',
  },
];

/** Which spine step a server stage belongs to; -1 if we do not recognise it. */
function indexOfStage(stage) {
  if (!stage) return -1;
  return STAGES.findIndex((s) => s.key === stage || (s.also ?? []).includes(stage));
}

/**
 * @param {object} props
 * @param {string} props.stage        the case's CASE_STAGE
 * @param {object} [props.summary]    the case summary the API returns alongside a case
 * @param {boolean} [props.compact]   hide the parallel track and the footnote
 */
export function CaseLifecycle({ stage, summary, compact = false, className }) {
  const current = indexOfStage(stage);

  return (
    <div className={cn('space-y-3', className)}>
      <ol className="flex items-start gap-1" aria-label="Case lifecycle">
        {STAGES.map((step, i) => {
          const done = current > i;
          const here = current === i;

          return (
            <li key={step.key} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              {/* The rail. Filled up to and including the current step. */}
              <div className="flex w-full items-center" aria-hidden>
                <span
                  className={cn(
                    'h-0.5 flex-1 rounded-full',
                    i === 0 ? 'bg-transparent' : done || here ? 'bg-ring/60' : 'bg-border'
                  )}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        'mx-1 grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold transition-colors',
                        done && 'border-ring/50 bg-ring/15 text-ring',
                        here && 'border-ring bg-ring text-background',
                        !done && !here && 'border-border bg-card text-muted-foreground'
                      )}
                    >
                      {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="font-medium">{step.label}</p>
                    <p className="mt-0.5">{step.detail}</p>
                  </TooltipContent>
                </Tooltip>
                <span
                  className={cn(
                    'h-0.5 flex-1 rounded-full',
                    i === STAGES.length - 1 ? 'bg-transparent' : done ? 'bg-ring/60' : 'bg-border'
                  )}
                />
              </div>
              <span
                className={cn(
                  'w-full truncate text-center text-[11px] leading-tight',
                  here ? 'font-semibold text-foreground' : 'text-muted-foreground'
                )}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      {!compact && (
        <div className="rounded-lg border border-dashed px-3.5 py-2.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground text-pretty">
            <span className="font-medium text-foreground">Running alongside: </span>
            forensic review. Every exhibit is given a review priority the moment it is
            registered, and a laboratory works the queue in that order — it does not wait for
            a stage, and the court reads the case file whether or not a verdict has been
            recorded.
            {summary && typeof summary.forensicOpinions === 'number' && (
              <>
                {' '}
                <span className="font-medium text-foreground">
                  {summary.forensicOpinions} of {summary.exhibits}
                </span>{' '}
                exhibit{summary.exhibits === 1 ? '' : 's'} on this case carr
                {summary.forensicOpinions === 1 ? 'ies' : 'y'} an opinion.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/** The current stage as one word, for a list row or a header. */
export function StageBadge({ stage, className }) {
  const i = indexOfStage(stage);
  const closed = i === STAGES.length - 1;
  const investigating = i === 0;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
        closed && 'border-border bg-muted text-muted-foreground',
        investigating && 'border-info/35 bg-info-muted text-info',
        !closed && !investigating && 'border-ring/30 bg-muted text-foreground',
        className
      )}
    >
      {i >= 0 ? STAGES[i].label : humanise(stage)}
    </span>
  );
}

export { STAGES as CASE_STAGES };
