/**
 * The court.
 *
 * ## The question this screen answers
 *
 * "What does this case need from me?"
 *
 * There were seven tabs here — cause list, exhibits, custody, ledger, orders,
 * representation, disclosure — and the three acts that actually move a case forward
 * were spread across four of them, behind a pack id that had to be pasted into a text
 * field. A judge could not tell, from the screen, that an advocate was waiting to be
 * taken on record.
 *
 * Now: the cause list is a list, the case is a panel, and everything the court can do
 * to the case is on that panel, in the order it happens.
 *
 *   1. Take counsel on record      — a vakalatnama is waiting, or it is not
 *   2. Share the case file         — one decision, composed, ruled and served
 *   3. Close the case              — protected, and explicit about what it preserves
 *
 * ## What the court can see, and when
 *
 * Everything, immediately, whether or not a laboratory has reported. Nothing about
 * the court's access to a case or its evidence is gated on a forensic verdict — and
 * because that is a question anyone watching will ask, the exhibit list says so out
 * loud rather than leaving it to be inferred from an empty column.
 */
import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import {
  Check, FileStack, Gavel, Link2, Loader2, Lock, Scale, Send, ShieldCheck, UserCheck, X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

import {
  Counter, CounterRow, DetailSkeleton, Disclosure, Empty, Facts, Digest, Panel, Row, Rows,
  RowsSkeleton, SplitView, Workspace,
} from '@/components/common/Shell';
import { CaseLifecycle, StageBadge } from '@/components/common/Lifecycle';
import { Denial, ForensicBadge, Note } from '@/components/common/Verdicts';
import { ExhibitDialog, useExhibitDialog } from '@/features/evidence/ExhibitDialog';
import { CustodyRegisterPanel } from '@/features/custody/CustodyKit';
import {
  useCase, useCases, useCloseCase, useEvidence, useLedger, usePacksForCase, useRecordOrder,
  useRepresentation, useRuleOnFiling, useShareCaseFile, useSyncRepresentation, useTraceWatermark,
  useVerifyChain,
} from '@/hooks/queries';
import { workingCaseSet, selectWorkingCaseId } from '@/features/ui/uiSlice';
import { explain } from '@/lib/api';
import { api } from '@/lib/api';
import { openBlob } from '@/lib/download';
import { cn, fmtDate, humanise } from '@/lib/utils';

// ====================================================== 1. counsel on record ====

/**
 * The lawyer-assignment workflow, which is now one screen and two buttons.
 *
 * An advocate files a vakalatnama; it arrives here as a pending filing with the
 * document attached. The court reads the document and either takes them on record or
 * refuses with a reason. Acceptance is written to the COURT REGISTER first — Lexx
 * mirrors that record and never invents an advocate's authority — and only then does
 * the case open to them.
 */
function CounselPanel({ caseId, caseDoc }) {
  const representation = useRepresentation(caseId);
  const rule = useRuleOnFiling();
  const sync = useSyncRepresentation();
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState('');

  // `pending` on the response is a COUNT; the filings themselves are in `filings`.
  const pending = (representation.data?.filings ?? []).filter((f) => f.status === 'PENDING');
  const onRecord = representation.data?.onRecord ?? [];

  const openDocument = async (filing) => {
    try {
      const blob = await api.vakalatnama.documentBlob(filing.id);
      openBlob(blob, `vakalatnama-${filing.advocateAuthorityId}`);
    } catch (err) {
      toast.error('The document could not be opened', { description: err.message });
    }
  };

  const decide = (filing, decision) =>
    rule.mutate(
      { id: filing.id, decision, note: decision === 'REJECT' ? note.trim() : undefined },
      {
        onSuccess: () => {
          toast.success(
            decision === 'ACCEPT'
              ? `${filing.advocateName ?? filing.advocateAuthorityId} is on record`
              : 'Filing refused'
          );
          setRejecting(null);
          setNote('');
        },
        onError: (err) =>
          toast.error('Not recorded', { description: explain(err.code, err.message) }),
      }
    );

  if (representation.isPending) return <RowsSkeleton rows={2} />;
  if (representation.isError) {
    return <Denial error={representation.error} heading="Representation not readable" />;
  }

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <div className="space-y-2">
          <p className="label-xs">Waiting for you</p>
          {pending.map((f) => (
            <div key={f.id} className="space-y-3 rounded-lg border border-warn/35 bg-warn-muted/40 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{f.advocateName ?? f.advocateAuthorityId}</p>
                  <p className="text-[12px] text-muted-foreground">
                    <code className="font-mono">{f.advocateAuthorityId}</code> · appearing for the{' '}
                    {humanise(f.appearingFor).toLowerCase()} ({f.partyName}) · filed{' '}
                    {fmtDate(f.filedAt)}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => openDocument(f)}>
                  Read the vakalatnama
                </Button>
              </div>

              {rejecting === f.id ? (
                <div className="space-y-2">
                  <Label htmlFor={`note-${f.id}`}>Why it is refused</Label>
                  <Textarea
                    id={`note-${f.id}`}
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="The document is not executed by the party it names."
                  />
                  <p className="text-[12px] text-muted-foreground">
                    An advocate is entitled to know why they were not taken on record, so a
                    refusal carries a reason and both go into the ledger.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={rule.isPending || note.trim().length < 3}
                      onClick={() => decide(f, 'REJECT')}
                    >
                      Refuse the filing
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={rule.isPending} onClick={() => decide(f, 'ACCEPT')}>
                    {rule.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <UserCheck className="size-3.5" />
                    )}
                    Take on record
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRejecting(f.id)}>
                    <X className="size-3.5" />
                    Refuse
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {onRecord.length > 0 ? (
        <div className="space-y-2">
          <p className="label-xs">On record</p>
          <ul className="divide-y rounded-lg border">
            {onRecord.map((g) => (
              <li key={g.grantId} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{g.name ?? g.authorityId}</p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {humanise(g.role)} · {humanise(g.grantBasis)}
                  </p>
                </div>
                <Check aria-hidden className="size-4 shrink-0 text-ok" />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        pending.length === 0 && (
          <Empty title="Nobody is on record yet" icon={UserCheck}>
            An advocate comes on record by filing a vakalatnama in this case. Until one does,
            there is nobody the case file can be shared with.
          </Empty>
        )
      )}

      <Disclosure
        label="Check the court register"
        hint="Legal-aid orders and appearances filed outside Lexx are mirrored from the court directory."
      >
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Lexx never grants a lawyer access on its own authority. This re-reads the court
          directory and mirrors what it says — an accepted vakalatnama, or a BNSS s.341 legal
          aid order — adding grants the register shows and revoking those it no longer does.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={sync.isPending}
          onClick={() =>
            sync.mutate(caseId, {
              onSuccess: (r) =>
                toast.success('Register checked', {
                  description: `${r.added?.length ?? 0} added, ${r.revoked?.length ?? 0} revoked.`,
                }),
              onError: (err) => toast.error(explain(err.code, err.message)),
            })
          }
        >
          {sync.isPending && <Loader2 className="size-3.5 animate-spin" />}
          Check the register now
        </Button>
        {sync.isError && <Denial error={sync.error} heading="Register not read" />}
        {caseDoc?.cnrNumber && (
          <p className="text-[12px] text-muted-foreground">
            CNR <code className="font-mono">{caseDoc.cnrNumber}</code>
          </p>
        )}
      </Disclosure>
    </div>
  );
}

// ========================================================= 2. the case file ====

/**
 * Sharing the case file: one decision by the court that holds it.
 *
 * The set is COMPUTED — every exhibit on the case, minus anything the court withholds
 * with a ground on the record. Withholding is the exception and lives behind a
 * disclosure; sharing everything takes no input at all.
 */
function ShareCaseFile({ caseId, exhibits, counselCount, disclosure }) {
  const share = useShareCaseFile();
  const [open, setOpen] = useState(false);
  const [withheld, setWithheld] = useState({});
  const [reason, setReason] = useState('');
  const [result, setResult] = useState(null);

  const chosen = Object.keys(withheld).filter((k) => withheld[k]);
  const reasonTooShort = chosen.length > 0 && reason.trim().length < 10;
  const alreadyShared = disclosure?.status === 'SERVED';

  const onShare = () =>
    share.mutate(
      {
        caseId,
        payload: {
          withheldItems: chosen.map((itemId) => ({ itemId, reason: reason.trim() })),
        },
      },
      {
        onSuccess: (r) => {
          setResult(r);
          toast.success('Case file shared', {
            description: `${r.servedNow?.length ?? 0} recipient(s), each with their own watermark.`,
          });
        },
        onError: (err) =>
          toast.error('Not shared', { description: explain(err.code, err.message) }),
      }
    );

  if (alreadyShared) {
    return (
      <div className="space-y-3">
        <Note>
          The case file was shared on {fmtDate(disclosure.servedOn)}. Each recipient&rsquo;s copy
          carries its own watermark, so a leaked page points back to the person it was served
          on. Changing what is in the file needs a fresh order.
        </Note>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={counselCount === 0}>
          <Send className="size-4" />
          Share the case file
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[88vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Share the case file with counsel</DialogTitle>
          <DialogDescription>
            Every exhibit on this case goes to the {counselCount} advocate
            {counselCount === 1 ? '' : 's'} on record, each with their own watermark. This is
            composed, ruled on and served in one act, and all three are written to the ledger.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <Note>
              Served. The fourteen-day BNSS s.230 clock stops for each recipient when they
              acknowledge receipt, not when the file leaves the court.
            </Note>
            <ul className="space-y-2">
              {(result.servedNow ?? []).map((r) => (
                <li key={r.userId} className="rounded-lg border p-3">
                  <p className="font-mono text-[12px]">{r.authorityId ?? r.userId}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{r.watermarkLabel}</p>
                  <Digest value={r.watermarkToken} className="mt-1.5" />
                </li>
              ))}
            </ul>
            <Button className="w-full" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Disclosure
              label="Withhold an exhibit"
              hint="The exception. Anything ticked here is kept from the defence, on the ground you give."
            >
              <div className="space-y-1.5">
                {exhibits.map((e) => (
                  <label
                    key={e._id}
                    htmlFor={`w-${e._id}`}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-warn/40 has-[[data-state=checked]]:bg-warn-muted/40"
                  >
                    <Checkbox
                      id={`w-${e._id}`}
                      className="mt-0.5"
                      checked={Boolean(withheld[e._id])}
                      onCheckedChange={(v) => setWithheld((x) => ({ ...x, [e._id]: v === true }))}
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{e.title}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {e.exhibitCode}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="withhold-reason">Ground for withholding</Label>
                <Textarea
                  id="withhold-reason"
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Identifies a protected witness; withheld pending an order under BNSS s.398."
                />
                <p
                  className={cn(
                    'text-[12px]',
                    reasonTooShort ? 'text-warn' : 'text-muted-foreground'
                  )}
                >
                  Recorded against each withheld exhibit and written to the ledger, so what was
                  kept back — and why — can be revisited.
                </p>
              </div>
            </Disclosure>

            {share.isError && <Denial error={share.error} heading="Not shared" />}

            <Button
              className="w-full"
              disabled={share.isPending || reasonTooShort}
              onClick={onShare}
            >
              {share.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Share {exhibits.length - chosen.length} of {exhibits.length} exhibit
              {exhibits.length === 1 ? '' : 's'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================================ 3. closing it ====

/**
 * Closing the case.
 *
 * Protected by a reason and a typed confirmation, because it is irreversible — and
 * explicit about what it does NOT do, because "close" is a word that reads as
 * "delete" and here it means very nearly the opposite.
 */
function CloseCase({ caseId, caseDoc }) {
  const close = useCloseCase();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');

  const closed = caseDoc?.stage === 'CLOSED' || caseDoc?.stage === 'DISPOSED';
  if (closed || !caseDoc?.cnrNumber) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Lock className="size-4" />
          Close the case
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Close FIR {caseDoc.firNumber}</DialogTitle>
          <DialogDescription>
            The case moves to Closed and stops accepting anything further, from every role
            including this court.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Note>
            <span className="font-medium text-foreground">Nothing is deleted.</span> Every
            exhibit, custody record, forensic opinion, certificate, ledger entry and anchored
            root stays exactly where it is and stays readable by everyone who can read it
            today. Closing stops the record; it does not remove it.
          </Note>

          <div className="space-y-1.5">
            <Label htmlFor="close-reason">Why the case is being closed</Label>
            <Textarea
              id="close-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Judgment pronounced; the accused is convicted under BNS s.103(1)."
            />
            <p className="text-[12px] text-muted-foreground">
              Recorded in the ledger with your authority identifier and the court.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="close-confirm">
              Type <span className="font-mono">CLOSE</span> to confirm
            </Label>
            <Input
              id="close-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
            />
          </div>

          {close.isError && <Denial error={close.error} heading="Case not closed" />}

          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={close.isPending || confirm !== 'CLOSE' || reason.trim().length < 3}
              onClick={() =>
                close.mutate(
                  { caseId, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      toast.success('Case closed', {
                        description: 'The whole record is preserved and stays readable.',
                      });
                      setOpen(false);
                      setConfirm('');
                      setReason('');
                    },
                    onError: (err) =>
                      toast.error('Not closed', { description: explain(err.code, err.message) }),
                  }
                )
              }
            >
              {close.isPending && <Loader2 className="size-4 animate-spin" />}
              Close the case
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================== orders ====

function RecordOrder({ caseId }) {
  const record = useRecordOrder();
  const [orderType, setOrderType] = useState('');
  const [text, setText] = useState('');

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        record.mutate(
          { caseId, payload: { orderType: orderType.trim(), text: text.trim() } },
          {
            onSuccess: (r) => {
              toast.success('Order recorded', { description: `Ledger sequence ${r.ledgerSeq}.` });
              setOrderType('');
              setText('');
            },
            onError: (err) => toast.error(explain(err.code, err.message)),
          }
        );
      }}
    >
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        An order is appended to the case ledger under your authority identifier, and can never
        be edited or withdrawn — only followed by another order. That is why there is no delete
        button anywhere in this system: where another design would remove a record, this one
        records an order and changes a status.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="order-type">Order type</Label>
        <Input
          id="order-type"
          value={orderType}
          onChange={(e) => setOrderType(e.target.value)}
          placeholder="COMMITTAL / EXHIBIT_MARKED / DISCLOSURE_DIRECTION"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="order-text">The order</Label>
        <Textarea
          id="order-text"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="In the words it is to be recorded in."
          required
        />
      </div>
      <Button type="submit" size="sm" disabled={record.isPending || !orderType.trim() || !text.trim()}>
        {record.isPending ? <Loader2 className="size-4 animate-spin" /> : <Gavel className="size-4" />}
        Record the order
      </Button>
      {record.isError && <Denial error={record.error} heading="Order not recorded" />}
      {record.data && (
        <Facts
          dense
          rows={[
            ['Ledger sequence', <span key="s" className="tabular">{record.data.ledgerSeq}</span>],
            ['Entry hash', <Digest key="h" value={record.data.entryHash} />],
          ]}
        />
      )}
    </form>
  );
}

// ================================================================== ledger ====

function LedgerTimeline({ caseId }) {
  const ledger = useLedger(caseId);
  const verify = useVerifyChain();
  const entries = ledger.data?.entries ?? [];
  const latest = entries.length ? Math.max(...entries.map((e) => e.seq)) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={verify.isPending}
          onClick={() =>
            verify.mutate(undefined, {
              onSuccess: (r) =>
                r.intact
                  ? toast.success('Chain intact', {
                      description: `${r.entriesChecked} entries recomputed.`,
                    })
                  : toast.error('Chain broken', {
                      description: `First break at sequence ${r.brokenAtSeq}.`,
                    }),
              onError: (err) => toast.error(explain(err.code, err.message)),
            })
          }
        >
          {verify.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          Verify the chain
        </Button>
        {verify.data && (
          <Badge
            variant="outline"
            className={cn(
              'rounded-full text-[11px]',
              verify.data.intact
                ? 'border-ok/35 bg-ok-muted text-ok'
                : 'border-bad/35 bg-bad-muted text-bad'
            )}
          >
            {verify.data.intact
              ? `Intact · ${verify.data.entriesChecked} entries`
              : `Broken at ${verify.data.brokenAtSeq}`}
          </Badge>
        )}
      </div>

      {ledger.isPending && <RowsSkeleton rows={3} />}
      {ledger.isError && <Denial error={ledger.error} heading="Ledger not readable" />}
      {ledger.isSuccess && entries.length === 0 && (
        <Empty title="No entries against this case" icon={Link2} />
      )}

      {entries.length > 0 && (
        <ol className="border-l-2 pl-5">
          {entries.map((entry) => {
            const broken = entry.eventType === 'INTEGRITY_EXCEPTION';
            return (
              <li key={entry.seq} className="relative pb-5 last:pb-0">
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-[calc(-1.25rem_-_5px)] top-1.5 size-2 rounded-full ring-4 ring-card',
                    broken ? 'bg-bad' : entry.seq === latest ? 'bg-ring' : 'bg-border'
                  )}
                />
                <p className={cn('text-[13px] font-medium', broken && 'text-bad')}>
                  {humanise(entry.eventType)}
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  <span className="font-mono tabular">seq {entry.seq}</span> ·{' '}
                  {fmtDate(entry.occurredAt)} · {humanise(entry.actorRole) || '—'}
                  {entry.payload?.exhibitCode ? ` · ${entry.payload.exhibitCode}` : ''}
                </p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {entry.anchorBatchId
                    ? `In anchor batch ${entry.anchorBatchId}`
                    : 'Not yet batched'}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ================================================================ the case ====

function CaseDetail({ caseId }) {
  const query = useCase(caseId);
  const evidence = useEvidence({ caseId }, { enabled: Boolean(caseId) });
  const packs = usePacksForCase(caseId);
  const representation = useRepresentation(caseId);
  const exhibitDialog = useExhibitDialog();

  if (!caseId) {
    return (
      <Panel title="No case selected">
        <Empty title="Choose a case" icon={Scale}>
          Open one from the cause list. Everything the court can do to it is on one panel.
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

  const exhibits = evidence.data?.evidence ?? [];
  const summary = c.summary ?? {};
  const disclosure = query.data?.disclosure ?? null;
  const counselCount = representation.data?.onRecord?.length ?? 0;
  const pendingCounsel = representation.data?.pending ?? 0;
  const closed = c.stage === 'CLOSED' || c.stage === 'DISPOSED';
  const awaiting = summary.awaitingForensics ?? 0;

  return (
    <div className="space-y-5">
      <Panel
        title={`FIR ${c.firNumber}`}
        actions={
          !closed && (
            <div className="flex flex-wrap gap-2">
              <ShareCaseFile
                caseId={caseId}
                exhibits={exhibits}
                counselCount={counselCount}
                disclosure={disclosure}
              />
              <CloseCase caseId={caseId} caseDoc={c} />
            </div>
          )
        }
      >
        <div className="space-y-5">
          <div className="space-y-1">
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

          {closed && (
            <Note>
              This case is closed. It stays readable in full — every exhibit, opinion,
              certificate and ledger entry is exactly where it was — and nothing further can be
              recorded against it.
              {c.closedOn ? ` Closed ${fmtDate(c.closedOn)}.` : ''}
            </Note>
          )}

          <Facts
            rows={[
              ['Station', <code key="s" className="font-mono text-xs">{c.stationCode}</code>],
              ['Sections', (c.bnsSections ?? []).join(', ') || '—'],
              ['Maximum punishment', `${c.maxPunishmentYears} years`],
              ['Chargesheet filed', fmtDate(c.chargesheetFiledOn)],
              [
                'Case file shared',
                disclosure?.servedOn ? fmtDate(disclosure.servedOn) : 'Not yet',
              ],
            ]}
          />
        </div>
      </Panel>

      <Panel
        title="Counsel"
        description={
          pendingCounsel > 0
            ? `${pendingCounsel} vakalatnama waiting for the court to rule on it.`
            : undefined
        }
      >
        <CounselPanel caseId={caseId} caseDoc={c} />
      </Panel>

      <Panel
        title="Evidence"
        description={
          awaiting > 0
            ? `${awaiting} of ${summary.exhibits} exhibits have no laboratory opinion yet. Nothing here waits on one.`
            : 'Every exhibit on this case carries a laboratory opinion.'
        }
      >
        {evidence.isPending && <RowsSkeleton rows={3} />}
        {evidence.isError && <Denial error={evidence.error} heading="Evidence not readable" />}
        {evidence.isSuccess && exhibits.length === 0 && (
          <Empty title="No exhibits on this case" icon={FileStack} />
        )}
        {exhibits.length > 0 && (
          <ul className="-mx-5 -my-5 divide-y">
            {exhibits.map((e) => (
              <Row
                key={e._id}
                title={e.title}
                meta={<code className="font-mono">{e.exhibitCode}</code>}
                badge={<ForensicBadge forensic={e.forensic} />}
                onSelect={() => exhibitDialog.open(e._id)}
              />
            ))}
          </ul>
        )}
      </Panel>

      {!closed && (
        <Disclosure label="Record a judicial order" hint="The only way anything in this system changes.">
          <RecordOrder caseId={caseId} />
        </Disclosure>
      )}

      <Disclosure label="Case history" hint="Every act on this case, hash-chained and anchored.">
        <LedgerTimeline caseId={caseId} />
      </Disclosure>

      <Disclosure label="Physical articles" hint="What the court's evidence room holds, and what is on its way.">
        <CustodyRegisterPanel
          query={{ caseId }}
          emptyText="No physical article has been booked on this case."
        />
      </Disclosure>

      <Disclosure label="Trace a leaked copy" hint="Every served page carries its recipient's watermark.">
        <TraceWatermark />
      </Disclosure>

      {packs.isError && <Denial error={packs.error} heading="Disclosure not readable" />}

      <ExhibitDialog
        evidenceId={exhibitDialog.evidenceId}
        onClose={exhibitDialog.close}
        canIssueCertificate
        canSignPartA
      />
    </div>
  );
}

function TraceWatermark() {
  const trace = useTraceWatermark();
  const [token, setToken] = useState('');
  const r = trace.data;

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Paste the watermark token printed on a leaked page to learn whose copy it was. The
        lookup is court-only, and it is itself audited.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          trace.mutate(token.trim());
        }}
      >
        <Input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="watermark token"
          className="font-mono"
        />
        <Button type="submit" size="sm" variant="outline" disabled={trace.isPending || token.trim().length < 20}>
          Trace
        </Button>
      </form>
      {trace.isError && <Denial error={trace.error} heading="Not traced" />}
      {r && (
        <Facts
          rows={[
            ['Served on', `${r.recipient?.name ?? '—'} · ${r.recipient?.authorityId ?? ''}`],
            ['Role', humanise(r.recipient?.role)],
            ['Served at', fmtDate(r.servedAt)],
            ['Acknowledged', r.acknowledgedAt ? fmtDate(r.acknowledgedAt) : 'not yet'],
          ]}
        />
      )}
    </div>
  );
}

// ==================================================================== page ====

export default function CourtPage() {
  const dispatch = useDispatch();
  const caseId = useSelector(selectWorkingCaseId);
  const cases = useCases();
  const listed = useMemo(() => cases.data?.cases ?? [], [cases.data]);

  useEffect(() => {
    if (!listed.length) return;
    if (!caseId || !listed.some((c) => String(c._id) === String(caseId))) {
      dispatch(workingCaseSet(String(listed[0]._id)));
    }
  }, [listed, caseId, dispatch]);

  const ready = cases.isSuccess;
  const totals = listed.reduce(
    (acc, c) => ({
      unshared: acc.unshared + (c.summary?.disclosure?.status === 'SERVED' ? 0 : 1),
      noCounsel: acc.noCounsel + ((c.summary?.counselOnRecord ?? 0) === 0 ? 1 : 0),
      closed: acc.closed + (c.stage === 'CLOSED' || c.stage === 'DISPOSED' ? 1 : 0),
    }),
    { unshared: 0, noCounsel: 0, closed: 0 }
  );

  return (
    <Workspace
      eyebrow="Court · cause list"
      title="Cases before you"
      lede="Read from the roster your authority directory holds. You see the whole case file — the court is never waiting on a laboratory to read it."
    >
      {cases.isError && <Denial error={cases.error} heading="Cause list not readable" />}

      <CounterRow>
        <Counter label="Cases listed" value={ready ? listed.length : '—'} />
        <Counter
          label="File not yet shared"
          value={ready ? totals.unshared : '—'}
          tone={totals.unshared > 0 ? 'warn' : 'neutral'}
        />
        <Counter
          label="No counsel on record"
          value={ready ? totals.noCounsel : '—'}
          tone={totals.noCounsel > 0 ? 'warn' : 'neutral'}
        />
        <Counter label="Closed" value={ready ? totals.closed : '—'} />
      </CounterRow>

      <SplitView
        list={
          <Panel title="Cause list" bodyClassName="p-0">
            {cases.isPending && <RowsSkeleton />}
            {ready && listed.length === 0 && (
              <div className="p-5">
                <Empty title="No case is listed in your court" icon={Scale}>
                  A case reaches a court when the chargesheet is filed. Until then there is
                  nothing here — which is a statement about listing, not about whether cases
                  exist.
                </Empty>
              </div>
            )}
            {listed.length > 0 && (
              <Rows>
                {listed.map((c) => (
                  <Row
                    key={c._id}
                    title={c.title}
                    meta={`FIR ${c.firNumber}`}
                    badge={<StageBadge stage={c.stage} />}
                    selected={String(c._id) === String(caseId)}
                    onSelect={() => dispatch(workingCaseSet(String(c._id)))}
                  >
                    <span className="mt-1 block text-[12px] text-muted-foreground">
                      {c.summary?.exhibits ?? 0} exhibits ·{' '}
                      {c.summary?.counselOnRecord ?? 0} counsel ·{' '}
                      {c.summary?.disclosure?.status === 'SERVED' ? 'file shared' : 'file not shared'}
                    </span>
                  </Row>
                ))}
              </Rows>
            )}
          </Panel>
        }
        detail={<CaseDetail caseId={caseId} />}
      />
    </Workspace>
  );
}
