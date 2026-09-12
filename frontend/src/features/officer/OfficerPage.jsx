/**
 * The investigating officer's workspace.
 *
 * ## The question this screen answers
 *
 * "Which of my cases needs something from me?"
 *
 * It used to be five tabs — cases, evidence, disclosure, custody, search — each with
 * its own tables and forms, over a "working case" selected from a dropdown at the top.
 * An officer arriving at it could not tell, without opening every tab, whether
 * anything needed doing. Now the cases are a list, the case is a panel, and the two
 * things an officer actually does to a case — register evidence, file the chargesheet
 * — are buttons on it.
 *
 * ## Disclosure is gone from this screen, on purpose
 *
 * The officer used to propose the disclosure set and ask to withhold parts of it.
 * That put a party to the case in charge of what the opposing party gets to see, and
 * it made the accused's statutory entitlement wait on a form the police had to
 * remember. Disclosure is now the court's, start to finish. The server refuses the
 * police outright, so there is nothing here that would only earn a refusal.
 *
 * Custody, the ledger and search are still here. They are behind a disclosure, because
 * they are things an officer opens occasionally rather than things they arrive to do.
 */
import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import {
  Boxes, FileText, FolderPlus, Gavel, Loader2, PackageSearch, Scale, Search,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

import {
  Counter, CounterRow, DetailSkeleton, Disclosure, Empty, Facts, Panel, Row, Rows,
  RowsSkeleton, SplitView, Workspace,
} from '@/components/common/Shell';
import { CaseLifecycle, StageBadge } from '@/components/common/Lifecycle';
import { Denial, ForensicBadge, Note, PriorityBadge } from '@/components/common/Verdicts';
import { UploadPipeline } from '@/features/officer/UploadPipeline';
import { ExhibitDialog, useExhibitDialog } from '@/features/evidence/ExhibitDialog';
import { CustodyLabelCard, ScanPanel } from '@/features/custody/CustodyKit';
import {
  useCase, useCases, useCreateCaseFromFir, useCreateCustodyItem, useCustodyItems,
  useEvidence, useFileChargesheet, useSearch,
} from '@/hooks/queries';
import { workingCaseSet, selectWorkingCaseId } from '@/features/ui/uiSlice';
import { cn, fmtDate, humanise } from '@/lib/utils';

/** Investigative writes stop at the chargesheet. Several panels need to know. */
const WRITABLE_STAGES = ['UNDER_INVESTIGATION', 'FURTHER_INVESTIGATION'];
const CUSTODY_LOCATIONS = ['FIELD', 'MALKHANA', 'FSL', 'COURT'];

/** "Malkhana" is the station's own store. The place survives; the separate role does not. */
const LOCATION_LABEL = {
  FIELD: 'In the field',
  MALKHANA: 'Station store',
  FSL: 'Laboratory',
  COURT: 'Court evidence room',
};

// ========================================================== opening a case ====

function NewCaseDialog() {
  const [open, setOpen] = useState(false);
  const [fir, setFir] = useState('');
  const create = useCreateCaseFromFir();
  const dispatch = useDispatch();

  const onSubmit = (e) => {
    e.preventDefault();
    create.mutate(fir.trim(), {
      onSuccess: (d) => {
        toast.success(`Case opened from FIR ${d.case.firNumber}`);
        dispatch(workingCaseSet(String(d.case._id)));
        setFir('');
        setOpen(false);
      },
      onError: (err) => toast.error(err.message ?? 'The case was not opened'),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <FolderPlus className="size-4" />
          Open a case
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Open a case from an FIR</DialogTitle>
          <DialogDescription>
            The case inherits its station, sections, sensitivity and investigating officer from
            the FIR the police directory already holds. Nothing on this form can change them,
            and there is no free-text case creation anywhere in this system.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fir">FIR number</Label>
            <Input
              id="fir"
              value={fir}
              onChange={(e) => setFir(e.target.value)}
              placeholder="0124/2026"
              required
            />
          </div>
          {create.isError && <Denial error={create.error} heading="Case not opened" />}
          <Button type="submit" className="w-full" disabled={create.isPending || !fir.trim()}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
            Open the case
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================== registering evidence ====

function RegisterEvidenceDialog({ caseId, caseDoc, disabled }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <PackageSearch className="size-4" />
          Register evidence
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b p-5 text-left">
          <DialogTitle>Register evidence</DialogTitle>
          <DialogDescription>
            Hashed and signed on this machine before a byte is sent. The server recomputes both
            and refuses anything that disagrees — and gives it a review priority the moment it
            lands.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[72vh]">
          <div className="p-5">
            <UploadPipeline
              caseId={caseId}
              disabled={disabled}
              disabledReason={`This case is at ${humanise(caseDoc?.stage)}, which is closed to new entries. The record is fixed at the chargesheet, for every police role.`}
            />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================ filing the case ====

function FileChargesheet({ caseDoc, caseId }) {
  const file = useFileChargesheet();
  const [open, setOpen] = useState(false);
  const writable = WRITABLE_STAGES.includes(caseDoc?.stage ?? '');

  if (!writable) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Gavel className="size-4" />
          File the chargesheet
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>File the chargesheet</DialogTitle>
          <DialogDescription>
            Filing registers the case with the court the jurisdiction router picks — the court
            allots its CNR — and closes the case to new entries. It starts the fourteen-day
            BNSS s.230 clock, and the court takes over from there.
          </DialogDescription>
        </DialogHeader>

        {file.isError && <Denial error={file.error} heading="Chargesheet not filed" />}

        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => setOpen(false)}>
            Not yet
          </Button>
          <Button
            className="flex-1"
            disabled={file.isPending}
            onClick={() =>
              file.mutate(caseId, {
                onSuccess: (d) => {
                  toast.success('Chargesheet filed', {
                    description: `CNR ${d.case?.cnrNumber ?? ''} · ${d.case?.courtName ?? ''}`,
                  });
                  setOpen(false);
                },
                onError: (err) => toast.error(err.message ?? 'Could not file'),
              })
            }
          >
            {file.isPending && <Loader2 className="size-4 animate-spin" />}
            File it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================== custody ====

function BookArticle({ caseId, canBook }) {
  const create = useCreateCustodyItem();
  const [booked, setBooked] = useState(null);
  const [form, setForm] = useState({
    description: '',
    sealNumber: '',
    imei: '',
    serialNumber: '',
    location: 'FIELD',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onSubmit = (e) => {
    e.preventDefault();
    create.mutate(
      {
        caseId,
        description: form.description.trim(),
        sealNumber: form.sealNumber.trim(),
        identifiers: {
          ...(form.imei.trim() ? { imei: form.imei.trim() } : {}),
          ...(form.serialNumber.trim() ? { serialNumber: form.serialNumber.trim() } : {}),
        },
        location: form.location,
      },
      {
        onSuccess: (d) => {
          setBooked(d.item ?? null);
          toast.success(`${d.item?.itemCode} booked`, {
            description: 'Print its label and fix it to the bag.',
          });
        },
        onError: (err) => toast.error(err.message ?? 'Could not book the article'),
      }
    );
  };

  if (!canBook) {
    return (
      <Note>
        This case is past the chargesheet, so no new article can be booked on it. Articles
        already booked can still be handed over — custody is not investigation, and a sealed
        article still has to travel.
      </Note>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="a-desc">What it is</Label>
          <Input id="a-desc" value={form.description} onChange={set('description')} required
            placeholder="Samsung Galaxy A54, black" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-seal">Seal number</Label>
          <Input id="a-seal" value={form.sealNumber} onChange={set('sealNumber')} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-loc">Where it is</Label>
          <Select
            value={form.location}
            onValueChange={(v) => setForm((f) => ({ ...f, location: v }))}
          >
            <SelectTrigger id="a-loc"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CUSTODY_LOCATIONS.map((l) => (
                <SelectItem key={l} value={l}>{LOCATION_LABEL[l]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-imei">IMEI</Label>
          <Input id="a-imei" value={form.imei} onChange={set('imei')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-serial">Serial number</Label>
          <Input id="a-serial" value={form.serialNumber} onChange={set('serialNumber')} />
        </div>
      </div>

      <Button type="submit" size="sm" disabled={create.isPending || !form.description.trim()}>
        {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Boxes className="size-4" />}
        Book into custody
      </Button>

      {create.isError && <Denial error={create.error} heading="Article not booked" />}
      {booked && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Label for {booked.itemCode}</p>
          <CustodyLabelCard item={booked} />
        </div>
      )}
    </form>
  );
}

function CustodyPanel({ caseId, canBook }) {
  const items = useCustodyItems({ caseId }, { enabled: Boolean(caseId) });
  const [selected, setSelected] = useState(null);
  const rows = items.data?.items ?? [];
  const chosen = rows.find((i) => i.id === selected) ?? null;

  return (
    <div className="space-y-4">
      {items.isPending && <RowsSkeleton rows={2} />}
      {items.isError && <Denial error={items.error} heading="Custody register unavailable" />}
      {items.isSuccess && rows.length === 0 && (
        <Empty title="No physical article on this case" icon={Boxes}>
          Digital evidence does not need one. Book an article when you seize a device, a drive
          or a disc — every later movement is then a two-scan handover.
        </Empty>
      )}
      {rows.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {rows.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => setSelected(i.id === selected ? null : i.id)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors',
                  i.id === selected ? 'row-selected' : 'hover:bg-muted/50'
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{i.description}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">
                    <code className="font-mono">{i.itemCode}</code> ·{' '}
                    {LOCATION_LABEL[i.currentLocation] ?? humanise(i.currentLocation)} ·{' '}
                    {i.currentHolder?.name ?? 'unassigned'}
                  </span>
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 rounded-full text-[11px]',
                    i.frozen
                      ? 'border-bad/35 bg-bad-muted text-bad'
                      : i.sealIntact
                        ? 'border-ok/35 bg-ok-muted text-ok'
                        : 'border-bad/35 bg-bad-muted text-bad'
                  )}
                >
                  {i.frozen ? 'Frozen' : i.sealIntact ? 'Seal intact' : 'Seal broken'}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}

      {chosen && <ScanPanel key={chosen.id} initial={chosen.qrPayload} />}

      <Disclosure label="Book a new article into custody">
        <BookArticle caseId={caseId} canBook={canBook} />
      </Disclosure>
    </div>
  );
}

// ============================================================== the case ====

function CaseDetail({ caseId }) {
  const query = useCase(caseId);
  const evidence = useEvidence({ caseId }, { enabled: Boolean(caseId) });
  const exhibitDialog = useExhibitDialog();

  if (!caseId) {
    return (
      <Panel title="No case selected">
        <Empty title="Choose a case" icon={Scale}>
          Open one from the list to see its evidence, register more, and file the chargesheet
          when the investigation is done.
        </Empty>
      </Panel>
    );
  }
  if (query.isPending) {
    return (
      <Panel title="Case">
        <DetailSkeleton />
      </Panel>
    );
  }
  if (query.isError) {
    return (
      <Panel title="Case">
        <Denial error={query.error} heading="Case not readable" />
      </Panel>
    );
  }

  const c = query.data?.case;
  if (!c) return null;

  const writable = WRITABLE_STAGES.includes(c.stage);
  const exhibits = evidence.data?.evidence ?? [];
  const summary = c.summary ?? {};

  return (
    <div className="space-y-5">
      <Panel
        title={`FIR ${c.firNumber}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <RegisterEvidenceDialog caseId={caseId} caseDoc={c} disabled={!writable} />
            <FileChargesheet caseDoc={c} caseId={caseId} />
          </div>
        }
      >
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h3 className="text-lg font-semibold leading-tight">{c.title}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <StageBadge stage={c.stage} />
              <Badge variant="outline" className="rounded-full text-[11px] font-normal">
                {humanise(c.sensitivityClass)}
              </Badge>
              {c.cnrNumber && (
                <code className="font-mono text-[11px] text-muted-foreground">
                  CNR {c.cnrNumber}
                </code>
              )}
            </div>
          </div>

          <CaseLifecycle stage={c.stage} summary={summary} />

          <Facts
            rows={[
              ['Station', <code key="s" className="font-mono text-xs">{c.stationCode}</code>],
              ['Sections', (c.bnsSections ?? []).join(', ') || '—'],
              ['Maximum punishment', `${c.maxPunishmentYears} years`],
              c.courtName && ['Before', c.courtName],
              c.clocks?.disclosureDueOn && [
                'Disclosure due',
                fmtDate(c.clocks.disclosureDueOn),
              ],
            ]}
          />

          {!writable && (
            <Note>
              This case is past the chargesheet, so its investigative record is fixed. You can
              still read everything on it, hand over articles already in custody, and sign the
              s.63 certificate for any exhibit you deposed to.
            </Note>
          )}
        </div>
      </Panel>

      <Panel
        title="Evidence on this case"
        description="Every exhibit carries a review priority computed when it was registered, and the laboratory's opinion when one has been recorded."
      >
        {evidence.isPending && <RowsSkeleton rows={3} />}
        {evidence.isError && <Denial error={evidence.error} heading="Evidence not readable" />}
        {evidence.isSuccess && exhibits.length === 0 && (
          <Empty title="No evidence registered yet" icon={PackageSearch}>
            {writable
              ? 'Register the first exhibit above. It will be hashed and signed in this browser before it is sent.'
              : 'Nothing was registered on this case before the chargesheet was filed.'}
          </Empty>
        )}
        {exhibits.length > 0 && (
          <ul className="-mx-5 -my-5 divide-y">
            {exhibits.map((e) => (
              <Row
                key={e._id}
                title={e.title}
                meta={<code className="font-mono">{e.exhibitCode}</code>}
                badge={
                  <span className="flex items-center gap-1.5">
                    <PriorityBadge priority={e.triage?.priority} disclaimer={e.triage?.disclaimer} />
                    <ForensicBadge forensic={e.forensic} />
                  </span>
                }
                onSelect={() => exhibitDialog.open(e._id)}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Disclosure
        label="Physical custody"
        hint={
          summary.exhibits
            ? 'Sealed articles on this case, and the two-scan handovers that move them.'
            : 'Sealed articles, their seals and their chain of custody.'
        }
      >
        <CustodyPanel caseId={caseId} canBook={writable} />
      </Disclosure>

      <ExhibitDialog
        evidenceId={exhibitDialog.evidenceId}
        onClose={exhibitDialog.close}
        canIssueCertificate
        canSignPartA
      />
    </div>
  );
}

// ================================================================== search ====

function SearchPanel() {
  const [q, setQ] = useState('');
  const search = useSearch(q);
  const results = search.data;

  return (
    <div className="space-y-3">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your cases and exhibits (at least 2 characters)"
      />
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Intersected with what you are entitled to see before the query runs, never filtered
        afterwards. A failure is reported as a failure and never as an empty result.
      </p>

      {search.isError && <Denial error={search.error} heading="Search unavailable" />}
      {results && (
        <div className="space-y-1.5">
          {(results.cases ?? []).map((c) => (
            <div key={c._id} className="rounded-lg border px-3 py-2 text-[13px]">
              <span className="font-medium">FIR {c.firNumber}</span> — {c.title}
            </div>
          ))}
          {(results.evidence ?? []).map((e) => (
            <div key={e._id} className="rounded-lg border px-3 py-2 text-[13px]">
              <code className="font-mono text-xs">{e.exhibitCode}</code> — {e.title}
            </div>
          ))}
          {results.total === 0 && (
            <Empty title="Nothing matched" icon={Search}>
              A genuine empty result. A failure would say so.
            </Empty>
          )}
        </div>
      )}
    </div>
  );
}

// ==================================================================== page ====

export default function OfficerPage() {
  const dispatch = useDispatch();
  const workingCaseId = useSelector(selectWorkingCaseId);
  const casesQuery = useCases({ limit: 100 });
  const cases = useMemo(() => casesQuery.data?.cases ?? [], [casesQuery.data]);

  // Land on a case so the workspace is never empty on arrival — but never override a
  // choice already made, and never keep one that is no longer in the list.
  useEffect(() => {
    if (!cases.length) return;
    if (!workingCaseId || !cases.some((c) => String(c._id) === String(workingCaseId))) {
      dispatch(workingCaseSet(String(cases[0]._id)));
    }
  }, [cases, workingCaseId, dispatch]);

  const open = cases.filter((c) => WRITABLE_STAGES.includes(c.stage));
  const totals = cases.reduce(
    (acc, c) => ({
      exhibits: acc.exhibits + (c.summary?.exhibits ?? 0),
      awaiting: acc.awaiting + (c.summary?.awaitingForensics ?? 0),
      urgent:
        acc.urgent +
        (c.summary?.highestPriority === 'CRITICAL' || c.summary?.highestPriority === 'HIGH' ? 1 : 0),
    }),
    { exhibits: 0, awaiting: 0, urgent: 0 }
  );

  const ready = casesQuery.isSuccess;

  return (
    <Workspace
      eyebrow="Police · investigating officer"
      title="Your cases"
      lede="Everything you record here is hashed, signed on your own device and written to an append-only ledger — including every refusal."
      action={<NewCaseDialog />}
    >
      {casesQuery.isError && <Denial error={casesQuery.error} heading="Cases not readable" />}

      <CounterRow>
        <Counter label="Open investigations" value={ready ? open.length : '—'} />
        <Counter label="Cases in total" value={ready ? cases.length : '—'} />
        <Counter label="Exhibits registered" value={ready ? totals.exhibits : '—'} />
        <Counter
          label="Awaiting a laboratory"
          value={ready ? totals.awaiting : '—'}
          tone={totals.awaiting > 0 ? 'warn' : 'neutral'}
        />
        <Counter
          label="Cases with urgent evidence"
          value={ready ? totals.urgent : '—'}
          tone={totals.urgent > 0 ? 'bad' : 'neutral'}
        />
      </CounterRow>

      <SplitView
        list={
          <Panel title="Cases you are on record for" bodyClassName="p-0">
            {casesQuery.isPending && <RowsSkeleton />}
            {casesQuery.isSuccess && cases.length === 0 && (
              <div className="p-5">
                <Empty title="No cases yet" icon={FileText}>
                  Open one from an FIR. A case cannot exist here without a directory record
                  behind it.
                </Empty>
              </div>
            )}
            {cases.length > 0 && (
              <Rows>
                {cases.map((c) => (
                  <Row
                    key={c._id}
                    title={c.title}
                    meta={`FIR ${c.firNumber} · ${c.summary?.exhibits ?? 0} exhibit${(c.summary?.exhibits ?? 0) === 1 ? '' : 's'}`}
                    // The badge is the one thing on the row that says "look here":
                    // the most urgent band of evidence on the case, when there is
                    // one. The stage is below, where it belongs as context.
                    badge={
                      c.summary?.highestPriority ? (
                        <PriorityBadge priority={c.summary.highestPriority} />
                      ) : null
                    }
                    selected={String(c._id) === String(workingCaseId)}
                    onSelect={() => dispatch(workingCaseSet(String(c._id)))}
                  >
                    <span className="mt-1.5 block">
                      <StageBadge stage={c.stage} />
                    </span>
                  </Row>
                ))}
              </Rows>
            )}
          </Panel>
        }
        detail={<CaseDetail caseId={workingCaseId} />}
      />

      <Disclosure label="Search" hint="Across the cases and exhibits you are entitled to see.">
        <SearchPanel />
      </Disclosure>
    </Workspace>
  );
}
