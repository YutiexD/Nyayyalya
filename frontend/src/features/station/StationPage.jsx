/**
 * Station supervision — the SHO and the district SP.
 *
 * ## The question this screen answers
 *
 * "Is anything wrong at my station?"
 *
 * Note what it is NOT: a queue of things waiting for the supervisor's approval. No
 * workflow in this product blocks on an SHO any more. Evidence reaches a laboratory
 * because the system prioritised it, not because a supervisor remembered to refer it;
 * disclosure is the court's; an advocate comes on record through the court. An
 * approval hop that adds no decision adds only delay, and every one of them has been
 * taken out.
 *
 * What is left is what supervision actually is — visibility, plus the two acts only a
 * supervisor can perform:
 *
 *   - lifting a custody freeze after a seal exception
 *   - putting a named question to a named laboratory about a specific exhibit
 *
 * Both are on this screen, and neither is in anybody else's way.
 */
import { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import {
  AlertTriangle, Boxes, FlaskConical, Link2, Loader2, ShieldAlert,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

import {
  Counter, CounterRow, DetailSkeleton, Disclosure, Empty, Facts, Panel, Row, Rows,
  RowsSkeleton, SplitView, Workspace,
} from '@/components/common/Shell';
import {
  Denial, ForensicBadge, Note, PriorityBadge, PriorityLegend, PriorityReasons, PRIORITY_ORDER,
} from '@/components/common/Verdicts';
import { ExhibitDialog, useExhibitDialog } from '@/features/evidence/ExhibitDialog';
import { CustodyChainView, CustodyRegisterPanel, Finding, ScanPanel } from '@/features/custody/CustodyKit';
import {
  useAudit, useCases, useCustodyGaps, useExhibit, useReferToFsl, useSecurityFeed, useTriageQueue,
} from '@/hooks/queries';
import { selectSession } from '@/features/auth/authSlice';
import { explain } from '@/lib/api';
import { cn, fmtDate, humanise } from '@/lib/utils';

/** The disciplines a s.79A laboratory can be asked for. Mirrors FSL_DISCIPLINE. */
const DISCIPLINES = ['MOBILE_FORENSICS', 'MEDIA_FORENSICS', 'COMPUTER_FORENSICS'];

// ========================================================= refer to a lab ====

/**
 * A referral is a QUESTION, not a gate.
 *
 * The laboratory already sees this exhibit and has already prioritised it — a referral
 * does not make examination possible, it makes it specific: this exhibit, this
 * discipline, these questions, and the sealed article to go with it.
 */
function ReferDialog({ exhibit }) {
  const refer = useReferToFsl();
  const [open, setOpen] = useState(false);
  const [labCode, setLabCode] = useState('UP-FSL-LKO');
  const [discipline, setDiscipline] = useState('MEDIA_FORENSICS');
  const [questions, setQuestions] = useState('');

  const already = exhibit?.forensic?.status && exhibit.forensic.status !== 'NOT_REFERRED';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={already}>
          <FlaskConical className="size-4" />
          {already ? humanise(exhibit.forensic.status) : 'Put a question to a laboratory'}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Refer {exhibit?.exhibitCode} for examination</DialogTitle>
          <DialogDescription>
            The laboratory already sees this exhibit in its review queue. A referral attaches
            your questions to it and lets the sealed article travel — the lab&rsquo;s identity
            and its s.79A notification reference come from the FSL directory, never from this
            form.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            refer.mutate(
              {
                evidenceId: exhibit._id,
                payload: {
                  labCode: labCode.trim(),
                  discipline,
                  questionsPosed: questions.trim(),
                },
              },
              {
                onSuccess: (d) => {
                  toast.success(`Referred to ${d.referral.labName}`);
                  setOpen(false);
                },
                onError: (err) => toast.error(explain(err.code, err.message)),
              }
            );
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lab">Laboratory code</Label>
              <Input
                id="lab"
                value={labCode}
                onChange={(e) => setLabCode(e.target.value)}
                className="font-mono"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discipline">Discipline</Label>
              <Select value={discipline} onValueChange={setDiscipline}>
                <SelectTrigger id="discipline"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DISCIPLINES.map((d) => (
                    <SelectItem key={d} value={d}>{humanise(d)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="questions">Questions for the laboratory</Label>
            <Textarea
              id="questions"
              rows={3}
              value={questions}
              onChange={(e) => setQuestions(e.target.value)}
              placeholder="Is the recording continuous? Are there signs of re-encoding or splicing?"
            />
          </div>

          {refer.isError && <Denial error={refer.error} heading="Not referred" />}

          <Button type="submit" className="w-full" disabled={refer.isPending}>
            {refer.isPending ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
            Refer for examination
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================ the exhibit ====

function ExhibitDetail({ exhibitId }) {
  const query = useExhibit(exhibitId);

  if (!exhibitId) {
    return (
      <Empty title="Choose an exhibit" icon={FlaskConical}>
        Open one from the queue to see what the system observed about it.
      </Empty>
    );
  }
  if (query.isPending) return <DetailSkeleton />;
  if (query.isError) return <Denial error={query.error} heading="Exhibit not readable" />;

  const e = query.data?.evidence;
  if (!e) return <Empty title="No such exhibit in your scope" icon={FlaskConical} />;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-[13px]">{e.exhibitCode}</code>
          <PriorityBadge priority={e.triage?.priority} disclaimer={e.triage?.disclaimer} />
          <ForensicBadge forensic={e.forensic} />
        </div>
        <h3 className="text-base font-semibold leading-snug">{e.title}</h3>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="label-xs">Why this priority</p>
        <PriorityReasons triage={e.triage} className="mt-2" limit={5} />
      </div>

      <Facts
        rows={[
          ['Type', `${e.mimeType ?? '—'}`],
          [
            'Source device',
            [humanise(e.sourceDevice?.sourceType), e.sourceDevice?.make, e.sourceDevice?.model]
              .filter(Boolean)
              .join(' · ') || '—',
          ],
          ['Registered', fmtDate(e.createdAt)],
        ]}
      />

      <ReferDialog exhibit={e} />
    </div>
  );
}

// ============================================================== the page ====

export default function StationPage() {
  const session = useSelector(selectSession);
  const readOnly = session?.role === 'DISTRICT_SP';

  const cases = useCases({ limit: 100 });
  const queue = useTriageQueue({ limit: 100 });
  const gaps = useCustodyGaps();
  const audit = useAudit({ decision: 'DENY', limit: 25 });

  const [band, setBand] = useState(null);
  const [selectedExhibit, setSelectedExhibit] = useState(null);
  const exhibitDialog = useExhibitDialog();

  const rows = useMemo(() => {
    const all = queue.data?.queue ?? [];
    return band ? all.filter((x) => x.triage?.priority === band) : all;
  }, [queue.data, band]);

  const byBand = useMemo(() => {
    const counts = Object.fromEntries(PRIORITY_ORDER.map((p) => [p, 0]));
    for (const x of queue.data?.queue ?? []) {
      const p = x.triage?.priority;
      if (p && p in counts) counts[p] += 1;
    }
    return counts;
  }, [queue.data]);

  const caseList = cases.data?.cases ?? [];
  const withFindings = (gaps.data?.items ?? []).filter((i) => (i.findings ?? []).length > 0);
  const urgent = byBand.CRITICAL + byBand.HIGH;
  const ready = queue.isSuccess;

  return (
    <Workspace
      eyebrow={readOnly ? 'Police · district supervision' : 'Police · station house officer'}
      title={readOnly ? 'Your district' : 'Your station'}
      lede="Everything registered in your scope, what the system says needs attention first, and where a chain of custody does not add up."
    >
      <CounterRow>
        <Counter label="Cases" value={cases.isSuccess ? caseList.length : '—'} />
        <Counter label="Exhibits" value={ready ? (queue.data?.queue?.length ?? 0) : '—'} />
        <Counter
          label="Needing attention"
          value={ready ? urgent : '—'}
          tone={urgent > 0 ? 'warn' : 'neutral'}
        />
        <Counter
          label="Custody findings"
          value={gaps.isSuccess ? withFindings.length : '—'}
          tone={withFindings.length > 0 ? 'bad' : 'neutral'}
        />
      </CounterRow>

      {/* ---- what needs attention first ---- */}
      <SplitView
        list={
          <Panel
            title="Evidence by review priority"
            actions={
              band && (
                <Button size="sm" variant="ghost" onClick={() => setBand(null)}>
                  Clear
                </Button>
              )
            }
            bodyClassName="p-0"
          >
            <div className="flex flex-wrap gap-1.5 border-b p-3">
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setBand((b) => (b === p ? null : p))}
                  aria-pressed={band === p}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                    band === p ? 'border-ring bg-muted' : 'hover:bg-muted/60'
                  )}
                >
                  {humanise(p)} {ready ? byBand[p] : '—'}
                </button>
              ))}
            </div>

            {queue.isPending && <RowsSkeleton />}
            {queue.isError && (
              <div className="p-5">
                <Denial error={queue.error} heading="Queue unavailable" />
              </div>
            )}
            {ready && rows.length === 0 && (
              <div className="p-5">
                <Empty title="Nothing queued in your scope" icon={FlaskConical}>
                  Every exhibit is prioritised the moment it is registered. An empty queue means
                  nothing has been registered here yet.
                </Empty>
              </div>
            )}
            {rows.length > 0 && (
              <Rows>
                {rows.map((e) => (
                  <Row
                    key={e._id}
                    title={e.title}
                    meta={<code className="font-mono">{e.exhibitCode}</code>}
                    badge={
                      <PriorityBadge
                        priority={e.triage?.priority}
                        disclaimer={e.triage?.disclaimer}
                      />
                    }
                    selected={String(e._id) === String(selectedExhibit)}
                    onSelect={() => setSelectedExhibit(String(e._id))}
                  />
                ))}
              </Rows>
            )}
          </Panel>
        }
        detail={
          <Panel
            title="The exhibit"
            actions={
              selectedExhibit && (
                <Button size="sm" variant="ghost" onClick={() => exhibitDialog.open(selectedExhibit)}>
                  Full record
                </Button>
              )
            }
          >
            {readOnly && (
              <Note className="mb-4">
                District supervision is read-only by design: you see every case in the district
                and can change none of them.
              </Note>
            )}
            <ExhibitDetail exhibitId={selectedExhibit} />
          </Panel>
        }
      />

      <Panel title="How this queue is ordered">
        <PriorityLegend disclaimer={queue.data?.disclaimer} />
      </Panel>

      {/* ---- what is wrong ---- */}
      <Panel
        title="Chain of custody"
        description="Every article at your station, and every chain whose recorded history does not make a lawful sequence."
      >
        <GapReport gaps={gaps} />
      </Panel>

      <Disclosure label="Custody register" hint="Every sealed article in your scope, and where each one is.">
        <CustodyRegisterPanel emptyText="No physical article is booked in your scope." />
      </Disclosure>

      <Disclosure label="Resolve a label" hint="Scan or paste a QR payload to see what it really is.">
        <ScanPanel />
      </Disclosure>

      <Disclosure
        label="Refusals"
        hint="Who was refused, and why. A log that shows only successes cannot show you the advocate who reached for an exhibit outside their set."
      >
        <Refusals audit={audit} />
      </Disclosure>

      {!readOnly && (
        <Disclosure label="Sign-in refusals" hint="Identity checks the authority directory turned down.">
          <SecurityFeed />
        </Disclosure>
      )}

      <ExhibitDialog evidenceId={exhibitDialog.evidenceId} onClose={exhibitDialog.close} />
    </Workspace>
  );
}

// ================================================================== gaps ====

function GapReport({ gaps }) {
  const [chainFor, setChainFor] = useState(null);

  if (gaps.isPending) return <RowsSkeleton rows={2} />;
  if (gaps.isError) return <Denial error={gaps.error} heading="Custody not readable" />;

  const items = gaps.data?.items ?? [];
  const flagged = items.filter((i) => (i.findings ?? []).length > 0);

  if (!items.length) {
    return (
      <Empty title="No custody items in your scope" icon={Boxes}>
        Digital evidence does not need one. An article is booked when a device, a drive or a
        disc is seized.
      </Empty>
    );
  }

  if (!flagged.length) {
    return (
      <Note>
        <span className="font-medium text-foreground">
          {items.length} article{items.length === 1 ? '' : 's'}, every chain complete.
        </span>{' '}
        Each recorded movement follows lawfully from the one before it, with no gap in the
        sequence and no jump the state machine forbids.
      </Note>
    );
  }

  return (
    <div className="space-y-3">
      {flagged.map((item) => (
        <div key={item.itemId} className="space-y-2 rounded-lg border border-warn/35 bg-warn-muted/30 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">{item.description ?? item.itemCode}</p>
              <p className="text-[12px] text-muted-foreground">
                <code className="font-mono">{item.itemCode}</code> ·{' '}
                {humanise(item.recordedStatus)}
                {item.frozen ? ' · frozen' : ''}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setChainFor(chainFor === item.itemId ? null : item.itemId)}
            >
              <Link2 className="size-3.5" />
              {chainFor === item.itemId ? 'Hide the chain' : 'Read the chain'}
            </Button>
          </div>
          <ul className="space-y-1.5">
            {(item.findings ?? []).map((f, i) => (
              <li key={i}>
                <Finding finding={f} />
              </li>
            ))}
          </ul>
          {chainFor === item.itemId && <CustodyChainView itemId={item.itemId} />}
        </div>
      ))}
    </div>
  );
}

// ============================================================== refusals ====

function Refusals({ audit }) {
  if (audit.isPending) return <RowsSkeleton rows={3} />;
  if (audit.isError) return <Denial error={audit.error} heading="Audit feed not readable" />;

  const events = audit.data?.events ?? [];
  if (!events.length) {
    return (
      <Empty title="No refusals recorded in your scope" icon={ShieldAlert}>
        Every denial this system makes is written here with its reason code. None has been
        recorded for the records you supervise.
      </Empty>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {events.map((e, i) => (
        <li key={i} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-[13px]">
              <span className="font-medium">{e.authorityId ?? 'unknown'}</span> —{' '}
              {humanise(e.action)} on {humanise(e.resourceType)}
              {e.resourceLabel ? ` ${e.resourceLabel}` : ''}
            </p>
            <p className="text-[12px] text-muted-foreground">{fmtDate(e.at)}</p>
          </div>
          <Badge
            variant="outline"
            className="shrink-0 rounded-full border-bad/35 bg-bad-muted font-mono text-[10px] text-bad"
          >
            {e.reason}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function SecurityFeed() {
  const feed = useSecurityFeed();
  if (feed.isPending) return <RowsSkeleton rows={2} />;
  if (feed.isError) return <Denial error={feed.error} heading="Security feed not readable" />;

  const events = (feed.data?.events ?? []).filter((e) => e.decision === 'DENY');
  if (!events.length) {
    return (
      <Empty title="No sign-in has been refused" icon={AlertTriangle}>
        Identity checks against the authority directories have all succeeded.
      </Empty>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {events.map((e, i) => (
        <li key={i} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[13px]">
          <span className="min-w-0">
            <code className="font-mono">{e.authorityId ?? '—'}</code>
            <span className="ml-2 text-muted-foreground">{fmtDate(e.at)}</span>
          </span>
          <Badge
            variant="outline"
            className="shrink-0 rounded-full border-bad/35 bg-bad-muted font-mono text-[10px] text-bad"
          >
            {e.reason}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
