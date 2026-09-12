/**
 * The forensic laboratory.
 *
 * ## The question this screen answers
 *
 * "What do I look at next?" — and nothing else. Everything on it is in service of
 * that: a queue ordered by the review priority the system computed at ingest, the
 * exhibit that is open, why it scored where it did, and one form to record a verdict.
 *
 * ## What used to be here
 *
 * A referral queue. An examiner saw an exhibit only once a police supervisor had
 * formally referred it — so the exhibits most likely to be manipulated sat in a
 * station queue, unseen, and the priority computed for them had no audience at all.
 * The laboratory now sees the digital evidence registered in the state it serves, in
 * the order the system says it should be looked at, and can record a verdict on any
 * of it in one step. Formal referrals still exist, still carry the physical article
 * and the named questions, and appear here as a filter.
 *
 * ## The boundary that has not moved
 *
 * AUTHENTIC / MANIPULATED / INCONCLUSIVE is the only authenticity vocabulary in this
 * system and only a laboratory can produce it. The verdict is hashed and signed in
 * this browser before it is sent, over a statement the server recomputes from the
 * fields it receives — so the opinion cannot be swapped after signing. And review
 * priority is never, anywhere on this screen, presented as a finding about a file.
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2, FileText, FlaskConical, Inbox, Loader2, Microscope, PenLine, Scale,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';

import {
  Counter, CounterRow, DetailSkeleton, Disclosure, Empty, Facts, Digest, Panel, Row, Rows,
  RowsSkeleton, SplitView, Workspace,
} from '@/components/common/Shell';
import {
  Denial, ForensicBadge, ForensicOpinion, Note, PriorityBadge, PriorityLegend, PriorityReasons,
  PRIORITY_ORDER,
} from '@/components/common/Verdicts';
import { useLabQueue, useExhibit, useRecordVerdict, useReferrals, useAcceptReferral } from '@/hooks/queries';
import { getOrCreateKeyPair, hashFile, hashString, signHashHex } from '@/lib/crypto';
import { OpenExhibitButton } from '@/features/evidence/ExhibitTools';
import { CertificatePanel } from '@/features/certificates/CertificatePanel';
import { CustodyRegisterPanel } from '@/features/custody/CustodyKit';
import { humanise, fmtDate, fmtBytes } from '@/lib/utils';

/** The whole authenticity vocabulary of this system. There is no fourth value. */
const OPINIONS = [
  { value: 'AUTHENTIC', label: 'Authentic', hint: 'Consistent with an unaltered original.' },
  { value: 'MANIPULATED', label: 'Manipulated', hint: 'Evidence of alteration was found.' },
  { value: 'INCONCLUSIVE', label: 'Inconclusive', hint: 'The examination could not decide.' },
];

/**
 * The statement the examiner signs, built exactly as the server rebuilds it.
 *
 * The signature covers the verdict itself rather than a digest the client chose, so
 * the opinion and the summary cannot be changed between signing and sending.
 */
const verdictStatement = ({ exhibitCode, opinion, examinationSummary, documentSha256 }) =>
  ['LEXX-FSL-VERDICT', 'v1', exhibitCode, opinion, examinationSummary, documentSha256 ?? '-'].join('|');

// =============================================================== the queue ====

function QueueRow({ item, selected, onSelect }) {
  return (
    <Row
      title={item.title}
      meta={
        <>
          <code className="font-mono">{item.exhibitCode}</code>
          {item.case?.firNumber ? ` · FIR ${item.case.firNumber}` : ''}
        </>
      }
      badge={<PriorityBadge priority={item.triage?.priority} disclaimer={item.triage?.disclaimer} />}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

// ============================================================== the verdict ====

/**
 * Record a verdict. One opinion, one summary, an optional report, one button.
 *
 * The old form needed a PDF before it would accept anything, which meant an examiner
 * who had finished examining could not record what they had found until they had also
 * produced a document. The document is now optional and the record says which it was.
 */
function VerdictForm({ exhibit, onRecorded }) {
  const record = useRecordVerdict();
  const [opinion, setOpinion] = useState('');
  const [summary, setSummary] = useState('');
  const [method, setMethod] = useState('');
  const [file, setFile] = useState(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState(null);

  const busy = signing || record.isPending;
  const ready = Boolean(opinion && summary.trim());

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!ready) return;

    setSignError(null);
    setSigning(true);

    // The register keeps ONE narrative field for the examination, so the method is
    // folded into it under its own heading rather than sent as a separate key that
    // the server's schema would drop without a word.
    const examinationSummary = method.trim()
      ? `Method: ${method.trim()}\n\n${summary.trim()}`
      : summary.trim();

    let documentSha256 = null;
    let verdictSha256;
    let verdictSignature;
    try {
      if (file) documentSha256 = await hashFile(file);
      verdictSha256 = await hashString(
        verdictStatement({
          exhibitCode: exhibit.exhibitCode,
          opinion,
          examinationSummary,
          documentSha256,
        })
      );
      const keyPair = await getOrCreateKeyPair();
      verdictSignature = await signHashHex(verdictSha256, keyPair.privateKey);
    } catch (err) {
      setSignError({ code: 'VERDICT_NOT_SIGNED', message: err.message });
      toast.error('The verdict could not be signed on this device.');
      return;
    } finally {
      setSigning(false);
    }

    const form = new FormData();
    form.set('opinion', opinion);
    form.set('examinationSummary', examinationSummary);
    form.set('verdictSha256', verdictSha256);
    form.set('verdictSignature', verdictSignature);
    if (file) form.set('report', file);

    record.mutate(
      { evidenceId: exhibit._id, form },
      {
        onSuccess: (result) => {
          onRecorded?.(result);
          toast.success(`Verdict recorded — ${humanise(opinion)}`, {
            description: 'It is on the exhibit, in the case timeline, and in the ledger.',
          });
        },
        onError: (err) => toast.error(err.message ?? 'The verdict was not recorded.'),
      }
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Your opinion</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {OPINIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={busy}
              onClick={() => setOpinion(o.value)}
              aria-pressed={opinion === o.value}
              className={
                opinion === o.value
                  ? 'rounded-lg border-2 border-ring bg-muted/60 px-3 py-2.5 text-left'
                  : 'rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/50'
              }
            >
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                {o.hint}
              </span>
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Three values, and no others. This is the only authenticity vocabulary in the system,
          and only a laboratory notified under IT Act s.79A can produce it.
        </p>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="verdict-summary">What the examination showed</Label>
        <Textarea
          id="verdict-summary"
          required
          rows={4}
          disabled={busy}
          value={summary}
          placeholder="Container and stream durations disagree by 19 seconds. Re-encoding artefacts at frame boundaries are consistent with a splice."
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>

      <Disclosure label="Method and report document" hint="Optional. Both are recorded verbatim.">
        <div className="space-y-1.5">
          <Label htmlFor="verdict-method">Method</Label>
          <Input
            id="verdict-method"
            value={method}
            disabled={busy}
            placeholder="ELA and quantisation-table comparison, container metadata review"
            onChange={(e) => setMethod(e.target.value)}
          />
          <p className="text-[12px] text-muted-foreground">
            Recorded at the head of the summary, so the technique is on the face of the record
            a court reads.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="verdict-file">Report document (PDF)</Label>
          <Input
            id="verdict-file"
            type="file"
            accept="application/pdf"
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Hashed on this machine before a byte is sent, and its digest is covered by the same
            signature as the opinion. Without one, the verdict is recorded as a signed opinion
            with no separate report — and the record says so.
            {file ? ` Selected: ${file.name} · ${fmtBytes(file.size)}.` : ''}
          </p>
        </div>
      </Disclosure>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !ready}>
          {signing || record.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <PenLine className="size-4" />
          )}
          {signing ? 'Signing…' : record.isPending ? 'Recording…' : 'Sign and record the verdict'}
        </Button>
        <p className="text-[12px] text-muted-foreground">
          Signed in this browser with your own key before it is sent.
        </p>
      </div>

      {signError && <Denial error={signError} heading="Verdict not signed" />}
      {record.isError && <Denial error={record.error} heading="Verdict not recorded" />}
    </form>
  );
}

// =============================================================== the exhibit ====

function ExhibitDetail({ evidenceId, referral, onAcceptReferral, accepting }) {
  const query = useExhibit(evidenceId);
  const [receipt, setReceipt] = useState(null);

  if (query.isPending) return <DetailSkeleton />;
  if (query.isError) return <Denial error={query.error} heading="Exhibit not readable" />;

  const e = query.data?.evidence;
  if (!e) return <Empty title="No exhibit record" icon={Microscope} />;

  const device = e.sourceDevice ?? {};
  const reviewed = Boolean(e.forensic?.opinion);

  return (
    <div className="space-y-5">
      {/* ---- what this is ---- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-[13px]">{e.exhibitCode}</code>
          <PriorityBadge priority={e.triage?.priority} disclaimer={e.triage?.disclaimer} />
          <ForensicBadge forensic={e.forensic} />
        </div>
        <h3 className="text-lg font-semibold leading-tight">{e.title}</h3>
      </div>

      {/* ---- why it is where it is in the queue ---- */}
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="label-xs">Why this priority</p>
        <PriorityReasons triage={e.triage} className="mt-2" limit={6} />
      </div>

      <Facts
        rows={[
          ['Type', `${humanise(e.kind)} · ${e.mimeType ?? '—'} · ${fmtBytes(e.sizeBytes)}`],
          [
            'Source device',
            [humanise(device.sourceType), device.make, device.model].filter(Boolean).join(' · ') || '—',
          ],
          ['Serial / IMEI', device.serialNumber ?? device.imeiOrUid ?? '—'],
          ['Captured', fmtDate(e.capturedAt)],
          ['Registered', fmtDate(e.createdAt)],
        ]}
      />

      <OpenExhibitButton exhibit={e} />

      <Separator />

      {/* ---- the act ---- */}
      {reviewed ? (
        <div className="space-y-4">
          <ForensicOpinion forensic={e.forensic} />
          {receipt && (
            <Facts
              dense
              rows={[
                ['Ledger sequence', <span key="s" className="tabular">{receipt.ledgerSeq}</span>],
                ['Entry hash', <Digest key="h" value={receipt.entryHash} />],
              ]}
            />
          )}
          <Note>
            An opinion is recorded once. To revisit it the station refers the exhibit afresh,
            and the new opinion sits beside this one in the case history rather than replacing
            it — nothing in this system is ever overwritten.
          </Note>
        </div>
      ) : referral && referral.status === 'OPEN' ? (
        <div className="space-y-3">
          <Note>
            This exhibit was formally referred to your laboratory with questions attached.
            Accept the referral to take it on — that is the moment the record shows your
            laboratory received it.
          </Note>
          <Button onClick={onAcceptReferral} disabled={accepting}>
            {accepting ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
            Accept this referral
          </Button>
        </div>
      ) : (
        <VerdictForm exhibit={e} onRecorded={setReceipt} />
      )}

      {/* ---- everything else, closed ---- */}
      <Disclosure label="Integrity record" hint="The digest recorded when this exhibit was registered.">
        <Facts
          rows={[
            ['Digest (SHA-256)', <Digest key="d" value={e.sha256Server} />],
            ['Hash matched on ingest', e.hashMatchedOnIngest ? 'Yes' : 'No'],
            ['Signature valid on ingest', e.signatureValidOnIngest ? 'Yes' : 'No'],
          ]}
        />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          If these particulars are wrong, the examination is about the wrong object — which is
          worth catching before an opinion is signed.
        </p>
      </Disclosure>

      {reviewed && (
        <Disclosure label="Section 63 certificate — Part B" hint="Your report, as the court reads it.">
          <CertificatePanel
            evidenceId={e._id}
            referralId={referral?.id}
            exhibitCode={e.exhibitCode}
            canSignPartB
          />
        </Disclosure>
      )}
    </div>
  );
}

// ================================================================== the page ====

const STATES = [
  { value: 'PENDING', label: 'To review' },
  { value: 'REVIEWED', label: 'Reviewed' },
  { value: 'ALL', label: 'Everything' },
];

export default function LabPage() {
  const [state, setState] = useState('PENDING');
  const [band, setBand] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const queue = useLabQueue({ state });
  // Referrals are the formal pipeline: a named question with an article attached.
  // They are overlaid onto the queue rather than living on a screen of their own.
  const referrals = useReferrals();
  const acceptReferral = useAcceptReferral();

  const items = useMemo(() => {
    const all = queue.data?.queue ?? [];
    return band ? all.filter((x) => x.triage?.priority === band) : all;
  }, [queue.data, band]);

  const referralByEvidence = useMemo(() => {
    const map = new Map();
    for (const r of referrals.data?.referrals ?? []) map.set(String(r.evidenceId), r);
    return map;
  }, [referrals.data]);

  const counts = queue.data?.counts;
  const pending = counts?.pending ?? 0;
  const critical = counts?.byPriority?.CRITICAL ?? 0;

  /**
   * The selection is DERIVED, not stored-and-corrected.
   *
   * An effect that "fixes" a stale selection after the fact renders once with the
   * wrong thing on screen and then again with the right one — and when the filter
   * changes under the examiner, that first render is a detail panel for an exhibit
   * that is no longer in the list. Falling back to the head of the queue during
   * render means the screen is never momentarily wrong, and the examiner always
   * lands on the most urgent item without being sent there.
   */
  const selected =
    items.find((x) => String(x._id) === String(selectedId)) ?? items[0] ?? null;
  const noLabScope = queue.isSuccess && !queue.data?.labId;

  const onAccept = () => {
    const referral = referralByEvidence.get(String(selectedId));
    if (!referral) return;
    acceptReferral.mutate(referral.id, {
      onSuccess: () => toast.success('Referral accepted. The exhibit is under examination.'),
      onError: (err) => toast.error(err.message ?? 'The referral was not accepted.'),
    });
  };

  return (
    <Workspace
      eyebrow="Forensic science laboratory · IT Act s.79A"
      title="Evidence to review"
      lede="Every exhibit is given a review priority the moment it is registered. This queue is in that order."
    >
      {noLabScope ? (
        <Note tone="warn">
          This session carries no laboratory scope, so it has no queue. That is the access
          policy answering, not an empty register.
        </Note>
      ) : (
        <>
          {/* ---- the answer to "what do I look at next?" ---- */}
          <section className="surface flex flex-wrap items-center justify-between gap-x-8 gap-y-5 p-5 sm:p-6">
            <div className="flex min-w-0 items-center gap-5">
              <p
                className={
                  critical > 0
                    ? 'shrink-0 text-4xl font-semibold tabular tracking-tight text-priority-critical sm:text-5xl'
                    : 'shrink-0 text-4xl font-semibold tabular tracking-tight sm:text-5xl'
                }
              >
                {queue.isSuccess ? pending : '—'}
              </p>
              <div className="min-w-0 space-y-0.5">
                <p className="text-[15px] font-medium leading-snug">
                  {pending === 1 ? 'exhibit awaiting review' : 'exhibits awaiting review'}
                </p>
                <p className="max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
                  {critical > 0
                    ? `${critical} of them ${critical === 1 ? 'is' : 'are'} critical — look at those before anything else.`
                    : 'Nothing in the queue is critical.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {STATES.map((s) => (
                <Button
                  key={s.value}
                  size="sm"
                  variant={state === s.value ? 'secondary' : 'ghost'}
                  className="rounded-full"
                  onClick={() => {
                    setState(s.value);
                    setSelectedId(null);
                  }}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </section>

          {/* ---- the bands, as filters ---- */}
          <CounterRow>
            {PRIORITY_ORDER.map((p) => (
              <Counter
                key={p}
                label={humanise(p)}
                value={queue.isSuccess ? (counts?.byPriority?.[p] ?? 0) : '—'}
                tone={p === 'CRITICAL' ? 'bad' : p === 'HIGH' ? 'warn' : 'neutral'}
                active={band === p}
                onClick={() => {
                  setBand((b) => (b === p ? null : p));
                  setSelectedId(null);
                }}
              />
            ))}
            <Counter
              label="Reviewed"
              value={queue.isSuccess ? (counts?.reviewed ?? 0) : '—'}
              tone="ok"
            />
          </CounterRow>

          <SplitView
            list={
              <Panel
                title={band ? `${humanise(band)} priority` : 'The queue'}
                actions={
                  band && (
                    <Button size="sm" variant="ghost" onClick={() => setBand(null)}>
                      Clear filter
                    </Button>
                  )
                }
                bodyClassName="p-0"
              >
                {queue.isPending && <RowsSkeleton />}
                {queue.isError && (
                  <div className="p-5">
                    <Denial error={queue.error} heading="Queue unavailable" />
                  </div>
                )}
                {queue.isSuccess && items.length === 0 && (
                  <div className="p-5">
                    <Empty title="Nothing here" icon={Inbox}>
                      {state === 'PENDING'
                        ? 'Every exhibit in your laboratory’s scope has been reviewed.'
                        : 'No exhibit matches this filter.'}
                    </Empty>
                  </div>
                )}
                {items.length > 0 && (
                  <Rows>
                    {items.map((item) => (
                      <QueueRow
                        key={item._id}
                        item={item}
                        selected={String(item._id) === String(selectedId)}
                        onSelect={() => setSelectedId(String(item._id))}
                      />
                    ))}
                  </Rows>
                )}
              </Panel>
            }
            detail={
              <Panel
                title={selected ? 'The exhibit' : 'Nothing selected'}
                actions={
                  referralByEvidence.has(String(selectedId)) && (
                    <Badge variant="outline" className="rounded-full text-[11px] font-normal">
                      Referred with questions
                    </Badge>
                  )
                }
              >
                {selected ? (
                  <ExhibitDetail
                    key={selected._id}
                    evidenceId={selected._id}
                    referral={referralByEvidence.get(String(selected._id))}
                    onAcceptReferral={onAccept}
                    accepting={acceptReferral.isPending}
                  />
                ) : (
                  <Empty title="Choose an exhibit" icon={Microscope}>
                    Open one from the queue to read what was observed about it and record a
                    verdict.
                  </Empty>
                )}
              </Panel>
            }
          />

          {/* ---- the standing explanation, once, at the bottom ---- */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="How this queue is ordered">
              <PriorityLegend disclaimer={queue.data?.disclaimer} />
            </Panel>

            <Panel title="Formal referrals" description="A named question about one exhibit, with the sealed article to go with it.">
              <ReferralSummary referrals={referrals} onOpen={setSelectedId} />
            </Panel>
          </div>

          <Disclosure
            label="Articles with your laboratory"
            hint="Physical articles sent here for examination, and the handovers that move them."
          >
            <CustodyRegisterPanel emptyText="No physical article is booked in a case referred to your laboratory." />
          </Disclosure>
        </>
      )}
    </Workspace>
  );
}

/** The referral pipeline, as a summary rather than a second queue. */
function ReferralSummary({ referrals, onOpen }) {
  const rows = referrals.data?.referrals ?? [];
  if (referrals.isPending) return <RowsSkeleton rows={2} />;
  if (referrals.isError) return <Denial error={referrals.error} heading="Referrals unavailable" />;
  if (!rows.length) {
    return (
      <Empty title="No formal referrals" icon={Scale}>
        Nothing has been sent to your laboratory with questions attached. The queue above does
        not depend on that — it is what you can examine, referred or not.
      </Empty>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.slice(0, 5).map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => onOpen(String(r.evidenceId))}
              className="truncate font-mono text-[13px] hover:underline"
            >
              {r.exhibitCode}
            </button>
            <p className="truncate text-[12px] text-muted-foreground">
              {humanise(r.discipline)} · {r.questionsPosed || 'no questions recorded'}
            </p>
          </div>
          <Badge
            variant="outline"
            className={
              r.status === 'REPORTED'
                ? 'shrink-0 rounded-full border-ok/35 bg-ok-muted text-[11px] text-ok'
                : r.status === 'OPEN'
                  ? 'shrink-0 rounded-full border-warn/35 bg-warn-muted text-[11px] text-warn'
                  : 'shrink-0 rounded-full text-[11px]'
            }
          >
            {r.status === 'REPORTED' ? (
              <CheckCircle2 className="mr-1 size-3" />
            ) : r.status === 'ACCEPTED' ? (
              <FileText className="mr-1 size-3" />
            ) : null}
            {humanise(r.status)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
