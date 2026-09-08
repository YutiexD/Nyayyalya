/**
 * Station supervision — SHO, malkhana custodian, district SP.
 *
 * Three questions a supervisor has to answer every day, in the order they are asked:
 *
 *   Queue    — what should the station look at first? Machine triage orders the work.
 *              It is a workload decision about a queue, never a finding about an
 *              exhibit, so the API's own disclaimer travels with every row and the
 *              only authenticity claim on this screen is the laboratory's.
 *   Custody  — does each item's recorded history make a lawful chain? A label scan
 *              answers "is this tag real"; it deliberately answers nothing about who
 *              may move the item.
 *   Denials  — who was refused, and why. A log that shows only successes cannot show
 *              you the advocate who reached for an exhibit outside their set.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { FlaskConical, ScanLine, ShieldAlert, Boxes, ListChecks } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import {
  Section,
  KeyValue,
  Hash,
  PageHeader,
  TableSkeleton,
  EmptyState,
} from '@/components/common/Primitives';
import { ReviewPriority, ForensicOpinion, Denial, Note } from '@/components/common/Verdicts';
import {
  useTriageQueue,
  useExhibit,
  useReferToFsl,
  useCustodyItems,
  useScanCustodyLabel,
  useCustodyChain,
  useCustodyGaps,
  useAudit,
} from '@/hooks/queries';
import { explain } from '@/lib/api';
import { useReveal } from '@/hooks/useGsap';
import { humanise, fmtDate, fmtBytes } from '@/lib/utils';

/** The disciplines a s.79A laboratory can be asked for. Mirrors FSL_DISCIPLINE. */
const DISCIPLINES = ['MOBILE_FORENSICS', 'MEDIA_FORENSICS', 'COMPUTER_FORENSICS'];

/**
 * The wording that must appear beside every triage priority.
 *
 * A fallback, not a substitute: the API sends its own text and that is what renders.
 * This exists so a response that somehow arrives without it still cannot put a
 * machine priority on screen unqualified.
 */
const TRIAGE_FALLBACK =
  'Automated triage only. Not expert opinion under BSA s.39 / IT Act s.79A.';

/** A verdict pill. Colour comes from the semantic tokens so dark mode follows. */
function Verdict({ tone = 'neutral', children }) {
  const styles = {
    ok: 'border-ok/40 bg-ok-muted text-ok',
    warn: 'border-warn/40 bg-warn-muted text-warn',
    bad: 'border-bad/40 bg-bad-muted text-bad',
    neutral: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <Badge variant="outline" className={styles[tone] ?? styles.neutral}>
      {children}
    </Badge>
  );
}

/** One custody or ledger finding, code first because that is what an auditor cites. */
function Finding({ finding }) {
  return (
    <li className="space-y-0.5">
      <code className="font-mono text-xs text-bad">{finding.code ?? 'FINDING'}</code>
      {finding.detail && (
        <p className="text-xs leading-relaxed text-muted-foreground">{finding.detail}</p>
      )}
      {/* `ledgerSeq`, not `seq`: a finding names the ledger entry it was derived from,
          and the two numbering schemes on a custody item — ledger sequence and custody
          sequence — are not interchangeable. */}
      {finding.ledgerSeq !== undefined && finding.ledgerSeq !== null && (
        <p className="text-xs text-muted-foreground">Ledger sequence {finding.ledgerSeq}</p>
      )}
    </li>
  );
}

// ============================================================== 1. QUEUE ====

function ReferralForm({ evidence }) {
  const refer = useReferToFsl();
  const [labCode, setLabCode] = useState('UP-FSL-LKO');
  const [discipline, setDiscipline] = useState(DISCIPLINES[0]);
  const [questionsPosed, setQuestionsPosed] = useState('');

  const onSubmit = (e) => {
    e.preventDefault();
    refer.mutate(
      {
        evidenceId: evidence._id,
        // The server resolves the lab code against the FSL directory and reads the
        // s.79A notification reference from there. Nothing typed here becomes a fact.
        payload: { labCode: labCode.trim(), discipline, questionsPosed: questionsPosed.trim() },
      },
      {
        onSuccess: (result) =>
          toast.success('Referral created', {
            description: `${result.referral?.labName ?? result.referral?.labId} · ledger sequence ${result.ledgerSeq}`,
          }),
        onError: (error) =>
          toast.error('Referral refused', { description: explain(error.code, error.message) }),
      }
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="lab-code">Laboratory code</Label>
        <Input
          id="lab-code"
          value={labCode}
          onChange={(e) => setLabCode(e.target.value)}
          placeholder="UP-FSL-LKO"
          required
        />
        <p className="text-xs text-muted-foreground">
          Resolved against the FSL directory. The laboratory&rsquo;s name and its s.79A
          notification reference are read from that record, never from this form.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="discipline">Discipline</Label>
        <Select value={discipline} onValueChange={setDiscipline}>
          <SelectTrigger id="discipline">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DISCIPLINES.map((d) => (
              <SelectItem key={d} value={d}>
                {humanise(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="questions">Questions posed</Label>
        <Textarea
          id="questions"
          rows={3}
          value={questionsPosed}
          onChange={(e) => setQuestionsPosed(e.target.value)}
          placeholder="What is the laboratory being asked to determine?"
        />
      </div>

      <Button type="submit" disabled={refer.isPending || !labCode.trim()}>
        <FlaskConical className="size-4" />
        {refer.isPending ? 'Referring…' : 'Refer to laboratory'}
      </Button>

      {refer.isError && <Denial error={refer.error} heading="Referral refused" />}

      {refer.data && (
        <KeyValue
          rows={[
            ['Referral', <code key="r" className="font-mono text-xs">{refer.data.referral?.id}</code>],
            ['Laboratory', refer.data.referral?.labName ?? refer.data.referral?.labId ?? '—'],
            [
              's.79A notification',
              <code key="s" className="font-mono text-xs">
                {refer.data.referral?.section79ARef ?? 'not recorded'}
              </code>,
            ],
            ['Discipline', humanise(refer.data.referral?.discipline)],
            ['Ledger sequence', <span key="q" className="tabular-nums">{refer.data.ledgerSeq}</span>],
            ['Entry hash', <Hash key="h" value={refer.data.entryHash} />],
          ]}
        />
      )}
    </form>
  );
}

function ExhibitDetail({ exhibitId }) {
  const query = useExhibit(exhibitId);

  if (!exhibitId) {
    return (
      <EmptyState title="No exhibit selected" icon={ListChecks}>
        Open a row from the queue to read its BSA s.63 source record and refer it for
        examination.
      </EmptyState>
    );
  }
  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.isError) return <Denial error={query.error} heading="Exhibit not readable" />;

  const e = query.data?.evidence;
  if (!e) return <EmptyState title="No such exhibit in your scope" />;

  const device = e.sourceDevice ?? {};

  return (
    <div className="space-y-5">
      <KeyValue
        rows={[
          ['Exhibit', <code key="c" className="font-mono text-xs">{e.exhibitCode}</code>],
          ['Title', e.title ?? '—'],
          ['Kind', humanise(e.kind)],
          ['Source', humanise(device.sourceType)],
          [
            'Make and model',
            [device.make, device.model].filter(Boolean).join(' ') || '—',
          ],
          ['Colour', device.colour || '—'],
          ['Serial number', device.serialNumber || '—'],
          ['IMEI / UID', device.imeiOrUid || '—'],
          ['MAC address', device.macAddress || '—'],
          ['Captured at', fmtDate(e.capturedAt)],
          ['File', `${e.mimeType ?? '—'} · ${fmtBytes(e.sizeBytes)}`],
          ['Court status', <Verdict key="cs">{humanise(e.courtStatus)}</Verdict>],
        ]}
      />

      <Separator />

      <KeyValue
        rows={[
          ['Recorded digest', <Hash key="d" value={e.sha256Server} />],
          ['Signer fingerprint', <Hash key="f" value={e.signerPubKeyFingerprint} />],
          [
            'Hash matched at ingest',
            <Verdict key="h" tone={e.hashMatchedOnIngest ? 'ok' : 'bad'}>
              {e.hashMatchedOnIngest ? 'Yes' : 'No'}
            </Verdict>,
          ],
          [
            'Signature valid at ingest',
            <Verdict key="s" tone={e.signatureValidOnIngest ? 'ok' : 'bad'}>
              {e.signatureValidOnIngest ? 'Yes' : 'No'}
            </Verdict>,
          ],
        ]}
      />

      <Separator />

      {/* The two claims, side by side and deliberately unalike. The priority is a
          queue position; the opinion is the only statement about authenticity this
          system carries. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ReviewPriority
          priority={e.triage?.priority}
          disclaimer={e.triage?.disclaimer ?? TRIAGE_FALLBACK}
        />
        {e.forensic?.opinion ? (
          <ForensicOpinion forensic={e.forensic} />
        ) : (
          <Note>
            No laboratory opinion on this exhibit. Its forensic status is{' '}
            {humanise(e.forensic?.status ?? 'NOT_REFERRED')} — nothing on this screen states
            whether the file is authentic.
          </Note>
        )}
      </div>
    </div>
  );
}

function QueueTab() {
  const queue = useTriageQueue();
  const [selectedId, setSelectedId] = useState(null);

  const items = queue.data?.queue ?? [];

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Section
        title="Review queue"
        description="Ordered by machine review priority so scarce examiner time reaches the right exhibits first. The ordering is a decision about this queue, not a finding about any exhibit in it."
      >
        {/* The disclaimer the API sends, rendered verbatim and above the data rather
            than as a footnote under it. */}
        <Note tone="warn">{queue.data?.disclaimer ?? TRIAGE_FALLBACK}</Note>

        {queue.isPending && <TableSkeleton rows={5} cols={4} />}
        {queue.isError && <Denial error={queue.error} heading="Queue not readable" />}

        {!queue.isPending && !queue.isError && items.length === 0 && (
          <EmptyState title="Nothing is queued for review in your scope" icon={ListChecks}>
            The queue lists exhibits in your own station or district. An empty queue means
            no exhibit there has been triaged, not that none exists.
          </EmptyState>
        )}

        {!queue.isPending && !queue.isError && items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Exhibit</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>{queue.data?.uiLabel ?? 'Review Priority'}</TableHead>
                <TableHead>Forensic status</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const id = String(item._id);
                return (
                  <TableRow
                    key={id}
                    data-state={id === selectedId ? 'selected' : undefined}
                    className="cursor-pointer align-top"
                    onClick={() => setSelectedId(id)}
                  >
                    <TableCell>
                      <code className="font-mono text-xs">{item.exhibitCode}</code>
                    </TableCell>
                    <TableCell className="max-w-[16rem]">{item.title ?? '—'}</TableCell>
                    <TableCell className="max-w-[20rem]">
                      <ReviewPriority
                        priority={item.triage?.priority}
                        disclaimer={item.triage?.disclaimer ?? TRIAGE_FALLBACK}
                      />
                    </TableCell>
                    <TableCell>
                      <Verdict tone={item.forensic?.status === 'REPORT_FILED' ? 'ok' : 'neutral'}>
                        {humanise(item.forensic?.status ?? 'NOT_REFERRED')}
                      </Verdict>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {fmtDate(item.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedId(id)}>
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      <div className="space-y-6">
        <Section
          title="Exhibit record"
          description="The BSA s.63 Schedule Part A particulars recorded at ingest: what the file came from, when it was captured, and the digest and signature taken before a byte reached the server."
        >
          <ExhibitDetail exhibitId={selectedId} />
        </Section>

        <Section
          title="Refer to a forensic science laboratory"
          description="Machine triage decides what gets looked at first. Only a s.79A-notified laboratory decides whether a file is authentic, and only after this referral puts the exhibit in front of it."
        >
          {selectedId ? (
            <ReferralFormForExhibit exhibitId={selectedId} />
          ) : (
            <EmptyState title="Select an exhibit first" icon={FlaskConical}>
              A referral names one exhibit, one laboratory and the questions it is asked to
              answer.
            </EmptyState>
          )}
        </Section>
      </div>
    </div>
  );
}

/**
 * The referral form needs the exhibit's own id, so it reads the same cached record the
 * detail panel does rather than taking a second copy of it through props.
 */
function ReferralFormForExhibit({ exhibitId }) {
  const query = useExhibit(exhibitId);
  if (query.isPending) return <Skeleton className="h-48 w-full" />;
  if (query.isError) return <Denial error={query.error} heading="Exhibit not readable" />;
  if (!query.data?.evidence) return <EmptyState title="No such exhibit in your scope" />;
  // Remount on a different exhibit so the form does not carry the previous one's text.
  return <ReferralForm key={exhibitId} evidence={query.data.evidence} />;
}

// ============================================================ 2. CUSTODY ====

function CustodyRegister() {
  const query = useCustodyItems();
  const items = query.data?.items ?? [];

  if (query.isPending) return <TableSkeleton rows={4} cols={5} />;
  if (query.isError) return <Denial error={query.error} heading="Register not readable" />;
  if (!items.length) {
    return (
      <EmptyState title="No custody items in your scope" icon={Boxes}>
        A malkhana custodian sees items at their own station; a district supervisor sees
        the district. An empty register is a scope statement, not an error.
      </EmptyState>
    );
  }

  return (
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
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              <code className="font-mono text-xs">{item.itemCode}</code>
            </TableCell>
            <TableCell className="max-w-[18rem]">{item.description ?? '—'}</TableCell>
            <TableCell>
              <Verdict tone={item.frozen ? 'bad' : 'neutral'}>
                {item.frozen ? 'Frozen' : humanise(item.status)}
              </Verdict>
            </TableCell>
            <TableCell>{humanise(item.currentLocation)}</TableCell>
            <TableCell className="space-y-1">
              <code className="font-mono text-xs">{item.sealNumber ?? '—'}</code>
              <div>
                <Verdict tone={item.sealIntact === false ? 'bad' : 'ok'}>
                  {item.sealIntact === false ? 'Broken' : 'Intact'}
                </Verdict>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ScanBox({ onShowChain }) {
  const scan = useScanCustodyLabel();
  const [token, setToken] = useState('');

  const onSubmit = (e) => {
    e.preventDefault();
    // The HMAC on the label is checked by the server, which holds the secret. A
    // client-side "looks valid" would mean nothing, so nothing is decided here.
    scan.mutate(token.trim(), {
      onSuccess: (result) => toast.success(`Label authentic — ${result.item?.itemCode}`),
      onError: (error) =>
        toast.error('Label not resolved', { description: explain(error.code, error.message) }),
    });
  };

  // The scan response returns the item under `id`. Reading `_id` here silently
  // removes the chain button on every successful scan.
  const itemId = scan.data?.item?.id ?? null;

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="qr-token">Label payload</Label>
          <Input
            id="qr-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="LEXX:v1:IT-0123-2026-002:…"
            className="font-mono"
          />
        </div>
        <Button type="submit" disabled={scan.isPending || !token.trim()}>
          <ScanLine className="size-4" />
          {scan.isPending ? 'Resolving…' : 'Resolve label'}
        </Button>
      </form>

      {scan.isError && <Denial error={scan.error} heading="Label resolved, access refused" />}

      {scan.data && (
        <div className="space-y-4">
          <Note>{scan.data.notice}</Note>
          <KeyValue
            rows={[
              ['Item', <code key="i" className="font-mono text-xs">{scan.data.item?.itemCode}</code>],
              ['Status', <Verdict key="s">{humanise(scan.data.item?.status)}</Verdict>],
              ['Location', humanise(scan.data.item?.currentLocation)],
              [
                'Permitted next states',
                (scan.data.nextStates ?? []).map(humanise).join(', ') || 'none',
              ],
              [
                'Actions open to you',
                (scan.data.allowedActions ?? []).map(humanise).join(', ') || 'none',
              ],
            ]}
          />
          {itemId && (
            <Button variant="outline" size="sm" onClick={() => onShowChain(itemId)}>
              Show the chain
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function GapReport({ onShowChain }) {
  const query = useCustodyGaps();
  const items = query.data?.items ?? [];

  if (query.isPending) return <TableSkeleton rows={4} cols={3} />;
  if (query.isError) return <Denial error={query.error} heading="Gap report not readable" />;
  if (!items.length) {
    return (
      <EmptyState title="No custody items in your scope" icon={ShieldAlert}>
        There is nothing to walk. This is not a statement that every chain elsewhere is
        sound.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Verdict tone={query.data?.withFindings ? 'bad' : 'ok'}>
          {query.data?.withFindings ?? 0} of {query.data?.total ?? 0} items with findings
        </Verdict>
        {query.data?.broken?.length > 0 && (
          <span className="text-xs text-muted-foreground">
            Broken: {query.data.broken.join(', ')}
          </span>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead>Findings</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((report) => (
            <TableRow key={report.itemId} className="align-top">
              <TableCell>
                <code className="font-mono text-xs">{report.itemCode ?? '—'}</code>
              </TableCell>
              <TableCell>
                <Verdict tone={report.intact ? 'ok' : 'bad'}>
                  {report.intact ? 'Intact' : 'Broken'}
                </Verdict>
              </TableCell>
              <TableCell className="max-w-[28rem]">
                {report.findings?.length ? (
                  <ul className="space-y-2">
                    {report.findings.map((f, i) => (
                      <Finding key={`${f.code}-${i}`} finding={f} />
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-muted-foreground">none</span>
                )}
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="sm" onClick={() => onShowChain(report.itemId)}>
                  Chain
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CustodyChain({ itemId }) {
  const query = useCustodyChain(itemId);

  if (!itemId) {
    return (
      <EmptyState title="No item selected" icon={Boxes}>
        Resolve a label or open a row from the gap report to read that item&rsquo;s whole
        recorded history.
      </EmptyState>
    );
  }
  if (query.isPending) return <Skeleton className="h-56 w-full" />;
  if (query.isError) return <Denial error={query.error} heading="Chain not readable" />;

  const item = query.data?.item ?? {};
  const analysis = query.data?.analysis ?? {};
  const events = query.data?.events ?? [];

  return (
    <div className="space-y-4">
      <KeyValue
        rows={[
          ['Item', <code key="i" className="font-mono text-xs">{item.itemCode ?? '—'}</code>],
          ['Description', item.description ?? '—'],
          ['Seal', <code key="s" className="font-mono text-xs">{item.sealNumber ?? '—'}</code>],
          [
            'Seal intact',
            <Verdict key="si" tone={item.sealIntact === false ? 'bad' : 'ok'}>
              {item.sealIntact === false ? 'Broken' : 'Intact'}
            </Verdict>,
          ],
          ['Status', <Verdict key="st">{humanise(item.status)}</Verdict>],
          ['Location', humanise(item.currentLocation)],
          [
            'Chain',
            <Verdict key="c" tone={analysis.intact ? 'ok' : 'bad'}>
              {analysis.intact ? 'Intact' : 'Broken'}
            </Verdict>,
          ],
        ]}
      />

      {analysis.findings?.length > 0 && (
        <Note tone="warn">
          <ul className="space-y-2">
            {analysis.findings.map((f, i) => (
              <Finding key={`${f.code}-${i}`} finding={f} />
            ))}
          </ul>
        </Note>
      )}

      {events.length === 0 ? (
        <EmptyState title="No custody events recorded">
          An item with no history in the ledger is itself the finding above.
        </EmptyState>
      ) : (
        <ol className="space-y-4 border-l border-border pl-5">
          {events.map((event) => (
            <li key={event.seq} className="relative space-y-1">
              <span
                className={
                  event.eventType === 'INTEGRITY_EXCEPTION'
                    ? 'absolute -left-[1.4rem] top-1.5 size-2 rounded-full bg-bad'
                    : 'absolute -left-[1.4rem] top-1.5 size-2 rounded-full bg-border'
                }
              />
              <p className="text-sm font-medium">{humanise(event.eventType)}</p>
              <p className="text-xs text-muted-foreground">
                {fmtDate(event.occurredAt)} · {humanise(event.actorRole) || '—'} · ledger
                sequence {event.seq}
              </p>
              {(event.payload?.toStatus || event.payload?.status) && (
                <p className="text-xs text-muted-foreground">
                  State: {humanise(event.payload.toStatus ?? event.payload.status)}
                </p>
              )}
              <Hash value={event.entryHash} label="Entry hash" />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CustodyTab() {
  const [chainItemId, setChainItemId] = useState(null);

  return (
    <div className="space-y-6">
      <Section
        title="Custody register"
        description="Every item held in your scope, with the seal number a supervisor checks against the physical package and the state the ledger last recorded."
      >
        <CustodyRegister />
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section
          title="Chain gap detection"
          description="A lawful chain has no timestamp inversions, no missing sequence numbers and no state jumps that skip the malkhana. Anything else is a finding a supervisor has to answer for."
        >
          <GapReport onShowChain={setChainItemId} />
        </Section>

        <div className="space-y-6">
          <Section
            title="Resolve a label"
            description="The signature on a custody label proves this system printed it. Authenticity of a label is not authority over the item — every action on it is authorised separately, and a scan changes nothing."
          >
            <ScanBox onShowChain={setChainItemId} />
          </Section>

          <Section
            title="Custody chain"
            description="The item's whole recorded history, straight from the ledger. Nothing here can be edited or removed, so a chain with a gap keeps showing the gap."
          >
            <CustodyChain itemId={chainItemId} />
          </Section>
        </div>
      </div>
    </div>
  );
}

// ============================================================ 3. DENIALS ====

function DenialsTab() {
  const query = useAudit({ decision: 'DENY', limit: 25 });
  const events = query.data?.events ?? [];

  return (
    <Section
      title="Refusals"
      description="Every access decision this system makes is written down, and the refusals are the interesting rows: a log that records only successes cannot show you the advocate who reached for an exhibit outside the set served on them."
    >
      <Note>
        The feed is itself scoped. You see decisions taken inside your own jurisdiction, not
        the whole deployment, and the reason code beside each row is the same string an
        auditor would cite from the record.
      </Note>

      {query.isPending && <TableSkeleton rows={5} cols={5} />}
      {query.isError && <Denial error={query.error} heading="Audit feed not readable" />}

      {!query.isPending && !query.isError && events.length === 0 && (
        <EmptyState title="No refusals recorded in your scope" icon={ShieldAlert}>
          Nothing has been denied here. That is a statement about your jurisdiction over the
          last twenty-five decisions, not about the deployment.
        </EmptyState>
      )}

      {!query.isPending && !query.isError && events.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event, i) => (
              <TableRow key={`${event.at}-${i}`} className="align-top">
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(event.at)}
                </TableCell>
                <TableCell>
                  <p className="font-medium">{event.actorName ?? '—'}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {event.authorityId ?? ''}
                  </p>
                </TableCell>
                <TableCell>
                  <Verdict>{humanise(event.role)}</Verdict>
                </TableCell>
                <TableCell>{humanise(event.action)}</TableCell>
                <TableCell>
                  <code className="font-mono text-xs">
                    {event.resourceLabel || humanise(event.resourceType) || '—'}
                  </code>
                </TableCell>
                <TableCell className="max-w-[24rem] space-y-1">
                  <code className="font-mono text-xs text-bad">{event.reason ?? '—'}</code>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {explain(event.reason)}
                  </p>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

// =============================================================== the page ====

export default function StationPage() {
  const [tab, setTab] = useState('queue');
  // Each tab's panels mount when it is opened, so the reveal has to run again then —
  // `.will-reveal` starts at opacity 0 and nothing else clears it.
  const scope = useReveal('.will-reveal', { deps: [tab] });

  return (
    <div ref={scope} className="container space-y-6 py-8">
      <PageHeader
        title="Station supervision"
        lede="What to look at first, whether each item's custody makes a lawful chain, and who was refused. The first is a machine's opinion about workload, the second and third are the record itself."
      />

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="custody">Custody</TabsTrigger>
          <TabsTrigger value="denials">Denials</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-0">
          <QueueTab />
        </TabsContent>
        <TabsContent value="custody" className="mt-0">
          <CustodyTab />
        </TabsContent>
        <TabsContent value="denials" className="mt-0">
          <DenialsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
