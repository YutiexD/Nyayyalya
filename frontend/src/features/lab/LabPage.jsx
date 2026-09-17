/**
 * The forensic laboratory: cases on the left, the selected case's evidence on the right,
 * and one exhibit at a time in a focused dialog (file, AI analysis, FSL verdict, s.63
 * certificate). Cases and exhibits arrive already ordered by AI review priority; nothing
 * here computes a score, a priority or a status.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FolderOpen, Inbox } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DetailSkeleton, Empty, MetaLine, Panel, Row, Rows, RowsSkeleton, SplitView, Workspace,
} from '@/components/common/Shell';
import { AiStatusBadge, Denial, ForensicBadge, PriorityBadge } from '@/components/common/Verdicts';
import { StageBadge } from '@/components/common/Lifecycle';
import { CopyableValue } from '@/components/common/CopyButton';
import { CertificateStatusBadge } from '@/features/certificates/CertificatePanel';
import { useFslCases } from '@/hooks/queries';

import { LabExhibitDialog } from './LabExhibitDialog';

const FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'To review' },
  { value: 'REVIEWED', label: 'Reviewed' },
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ badges ----

function CertificateBadge({ certificate }) {
  const last = certificate?.lastVerification;
  if (last?.result === 'VERIFIED') {
    return (
      <Badge variant="success" size="sm" dot>
        Verified
      </Badge>
    );
  }
  if (last?.result) {
    return (
      <Badge variant="danger" size="sm" dot>
        Verification failed
      </Badge>
    );
  }
  return <CertificateStatusBadge status={certificate?.status ?? null} />;
}

// ------------------------------------------------------------------- cases ----

function CaseRow({ group, selected, onSelect }) {
  const c = group.case;
  const s = group.summary ?? {};
  const exhibits = s.exhibits ?? group.evidence?.length ?? 0;
  const awaiting = s.awaitingVerdict ?? 0;

  const badge =
    exhibits > 0 && awaiting === 0 ? (
      <Badge variant="success" size="sm" dot>
        Reviewed
      </Badge>
    ) : group.highestPriority ? (
      <PriorityBadge priority={group.highestPriority} />
    ) : null;

  return (
    <Row
      title={c.title ?? 'Untitled case'}
      meta={
        <MetaLine
          items={[
            `FIR ${c.firNumber ?? '—'}`,
            plural(exhibits, 'exhibit', 'exhibits'),
            awaiting > 0 && `${awaiting} awaiting verdict`,
          ]}
        />
      }
      badge={badge}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

// ---------------------------------------------------------------- evidence ----

function EvidenceTable({ evidence, onOpen }) {
  if (!evidence.length) return <Empty title="No exhibits" icon={Inbox} compact />;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-5">Exhibit</TableHead>
          <TableHead>AI priority</TableHead>
          <TableHead>FSL verdict</TableHead>
          <TableHead>Certificate</TableHead>
          <TableHead className="w-10" aria-label="Open" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {evidence.map((card) => {
          const status = card.aiAnalysis?.status;
          return (
            <TableRow
              key={card._id}
              onClick={() => onOpen(card)}
              className="cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="py-3.5 pl-5">
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onOpen(card);
                  }}
                  className="block max-w-[20rem] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block truncate text-body font-medium text-foreground">{card.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2">
                    <code className="font-mono text-label text-muted-foreground">{card.exhibitCode}</code>
                    {status && status !== 'COMPLETED' && <AiStatusBadge status={status} />}
                  </span>
                </button>
              </TableCell>
              <TableCell>
                <PriorityBadge priority={status === 'COMPLETED' ? card.aiAnalysis?.triagePriority : null} />
              </TableCell>
              <TableCell>
                <ForensicBadge forensic={card.forensic} />
              </TableCell>
              <TableCell>
                <CertificateBadge certificate={card.certificate} />
              </TableCell>
              <TableCell className="pr-4 text-muted-foreground">
                <ChevronRight aria-hidden className="size-4" />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CaseDetail({ group, onOpen }) {
  const c = group.case;
  return (
    <section className="surface overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0 space-y-0.5">
          <MetaLine
            items={[
              `FIR ${c.firNumber ?? '—'}`,
              c.cnrNumber && (
                <span key="cnr" className="inline-flex items-center gap-1">
                  CNR <CopyableValue value={c.cnrNumber} label="Copy CNR" />
                </span>
              ),
            ]}
          />
          <h2 className="text-section text-foreground">{c.title ?? 'Untitled case'}</h2>
        </div>
        {c.stage && <StageBadge stage={c.stage} />}
      </header>
      <EvidenceTable evidence={group.evidence ?? []} onOpen={onOpen} />
    </section>
  );
}

// -------------------------------------------------------------------- page ----

export default function LabPage() {
  const qc = useQueryClient();
  const [state, setState] = useState('ALL');
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [openCard, setOpenCard] = useState(null);
  const [openFir, setOpenFir] = useState(null);

  const cases = useFslCases({ state });
  const groups = useMemo(() => cases.data?.cases ?? [], [cases.data]);

  // Derived, not stored-and-corrected: a case that leaves the filter falls back to the
  // head of the list (the most urgent case).
  const selectedGroup =
    groups.find((g) => String(g.case.id) === String(selectedCaseId)) ?? groups[0] ?? null;

  // The open exhibit follows the live list, and keeps its last card if it leaves the filter.
  const liveCard = openCard
    ? groups.flatMap((g) => g.evidence ?? []).find((x) => String(x._id) === String(openCard._id)) ?? openCard
    : null;

  const noLabScope = cases.isSuccess && !cases.data?.labId;

  const closeExhibit = () => {
    setOpenCard(null);
    // Verifying a certificate refreshes only the certificate register; refresh the list too.
    qc.invalidateQueries({ queryKey: ['fsl'] });
  };

  const filter = (
    <Tabs value={state} onValueChange={setState}>
      <TabsList>
        {FILTERS.map((f) => (
          <TabsTrigger key={f.value} value={f.value}>
            {f.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  return (
    <Workspace title="Lab cases" action={!noLabScope && filter}>
      {noLabScope ? (
        <Panel>
          <Empty title="No laboratory is assigned to this account" icon={Inbox} />
        </Panel>
      ) : (
        <SplitView
          sticky
          list={
            <Panel title="Cases" bodyClassName="p-0">
              {cases.isPending && <RowsSkeleton />}
              {cases.isError && (
                <div className="p-5">
                  <Denial error={cases.error} heading="Cases unavailable" />
                </div>
              )}
              {cases.isSuccess && groups.length === 0 && (
                <Empty
                  title={state === 'PENDING' ? 'Nothing to review' : state === 'REVIEWED' ? 'No reviewed cases' : 'No cases'}
                  icon={Inbox}
                />
              )}
              {groups.length > 0 && (
                <Rows>
                  {groups.map((g) => (
                    <CaseRow
                      key={g.case.id}
                      group={g}
                      selected={String(g.case.id) === String(selectedGroup?.case.id)}
                      onSelect={() => setSelectedCaseId(String(g.case.id))}
                    />
                  ))}
                </Rows>
              )}
            </Panel>
          }
          detail={
            cases.isPending ? (
              <Panel>
                <DetailSkeleton />
              </Panel>
            ) : selectedGroup ? (
              <CaseDetail
                key={selectedGroup.case.id}
                group={selectedGroup}
                onOpen={(card) => {
                  setOpenCard(card);
                  setOpenFir(selectedGroup.case.firNumber ?? null);
                }}
              />
            ) : cases.isSuccess ? (
              <Panel>
                <Empty title="Select a case" icon={FolderOpen} />
              </Panel>
            ) : null
          }
        />
      )}

      <LabExhibitDialog card={liveCard} caseInfo={{ firNumber: openFir }} onClose={closeExhibit} />
    </Workspace>
  );
}
