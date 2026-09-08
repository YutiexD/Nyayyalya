/**
 * Court — judge, registrar, evidence custodian.
 *
 *   Cause list  — the cases listed in the court this session is rostered to. The
 *                 roster is read from the court directory at sign-in; Lexx never
 *                 assigns a judge to a case and cannot.
 *   Ledger      — the case's hash-chained history, entry by entry. Nothing is ever
 *                 removed, so this is the whole record rather than a current state.
 *   Orders      — the judicial write path, and the reason there is no delete endpoint
 *                 anywhere in this system.
 *   Disclosure  — the registry rules on the exclusions the investigating officer
 *                 requested, then serves, minting one watermark per recipient so a
 *                 leaked copy points back to the person it was served on.
 *
 * The case selected in the cause list is held in Redux rather than in each tab, so
 * switching tabs does not lose it and switching cases moves every tab at once.
 */
import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import { Gavel, Hourglass, Link2, ListTree, Scale, Send, ShieldCheck, FileStack } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import {
  Section,
  KeyValue,
  Hash,
  PageHeader,
  TableSkeleton,
  EmptyState,
} from '@/components/common/Primitives';
import { Eyebrow, StatCard } from '@/components/common/Premium';
import { Denial, Note } from '@/components/common/Verdicts';
import {
  useCases,
  useLedger,
  useVerifyChain,
  useRecordOrder,
  usePacksForCase,
  useApprovePack,
  useServePack,
} from '@/hooks/queries';
import { explain } from '@/lib/api';
import { workingCaseSet, selectWorkingCaseId } from '@/features/ui/uiSlice';
import { useReveal } from '@/hooks/useGsap';
import { cn, humanise, fmtDate } from '@/lib/utils';

/** Column headings read as labels over the data, not as a first row of it. */
const HEADINGS = '[&_th]:text-xs [&_th]:uppercase [&_th]:tracking-wider hover:bg-transparent';

/**
 * The working case, marked by the accent on its leading edge. It is the one active
 * state on the cause list, and the accent is reserved for exactly that kind of thing.
 */
const SELECTABLE_ROW =
  'cursor-pointer data-[state=selected]:[box-shadow:inset_3px_0_0_0_hsl(var(--accent-from))]';

/** A verdict pill. Colour comes from the semantic tokens so dark mode follows. */
function Verdict({ tone = 'neutral', children }) {
  const styles = {
    ok: 'border-ok/40 bg-ok-muted text-ok',
    warn: 'border-warn/40 bg-warn-muted text-warn',
    bad: 'border-bad/40 bg-bad-muted text-bad',
    neutral: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <Badge variant="outline" className={cn('rounded-full', styles[tone] ?? styles.neutral)}>
      {children}
    </Badge>
  );
}

/** The case the whole workspace is pointed at, resolved against the cause list. */
function useWorkingCase() {
  const caseId = useSelector(selectWorkingCaseId);
  const cases = useCases();
  const workingCase =
    (cases.data?.cases ?? []).find((c) => String(c._id) === String(caseId)) ?? null;
  return { caseId, workingCase, cases };
}

/** Shown by every tab that needs a case before it can say anything at all. */
function NoCaseSelected({ children }) {
  return (
    <EmptyState title="No case selected" icon={Scale}>
      {children ?? 'Open a case from the cause list. Every other tab follows that choice.'}
    </EmptyState>
  );
}

/** Splits a comma-separated list of identifiers typed by hand. */
const splitIds = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// =============================================================== FIGURES ====

/**
 * The figures above the tabs. Each is a count the page already fetches for a tab, so
 * nothing here is a second source of truth — and until a query has answered the card
 * shows a dash, because a 0 that means "not loaded yet" is indistinguishable from a
 * 0 that means "none", and the second is a finding.
 */
function CourtFigures({ caseId, workingCase, cases }) {
  const ledger = useLedger(caseId);
  const packs = usePacksForCase(caseId);

  const listed = cases.data?.cases ?? [];
  const entries = ledger.data?.entries ?? [];
  const packList = packs.data?.packs ?? [];
  const awaiting = packList.filter((p) => p.unruledExclusionCount > 0).length;
  const served = packList.filter((p) => p.status === 'SERVED').length;

  const onCase = Boolean(caseId);
  const caseCaption = workingCase
    ? `On FIR ${workingCase.firNumber}.`
    : 'Open a case from the cause list.';

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        className="will-reveal"
        label="Cases listed"
        value={cases.isSuccess ? listed.length : '—'}
        icon={Scale}
        tone="accent"
        caption="In the court your roster entry puts you in today."
      />
      <StatCard
        className="will-reveal"
        label="Ledger entries"
        value={onCase && ledger.isSuccess ? entries.length : '—'}
        icon={ListTree}
        caption={caseCaption}
        delay={0.1}
      />
      <StatCard
        className="will-reveal"
        label="Awaiting a ruling"
        value={onCase && packs.isSuccess ? awaiting : '—'}
        icon={Hourglass}
        tone={awaiting > 0 ? 'warn' : undefined}
        caption="Packs with an exclusion the registry has not decided. A pending exclusion blocks service."
        delay={0.2}
      />
      <StatCard
        className="will-reveal"
        label="Packs served"
        value={onCase && packs.isSuccess ? served : '—'}
        icon={Send}
        tone="ok"
        caption="One watermark per recipient, each recorded in the ledger at the moment of service."
        delay={0.3}
      />
    </div>
  );
}

// ========================================================== 1. CAUSE LIST ====

function CauseListTab() {
  const dispatch = useDispatch();
  const selectedId = useSelector(selectWorkingCaseId);
  const query = useCases();
  const cases = query.data?.cases ?? [];

  return (
    <Section
      title="Cases listed in your court"
      description="You see the cases listed in the court your roster entry puts you in today. That roster is read from the court directory at sign-in, and Lexx cannot write to it."
    >
      <Note>
        Opening a case here points the ledger, orders and disclosure tabs at it. A case with
        no CNR has not been committed to a court yet, which is why it may be readable in one
        role&rsquo;s view and absent from another&rsquo;s.
      </Note>

      {query.isPending && <TableSkeleton rows={5} cols={6} />}
      {query.isError && <Denial error={query.error} heading="Cause list not readable" />}

      {!query.isPending && !query.isError && cases.length === 0 && (
        <EmptyState title="No case is listed in your court" icon={Scale}>
          A case reaches a court when the chargesheet is filed and a court is recorded
          against it. Until then there is nothing here — which is a statement about listing,
          not about whether cases exist.
        </EmptyState>
      )}

      {!query.isPending && !query.isError && cases.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow className={HEADINGS}>
              <TableHead>FIR</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Station</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Sensitivity</TableHead>
              <TableHead>Maximum punishment</TableHead>
              <TableHead>CNR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cases.map((c) => {
              const id = String(c._id);
              return (
                <TableRow
                  key={id}
                  data-state={id === String(selectedId) ? 'selected' : undefined}
                  className={SELECTABLE_ROW}
                  onClick={() => dispatch(workingCaseSet(id))}
                >
                  <TableCell>
                    <code className="font-mono text-xs">{c.firNumber}</code>
                  </TableCell>
                  <TableCell className="max-w-[18rem] font-medium">{c.title ?? '—'}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{c.stationCode ?? '—'}</code>
                  </TableCell>
                  <TableCell>
                    <Verdict>{humanise(c.stage)}</Verdict>
                  </TableCell>
                  <TableCell>
                    <Verdict tone={c.sensitivityClass === 'ROUTINE' ? 'neutral' : 'warn'}>
                      {humanise(c.sensitivityClass)}
                    </Verdict>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {c.maxPunishmentYears ? `${c.maxPunishmentYears} years` : '—'}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">
                      {c.cnrNumber ?? 'not committed'}
                    </code>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

// ============================================================== 2. LEDGER ====

function ChainVerification() {
  const verify = useVerifyChain();

  const onVerify = () =>
    verify.mutate(undefined, {
      onSuccess: (result) =>
        result.intact
          ? toast.success('Chain intact', {
              description: `${result.entriesChecked} entries recomputed.`,
            })
          : toast.error('Chain broken', {
              description: `First break at sequence ${result.brokenAtSeq}.`,
            }),
      onError: (error) =>
        toast.error('Chain not verified', { description: explain(error.code, error.message) }),
    });

  return (
    <div className="space-y-4">
      <Button onClick={onVerify} disabled={verify.isPending}>
        <ShieldCheck className="size-4" />
        {verify.isPending ? 'Recomputing every entry…' : 'Verify the chain'}
      </Button>

      {verify.isError && <Denial error={verify.error} heading="Chain not verified" />}

      {verify.data && (
        <>
          <KeyValue
            rows={[
              [
                'Result',
                <Verdict key="i" tone={verify.data.intact ? 'ok' : 'bad'}>
                  {verify.data.intact ? 'Intact' : 'Broken'}
                </Verdict>,
              ],
              [
                'Entries checked',
                <span key="c" className="tabular-nums">
                  {verify.data.entriesChecked ?? 0}
                </span>,
              ],
              [
                'Broken at sequence',
                verify.data.brokenAtSeq === null || verify.data.brokenAtSeq === undefined ? (
                  <span key="b" className="text-muted-foreground">
                    no break found
                  </span>
                ) : (
                  <span key="b" className="tabular-nums text-bad">
                    {verify.data.brokenAtSeq}
                  </span>
                ),
              ],
              ['Reason', verify.data.reason ? humanise(verify.data.reason) : '—'],
              ['Verified at', fmtDate(verify.data.verifiedAt)],
            ]}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Verification recomputes each entry hash from its own contents and the hash before
            it. It is a statement about the chain the server holds, and it is scoped: it says
            whether the chain is intact and where it broke, never the contents of entries you
            are not entitled to read.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The ledger as a timeline: one rail, one dot per entry, the most recent lit. "Most
 * recent" is the highest sequence number rather than the last item, so the marker is
 * right whichever order the server chose to list them in.
 */
function LedgerTimeline({ entries }) {
  const latestSeq = Math.max(...entries.map((e) => e.seq));

  return (
    <ol className="border-l-2 border-border pl-6">
      {entries.map((entry) => {
        const latest = entry.seq === latestSeq;
        const broken = entry.eventType === 'INTEGRITY_EXCEPTION';
        return (
          <li key={entry.seq} className="relative pb-6 last:pb-0">
            <span
              aria-hidden
              className={cn(
                'absolute top-1.5 size-2.5 rounded-full ring-4 ring-card left-[calc(-1.5rem_-_6px)]',
                latest ? 'bg-accent-from' : 'bg-border',
                // An integrity exception keeps its warning colour whatever its position
                // on the rail. It is the one entry a judge must not scroll past.
                broken && 'bg-bad'
              )}
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className={cn('text-sm font-medium', broken && 'text-bad')}>
                {humanise(entry.eventType)}
              </p>
              {latest && (
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Most recent
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-mono tabular">seq {entry.seq}</span> ·{' '}
              {fmtDate(entry.occurredAt)} · {humanise(entry.actorRole) || '—'}
            </p>
            {entry.payload?.exhibitCode && (
              <p className="mt-1 text-xs text-muted-foreground">
                Exhibit <span className="font-mono">{entry.payload.exhibitCode}</span>
              </p>
            )}
            {entry.payload?.orderType && (
              <p className="mt-1 text-xs text-muted-foreground">
                Order: {entry.payload.orderType}
              </p>
            )}
            <div className="mt-1.5">
              <Hash value={entry.entryHash} label="Entry hash" />
            </div>
            {/* "In anchor batch", never "anchored in batch". The entry carries the
                id of the batch it was gathered into — it does not carry whether that
                batch was ever submitted to a chain, and only the anchoring record can
                say that. */}
            <p className="mt-1 text-xs text-muted-foreground">
              {entry.anchorBatchId
                ? `In anchor batch ${entry.anchorBatchId}`
                : 'Not yet batched'}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function LedgerTab() {
  const { caseId, workingCase } = useWorkingCase();
  const query = useLedger(caseId);
  const entries = query.data?.entries ?? [];

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[1.6fr_1fr]">
      <Section
        title={workingCase ? `Ledger — FIR ${workingCase.firNumber}` : 'Ledger'}
        description="Every entry carries the hash of the one before it. There is no update and no delete code path against this collection, so what you are reading is the whole history rather than a state somebody arrived at."
      >
        {!caseId && <NoCaseSelected />}

        {caseId && query.isPending && <Skeleton className="h-72 w-full" />}
        {caseId && query.isError && <Denial error={query.error} heading="Ledger not readable" />}

        {caseId && !query.isPending && !query.isError && entries.length === 0 && (
          <EmptyState title="No entries recorded against this case" icon={Link2}>
            The ledger is written by the acts the system records — a seizure, an upload, a
            referral, an order. A case with none has had none.
          </EmptyState>
        )}

        {caseId && entries.length > 0 && <LedgerTimeline entries={entries} />}
      </Section>

      <Section
        title="Verify the chain"
        description="Recomputes the hash chain end to end. A tampered or missing entry shows up as the sequence number where the recomputed hash stops matching the recorded one."
      >
        <ChainVerification />
      </Section>
    </div>
  );
}

// ============================================================== 3. ORDERS ====

function OrdersTab() {
  const { caseId, workingCase } = useWorkingCase();
  const record = useRecordOrder();

  const [orderType, setOrderType] = useState('');
  const [text, setText] = useState('');
  const [effectiveOn, setEffectiveOn] = useState('');

  const onSubmit = (e) => {
    e.preventDefault();
    if (!caseId) return;

    const payload = { orderType: orderType.trim(), text: text.trim() };
    // A date typed here is the court's asserted date and travels as evidence. The
    // ledger's own sequence and timestamps are the server's, and a client-asserted
    // time is never chain input.
    if (effectiveOn) payload.effectiveOn = new Date(effectiveOn).toISOString();

    record.mutate(
      { caseId, payload },
      {
        onSuccess: (result) => {
          toast.success('Order recorded in the ledger', {
            description: `Sequence ${result.ledgerSeq}.`,
          });
          setOrderType('');
          setText('');
          setEffectiveOn('');
        },
        onError: (error) =>
          toast.error('Order not recorded', { description: explain(error.code, error.message) }),
      }
    );
  };

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[1.4fr_1fr]">
      <Section
        title={workingCase ? `Judicial order — FIR ${workingCase.firNumber}` : 'Judicial order'}
        description="The order is appended to the case ledger under the authority identifier of whoever entered it, and it can never be edited or withdrawn — only followed by another order."
      >
        {!caseId ? (
          <NoCaseSelected>
            An order names one case. Open it in the cause list first.
          </NoCaseSelected>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="order-type">Order type</Label>
              <Input
                id="order-type"
                value={orderType}
                onChange={(e) => setOrderType(e.target.value)}
                placeholder="COMMITTAL / EXHIBIT_MARKED / DISCLOSURE_DIRECTION"
                required
              />
              <p className="text-xs text-muted-foreground">
                A short classifier for the register. The order itself is the text below.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="order-text">Order</Label>
              <Textarea
                id="order-text"
                rows={6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="The order, in the words it is to be recorded in."
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="effective-on">Effective on</Label>
              <Input
                id="effective-on"
                type="datetime-local"
                value={effectiveOn}
                onChange={(e) => setEffectiveOn(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Recorded as the court&rsquo;s asserted date. The ledger&rsquo;s own sequence
                and timestamps are the server&rsquo;s, and a time asserted by a browser is
                never chain input.
              </p>
            </div>

            <Button type="submit" disabled={record.isPending || !orderType.trim() || !text.trim()}>
              <Gavel className="size-4" />
              {record.isPending ? 'Recording…' : 'Record the order'}
            </Button>

            {record.isError && <Denial error={record.error} heading="Order not recorded" />}

            {record.data && (
              <KeyValue
                rows={[
                  [
                    'Ledger sequence',
                    <span key="s" className="tabular-nums">
                      {record.data.ledgerSeq}
                    </span>,
                  ],
                  ['Entry hash', <Hash key="h" value={record.data.entryHash} />],
                ]}
              />
            )}
          </form>
        )}
      </Section>

      <Section
        title="Why there is no delete button"
        description="Standing note. It applies to this form and to every other write path in the system."
      >
        <span className="grid size-10 place-items-center rounded-lg bg-accent-gradient-soft text-accent-from">
          <Gavel className="size-5" />
        </span>
        <Note>
          There is no delete endpoint anywhere in this system — not for a case, an exhibit, a
          custody item, a disclosure pack or a ledger entry. Where another design would remove
          a record, this one records an order and changes a status, signed by whoever ordered
          it. An exhibit withdrawn from the trial is still in the register, marked withdrawn,
          with the order that withdrew it beside it.
        </Note>
        <p className="text-xs leading-relaxed text-muted-foreground">
          That is what makes the ledger worth verifying. A hash chain over records that can
          quietly disappear proves nothing about the ones that are gone.
        </p>
      </Section>
    </div>
  );
}

// ========================================================== 4. DISCLOSURE ====

function PackDiscovery({ caseId, onUsePack }) {
  const query = usePacksForCase(caseId);
  const packs = query.data?.packs ?? [];

  if (!caseId) {
    return (
      <NoCaseSelected>
        Packs are listed against a case. Open one in the cause list first.
      </NoCaseSelected>
    );
  }
  if (query.isPending) return <TableSkeleton rows={3} cols={5} />;
  if (query.isError) return <Denial error={query.error} heading="Packs not listed" />;
  if (!packs.length) {
    return (
      <EmptyState title="No disclosure pack has been prepared on this case" icon={FileStack}>
        The investigating officer prepares the pack and states a reason for anything withheld.
        Until they do, there is nothing for the registry to rule on.
      </EmptyState>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className={HEADINGS}>
          <TableHead>Pack</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Exhibits</TableHead>
          <TableHead>Exclusions</TableHead>
          <TableHead>Served</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {packs.map((p) => (
          <TableRow key={p.packId}>
            <TableCell>
              <code className="font-mono text-xs">{p.packId}</code>
            </TableCell>
            <TableCell>
              <Verdict tone={p.status === 'SERVED' ? 'ok' : 'neutral'}>
                {humanise(p.status)}
              </Verdict>
            </TableCell>
            <TableCell className="tabular-nums">{p.exhibitCount ?? 0}</TableCell>
            <TableCell>
              {/* An unruled exclusion is the one number that blocks service, so it is the
                  one that gets a colour. */}
              {p.unruledExclusionCount ? (
                <Verdict tone="warn">
                  {p.unruledExclusionCount} of {p.exclusionCount} awaiting a ruling
                </Verdict>
              ) : (
                <span className="tabular-nums">{p.exclusionCount ?? 0}</span>
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {fmtDate(p.servedOn)}
            </TableCell>
            <TableCell className="text-right">
              <Button variant="ghost" size="sm" onClick={() => onUsePack(p.packId)}>
                Use this pack
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ApprovePanel({ packId }) {
  const approve = useApprovePack();
  const [redactionVariant, setRedactionVariant] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [maskVictimIdentity, setMaskVictimIdentity] = useState(false);

  const onApprove = () => {
    if (!packId) return;
    const payload = {
      approvedExclusions: splitIds(exclusions),
      maskVictimIdentity,
    };
    if (redactionVariant.trim()) payload.redactionVariant = redactionVariant.trim();

    approve.mutate(
      { packId, payload },
      {
        onSuccess: (result) =>
          result.servable
            ? toast.success('Pack approved and ready to serve')
            : toast.warning('Pack approved, exclusions still pending', {
                description: 'It cannot be served until every requested exclusion is decided.',
              }),
        onError: (error) =>
          toast.error('Pack not approved', { description: explain(error.code, error.message) }),
      }
    );
  };

  const result = approve.data;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="redaction-variant">Redaction variant</Label>
        <Input
          id="redaction-variant"
          value={redactionVariant}
          onChange={(e) => setRedactionVariant(e.target.value)}
          placeholder="DEFENCE_V1"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="exclusions">Approve these exclusions</Label>
        <Input
          id="exclusions"
          value={exclusions}
          onChange={(e) => setExclusions(e.target.value)}
          placeholder="exhibit ids to withhold, comma separated"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Each id listed here is an exhibit the registry agrees to withhold. Anything the
          officer requested and you do not rule on stays pending, and a pending exclusion
          blocks service.
        </p>
      </div>

      <div className="flex items-center gap-2.5">
        <Checkbox
          id="mask-victim"
          checked={maskVictimIdentity}
          onCheckedChange={(value) => setMaskVictimIdentity(value === true)}
        />
        <Label htmlFor="mask-victim" className="font-normal">
          Mask victim identity
        </Label>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        One-way. A case already marked victim-protected stays masked whatever is set here.
      </p>

      <Button onClick={onApprove} disabled={!packId || approve.isPending}>
        {approve.isPending ? 'Approving…' : 'Approve the pack'}
      </Button>

      {approve.isError && <Denial error={approve.error} heading="Pack not approved" />}

      {result && (
        <div className="space-y-4">
          <Note tone={result.servable ? 'info' : 'warn'}>
            {result.servable
              ? 'Pack approved and ready to serve.'
              : 'Pack approved, but exclusions are still pending a ruling — it cannot be served until every one is decided.'}
          </Note>

          <KeyValue
            rows={[
              ['Pack', <code key="p" className="font-mono text-xs">{result.pack?.packId}</code>],
              ['Status', <Verdict key="s">{humanise(result.pack?.status)}</Verdict>],
              [
                'Exhibits',
                <span key="e" className="tabular-nums">
                  {result.pack?.exhibitCount ?? 0}
                </span>,
              ],
              [
                'Redaction variant',
                <code key="r" className="font-mono text-xs">
                  {result.pack?.redactionVariant ?? '—'}
                </code>,
              ],
              ['Victim identity masked', result.pack?.maskVictimIdentity ? 'Yes' : 'No'],
            ]}
          />

          {result.pendingExclusions?.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Pending exclusions
              </p>
              <ul className="space-y-1">
                {result.pendingExclusions.map((id) => (
                  <li key={String(id)} className="font-mono text-xs">
                    {String(id)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.pack?.excludedItems?.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Exclusions on record
              </p>
              <ul className="space-y-2">
                {result.pack.excludedItems.map((x) => (
                  <li key={x.itemId} className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs">{x.itemId}</code>
                    <span className="text-xs text-muted-foreground">{x.reason}</span>
                    <Verdict tone={x.approved ? 'ok' : 'warn'}>
                      {x.approved ? 'Approved' : 'Pending'}
                    </Verdict>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ServePanel({ packId }) {
  const serve = useServePack();
  const [recipients, setRecipients] = useState('');

  const onServe = () => {
    if (!packId) return;
    const ids = splitIds(recipients);
    serve.mutate(
      { packId, payload: ids.length ? { recipientUserIds: ids } : {} },
      {
        onSuccess: (result) =>
          toast.success('Pack served', {
            description: `${result.servedNow?.length ?? 0} watermarked copy or copies minted.`,
          }),
        onError: (error) =>
          toast.error('Pack not served', { description: explain(error.code, error.message) }),
      }
    );
  };

  const served = serve.data?.servedNow ?? [];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="recipients">Recipients</Label>
        <Input
          id="recipients"
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
          placeholder="optional: recipient user ids, comma separated"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Leave blank to serve every advocate holding a live grant on this case. A grant comes
          from a vakalatnama the registrar accepted or a legal aid order, never from this form.
        </p>
      </div>

      <Button onClick={onServe} disabled={!packId || serve.isPending}>
        <Send className="size-4" />
        {serve.isPending ? 'Serving…' : 'Serve the pack'}
      </Button>

      {serve.isError && <Denial error={serve.error} heading="Pack not served" />}

      {serve.data && (
        <div className="space-y-4">
          <Note>
            Served. The BNSS s.230 clock stops for each recipient when they acknowledge, not
            when the pack leaves the registry.
          </Note>

          {served.length === 0 ? (
            <EmptyState title="No recipient was served">
              Nobody on this case holds a live grant, so there was nobody to serve. Check the
              representation record before trying again.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className={HEADINGS}>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Watermark identity</TableHead>
                  <TableHead>Token</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {served.map((row) => (
                  <TableRow key={row.userId} className="align-top">
                    <TableCell>
                      <code className="font-mono text-xs">{row.authorityId ?? row.userId}</code>
                    </TableCell>
                    <TableCell className="max-w-[20rem] text-xs">
                      {row.watermarkLabel ?? '—'}
                    </TableCell>
                    <TableCell className="max-w-[20rem]">
                      {/* The token is what ties a leaked copy back to one recipient, so it
                          is never shortened. */}
                      <Hash value={row.watermarkToken} label="Watermark token" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            Each recipient gets their own watermark token, recorded in the ledger at the moment
            of service. A copy that leaks therefore points back to the person it was served on.
          </p>
        </div>
      )}
    </div>
  );
}

function DisclosureTab() {
  const { caseId, workingCase } = useWorkingCase();
  const [packId, setPackId] = useState('');

  return (
    <div className="space-y-6">
      <Section
        title="Find the pack"
        description="Packs prepared on the case you have open. The endpoint behind this is gated on approval authority over the case, so it shows the packs on cases listed in this court and nothing else."
      >
        <Note>
          A case appears here only once it is listed before this court. Court scope is read
          from the case&rsquo;s own court, which is written when the chargesheet is filed —
          so an investigation still with the station is invisible to the registry by
          construction, not by a filter somebody remembered to apply.
        </Note>
        <PackDiscovery caseId={caseId} onUsePack={setPackId} />
      </Section>

      <Section
        title="Pack"
        description="Filled in by “Use this pack” above, or pasted by hand. Both panels below act on whatever is in this field."
      >
        <div className="space-y-2">
          <Label htmlFor="pack-id">Pack id</Label>
          <Input
            id="pack-id"
            value={packId}
            onChange={(e) => setPackId(e.target.value)}
            placeholder="select a pack above, or paste a 24-character pack id"
            className="font-mono"
          />
          {workingCase && (
            <p className="text-xs text-muted-foreground">
              Working case: FIR {workingCase.firNumber}
              {workingCase.cnrNumber ? ` · CNR ${workingCase.cnrNumber}` : ''}
            </p>
          )}
        </div>
        <Separator />
        <p className="text-xs leading-relaxed text-muted-foreground">
          The investigating officer proposes a set and states a reason for anything withheld.
          The registry rules on those reasons, then serves — and only then does defence counsel
          see anything at all.
        </p>
      </Section>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Section
          title="Approve"
          description="Rule on each requested exclusion and fix the redaction variant. A pack with an undecided exclusion cannot be served, which is what stops material being withheld by silence."
        >
          <ApprovePanel packId={packId.trim()} />
        </Section>

        {/* Serving is the act the whole tab leads to, so it is the panel that carries
            the beam. */}
        <Section
          accent
          title="Serve"
          description="Mints one watermark per recipient and records each one in the ledger. This is the act that starts the disclosure obligation running against the court's own record."
        >
          <ServePanel packId={packId.trim()} />
        </Section>
      </div>
    </div>
  );
}

// =============================================================== the page ====

export default function CourtPage() {
  const [tab, setTab] = useState('cause-list');
  const scope = useReveal();

  const { caseId, workingCase, cases } = useWorkingCase();

  return (
    <div ref={scope} className="container space-y-8 py-10">
      <div className="space-y-4">
        <div className="will-reveal">
          <Eyebrow>Court · cause list, ledger, orders, disclosure</Eyebrow>
        </div>
        <PageHeader
          title="Court"
          lede="The cause list your roster puts you in, the ledger behind each case, the orders that are the only way anything in this system changes, and the disclosure the registry rules on before defence counsel sees a single exhibit."
          actions={
            caseId && workingCase ? (
              <Badge variant="secondary" className="rounded-full px-3 py-1 font-normal">
                FIR {workingCase.firNumber}
                {workingCase.cnrNumber ? ` · ${workingCase.cnrNumber}` : ''}
              </Badge>
            ) : null
          }
        />
      </div>

      {/* A refusal on the cause list is the one error that would otherwise be invisible
          on the tabs that depend on it. */}
      {cases.isError && <Denial error={cases.error} heading="Cause list not readable" />}

      <CourtFigures caseId={caseId} workingCase={workingCase} cases={cases} />

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList className="h-auto rounded-full p-1 will-reveal">
          <TabsTrigger value="cause-list" className="rounded-full px-4 py-1.5">
            Cause list
          </TabsTrigger>
          <TabsTrigger value="ledger" className="rounded-full px-4 py-1.5">
            Ledger
          </TabsTrigger>
          <TabsTrigger value="orders" className="rounded-full px-4 py-1.5">
            Orders
          </TabsTrigger>
          <TabsTrigger value="disclosure" className="rounded-full px-4 py-1.5">
            Disclosure
          </TabsTrigger>
        </TabsList>

        <TabsContent value="cause-list" className="mt-0">
          <CauseListTab />
        </TabsContent>
        <TabsContent value="ledger" className="mt-0">
          <LedgerTab />
        </TabsContent>
        <TabsContent value="orders" className="mt-0">
          <OrdersTab />
        </TabsContent>
        <TabsContent value="disclosure" className="mt-0">
          <DisclosureTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
