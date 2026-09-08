/**
 * Forensic science laboratory.
 *
 * An examiner's entire world is the referrals to THEIR laboratory. `GET /api/fsl/referrals`
 * answers with what the session's lab scope allows and nothing else, and a session
 * carrying no lab scope gets an empty list rather than everything. The copy says so out
 * loud, because an empty queue that looks like an empty database invites exactly the
 * wrong conclusion in front of a court.
 *
 * Filing a report is the only place in this system where an authenticity opinion can be
 * created. The report document is hashed and signed in this browser, the same way
 * evidence is, so the laboratory's document carries the examiner's own signature over
 * its digest rather than the server's word for it.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { FlaskConical, Inbox, Microscope, PenLine } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { Section, KeyValue, Hash, PageHeader, TableSkeleton, EmptyState } from '@/components/common/Primitives';
import { ForensicOpinion, Denial, Note } from '@/components/common/Verdicts';
import { useReferrals, useAcceptReferral, useFileReport, useExhibit } from '@/hooks/queries';
import { getOrCreateKeyPair, hashFile, signHashHex } from '@/lib/crypto';
import { useReveal } from '@/hooks/useGsap';
import { humanise, fmtDate, fmtBytes } from '@/lib/utils';

/** The whole authenticity vocabulary of this system. There is no fourth value. */
const OPINIONS = ['AUTHENTIC', 'MANIPULATED', 'INCONCLUSIVE'];

const STATUS_STYLES = {
  OPEN: 'border-warn/40 bg-warn-muted text-warn',
  ACCEPTED: 'border-border bg-muted text-muted-foreground',
  REPORTED: 'border-ok/40 bg-ok-muted text-ok',
  WITHDRAWN: 'border-border bg-muted text-muted-foreground',
};

const STATUS_FILTERS = ['ALL', 'OPEN', 'ACCEPTED', 'REPORTED'];

const StatusBadge = ({ status }) => (
  <Badge variant="outline" className={STATUS_STYLES[status] ?? STATUS_STYLES.WITHDRAWN}>
    {humanise(status)}
  </Badge>
);

// ------------------------------------------------------------------ exhibit ----

/**
 * The exhibit as the examiner needs to see it: what the device was, and the digest
 * recorded when it was received. If those particulars are wrong, the examination is
 * about the wrong object, and that is worth catching before an opinion is signed.
 */
function ExhibitDetail({ evidenceId }) {
  const q = useExhibit(evidenceId);

  if (q.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-3/4" />
      </div>
    );
  }
  if (q.isError) return <Denial error={q.error} heading="Exhibit refused" />;

  const e = q.data?.evidence;
  if (!e) {
    return (
      <EmptyState title="No exhibit record">
        The referral names an exhibit the register did not return.
      </EmptyState>
    );
  }

  const device = e.sourceDevice ?? {};

  return (
    <KeyValue
      rows={[
        ['Exhibit', <span key="kv" className="font-mono">{e.exhibitCode ?? '—'}</span>],
        ['Title', e.title ?? '—'],
        ['Kind', humanise(e.kind)],
        ['Source device', humanise(device.sourceType)],
        ['Make and model', [device.make, device.model].filter(Boolean).join(' ') || '—'],
        ['Colour', device.colour ?? '—'],
        ['Serial number', device.serialNumber ?? '—'],
        ['IMEI / UID', device.imeiOrUid ?? '—'],
        ['MAC address', device.macAddress ?? '—'],
        ['File type', e.mimeType ?? '—'],
        ['Size', fmtBytes(e.sizeBytes)],
        ['Captured at', fmtDate(e.capturedAt)],
        ['Digest recorded at ingest', <Hash key="kv" value={e.sha256Server ?? e.sha256} />],
      ]}
    />
  );
}

// ------------------------------------------------------------- report form ----

function ReportForm({ referral }) {
  const fileReport = useFileReport();

  const [opinion, setOpinion] = useState('');
  const [summary, setSummary] = useState('');
  const [method, setMethod] = useState('');
  const [file, setFile] = useState(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState(null);
  const [filed, setFiled] = useState(null);

  const busy = signing || fileReport.isPending;

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!file || !opinion || !summary.trim()) return;

    setSignError(null);
    setFiled(null);
    setSigning(true);

    let sha256;
    let signature;
    try {
      sha256 = await hashFile(file);
      const keyPair = await getOrCreateKeyPair();
      signature = await signHashHex(sha256, keyPair.privateKey);
    } catch (err) {
      setSignError({ code: 'REPORT_NOT_SIGNED', message: err.message });
      toast.error('The report could not be hashed and signed on this device.');
      return;
    } finally {
      setSigning(false);
    }

    const form = new FormData();
    form.set('report', file);
    form.set('opinion', opinion);
    /**
     * The register keeps ONE narrative field for the examination, so the method is
     * folded into it under its own heading rather than sent as a separate key. An
     * extra multipart field would be dropped by the server's schema without a word,
     * and an examiner would believe they had recorded something the record does not
     * hold.
     */
    form.set(
      'examinationSummary',
      method.trim() ? `Method: ${method.trim()}\n\n${summary.trim()}` : summary.trim()
    );
    form.set('reportSha256', sha256);
    form.set('reportSignature', signature);

    fileReport.mutate(
      { id: referral.id, form },
      {
        onSuccess: (result) => {
          setFiled({ ...result, browserSha256: sha256, sizeBytes: file.size });
          toast.success('Report filed and signed.', {
            description: 'It is now the source for Part B of the section 63 certificate.',
          });
        },
        onError: (err) => toast.error(err.message ?? 'The report was not filed.'),
      }
    );
  };

  return (
    <Section
      title="File the forensic report"
      description="Your opinion is expert evidence under BSA s.39, and this form is the only route by which an authenticity finding enters Lexx. It is recorded, displayed and reasoned about separately from machine review prioritisation, which is investigative triage and never an authenticity claim."
    >
      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="report-file">Report document</Label>
          <Input
            id="report-file"
            type="file"
            required
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Hashed and signed here, on your machine, before a byte is sent. The signature is
            made with the private key held in this browser, so the document that reaches the
            register carries your own attestation of its digest.
            {file ? ` Selected: ${file.name} · ${fmtBytes(file.size)}.` : ''}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="report-opinion">Opinion</Label>
          <Select value={opinion} onValueChange={setOpinion} disabled={busy}>
            <SelectTrigger id="report-opinion">
              <SelectValue placeholder="Choose an opinion" />
            </SelectTrigger>
            <SelectContent>
              {OPINIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {humanise(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Three values, and no others: AUTHENTIC, MANIPULATED, INCONCLUSIVE. This is the
            only authenticity vocabulary in the system, and only a laboratory notified under
            IT Act s.79A can produce it.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="report-method">Method</Label>
          <Input
            id="report-method"
            value={method}
            disabled={busy}
            placeholder="e.g. ELA and quantisation-table comparison, container metadata review"
            onChange={(e) => setMethod(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Recorded at the head of the examination summary, so the technique is on the face
            of the record a court reads.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="report-summary">Examination summary</Label>
          <Textarea
            id="report-summary"
            required
            rows={6}
            disabled={busy}
            value={summary}
            placeholder="What was examined, by what method, and what the examination showed."
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>

        <Button type="submit" disabled={busy || !file || !opinion || !summary.trim()}>
          <PenLine className="size-4" />
          {signing ? 'Hashing and signing…' : fileReport.isPending ? 'Filing…' : 'Sign and file the report'}
        </Button>
      </form>

      {signError && <Denial error={signError} heading="Report not signed" />}
      {fileReport.isError && <Denial error={fileReport.error} heading="Report not filed" />}

      {filed && (
        <div className="space-y-4">
          <Separator />
          <ForensicOpinion
            forensic={{
              opinion: filed.forensic?.opinion,
              labName: filed.forensic?.labName,
              section79ARef: filed.forensic?.section79ARef,
              reportedAt: filed.forensic?.reportedAt,
            }}
          />
          <KeyValue
            rows={[
              ['Report digest (this browser)', <Hash key="kv" value={filed.browserSha256} />],
              ['Report digest (server)', <Hash key="kv" value={filed.forensic?.reportSha256} />],
              ['Report size', fmtBytes(filed.sizeBytes)],
              ['Ledger sequence', <span key="kv" className="font-mono">{filed.ledgerSeq ?? '—'}</span>],
              ['Ledger entry hash', <Hash key="kv" value={filed.entryHash} />],
            ]}
          />
          {/* Both digests are shown because equality between them is the check: the
              server recomputed the hash from the bytes it received, and if it disagreed
              with the browser the upload would have been refused rather than stored. */}
          {filed.basisNote && <Note>{filed.basisNote}</Note>}
        </div>
      )}
    </Section>
  );
}

// -------------------------------------------------------------------- page ----

export default function LabPage() {
  const [status, setStatus] = useState('ALL');
  const [selectedId, setSelectedId] = useState(null);

  const referrals = useReferrals(status === 'ALL' ? undefined : { status });
  const accept = useAcceptReferral();

  const rows = referrals.data?.referrals ?? [];

  /**
   * Accepting a referral while the queue is filtered to OPEN moves it out of the list
   * the detail panel reads from, which would collapse the panel at exactly the moment
   * the examiner needs the report form. The mutation's own response is the referral in
   * its new state, so fall back to that rather than to nothing.
   */
  const inList = rows.find((r) => r.id === selectedId) ?? null;
  const justAccepted = accept.data?.referral;
  const selected =
    inList ?? (justAccepted && justAccepted.id === selectedId ? justAccepted : null);

  /**
   * A panel that mounts after the entrance timeline has run would stay at its
   * pre-animation opacity, so the timeline is re-run whenever the set of panels
   * changes: when a referral is first opened, and when its status admits the report
   * form. Switching between two referrals in the same state adds no panels and
   * therefore does not re-animate the queue.
   */
  const scope = useReveal('.will-reveal', {
    deps: [Boolean(selected), selected?.status ?? null],
  });

  const onAccept = () => {
    accept.mutate(selected.id, {
      onSuccess: () =>
        toast.success('Referral accepted.', {
          description: 'The exhibit is under examination by your laboratory.',
        }),
      onError: (err) => toast.error(err.message ?? 'The referral was not accepted.'),
    });
  };

  return (
    <div ref={scope} className="container space-y-6 py-8">
      <PageHeader
        title="Referrals to your laboratory"
        lede="Visibility here is derived per exhibit from a live referral row, not from a role. The server scopes this queue to the laboratory your session is acting for; an examiner at another laboratory is refused with NO_OPEN_REFERRAL_TO_YOUR_LAB — a statement about the absence of a referral, which is the fact that actually matters."
      />

      {referrals.isSuccess &&
        (referrals.data?.labId ? (
          <Note>
            You are acting for laboratory{' '}
            <span className="font-mono">{referrals.data.labId}</span>. This queue contains only
            exhibits referred to it. Nothing else in the register is visible to this session,
            and no filter on this page can widen that.
          </Note>
        ) : (
          <Note tone="warn">
            This session carries no laboratory scope, so it has no referrals. That is the
            access policy answering, not an empty database.
          </Note>
        ))}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Queue"
          description="Every referral naming your laboratory, in the state the register holds it."
          actions={
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[10.5rem]" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value === 'ALL' ? 'All referrals' : humanise(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          {referrals.isPending && <TableSkeleton rows={4} cols={4} />}
          {referrals.isError && <Denial error={referrals.error} heading="Queue unavailable" />}

          {referrals.isSuccess &&
            (rows.length === 0 ? (
              <EmptyState title="No referrals to your laboratory" icon={Inbox}>
                Nothing has been referred here in this state. An investigating officer refers
                an exhibit to a named laboratory; until that happens there is nothing for you
                to examine.
              </EmptyState>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Exhibit</TableHead>
                    <TableHead>Discipline</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Referred</TableHead>
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} data-state={r.id === selectedId ? 'selected' : undefined}>
                      <TableCell className="font-mono">{r.exhibitCode ?? '—'}</TableCell>
                      <TableCell>{humanise(r.discipline)}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {fmtDate(r.referredAt)}
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" onClick={() => setSelectedId(r.id)}>
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ))}
        </Section>

        <div className="space-y-6">
          {!selected ? (
            <Section
              title="Referral"
              description="Open a referral to see the questions posed to your laboratory and the exhibit's particulars."
            >
              <EmptyState title="Nothing selected" icon={Microscope}>
                Choose a referral from the queue.
              </EmptyState>
            </Section>
          ) : (
            <>
              <Section
                title={`Referral — ${selected.exhibitCode ?? ''}`}
                description="The questions the investigating officer put to this laboratory, and the notification under which the laboratory answers them."
              >
                <KeyValue
                  rows={[
                    ['Referral id', <span key="kv" className="font-mono">{selected.id}</span>],
                    ['Laboratory', selected.labName ?? selected.labId ?? '—'],
                    [
                      'IT Act s.79A notification',
                      <span key="kv" className="font-mono">{selected.section79ARef ?? 'not recorded'}</span>,
                    ],
                    ['Discipline', humanise(selected.discipline)],
                    ['Questions posed', selected.questionsPosed || '—'],
                    ['Status', <StatusBadge key="kv" status={selected.status} />],
                    ['Referred at', fmtDate(selected.referredAt)],
                    ['Accepted at', fmtDate(selected.acceptedAt)],
                  ]}
                />

                <Button
                  onClick={onAccept}
                  disabled={selected.status !== 'OPEN' || accept.isPending}
                >
                  <FlaskConical className="size-4" />
                  {selected.status !== 'OPEN'
                    ? `Referral is ${humanise(selected.status).toLowerCase()}`
                    : accept.isPending
                      ? 'Accepting…'
                      : 'Accept this referral'}
                </Button>

                {accept.isError && (
                  <Denial error={accept.error} heading="Referral not accepted" />
                )}
              </Section>

              <Section
                title="The exhibit"
                description="Check the particulars before you examine: an opinion about the wrong object is worse than no opinion."
              >
                <ExhibitDetail evidenceId={selected.evidenceId} />
              </Section>

              {selected.status === 'ACCEPTED' || selected.status === 'REPORTED' ? (
                // Keyed on the referral so a half-typed report never carries across to
                // a different exhibit.
                <ReportForm key={selected.id} referral={selected} />
              ) : (
                <Note>
                  Accept the referral before filing a report. Accepting is the laboratory
                  taking the exhibit on, and an opinion from a laboratory that never accepted
                  the work has no chain to stand on.
                </Note>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
