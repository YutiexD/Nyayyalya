/**
 * The case lifecycle as a compact stepper, and the stage as a badge.
 *
 * When the server's workflow is passed (`GET /api/cases/:id/workflow`, or `workflow` on
 * a case overview) step states come from it and not-applicable steps (committal for a
 * Magistrate-triable case) are hidden. Without it, states are derived from the stage.
 */
import { Check } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn, humanise } from '@/lib/utils';

/** CASE_STAGE values from the server, in order. */
const STAGES = [
  { key: 'UNDER_INVESTIGATION', label: 'Investigation', also: ['FURTHER_INVESTIGATION'] },
  { key: 'CHARGESHEET_FILED', label: 'Chargesheet filed' },
  { key: 'COGNIZANCE_TAKEN', label: 'Cognizance' },
  { key: 'COMMITTED', label: 'Committed' },
  { key: 'TRIAL', label: 'Trial' },
  { key: 'CLOSED', label: 'Closed', also: ['DISPOSED'] },
];

const STAGE_LABEL = {
  UNDER_INVESTIGATION: 'Investigation',
  FURTHER_INVESTIGATION: 'Further investigation',
  CHARGESHEET_FILED: 'Chargesheet filed',
  COGNIZANCE_TAKEN: 'Cognizance taken',
  COMMITTED: 'Committed',
  TRIAL: 'Trial',
  CLOSED: 'Closed',
  DISPOSED: 'Disposed',
};

/** Which step a server stage belongs to; -1 if unrecognised. */
function indexOfStage(stage) {
  if (!stage) return -1;
  return STAGES.findIndex((s) => s.key === stage || (s.also ?? []).includes(stage));
}

/**
 * @param {object} props
 * @param {string} props.stage          the case's CASE_STAGE
 * @param {object} [props.workflow]     the server's workflow for the case
 * @param {boolean} [props.compact]     hide the next-step line
 */
export function CaseLifecycle({ stage, workflow, compact = false, className }) {
  const current = indexOfStage(stage);
  const serverStates = new Map(
    (Array.isArray(workflow?.lifecycle) ? workflow.lifecycle : [])
      .filter(Boolean)
      .map((s) => [s.stage ?? s.key, s.state])
  );

  const steps = STAGES.map((step, i) => ({
    ...step,
    label: i === current && stage === 'FURTHER_INVESTIGATION' ? STAGE_LABEL[stage] : step.label,
    state: serverStates.get(step.key) ?? (i < current ? 'done' : i === current ? 'current' : 'upcoming'),
  })).filter(
    (step) =>
      step.state !== 'not_applicable' && !(step.key === 'COMMITTED' && workflow?.requiresCommittal === false)
  );

  const next = workflow?.nextPoliceAction
    ? { who: 'Police', ...workflow.nextPoliceAction }
    : workflow?.nextCourtAction
      ? { who: 'Court', ...workflow.nextCourtAction }
      : null;

  return (
    <div className={cn('space-y-2', className)}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2" aria-label="Case stage">
        {steps.map((step, i) => {
          const done = step.state === 'done';
          const here = step.state === 'current';
          return (
            <li key={step.key} className="flex items-center gap-2">
              {i > 0 && (
                <span aria-hidden className={cn('h-px w-4 sm:w-6', done || here ? 'bg-primary/50' : 'bg-border')} />
              )}
              <span
                aria-current={here ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1.5 text-meta',
                  here ? 'font-medium text-foreground' : done ? 'text-foreground/80' : 'text-muted-foreground'
                )}
              >
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold',
                    done && 'border-primary/40 bg-primary/10 text-primary',
                    here && 'border-primary bg-primary text-primary-foreground',
                    !done && !here && 'border-border bg-card text-muted-foreground'
                  )}
                >
                  {done ? <Check aria-hidden className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      {!compact && next?.label && (
        <p className="text-meta text-muted-foreground">
          <span className="font-medium text-foreground">Next · {next.who}:</span> {next.label}
        </p>
      )}
    </div>
  );
}

/** The current stage as a badge, for a list row or a header. */
export function StageBadge({ stage, size = 'sm', className }) {
  const i = indexOfStage(stage);
  const variant = i === 0 ? 'info' : i === STAGES.length - 1 ? 'muted' : 'neutral';
  return (
    <Badge variant={variant} size={size} className={className}>
      {STAGE_LABEL[stage] ?? (humanise(stage) || 'Unknown stage')}
    </Badge>
  );
}

export { STAGES as CASE_STAGES };
