/**
 * The investigating officer's workspace.
 *
 * Four tabs over one working case: the case file, evidence, disclosure and custody.
 * The working case lives in Redux rather than in each tab's own state, because these
 * are four views of one thing — switching tabs must not lose it, and switching cases
 * must move all four at once.
 */
import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import {
  FileText, Scale, Gavel, PackageSearch, Boxes, ShieldCheck, Loader2, Search,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';

import {
  PageHeader, Section, KeyValue, Hash, TableSkeleton, EmptyState,
} from '@/components/common/Primitives';
import { Denial, Note, ReviewPriority, ForensicOpinion } from '@/components/common/Verdicts';
import { UploadPipeline } from '@/features/officer/UploadPipeline';
import {
  useCases, useCase, useCreateCaseFromFir, useComputeJurisdiction, useFileChargesheet,
  useEvidence, useExhibit, useVerifyExhibit, usePreparePack, useCustodyItems,
  useCreateCustodyItem, useSearch,
} from '@/hooks/queries';
import { selectWorkingCaseId, workingCaseSet } from '@/features/ui/uiSlice';
import { useReveal } from '@/hooks/useGsap';
import { humanise, fmtDate, fmtBytes } from '@/lib/utils';

const CUSTODY_LOCATIONS = ['FIELD', 'MALKHANA', 'FSL', 'COURT'];

/** Investigative writes stop at the chargesheet. Every tab needs to know. */
const WRITABLE_STAGES = ['UNDER_INVESTIGATION', 'FURTHER_INVESTIGATION'];

function CasePicker({ cases, value, onChange }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="working-case">Working case</Label>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger id="working-case" className="max-w-xl">
          <SelectValue placeholder="Select a case" />
        </SelectTrigger>
        <SelectContent>
          {cases.map((c) => (
            <SelectItem key={c._id} value={c._id}>
              FIR {c.firNumber} · {c.stationCode} · {humanise(c.stage)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ------------------------------------------------------------------- cases ----

function CasesTab({ cases, isPending, error }) {
  const [fir, setFir] = useState('');
  const create = useCreateCaseFromFir();
  const jurisdiction = useComputeJurisdiction();
  const [routed, setRouted] = useState(null);

  const onCreate = (e) => {
    e.preventDefault();
    create.mutate(fir.trim(), {
      onSuccess: (d) => {
        toast.success(`Case created from FIR ${d.case.firNumber}`);
        setFir('');
      },
      onError: (err) => toast.error(err.message ?? 'Could not create the case'),
    });
  };

  return (
    <div className="space-y-6">
      <Section
        title="Create a case from an FIR"
        description="A case is created only from an FIR the police directory already holds, so its jurisdictional facts are directory facts rather than anyone's assertions. There is no free-text case creation in this system."
      >
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1 space-y-2">
            <Label htmlFor="fir">FIR number</Label>
            <Input id="fir" value={fir} onChange={(e) => setFir(e.target.value)} placeholder="0124/2026" required />
          </div>
          <Button type="submit" disabled={create.isPending || !fir.trim()}>
            {create.isPending && <Loader2 className="size-4 animate-spin" />}
            Create case from FIR
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          The case inherits its station, sections, sensitivity and investigating officer from the
          FIR record. Nothing on this form can change them.
        </p>
        {create.isError && <Denial error={create.error} heading="Case not created" />}
      </Section>

      <Section
        title="Your cases"
        description="Scope-filtered by the access resolver — you see the cases you are on record for, and no others."
      >
        {isPending ? (
          <TableSkeleton cols={6} />
        ) : error ? (
          <Denial error={error} heading="Cases could not be listed" />
        ) : cases.length === 0 ? (
          <EmptyState title="No cases yet" icon={FileText}>
            Create one from an FIR above. A case cannot exist here without a directory record
            behind it.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>FIR</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Station</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Sensitivity</TableHead>
                  <TableHead>Max punishment</TableHead>
                  <TableHead>CNR</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map((c) => (
                  <TableRow key={c._id}>
                    <TableCell className="font-medium">{c.firNumber}</TableCell>
                    <TableCell className="max-w-64 truncate">{c.title}</TableCell>
                    <TableCell className="font-mono text-xs">{c.stationCode}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{humanise(c.stage)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{humanise(c.sensitivityClass)}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">{c.maxPunishmentYears} yrs</TableCell>
                    <TableCell className="font-mono text-xs">{c.cnrNumber ?? '—'}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={jurisdiction.isPending}
                        onClick={() =>
                          jurisdiction.mutate(c._id, {
                            onSuccess: (d) => setRouted({ caseId: c._id, ...d }),
                            onError: (err) => toast.error(err.message ?? 'Could not compute'),
                          })
                        }
                      >
                        <Scale className="size-3.5" />
                        Compute jurisdiction
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {routed && (
          <div className="rounded-md border bg-muted/40 p-4">
            <p className="mb-2 text-sm font-semibold">Jurisdiction</p>
            <KeyValue
              rows={[
                ['Court type', humanise(routed.courtType ?? routed.jurisdiction?.courtType)],
                ['Reason', routed.reason ?? routed.jurisdiction?.reason ?? '—'],
                ['Court', routed.court?.name ?? routed.jurisdiction?.court?.name ?? '—'],
              ]}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Derived from the maximum punishment and the sensitivity class on the FIR — the
              statute decides, not the officer.
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- evidence ----

function ExhibitDetail({ id }) {
  const { data, isPending, isError, error } = useExhibit(id);
  const verify = useVerifyExhibit();
  const [report, setReport] = useState(null);

  if (!id) return null;
  if (isPending) return <TableSkeleton rows={3} cols={2} />;
  if (isError) return <Denial error={error} heading="Exhibit not available" />;

  const e = data?.evidence ?? data;
  if (!e) return null;

  return (
    <div className="space-y-4">
      <KeyValue
        rows={[
          ['Exhibit code', <span key="c" className="font-mono">{e.exhibitCode}</span>],
          ['Title', e.title],
          ['Type', `${e.kind ? humanise(e.kind) : ''} ${e.mimeType ?? ''}`.trim()],
          ['Size', fmtBytes(e.sizeBytes)],
          [
            'Source device',
            [e.sourceDevice?.sourceType, e.sourceDevice?.make, e.sourceDevice?.model]
              .filter(Boolean)
              .join(' · ') || '—',
          ],
          ['Serial / IMEI', e.sourceDevice?.serialNumber ?? e.sourceDevice?.imeiOrUid ?? '—'],
          ['Digest (server)', <Hash key="h" value={e.sha256Server} />],
          ['Uploaded', fmtDate(e.createdAt)],
        ]}
      />

      {e.triage?.priority && (
        <ReviewPriority priority={e.triage.priority} disclaimer={e.triage.disclaimer} />
      )}
      {e.forensic?.opinion && <ForensicOpinion forensic={e.forensic} />}

      <Separator />
      <Button
        variant="outline"
        disabled={verify.isPending}
        onClick={() =>
          verify.mutate(e._id, {
            onSuccess: setReport,
            onError: (err) => toast.error(err.message ?? 'Verification failed'),
          })
        }
      >
        {verify.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        Verify this exhibit
      </Button>

      {report && (
        <div className="space-y-3 rounded-md border p-4">
          <KeyValue
            rows={[
              ['Stored file', humanise(report.fileIntegrity)],
              ['Signature', report.signatureValid ? 'Verified' : 'Not verified'],
              ['Ledger chain', humanise(report.chainIntegrity)],
              ['Anchored root', humanise(report.anchorIntegrity)],
              ['Expected digest', <Hash key="a" value={report.expectedSha256} />],
              ['Recomputed digest', <Hash key="b" value={report.recomputedSha256} />],
            ]}
          />
          {/* The narrower claim, stated rather than implied: light 3 walks the
              unanchored tail; everything earlier is covered by the anchored root. */}
          {report.chainCheckedFrom != null && (
            <p className="text-xs text-muted-foreground">
              Chain walked from sequence {report.chainCheckedFrom} to {report.chainCheckedTo}.
              Earlier entries are covered by the anchored Merkle root rather than by this walk.
            </p>
          )}
          <p className="text-sm">{report.interpretation}</p>
        </div>
      )}
    </div>
  );
}

function EvidenceTab({ caseDoc, caseId }) {
  const { data, isPending, isError, error } = useEvidence({ caseId }, { enabled: Boolean(caseId) });
  const [selected, setSelected] = useState(null);

  const exhibits = data?.evidence ?? [];
  const writable = caseDoc ? WRITABLE_STAGES.includes(caseDoc.stage) : false;

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <UploadPipeline
        caseId={caseId}
        disabled={!caseId || !writable}
        disabledReason={
          !caseId
            ? 'Select a working case first.'
            : `This case is at ${humanise(caseDoc?.stage)}, which is closed to investigative writes. The record is fixed at the chargesheet — for every police role, not only the assigned officer.`
        }
      />

      <Section
        title="Exhibits on this case"
        description="Select one to see its Part A device record and to run the four independent integrity checks."
      >
        {!caseId ? (
          <Note>Select a working case to list its exhibits.</Note>
        ) : isPending ? (
          <TableSkeleton cols={3} />
        ) : isError ? (
          <Denial error={error} heading="Exhibits could not be listed" />
        ) : exhibits.length === 0 ? (
          <EmptyState title="No exhibits yet" icon={PackageSearch}>
            Upload one on the left. It will be hashed and signed here before it is sent.
          </EmptyState>
        ) : (
          <div className="space-y-1">
            {exhibits.map((e) => (
              <button
                key={e._id}
                type="button"
                onClick={() => setSelected(e._id)}
                className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-muted ${
                  selected === e._id ? 'border-primary/50 bg-muted' : 'border-border'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{e.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">{e.exhibitCode}</span>
                </span>
                {e.triage?.priority && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {e.triage.priority}
                  </Badge>
                )}
              </button>
            ))}
          </div>
        )}

        {selected && (
          <>
            <Separator />
            <ExhibitDetail id={selected} />
          </>
        )}
      </Section>
    </div>
  );
}

// -------------------------------------------------------------- disclosure ----

function DisclosureTab({ caseId, caseDoc }) {
  const { data } = useEvidence({ caseId }, { enabled: Boolean(caseId) });
  const prepare = usePreparePack();
  const fileChargesheet = useFileChargesheet();
  const [excluded, setExcluded] = useState({});
  const [reason, setReason] = useState('');
  const [pack, setPack] = useState(null);

  const exhibits = data?.evidence ?? [];
  const chosen = Object.keys(excluded).filter((k) => excluded[k]);

  const onPrepare = () => {
    prepare.mutate(
      {
        caseId,
        payload: {
          excludedItems: chosen.map((itemId) => ({
            itemId,
            reason: reason.trim() || 'Withheld pending a redaction order.',
          })),
        },
      },
      {
        onSuccess: (d) => {
          setPack(d.pack);
          toast.success('Disclosure pack prepared');
        },
        onError: (err) => toast.error(err.message ?? 'Could not prepare the pack'),
      }
    );
  };

  if (!caseId) return <Note>Select a working case to prepare disclosure.</Note>;

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Section
        title="Propose the disclosure set"
        description="The set is COMPUTED, not submitted: every active exhibit on the case, minus the items you ask to withhold. An officer cannot quietly drop an exhibit by omitting it — omission is not a thing this form can express, only a reasoned exclusion the court then rules on."
      >
        {exhibits.length === 0 ? (
          <EmptyState title="No exhibits to disclose" icon={PackageSearch} />
        ) : (
          <div className="space-y-2">
            {exhibits.map((e) => (
              <label
                key={e._id}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted"
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[hsl(var(--primary))]"
                  checked={Boolean(excluded[e._id])}
                  onChange={(ev) =>
                    setExcluded((x) => ({ ...x, [e._id]: ev.target.checked }))
                  }
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{e.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">{e.exhibitCode}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="reason">Reason for withholding</Label>
          <Textarea
            id="reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Identifies a protected witness; withheld pending a redaction order."
          />
          <p className="text-xs text-muted-foreground">
            Every exclusion carries a reason, and the court rules on each one before the pack can
            be served.
          </p>
        </div>

        <Button onClick={onPrepare} disabled={prepare.isPending}>
          {prepare.isPending && <Loader2 className="size-4 animate-spin" />}
          Prepare the pack ({exhibits.length - chosen.length} of {exhibits.length} disclosed)
        </Button>

        {prepare.isError && <Denial error={prepare.error} heading="Pack not prepared" />}
        {pack && (
          <div className="rounded-md border border-ok/40 bg-ok-muted p-3 text-sm">
            <p className="font-medium text-ok">Pack prepared</p>
            <p className="mt-1 font-mono text-xs">{pack.packId}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The registrar finds this from the case itself — you do not need to send the id
              anywhere.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="File the chargesheet"
        description="Filing binds the case to a court and closes it to investigative writes. Do it after the pack is prepared: the court cannot see a pack on a case that is not yet listed before it."
      >
        <KeyValue
          rows={[
            ['Stage', humanise(caseDoc?.stage)],
            ['CNR', caseDoc?.cnrNumber ?? 'Not yet listed'],
            ['Disclosure due', fmtDate(caseDoc?.clocks?.disclosureDueOn)],
            ['Disclosure served', fmtDate(caseDoc?.clocks?.disclosureServedOn)],
          ]}
        />
        <Button
          variant="outline"
          disabled={fileChargesheet.isPending || !WRITABLE_STAGES.includes(caseDoc?.stage ?? '')}
          onClick={() =>
            fileChargesheet.mutate(caseId, {
              onSuccess: (d) =>
                toast.success(`Chargesheet filed · CNR ${d.case?.cnrNumber ?? ''}`),
              onError: (err) => toast.error(err.message ?? 'Could not file'),
            })
          }
        >
          {fileChargesheet.isPending && <Loader2 className="size-4 animate-spin" />}
          <Gavel className="size-4" />
          File the chargesheet
        </Button>
        {fileChargesheet.isError && (
          <Denial error={fileChargesheet.error} heading="Chargesheet not filed" />
        )}
      </Section>
    </div>
  );
}

// ----------------------------------------------------------------- custody ----

function CustodyTab({ caseId }) {
  const { data, isPending, isError, error } = useCustodyItems(
    { caseId },
    { enabled: Boolean(caseId) }
  );
  const create = useCreateCustodyItem();
  const [form, setForm] = useState({
    description: '', sealNumber: '', imei: '', serialNumber: '',
    location: 'FIELD', locationDetail: '',
  });
  const [qr, setQr] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onCreate = (e) => {
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
        ...(form.locationDetail.trim() ? { locationDetail: form.locationDetail.trim() } : {}),
      },
      {
        onSuccess: (d) => {
          setQr(d.qr?.payload ?? null);
          toast.success(`Item ${d.item?.itemCode} booked`);
        },
        onError: (err) => toast.error(err.message ?? 'Could not book the item'),
      }
    );
  };

  if (!caseId) return <Note>Select a working case to see its custody register.</Note>;

  const items = data?.items ?? [];

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Section
        title="Book a physical item into custody"
        description="A custody item is the physical article an exhibit came from. Booking one prints a QR label; every later movement is a two-scan handshake between the officer handing over and the officer receiving."
      >
        <form onSubmit={onCreate} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cdesc">Description</Label>
            <Input id="cdesc" value={form.description} onChange={set('description')} required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="seal">Seal number</Label>
              <Input id="seal" value={form.sealNumber} onChange={set('sealNumber')} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loc">Location</Label>
              <Select value={form.location} onValueChange={(v) => setForm((f) => ({ ...f, location: v }))}>
                <SelectTrigger id="loc"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CUSTODY_LOCATIONS.map((l) => (
                    <SelectItem key={l} value={l}>{humanise(l)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="imei">IMEI</Label>
              <Input id="imei" value={form.imei} onChange={set('imei')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cserial">Serial number</Label>
              <Input id="cserial" value={form.serialNumber} onChange={set('serialNumber')} />
            </div>
          </div>
          <Button type="submit" disabled={create.isPending || !form.description.trim()}>
            {create.isPending && <Loader2 className="size-4 animate-spin" />}
            <Boxes className="size-4" />
            Book into custody
          </Button>
        </form>
        {create.isError && <Denial error={create.error} heading="Item not booked" />}
        {qr && (
          <div className="rounded-md border p-3">
            <p className="text-sm font-medium">QR label payload</p>
            <Hash value={qr} />
            <p className="mt-1 text-xs text-muted-foreground">
              The label identifies the item. It grants no authority to move it — that comes from
              the resolver, on every scan.
            </p>
          </div>
        )}
      </Section>

      <Section title="Custody register" description="The items on this case, and where each one is.">
        {isPending ? (
          <TableSkeleton cols={4} />
        ) : isError ? (
          <Denial error={error} heading="Custody register unavailable" />
        ) : items.length === 0 ? (
          <EmptyState title="No custody items on this case" icon={Boxes} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Seal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.itemCode}</TableCell>
                    <TableCell className="max-w-56 truncate">{i.description}</TableCell>
                    <TableCell><Badge variant="secondary">{humanise(i.status)}</Badge></TableCell>
                    <TableCell>{humanise(i.currentLocation)}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={i.sealIntact ? 'border-ok/40 bg-ok-muted text-ok' : 'border-bad/40 bg-bad-muted text-bad'}
                      >
                        {i.sealIntact ? 'Intact' : 'Broken'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </div>
  );
}

// -------------------------------------------------------------------- page ----

export default function OfficerPage() {
  const dispatch = useDispatch();
  const workingCaseId = useSelector(selectWorkingCaseId);
  const casesQuery = useCases({ limit: 100 });
  const cases = useMemo(() => casesQuery.data?.cases ?? [], [casesQuery.data]);
  const scope = useReveal('.will-reveal', { deps: [casesQuery.isPending] });

  const [q, setQ] = useState('');
  const search = useSearch(q);

  // Default to the first case the officer can see, so the workspace is never empty
  // on arrival — but never override a choice they have already made.
  useEffect(() => {
    if (!workingCaseId && cases.length) dispatch(workingCaseSet(cases[0]._id));
  }, [cases, workingCaseId, dispatch]);

  const caseQuery = useCase(workingCaseId);
  const caseDoc = caseQuery.data?.case ?? cases.find((c) => c._id === workingCaseId) ?? null;

  return (
    <div ref={scope} className="container space-y-6 py-8">
      <PageHeader
        title="Investigating officer"
        lede="Case file, evidence ingest and custody. Every action you take here is written to an append-only ledger, and every refusal is written there too."
      />

      {cases.length > 0 && (
        <div className="will-reveal">
          <CasePicker
            cases={cases}
            value={workingCaseId}
            onChange={(v) => dispatch(workingCaseSet(v))}
          />
        </div>
      )}

      <Tabs defaultValue="cases" className="will-reveal">
        <TabsList>
          <TabsTrigger value="cases">Cases</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="disclosure">Disclosure</TabsTrigger>
          <TabsTrigger value="custody">Custody</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
        </TabsList>

        <TabsContent value="cases" className="mt-6">
          <CasesTab cases={cases} isPending={casesQuery.isPending} error={casesQuery.error} />
        </TabsContent>

        <TabsContent value="evidence" className="mt-6">
          {/* Keyed on the case so switching cases remounts with a clean selection,
              rather than clearing it from an effect after a render has already gone
              out with the previous case's exhibit selected. */}
          <EvidenceTab key={workingCaseId} caseDoc={caseDoc} caseId={workingCaseId} />
        </TabsContent>

        <TabsContent value="disclosure" className="mt-6">
          <DisclosureTab caseId={workingCaseId} caseDoc={caseDoc} />
        </TabsContent>

        <TabsContent value="custody" className="mt-6">
          <CustodyTab caseId={workingCaseId} />
        </TabsContent>

        <TabsContent value="search" className="mt-6">
          <Section
            title="Search"
            description="Always intersected with what you are entitled to see, before the query runs — never filtered afterwards. A failure here is reported as a failure, never as an empty result."
          >
            <div className="flex gap-2">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search cases and exhibits (at least 2 characters)"
              />
              <Button variant="outline" disabled>
                <Search className="size-4" />
              </Button>
            </div>

            {search.isError && <Denial error={search.error} heading="Search unavailable" />}
            {search.isPending && q.trim().length >= 2 && <TableSkeleton rows={2} cols={2} />}
            {search.data && (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">{search.data.total} result(s)</p>
                {(search.data.cases ?? []).map((c) => (
                  <div key={c._id} className="rounded-md border p-3 text-sm">
                    <span className="font-medium">FIR {c.firNumber}</span> — {c.title}
                  </div>
                ))}
                {(search.data.evidence ?? []).map((e) => (
                  <div key={e._id} className="rounded-md border p-3 text-sm">
                    <span className="font-mono text-xs">{e.exhibitCode}</span> — {e.title}
                  </div>
                ))}
                {search.data.total === 0 && (
                  <EmptyState title="Nothing matched" icon={Search}>
                    This is a genuine empty result, not a failure — a failure would say so.
                  </EmptyState>
                )}
              </div>
            )}
          </Section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
