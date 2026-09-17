/**
 * Station supervision — the SHO and the district SP. Read-only visibility: the cases in
 * scope, the selected case's stage and evidence, and what (if anything) it is waiting on.
 * No step in any workflow waits on a supervisor.
 */
import { useState } from 'react';
import { useSelector } from 'react-redux';
import { ChevronRight, Scale } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import {
  DetailSkeleton, Empty, MetaLine, Panel, Rows, RowsSkeleton, SectionHeader, SplitView, Workspace,
} from '@/components/common/Shell';
import { CaseLifecycle } from '@/components/common/Lifecycle';
import { CaseClosure, CaseTimeline } from '@/components/common/CaseRecord';
import { Denial } from '@/components/common/Verdicts';
import {
  CaseHeading, CaseListItem, CourtFact, EvidenceTable, shortDate,
} from '@/features/officer/CaseParts';
import { ExhibitDialog, useExhibitDialog } from '@/features/evidence/ExhibitDialog';
import { selectSession } from '@/features/auth/authSlice';
import { useCaseOverview, useCases } from '@/hooks/queries';
import { ROLE_LABEL } from '@/lib/api';
import { humanise } from '@/lib/utils';

const ACTOR = {
  POLICE: { label: 'Police', variant: 'info' },
  COURT: { label: 'Court', variant: 'neutral' },
  FSL: { label: 'FSL', variant: 'warning' },
};

/** Custody and analysis entries are not shown to police supervisors. */
const HIDDEN = /CUSTODY|AI_|ANALYSIS|PRIORITY|TRIAGE|FSL_REVIEW_RECOMMENDED/;

// ========================================================= needs attention ====

function NeedsAttention({ actions, evidence, onOpenExhibit }) {
  return (
    <div className="border-t">
      <SectionHeader title="Needs attention" className="px-6 pb-2 pt-5" />
      <Rows className="pb-2">
        {actions.map((a, i) => {
          const actor = ACTOR[a.actor] ?? { label: humanise(a.actor), variant: 'neutral' };
          const exhibit = a.target ? evidence.find((x) => x.exhibitCode === a.target) : null;
          return (
            <li key={`${a.code}-${a.target ?? ''}-${i}`} className="flex items-center gap-3 px-6 py-2.5">
              <Badge variant={actor.variant} size="sm" className="w-14 justify-center">
                {actor.label}
              </Badge>
              <span className="min-w-0 flex-1 text-body">{a.message}</span>
              {exhibit && (
                <Button size="xs" variant="ghost" onClick={() => onOpenExhibit(exhibit._id)}>
                  Open
                </Button>
              )}
            </li>
          );
        })}
      </Rows>
    </div>
  );
}

// ========================================================= recent activity ====

function RecentActivity({ events }) {
  if (!events.length) return null;
  return (
    <details className="group border-t">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />
        Recent activity
      </summary>
      <ul className="divide-y border-t">
        {events.map((e) => (
          <li key={e.seq} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-6 py-2.5">
            <span className="text-body">
              {humanise(e.eventType)}
              {e.exhibitCode && (
                <code className="ml-2 font-mono text-[12px] text-muted-foreground">{e.exhibitCode}</code>
              )}
            </span>
            <MetaLine items={[ROLE_LABEL[e.actorRole] ?? humanise(e.actorRole), shortDate(e.occurredAt)]} />
          </li>
        ))}
      </ul>
    </details>
  );
}

// ================================================================ the case ====

function CaseOverview({ caseId }) {
  const overview = useCaseOverview(caseId);
  const exhibitDialog = useExhibitDialog();

  if (!caseId) {
    return (
      <Panel>
        <Empty title="Select a case" icon={Scale} />
      </Panel>
    );
  }
  if (overview.isPending) {
    return (
      <Panel>
        <DetailSkeleton />
      </Panel>
    );
  }
  if (overview.isError) {
    return (
      <Panel>
        <Denial error={overview.error} heading="Case not readable" />
      </Panel>
    );
  }

  const data = overview.data ?? {};
  const c = data.case;
  if (!c) {
    return (
      <Panel>
        <Empty title="Case not found" icon={Scale} />
      </Panel>
    );
  }

  const evidence = data.evidence ?? [];
  const actions = (data.pendingActions ?? []).filter((a) => !HIDDEN.test(String(a.code ?? '')));
  const activity = (data.recentActivity ?? [])
    .filter((e) => !HIDDEN.test(String(e.eventType ?? '')))
    .slice(0, 6);

  return (
    <section className="surface overflow-hidden">
      <div className="space-y-5 p-6">
        <CaseHeading c={c} />
        <CaseLifecycle stage={c.stage} workflow={data.workflow} compact />
        <CourtFact c={c} />
        <CaseClosure caseId={caseId} caseDoc={c} />
      </div>

      <CaseTimeline entries={data.workflow?.lifecycle} variant="section" />

      {actions.length > 0 && (
        <NeedsAttention actions={actions} evidence={evidence} onOpenExhibit={exhibitDialog.open} />
      )}

      <div className="border-t">
        <SectionHeader
          title={`Evidence${evidence.length ? ` (${evidence.length})` : ''}`}
          className="px-6 pb-2 pt-5"
        />
        <div className="pb-2">
          <EvidenceTable evidence={evidence} onOpen={exhibitDialog.open} caseInfo={{ firNumber: c.firNumber }} />
        </div>
      </div>

      <RecentActivity events={activity} />

      <ExhibitDialog
        evidenceId={exhibitDialog.evidenceId}
        onClose={exhibitDialog.close}
        caseInfo={{ firNumber: c.firNumber }}
      />
    </section>
  );
}

// ==================================================================== page ====

export default function StationPage() {
  const session = useSelector(selectSession);
  const district = session?.role === 'DISTRICT_SP';

  const cases = useCases({ limit: 100 });
  const [picked, setPicked] = useState(null);

  const caseList = cases.data?.cases ?? [];
  // Fall back to the first case; never keep one that has left the list.
  const selectedId = caseList.some((c) => String(c._id) === picked)
    ? picked
    : caseList[0]
      ? String(caseList[0]._id)
      : null;

  return (
    <Workspace title={district ? 'District cases' : 'Station cases'}>
      {cases.isError && <Denial error={cases.error} heading="Cases not readable" />}

      <SplitView
        sticky
        list={
          <Panel bodyClassName="p-0">
            {cases.isPending && <RowsSkeleton />}
            {cases.isSuccess && caseList.length === 0 && <Empty title="No cases yet" icon={Scale} />}
            {caseList.length > 0 && (
              <Rows>
                {caseList.map((c) => (
                  <CaseListItem
                    key={c._id}
                    c={c}
                    selected={String(c._id) === selectedId}
                    onSelect={() => setPicked(String(c._id))}
                  />
                ))}
              </Rows>
            )}
          </Panel>
        }
        detail={<CaseOverview key={selectedId ?? 'none'} caseId={selectedId} />}
      />
    </Workspace>
  );
}
