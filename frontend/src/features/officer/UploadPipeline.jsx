/**
 * Upload evidence.
 *
 * File, title and an optional description. The file is fingerprinted (SHA-256) and
 * signed with this browser's key before a byte is sent; the server recomputes both,
 * stores the exhibit and issues its s.63 certificate in the same request. If signing
 * fails nothing is sent — an unsigned exhibit would be unattributable.
 *
 *   UploadEvidenceDialog   the "Upload evidence" button and its dialog
 *   UploadEvidenceForm     the form alone, for embedding
 *   UploadPipeline         deprecated alias of the form
 */
import { useId, useState } from 'react';
import { Check, CheckCircle2, Loader2, Upload, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

import { Denial, Note } from '@/components/common/Verdicts';
import { QrCode } from '@/components/common/QrCode';
import { PrintQrLabelButton, labelUrlOf } from '@/features/evidence/QrLabel';
import { useUploadEvidence } from '@/hooks/queries';
import { ApiError } from '@/lib/api';
import { getOrCreateKeyPair, hashFile, signHashHex } from '@/lib/crypto';
import { cn, fmtBytes } from '@/lib/utils';

const STEPS = ['Fingerprint', 'Upload', 'Certificate issued'];

/** idle | running | done | failed | pending, per step. */
const idleSteps = () => STEPS.map(() => 'idle');

const titleFromName = (name) =>
  name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

const certificateIssued = (cert) =>
  Boolean(cert) && (cert.state === 'ISSUED' || (!cert.state && ['ACTIVE', 'ISSUED'].includes(cert.status)));

function StepStatus({ steps }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-meta" aria-label="Upload progress">
      {STEPS.map((label, i) => {
        const s = steps[i];
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && (
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
            )}
            <span
              className={cn(
                'inline-flex items-center gap-1.5',
                s === 'idle' ? 'text-muted-foreground' : 'text-foreground',
                s === 'failed' && 'text-bad',
                s === 'pending' && 'text-warn'
              )}
            >
              {s === 'running' ? (
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
              ) : s === 'done' ? (
                <Check aria-hidden className="size-3.5 text-ok" />
              ) : s === 'failed' ? (
                <X aria-hidden className="size-3.5" />
              ) : (
                <span aria-hidden className={cn('size-1.5 rounded-full', s === 'pending' ? 'bg-warn' : 'bg-border')} />
              )}
              {i === 2 && s === 'pending' ? 'Certificate pending' : label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * @param {object} props
 * @param {string} props.caseId
 * @param {() => void} [props.onDone]                 shows a Done button after success
 * @param {(running: boolean) => void} [props.onRunningChange]
 * @param {{ firNumber?: string }} [props.caseInfo]  printed on the QR label
 */
export function UploadEvidenceForm({ caseId, onDone, onRunningChange, caseInfo }) {
  const upload = useUploadEvidence();
  const fileInputId = useId();
  const titleId = useId();
  const descriptionId = useId();

  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [autoTitle, setAutoTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dragging, setDragging] = useState(false);
  const [steps, setSteps] = useState(idleSteps);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const setBusy = (value) => {
    setRunning(value);
    onRunningChange?.(value);
  };
  const mark = (i, state) => setSteps((s) => s.map((x, idx) => (idx === i ? state : x)));

  const choose = (next) => {
    if (!next || running) return;
    const suggested = titleFromName(next.name);
    setFile(next);
    setTitle((t) => (!t.trim() || t === autoTitle ? suggested : t));
    setAutoTitle(suggested);
    setError(null);
    setSteps(idleSteps());
  };

  const reset = () => {
    setFile(null);
    setTitle('');
    setAutoTitle('');
    setDescription('');
    setSteps(idleSteps());
    setError(null);
    setResult(null);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!file || !caseId || !title.trim() || running) return;

    setBusy(true);
    setError(null);
    setResult(null);
    setSteps(idleSteps());

    // ---- fingerprint and sign, here ----
    let sha256;
    let signature;
    mark(0, 'running');
    try {
      sha256 = await hashFile(file);
    } catch (err) {
      mark(0, 'failed');
      setError(new ApiError(0, 'HASH_FAILED', err.message));
      setBusy(false);
      return;
    }
    try {
      const keyPair = await getOrCreateKeyPair();
      signature = await signHashHex(sha256, keyPair.privateKey);
      mark(0, 'done');
    } catch (err) {
      // Deliberately not sent: an unsigned exhibit cannot be attributed to anyone.
      mark(0, 'failed');
      setError(new ApiError(0, 'SIGNING_FAILED', err.message));
      setBusy(false);
      return;
    }

    // ---- send ----
    const form = new FormData();
    form.set('file', file);
    form.set('caseId', String(caseId));
    form.set('title', title.trim());
    if (description.trim()) form.set('description', description.trim());
    form.set('sha256Client', sha256);
    form.set('signature', signature);

    mark(1, 'running');
    try {
      const data = await upload.mutateAsync(form);
      mark(1, 'done');
      mark(2, certificateIssued(data?.certificate) ? 'done' : 'pending');
      setResult(data);
    } catch (err) {
      mark(1, 'failed');
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (result?.evidence) {
    const issued = certificateIssued(result.certificate);
    const exhibit = result.evidence;
    const labelUrl = labelUrlOf(exhibit);
    return (
      <div className="space-y-4">
        <StepStatus steps={steps} />
        <div className="flex items-center justify-between gap-4 rounded-lg border border-ok/25 bg-ok-muted px-4 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-ok" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Evidence uploaded</p>
              <p className="text-meta text-muted-foreground">
                <code className="font-mono text-foreground">{exhibit.exhibitCode}</code>
                {' · '}
                {issued ? 'Certificate issued' : 'Certificate pending'}
              </p>
              {labelUrl && <p className="mt-1 text-label text-muted-foreground">Scan to verify</p>}
            </div>
          </div>
          {labelUrl && (
            <QrCode
              value={labelUrl}
              size={84}
              alt={`QR label for ${exhibit.exhibitCode ?? 'this exhibit'}`}
              className="border"
            />
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={reset}>
            Upload another
          </Button>
          {onDone && (
            <Button variant={labelUrl ? 'outline' : 'default'} onClick={onDone}>
              Done
            </Button>
          )}
          <PrintQrLabelButton exhibit={exhibit} caseInfo={caseInfo} variant="default" size="default" />
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label
        htmlFor={fileInputId}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files?.[0] ?? null);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center transition-colors hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring',
          dragging && 'border-primary bg-primary/5',
          running && 'pointer-events-none opacity-60'
        )}
      >
        <Upload aria-hidden className="size-5 text-muted-foreground" />
        {file ? (
          <>
            <span className="max-w-full truncate text-sm font-medium text-foreground">{file.name}</span>
            <span className="text-meta text-muted-foreground">{fmtBytes(file.size)} · Click to change</span>
          </>
        ) : (
          <span className="text-sm font-medium text-foreground">Drop a file or click to choose</span>
        )}
        <input
          id={fileInputId}
          type="file"
          className="sr-only"
          disabled={running}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
      </label>

      <div className="space-y-1.5">
        <Label htmlFor={titleId}>Title</Label>
        <Input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} disabled={running} required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={descriptionId}>
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={descriptionId}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={running}
        />
      </div>

      {error && <Denial error={error} heading="Upload failed" />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {steps.some((s) => s !== 'idle') ? <StepStatus steps={steps} /> : <span />}
        <Button type="submit" disabled={running || !file || !caseId || !title.trim()}>
          {running ? <Loader2 className="animate-spin" /> : <Upload />}
          {running ? 'Uploading…' : 'Upload'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The "Upload evidence" button and dialog. The dialog cannot be dismissed mid-upload,
 * and reopening it starts a fresh form.
 *
 * @param {object} props
 * @param {string} props.caseId
 * @param {boolean} [props.disabled]
 * @param {React.ReactNode} [props.trigger]  replaces the default button
 * @param {{ firNumber?: string }} [props.caseInfo]  printed on the QR label
 */
export function UploadEvidenceDialog({ caseId, disabled = false, trigger, caseInfo }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [formKey, setFormKey] = useState(0);

  const onOpenChange = (next) => {
    if (running) return;
    if (next) setFormKey((k) => k + 1);
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" disabled={disabled || !caseId}>
            <Upload />
            Upload evidence
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload evidence</DialogTitle>
          <DialogDescription className="sr-only">Choose a file and give it a title.</DialogDescription>
        </DialogHeader>
        <UploadEvidenceForm
          key={formKey}
          caseId={caseId}
          caseInfo={caseInfo}
          onRunningChange={setRunning}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/** @deprecated Use `UploadEvidenceDialog` or `UploadEvidenceForm`. */
export function UploadPipeline({ caseId, disabled, disabledReason }) {
  if (disabled) return <Note tone="warn">{disabledReason}</Note>;
  return <UploadEvidenceForm caseId={caseId} />;
}
