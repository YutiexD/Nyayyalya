/**
 * The court: the cases listed before it, and the one judicial step each needs.
 *
 * The server's case state machine decides which acts are valid; the client only names
 * the act. Accepting a vakalatnama is the whole of lawyer access — the case and its
 * evidence open to that advocate automatically, with nothing to share by hand.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import {
  ArrowRight, Check, FileText, Gavel, Loader2, Lock, Paperclip, RefreshCw, RotateCcw, Scale, ShieldCheck,
  ShieldX, UserCheck, X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

import {
  DetailSkeleton, Empty, MetaLine, Panel, Row, Rows, RowsSkeleton, SplitView, Workspace,
} from '@/components/common/Shell';
import { CaseLifecycle, StageBadge } from '@/components/common/Lifecycle';
import { CaseClosure, CaseTimeline } from '@/components/common/CaseRecord';
import { CopyableValue } from '@/components/common/CopyButton';
import { Denial } from '@/components/common/Verdicts';
import { ExhibitDialog, useExhibitDialog } from '@/features/evidence/ExhibitDialog';
import { FilingRuling, FilingStatusBadge } from '@/features/vakalatnama/Vakalatnama';
import { EvidenceTable } from '@/features/court/EvidenceTable';
import {
  useCaseOverview, useCases, useRepresentation, useSyncRepresentation, useTransitionCase,
  useVerifyChain,
} from '@/hooks/queries';
import { workingCaseSet, selectWorkingCaseId } from '@/features/ui/uiSlice';
import { api, explain } from '@/lib/api';
import { getOrCreateKeyPair, hashFile, signHashHex } from '@/lib/crypto';
import { openBlob } from '@/lib/download';
import { cn, fmtBytes, fmtDate, humanise } from '@/lib/utils';

const CLOSED_STAGES = new Set(['CLOSED', 'DISPOSED']);
const isClosed = (c) => CLOSED_STAGES.has(c?.stage);

const ACTION_ICON = {
  TAKE_COGNIZANCE: Gavel,
  COMMIT_FOR_TRIAL: ArrowRight,
  BEGIN_TRIAL: Scale,
  DIRECT_FURTHER_INVESTIGATION: RotateCcw,
  CLOSE_CASE: Lock,
};

const certificateStatus = (c) => (!c || c.state === 'PENDING_ISSUE' ? 'PENDING_ISSUE' : c.status ?? c.state);

// ======================================================== judicial step ====

const CLOSURE_KINDS = [
  { value: 'FINAL_JUDGMENT', label: 'Final judgment' },
  { value: 'DECLARATION', label: 'Declaration' },
  { value: 'ORDER', label: 'Closing order' },
];
const CLOSURE_MAX_BYTES = 20 * 1024 * 1024;
const CLOSE_STEPS = [
  { key: 'fingerprint', label: 'Fingerprint' },
  { key: 'sign', label: 'Sign' },
  { key: 'close', label: 'Close' },
];

const isPdf = (file) => file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name ?? '');

/** Fingerprint · Sign · Close, with the step in flight spinning and finished ones checked. */
function CloseProgress({ step }) {
  const at = CLOSE_STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta" aria-label="Progress">
      {CLOSE_STEPS.map((s, i) => {
        const done = at > i;
        const active = at === i;
        return (
          <li key={s.key} className="flex items-center gap-2">
            {i > 0 && (
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
            )}
            <span
              className={cn(
                'inline-flex items-center gap-1',
                active ? 'font-medium text-foreground' : done ? 'text-ok' : 'text-muted-foreground'
              )}
              aria-current={active ? 'step' : undefined}
            >
              {done ? (
                <Check aria-hidden className="size-3.5" />
              ) : active ? (
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
              ) : null}
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ClosureAttachment({ kind, onKind, file, onFile, disabled, problem }) {
  const fileId = useId();
  return (
    <fieldset className="space-y-2.5 rounded-lg border p-3.5" disabled={disabled}>
      <legend className="px-1 text-meta font-medium text-foreground">
        Attach final judgment / declaration <span className="font-normal text-muted-foreground">(optional)</span>
      </legend>
      <div className="grid gap-2.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <Select value={kind} onValueChange={onKind} disabled={disabled}>
          <SelectTrigger aria-label="Document kind">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            {CLOSURE_KINDS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {file ? (
          <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5">
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-meta text-foreground" title={file.name}>
              {file.name}
            </span>
            <span className="shrink-0 text-label text-muted-foreground">{fmtBytes(file.size)}</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="size-6 [&_svg]:size-3.5"
              aria-label="Remove document"
              onClick={() => onFile(null)}
            >
              <X />
            </Button>
          </div>
        ) : (
          <div>
            <Label htmlFor={fileId} className="sr-only">
              PDF document
            </Label>
            <Input
              id={fileId}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => {
                onFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </div>
      {problem ? (
        <p className="text-meta text-warn">{problem}</p>
      ) : (
        <p className="flex items-center gap-1.5 text-label text-muted-foreground">
          <Paperclip aria-hidden className="size-3" />
          PDF up to 20 MB · fingerprinted and signed on this device
        </p>
      )}
    </fieldset>
  );
}

function TransitionDialog({ caseId, caseDoc, action, primary = false }) {
  const transition = useTransitionCase();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [kind, setKind] = useState('');
  const [file, setFile] = useState(null);
  const [step, setStep] = useState(null);
  const [signError, setSignError] = useState(null);

  const closing = action.action === 'CLOSE_CASE';
  const Icon = ACTION_ICON[action.action] ?? Gavel;
  const noteMissing = action.requiresNote && note.trim().length < 3;
  const busy = Boolean(step) || transition.isPending;

  const fileProblem = !file
    ? null
    : !isPdf(file)
      ? explain('CLOSURE_DOCUMENT_NOT_PDF')
      : file.size > CLOSURE_MAX_BYTES
        ? explain('CLOSURE_DOCUMENT_TOO_LARGE')
        : null;
  const kindMissing = closing && Boolean(file) && !kind;
  const blocked = busy || noteMissing || Boolean(fileProblem) || kindMissing;

  const onOpenChange = (next) => {
    if (busy && !next) return;
    setOpen(next);
    if (!next) {
      setNote('');
      setKind('');
      setFile(null);
      setStep(null);
      setSignError(null);
      transition.reset();
    }
  };

  // Awaited rather than per-call callbacks: the stage changes on success and this
  // button may unmount before the response lands.
  const onConfirm = async () => {
    if (blocked) return;
    setSignError(null);
    const trimmed = note.trim() || undefined;
    let form;

    if (closing && file) {
      let sha256;
      let signature;
      try {
        setStep('fingerprint');
        sha256 = await hashFile(file);
        setStep('sign');
        const keyPair = await getOrCreateKeyPair();
        // Same format as a vakalatnama or an FSL report: the hex digest string, signed.
        signature = await signHashHex(sha256, keyPair.privateKey);
      } catch (err) {
        setStep(null);
        setSignError({ code: 'CLOSURE_NOT_SIGNED', message: err.message });
        return;
      }
      form = new FormData();
      form.set('action', action.action);
      if (trimmed) form.set('note', trimmed);
      form.set('documentKind', kind);
      form.set('documentSha256', sha256);
      form.set('documentSignature', signature);
      form.set('document', file, file.name);
    }

    try {
      if (closing && file) setStep('close');
      const r = await transition.mutateAsync({ caseId, action: action.action, note: trimmed, form });
      toast.success(closing ? 'Case closed' : action.label, {
        description: closing
          ? r?.case?.closure?.kindLabel ?? (file ? CLOSURE_KINDS.find((k) => k.value === kind)?.label : undefined)
          : r?.workflow?.stageLabel ?? (humanise(r?.case?.stage) || undefined),
      });
      setStep(null);
      onOpenChange(false);
    } catch (err) {
      setStep(null);
      toast.error('Not recorded', { description: explain(err.code, err.message) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={primary ? 'default' : 'outline'} size={primary ? 'default' : 'sm'}>
          <Icon />
          {action.label}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>
            FIR {caseDoc.firNumber}
            {action.description ? ` · ${action.description}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`note-${action.action}`}>{action.requiresNote ? 'Reason' : 'Note (optional)'}</Label>
            <Textarea
              id={`note-${action.action}`}
              rows={3}
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {closing && (
            <ClosureAttachment
              kind={kind}
              onKind={setKind}
              file={file}
              onFile={setFile}
              disabled={busy}
              problem={fileProblem ?? (kindMissing ? 'Choose what the document is.' : null)}
            />
          )}

          {closing && file && step && <CloseProgress step={step} />}

          {signError && <Denial error={signError} heading="Document not signed" />}
          {transition.isError && <Denial error={transition.error} heading="Not recorded" />}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={closing ? 'destructive' : 'default'} disabled={blocked} onClick={onConfirm}>
            {busy ? <Loader2 className="animate-spin" /> : <Icon />}
            {closing ? 'Close case' : action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JudicialStep({ caseId, caseDoc, workflow }) {
  if (isClosed(caseDoc)) return <CaseClosure caseId={caseId} caseDoc={caseDoc} variant="plain" />;

  const courtActions = (workflow?.actions ?? []).filter((a) => a.authority === 'COURT');
  const primaryKey = workflow?.nextCourtAction?.action ?? null;
  const primary = primaryKey
    ? courtActions.find((a) => a.action === primaryKey) ?? workflow.nextCourtAction
    : null;
  const others = courtActions.filter((a) => a.action !== primaryKey);
  const available = others.filter((a) => a.ok);
  const unavailable = others.filter((a) => !a.ok);

  return (
    <div className="space-y-4">
      {primary ? (
        <TransitionDialog caseId={caseId} caseDoc={caseDoc} action={primary} primary />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral" size="default" dot>
            {workflow?.waitingOn === 'POLICE' ? 'Waiting on police' : 'No judicial step due'}
          </Badge>
          {workflow?.waitingOn === 'POLICE' && workflow.nextPoliceAction?.label && (
            <span className="text-meta text-muted-foreground">{workflow.nextPoliceAction.label}</span>
          )}
        </div>
      )}

      {(available.length > 0 || unavailable.length > 0) && (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {available.map((a) => (
            <TransitionDialog key={a.action} caseId={caseId} caseDoc={caseDoc} action={a} />
          ))}
          {unavailable.map((a) => {
            const Icon = ACTION_ICON[a.action] ?? Gavel;
            return (
              <Tooltip key={a.action}>
                <TooltipTrigger asChild>
                  {/* A disabled button fires no pointer events; the span carries the tooltip. */}
                  <span tabIndex={0} className="inline-flex rounded-md">
                    <Button size="sm" variant="outline" disabled>
                      <Icon />
                      {a.label}
                    </Button>
                  </span>
                </TooltipTrigger>
                {a.message && <TooltipContent className="max-w-xs">{a.message}</TooltipContent>}
              </Tooltip>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================== lawyers ====

function Lawyers({ caseId, closed }) {
  const representation = useRepresentation(caseId);

  const openDocument = async (filing) => {
    try {
      openBlob(await api.vakalatnama.documentBlob(filing.id), `vakalatnama-${filing.advocateAuthorityId}`);
    } catch (err) {
      toast.error('The document could not be opened', { description: err.message });
    }
  };

  if (representation.isPending) return <RowsSkeleton rows={2} />;
  if (representation.isError) {
    return (
      <div className="p-5">
        <Denial error={representation.error} heading="Lawyers not available" />
      </div>
    );
  }

  const pending = (representation.data?.filings ?? []).filter((f) => f.status === 'PENDING');
  const onRecord = representation.data?.onRecord ?? [];

  if (!pending.length && !onRecord.length) {
    return <Empty compact title="No lawyers on record" icon={UserCheck} />;
  }

  return (
    <Rows>
      {pending.map((f) => (
        <li key={f.id} className="space-y-3 bg-warn-muted/30 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[15px] font-medium leading-6 text-foreground">
                {f.advocateName ?? f.advocateAuthorityId}
              </p>
              <MetaLine
                items={[
                  <code key="id" className="font-mono">{f.advocateAuthorityId}</code>,
                  `For the ${humanise(f.appearingFor).toLowerCase()}${f.partyName ? ` (${f.partyName})` : ''}`,
                  `Filed ${fmtDate(f.filedAt)}`,
                ]}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => openDocument(f)}>
                <FileText />
                Vakalatnama
              </Button>
              <FilingStatusBadge status={f.status} />
            </div>
          </div>
          {!closed && <FilingRuling filing={f} />}
        </li>
      ))}

      {onRecord.map((g) => (
        <Row
          key={g.grantId}
          leading={<UserCheck className="size-4" />}
          title={g.name ?? g.authorityId}
          meta={
            <MetaLine
              items={[
                humanise(g.role),
                humanise(g.grantBasis),
                g.validFrom && `Since ${fmtDate(g.validFrom)}`,
              ]}
            />
          }
          badge={
            <Badge variant="success" dot>
              On record
            </Badge>
          }
        />
      ))}
    </Rows>
  );
}

function SyncRegisterButton({ caseId }) {
  const sync = useSyncRepresentation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Re-check the court register"
          disabled={sync.isPending}
          onClick={() =>
            sync.mutate(caseId, {
              onSuccess: (r) =>
                toast.success('Court register checked', {
                  description: `${r.added?.length ?? 0} added · ${r.revoked?.length ?? 0} revoked`,
                }),
              onError: (err) => toast.error('Register not read', { description: explain(err.code, err.message) }),
            })
          }
        >
          <RefreshCw className={sync.isPending ? 'animate-spin' : undefined} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Re-check the court register</TooltipContent>
    </Tooltip>
  );
}

// ========================================================== verify record ====

function VerifyRecordButton() {
  const verify = useVerifyChain();
  const r = verify.data;

  return (
    <div className="flex items-center gap-2">
      {r && (
        <Badge variant={r.intact ? 'success' : 'danger'} size="default">
          {r.intact ? <ShieldCheck /> : <ShieldX />}
          {r.intact ? 'Record intact' : `Broken at ${r.brokenAtSeq}`}
        </Badge>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={verify.isPending}
        onClick={() =>
          verify.mutate(undefined, {
            onError: (err) => toast.error('Not verified', { description: explain(err.code, err.message) }),
          })
        }
      >
        {verify.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
        Verify record
      </Button>
    </div>
  );
}

// ============================================================== the case ====

function CaseDetail({ caseId }) {
  const overview = useCaseOverview(caseId);
  const exhibitDialog = useExhibitDialog();

  if (!caseId) {
    return (
      <Panel>
        <Empty title="Select a case" icon={Scale} />
      </Panel>
    );
  }
  if (overview.isPending) {
    return (
      <Panel>
        <DetailSkeleton />
      </Panel>
    );
  }
  if (overview.isError) return <Denial error={overview.error} heading="Case not available" />;

  const c = overview.data?.case;
  if (!c) return null;

  const workflow = overview.data?.workflow ?? null;
  const closed = isClosed(c);
  const items = (overview.data?.evidence ?? []).map((e) => ({
    id: e._id,
    exhibitCode: e.exhibitCode,
    title: e.title,
    kind: e.kind,
    mimeType: e.mimeType,
    createdAt: e.createdAt,
    forensic: e.forensic,
    certificateId: e.certificate?.certificateId ?? null,
    certificateStatus: certificateStatus(e.certificate),
    label: e.label ?? null,
  }));

  return (
    <div className="space-y-6">
      <Panel>
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <MetaLine
                items={[
                  <span key="fir" className="font-medium text-foreground">FIR {c.firNumber}</span>,
                  c.cnrNumber && (
                    <span key="cnr" className="inline-flex items-center gap-1">
                      CNR <CopyableValue value={c.cnrNumber} label="Copy CNR" />
                    </span>
                  ),
                  c.courtName,
                ]}
              />
              <h2 className="text-xl font-semibold leading-snug tracking-tight text-foreground">{c.title}</h2>
              <StageBadge stage={c.stage} size="default" />
            </div>
            <VerifyRecordButton />
          </div>
          <div className="border-t pt-4">
            <CaseLifecycle stage={c.stage} workflow={workflow} compact />
          </div>
        </div>
      </Panel>

      <CaseTimeline entries={workflow?.lifecycle} />

      <Panel title={closed ? undefined : 'Next judicial step'}>
        <JudicialStep caseId={caseId} caseDoc={c} workflow={workflow} />
      </Panel>

      <Panel title="Lawyers" actions={!closed && <SyncRegisterButton caseId={caseId} />} bodyClassName="p-0">
        <Lawyers caseId={caseId} closed={closed} />
      </Panel>

      <Panel title="Evidence" bodyClassName="p-0">
        <EvidenceTable items={items} onOpen={exhibitDialog.open} caseInfo={{ firNumber: c.firNumber }} />
      </Panel>

      <ExhibitDialog
        evidenceId={exhibitDialog.evidenceId}
        onClose={exhibitDialog.close}
        caseInfo={{ firNumber: c.firNumber }}
      />
    </div>
  );
}

// ============================================================ case list ====

const needsCourt = (c) =>
  !isClosed(c) &&
  Boolean(
    c.summary?.workflow?.nextCourtAction ||
      (c.summary?.pendingFilings ?? 0) > 0 ||
      (c.summary?.attention?.court ?? 0) > 0
  );

function CaseRow({ c, selected, onSelect }) {
  const next = !isClosed(c) ? c.summary?.workflow?.nextCourtAction : null;
  const filings = !isClosed(c) ? c.summary?.pendingFilings ?? 0 : 0;
  const exhibits = c.summary?.exhibits ?? 0;

  return (
    <Row
      title={c.title ?? `FIR ${c.firNumber}`}
      meta={
        <MetaLine
          items={[
            `FIR ${c.firNumber}`,
            c.cnrNumber && (
              <span key="cnr" className="inline-flex items-center gap-1">
                CNR <CopyableValue value={c.cnrNumber} label="Copy CNR" nested />
              </span>
            ),
            c.summary?.workflow?.stageLabel ?? humanise(c.stage),
            `${exhibits} exhibit${exhibits === 1 ? '' : 's'}`,
          ]}
        />
      }
      selected={selected}
      onSelect={onSelect}
    >
      {(next || filings > 0) && (
        <span className="mt-2 flex flex-wrap gap-1.5">
          {next && (
            <Badge variant="warning" dot>
              Next: {next.label}
            </Badge>
          )}
          {filings > 0 && (
            <Badge variant="info" dot>
              Vakalatnama pending
            </Badge>
          )}
        </span>
      )}
    </Row>
  );
}

// ================================================================== page ====

export default function CourtPage() {
  const dispatch = useDispatch();
  const caseId = useSelector(selectWorkingCaseId);
  const cases = useCases();
  const listed = useMemo(() => cases.data?.cases ?? [], [cases.data]);
  const needs = useMemo(() => listed.filter(needsCourt), [listed]);
  const [chosenTab, setChosenTab] = useState(null);

  const tab = chosenTab ?? (cases.isSuccess && needs.length === 0 ? 'all' : 'needs');
  const shown = tab === 'needs' ? needs : listed;

  // Land on the first case that needs the court.
  useEffect(() => {
    if (!listed.length) return;
    if (!caseId || !listed.some((c) => String(c._id) === String(caseId))) {
      dispatch(workingCaseSet(String((needs[0] ?? listed[0])._id)));
    }
  }, [listed, needs, caseId, dispatch]);

  const select = (id) => dispatch(workingCaseSet(id));

  return (
    <Workspace title="Court">
      {cases.isError && <Denial error={cases.error} heading="Cases not available" />}

      <SplitView
        sticky
        list={
          <Panel
            title="Cases"
            bodyClassName="p-0"
            actions={
              <Tabs value={tab} onValueChange={setChosenTab}>
                <TabsList>
                  <TabsTrigger value="needs">Needs action</TabsTrigger>
                  <TabsTrigger value="all">All cases</TabsTrigger>
                </TabsList>
              </Tabs>
            }
          >
            {cases.isPending && <RowsSkeleton />}
            {cases.isSuccess && shown.length === 0 && (
              <Empty
                compact
                title={tab === 'needs' ? 'Nothing needs the court' : 'No cases listed'}
                icon={Scale}
              />
            )}
            {shown.length > 0 && (
              <Rows>
                {shown.map((c) => (
                  <CaseRow
                    key={c._id}
                    c={c}
                    selected={String(c._id) === String(caseId)}
                    onSelect={() => select(String(c._id))}
                  />
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
