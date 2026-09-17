/**
 * Counsel: the cases the court has put you on record for, and their evidence.
 *
 * Access is automatic — the court accepting a vakalatnama opens the case and every
 * exhibit. Nothing on this page is served, acknowledged or withheld by hand.
 */
import { useMemo, useState } from 'react';
import { Scale } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  DetailSkeleton, Empty, MetaLine, Panel, Row, Rows, RowsSkeleton, SplitView, Workspace,
} from '@/components/common/Shell';
import { CaseLifecycle, StageBadge } from '@/components/common/Lifecycle';
import { CaseClosure, CaseTimeline } from '@/components/common/CaseRecord';
import { CopyableValue } from '@/components/common/CopyButton';
import { Denial } from '@/components/common/Verdicts';
import { ExhibitDialog, useExhibitDialog } from '@/features/evidence/ExhibitDialog';
import { FileVakalatnama, MyFilings } from '@/features/vakalatnama/Vakalatnama';
import { EvidenceTable } from '@/features/court/EvidenceTable';
import { useCaseFile, useCaseWorkflow, useCases } from '@/hooks/queries';
import { humanise } from '@/lib/utils';

// ============================================================== the case ====

function CaseFile({ caseId }) {
  const file = useCaseFile(caseId);
  // The case file carries no workflow; the stepper, timeline and closure come from the
  // case workflow. A refusal there simply leaves those blocks out.
  const workflowQuery = useCaseWorkflow(caseId, { retry: false });
  const exhibitDialog = useExhibitDialog();

  if (!caseId) {
    return (
      <Panel>
        <Empty title="Select a case" icon={Scale} />
      </Panel>
    );
  }
  if (file.isPending) {
    return (
      <Panel>
        <DetailSkeleton />
      </Panel>
    );
  }
  if (file.isError) {
    return <Denial error={file.error} heading="Case not available" />;
  }

  const p = file.data;
  const wfData = workflowQuery.data ?? null;
  const wf = wfData?.workflow ?? wfData;
  const workflow = Array.isArray(wf?.lifecycle) ? wf : null;
  const closure = p.closure ?? wfData?.closure ?? wfData?.case?.closure ?? null;
  const roles = [...new Set((p.onRecord ?? []).map((g) => g.role))];
  const items = (p.exhibits ?? []).map((e) => ({
    id: e.evidenceId,
    exhibitCode: e.exhibitCode,
    title: e.title,
    kind: e.kind,
    mimeType: e.mimeType,
    createdAt: e.createdAt,
    forensic: e.forensic,
    certificateId: e.certificateId,
    certificateStatus: e.certificate?.status ?? (e.certificateId ? 'ISSUED' : 'PENDING_ISSUE'),
    label: e.label ?? null,
  }));

  return (
    <div className="space-y-6">
      <Panel>
        <div className="space-y-3">
          <MetaLine
            items={[
              <span key="fir" className="font-medium text-foreground">FIR {p.firNumber}</span>,
              p.cnrNumber && (
                <span key="cnr" className="inline-flex items-center gap-1">
                  CNR <CopyableValue value={p.cnrNumber} label="Copy CNR" />
                </span>
              ),
            ]}
          />
          <h2 className="text-xl font-semibold leading-snug tracking-tight text-foreground">
            {p.title ?? `FIR ${p.firNumber}`}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <StageBadge stage={p.stage} size="default" />
            {roles.map((r) => (
              <Badge key={r} variant="info" size="default" dot>
                {humanise(r)}
              </Badge>
            ))}
          </div>
          {workflow && (
            <div className="border-t pt-3">
              <CaseLifecycle stage={p.stage} workflow={workflow} compact />
            </div>
          )}
          <CaseClosure caseId={caseId} caseDoc={p} closure={closure} />
        </div>
      </Panel>

      <CaseTimeline entries={workflow?.lifecycle} />

      <Panel title="Evidence" bodyClassName="p-0">
        <EvidenceTable items={items} onOpen={exhibitDialog.open} caseInfo={{ firNumber: p.firNumber }} />
      </Panel>

      <ExhibitDialog
        evidenceId={exhibitDialog.evidenceId}
        onClose={exhibitDialog.close}
        caseInfo={{ firNumber: p.firNumber }}
      />
    </div>
  );
}

// ================================================================== page ====

export default function CounselPage() {
  const cases = useCases();
  const list = useMemo(() => cases.data?.cases ?? [], [cases.data]);
  const [chosen, setChosen] = useState(null);

  const current = list.find((c) => String(c._id) === String(chosen)) ?? list[0] ?? null;
  const selected = current ? String(current._id) : null;

  const filings = (
    <Panel title="Your filings" bodyClassName="p-0">
      <MyFilings />
    </Panel>
  );

  return (
    <Workspace title="Your cases" action={<FileVakalatnama />}>
      {cases.isError && <Denial error={cases.error} heading="Cases not available" />}

      {cases.isSuccess && list.length === 0 ? (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Panel title="Cases">
            <Empty title="You are not on record in any case" icon={Scale} />
          </Panel>
          {filings}
        </div>
      ) : (
        <SplitView
          sticky
          list={
            <div className="space-y-6">
              <Panel title="Cases" bodyClassName="p-0">
                {cases.isPending && <RowsSkeleton rows={3} />}
                {list.length > 0 && (
                  <Rows>
                    {list.map((c) => (
                      <Row
                        key={c._id}
                        title={c.title ?? `FIR ${c.firNumber}`}
                        meta={<MetaLine items={[`FIR ${c.firNumber}`, c.courtName]} />}
                        badge={<StageBadge stage={c.stage} />}
                        selected={String(c._id) === selected}
                        onSelect={() => setChosen(String(c._id))}
                      />
                    ))}
                  </Rows>
                )}
              </Panel>
              {filings}
            </div>
          }
          detail={<CaseFile caseId={selected} />}
        />
      )}
    </Workspace>
  );
}
