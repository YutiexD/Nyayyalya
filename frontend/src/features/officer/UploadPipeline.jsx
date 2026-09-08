/**
 * The upload pipeline, with all four steps on screen.
 *
 * The visibility is the point. This system's central claim is that a file is hashed
 * and signed on the officer's own machine BEFORE a byte is sent, and that the server
 * independently recomputes both and refuses anything that disagrees. A progress bar
 * would hide exactly the part that matters, so each step reports what it produced:
 * the digest, the signature, the bytes transferred, and the server's own recomputation.
 *
 * Failure is treated the same way. If signing fails the upload is NOT attempted — an
 * unsigned exhibit would be unattributable, and sending it and sorting it out later is
 * how an evidence register becomes untrustworthy.
 */
import { useState } from 'react';
import { Check, X, Loader2, Upload, FileDigit, PenLine, ServerCog } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

import { Section, KeyValue, Hash } from '@/components/common/Primitives';
import { Denial, Note } from '@/components/common/Verdicts';
import { hashFile, signHashHex, getOrCreateKeyPair } from '@/lib/crypto';
import { useUploadEvidence } from '@/hooks/queries';
import { ApiError } from '@/lib/api';
import { fmtBytes, cn } from '@/lib/utils';

const SOURCE_TYPES = ['MOBILE', 'COMPUTER', 'DVR', 'CD_DVD', 'FLASH_DRIVE', 'SERVER', 'CLOUD', 'OTHER'];

const STEP_META = [
  { label: 'Hash in this browser', icon: FileDigit },
  { label: 'Sign in this browser', icon: PenLine },
  { label: 'Upload', icon: Upload },
  { label: 'Server verification', icon: ServerCog },
];

/** idle | running | done | failed, per step, with whatever the step produced. */
const initialSteps = () => STEP_META.map(() => ({ state: 'idle', detail: null }));

function StepRow({ index, meta, step }) {
  const Icon = meta.icon;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        className={cn(
          'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-medium',
          step.state === 'done' && 'border-ok/40 bg-ok-muted text-ok',
          step.state === 'failed' && 'border-bad/40 bg-bad-muted text-bad',
          step.state === 'running' && 'border-border bg-muted',
          step.state === 'idle' && 'border-border text-muted-foreground'
        )}
      >
        {step.state === 'done' ? (
          <Check className="size-3.5" />
        ) : step.state === 'failed' ? (
          <X className="size-3.5" />
        ) : step.state === 'running' ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          index + 1
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium">{meta.label}</span>
          {step.state === 'done' && (
            <Badge variant="outline" className="border-ok/40 bg-ok-muted text-[10px] text-ok">
              DONE
            </Badge>
          )}
          {step.state === 'failed' && (
            <Badge variant="outline" className="border-bad/40 bg-bad-muted text-[10px] text-bad">
              FAILED
            </Badge>
          )}
        </div>
        {step.detail && (
          <div className="mt-1 min-w-0">
            {/^[0-9a-f]{40,}$/i.test(step.detail) ? (
              <Hash value={step.detail} />
            ) : (
              <p className="text-xs text-muted-foreground">{step.detail}</p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function UploadPipeline({ caseId, disabled, disabledReason }) {
  const upload = useUploadEvidence();

  const [file, setFile] = useState(null);
  const [fields, setFields] = useState({
    title: '', description: '', sourceType: 'MOBILE',
    make: '', model: '', colour: '', serialNumber: '', imeiOrUid: '', capturedAt: '',
  });
  const [steps, setSteps] = useState(initialSteps);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  const set = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const mark = (i, state, detail) =>
    setSteps((s) => s.map((step, idx) => (idx === i ? { state, detail: detail ?? step.detail } : step)));

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!file || !caseId || running) return;

    setRunning(true);
    setError(null);
    setResult(null);
    setSteps(initialSteps());

    let sha256;
    let signature;

    // ---- step 1: hash, here ----
    try {
      mark(0, 'running', `reading ${fmtBytes(file.size)}`);
      sha256 = await hashFile(file);
      mark(0, 'done', sha256);
    } catch (err) {
      mark(0, 'failed', err.message);
      setError(new ApiError(0, 'HASH_FAILED', `The file could not be read: ${err.message}`));
      setRunning(false);
      return;
    }

    // ---- step 2: sign, here ----
    try {
      mark(1, 'running', 'ECDSA P-256 over the digest');
      const keyPair = await getOrCreateKeyPair();
      signature = await signHashHex(sha256, keyPair.privateKey);
      mark(1, 'done', signature);
    } catch (err) {
      mark(1, 'failed', err.message);
      // Deliberately not attempted: an unsigned exhibit cannot be attributed to
      // anyone, so sending it would put a record in the vault that nobody can stand
      // behind. Better to refuse here than to explain it in court.
      setError(
        new ApiError(
          0,
          'SIGNING_FAILED',
          `Could not sign in this browser: ${err.message}. Without a signature the upload would be unattributable, so it has not been sent.`
        )
      );
      setRunning(false);
      return;
    }

    // ---- step 3: send ----
    const form = new FormData();
    form.set('file', file);
    form.set('caseId', String(caseId));
    form.set('title', fields.title.trim());
    if (fields.description.trim()) form.set('description', fields.description.trim());
    form.set('sha256Client', sha256);
    form.set('signature', signature);
    form.set('sourceType', fields.sourceType);
    for (const key of ['make', 'model', 'colour', 'serialNumber', 'imeiOrUid']) {
      if (fields[key].trim()) form.set(key, fields[key].trim());
    }
    if (fields.capturedAt) form.set('capturedAt', new Date(fields.capturedAt).toISOString());

    try {
      mark(2, 'running', `sending ${fmtBytes(file.size)}`);
      const data = await upload.mutateAsync(form);
      mark(2, 'done', `${fmtBytes(file.size)} transferred`);
      mark(3, 'done', 'digest recomputed and matched; signature verified');
      setResult(data);
    } catch (err) {
      mark(2, 'failed', err.code ?? 'failed');
      mark(3, 'failed', 'refused');
      setError(err);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Section
      title="Upload an exhibit"
      description="Four steps, all of them visible. The file is hashed and signed on this machine before it is sent; the server recomputes both and refuses anything that does not agree — and records the refusal."
    >
      {disabled ? (
        <Note tone="warn">{disabledReason}</Note>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="file">File</Label>
            <Input
              id="file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Hashed in this browser before it is sent. Nothing is uploaded first and checked later.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={fields.title} onChange={set('title')} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sourceType">Source type</Label>
              <Select
                value={fields.sourceType}
                onValueChange={(v) => setFields((f) => ({ ...f, sourceType: v }))}
              >
                <SelectTrigger id="sourceType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" rows={2} value={fields.description} onChange={set('description')} />
          </div>

          <Separator />
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            BSA s.63 Schedule, Part A — the device this came from
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ['make', 'Make'],
              ['model', 'Model'],
              ['colour', 'Colour'],
              ['serialNumber', 'Serial number'],
              ['imeiOrUid', 'IMEI / UID'],
            ].map(([key, label]) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={key}>{label}</Label>
                <Input id={key} value={fields[key]} onChange={set(key)} />
              </div>
            ))}
            <div className="space-y-2">
              <Label htmlFor="capturedAt">Captured at</Label>
              <Input
                id="capturedAt"
                type="datetime-local"
                value={fields.capturedAt}
                onChange={set('capturedAt')}
              />
            </div>
          </div>

          <Button type="submit" disabled={running || !file || !caseId || !fields.title.trim()}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {running ? 'Working…' : 'Hash, sign and upload'}
          </Button>
        </form>
      )}

      {steps.some((s) => s.state !== 'idle') && (
        <>
          <Separator />
          <ol className="divide-y">
            {STEP_META.map((meta, i) => (
              <StepRow key={meta.label} index={i} meta={meta} step={steps[i]} />
            ))}
          </ol>
        </>
      )}

      {error && <Denial error={error} heading="Upload refused" />}

      {result?.evidence && (
        <div className="space-y-3 rounded-md border border-ok/40 bg-ok-muted p-4">
          <p className="text-sm font-semibold text-ok">Server verification</p>
          <KeyValue
            rows={[
              ['Exhibit code', <span key="c" className="font-mono">{result.evidence.exhibitCode}</span>],
              ['Hash (client, in browser)', <Hash key="h1" value={result.evidence.sha256Client} />],
              ['Hash (server, recomputed)', <Hash key="h2" value={result.evidence.sha256Server} />],
              ['Size', fmtBytes(result.evidence.sizeBytes)],
              // From the receipt: it is the officer's own independent copy of what was
              // submitted, and it carries the chain facts the ledger recorded.
              ['Ledger sequence', result.receipt?.ledgerSeq ?? result.evidence.ledgerSeq ?? '—'],
              ['Ledger entry hash', <Hash key="e" value={result.receipt?.entryHash} />],
            ]}
          />
          <p className="text-xs text-muted-foreground">
            The two digests are computed independently — one here, one from the bytes the server
            actually received. They match, so what was stored is what was hashed and signed.
          </p>
        </div>
      )}
    </Section>
  );
}
