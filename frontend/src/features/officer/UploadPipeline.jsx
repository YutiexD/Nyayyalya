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
import {
  Check, X, Loader2, Upload, FileDigit, PenLine, ServerCog, ShieldCheck, FileDown, ExternalLink,
} from 'lucide-react';

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
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';

import { Facts as KeyValue, Digest as Hash } from '@/components/common/Shell';
import { Denial, Note, PriorityBadge, PriorityReasons } from '@/components/common/Verdicts';
import { hashFile, signHashHex, getOrCreateKeyPair } from '@/lib/crypto';
import { useUploadEvidence } from '@/hooks/queries';
import { ApiError } from '@/lib/api';
import { saveBlob } from '@/lib/download';
import { fmtBytes, cn, humanise } from '@/lib/utils';

const SOURCE_TYPES = ['MOBILE', 'COMPUTER', 'DVR', 'CD_DVD', 'FLASH_DRIVE', 'SERVER', 'CLOUD', 'OTHER'];

const STEP_META = [
  { label: 'Hash in this browser', icon: FileDigit },
  { label: 'Sign in this browser', icon: PenLine },
  { label: 'Upload', icon: Upload },
  { label: 'Server verification', icon: ServerCog },
];

/** idle | running | done | failed, per step, with whatever the step produced. */
const initialSteps = () => STEP_META.map(() => ({ state: 'idle', detail: null }));

/** A digest or a signature. Long hex is data and gets a block of its own, not a sentence. */
const isHex = (s) => typeof s === 'string' && /^[0-9a-f]{40,}$/i.test(s);

function StepRow({ index, meta, step }) {
  const Icon = meta.icon;
  const running = step.state === 'running';
  return (
    <li
      aria-current={running ? 'step' : undefined}
      className={cn(
        'surface relative flex items-start gap-3 p-3',
        running && 'glow border-accent-from/40',
        step.state === 'failed' && 'border-bad/40'
      )}
    >
      <span
        className={cn(
          'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border text-[11px] font-semibold tabular-nums',
          step.state === 'done' && 'border-ok/40 bg-ok-muted text-ok',
          step.state === 'failed' && 'border-bad/40 bg-bad-muted text-bad',
          running && 'border-accent-from/40 bg-accent-gradient-soft text-accent-from',
          step.state === 'idle' && 'border-border text-muted-foreground'
        )}
      >
        {step.state === 'done' ? (
          <Check className="size-3.5" />
        ) : step.state === 'failed' ? (
          <X className="size-3.5" />
        ) : running ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          index + 1
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className={cn('size-3.5', running ? 'text-accent-from' : 'text-muted-foreground')} />
          <span className="text-sm font-medium">{meta.label}</span>
          {running && (
            <Badge
              variant="outline"
              className="rounded-full border-accent-from/40 bg-accent-gradient-soft text-[10px] text-accent-from"
            >
              WORKING
            </Badge>
          )}
          {step.state === 'done' && (
            <Badge variant="outline" className="rounded-full border-ok/40 bg-ok-muted text-[10px] text-ok">
              DONE
            </Badge>
          )}
          {step.state === 'failed' && (
            <Badge variant="outline" className="rounded-full border-bad/40 bg-bad-muted text-[10px] text-bad">
              FAILED
            </Badge>
          )}
        </div>
        {step.detail &&
          (isHex(step.detail) ? (
            <Hash value={step.detail} />
          ) : (
            <p className="text-xs text-muted-foreground">{step.detail}</p>
          ))}
      </div>
    </li>
  );
}

/**
 * Source types that describe a physical article — the same list the certificate
 * generator uses. For these, BSA s.63 Part A needs make, model and colour; for every
 * source it needs a serial number or an IMEI/UID. Nothing can add them to an exhibit
 * after upload, so a certificate refused for want of them could never be issued.
 */
const PHYSICAL_SOURCES = new Set(['MOBILE', 'COMPUTER', 'DVR', 'CD_DVD', 'FLASH_DRIVE', 'SERVER']);

function missingParticulars(fields) {
  const missing = [];
  if (PHYSICAL_SOURCES.has(fields.sourceType)) {
    for (const [key, label] of [['make', 'make'], ['model', 'model'], ['colour', 'colour']]) {
      if (!fields[key].trim()) missing.push(label);
    }
  }
  if (!fields.serialNumber.trim() && !fields.imeiOrUid.trim()) missing.push('serial number or IMEI/UID');
  return missing;
}

/** The officer's own copy of what they submitted, as a file they keep. */
function saveReceipt(receipt) {
  if (!receipt) return;
  const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
  saveBlob(blob, `receipt-${receipt.exhibitCode ?? 'exhibit'}.json`);
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
  const [noCertificate, setNoCertificate] = useState(false);

  const missing = missingParticulars(fields);
  const particularsOk = missing.length === 0 || noCertificate;

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
      // The receipt is the officer's independent proof of what they handed over. The
      // screens always said it was downloaded at upload; now it is.
      saveReceipt(data.receipt);
    } catch (err) {
      mark(2, 'failed', err.code ?? 'failed');
      mark(3, 'failed', 'refused');
      setError(err);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      {disabled ? (
        <Note tone="warn">{disabledReason}</Note>
      ) : (
        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="file">File</Label>
            <Input
              id="file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
              className="cursor-pointer"
            />
            {file && (
              <p className="flex min-w-0 items-center gap-2 text-xs">
                <FileDigit className="size-3.5 shrink-0 text-accent-from" />
                <span className="truncate font-medium">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{fmtBytes(file.size)}</span>
              </p>
            )}
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
                      {humanise(t)}
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

          <div className="flex items-center gap-3 pt-1">
            <p className="shrink-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              BSA s.63 Schedule, Part A — the device this came from
            </p>
            <Separator className="flex-1" />
          </div>

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

          {missing.length > 0 && (
            <div className="space-y-2 rounded-md border border-warn/40 bg-warn-muted/40 p-3">
              <p className="text-xs leading-relaxed">
                A section 63 certificate for this exhibit needs the device&rsquo;s{' '}
                <span className="font-medium">{missing.join(', ')}</span>. These cannot be added after
                upload, so without them no certificate can ever be issued for it.
              </p>
              <label htmlFor="no-certificate" className="flex items-center gap-2 text-xs">
                <Checkbox
                  id="no-certificate"
                  checked={noCertificate}
                  onCheckedChange={(v) => setNoCertificate(v === true)}
                />
                The particulars are not available — upload without a certificate
              </label>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button type="submit" disabled={running || !file || !caseId || !fields.title.trim() || !particularsOk}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {running ? 'Working…' : 'Hash, sign and upload'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Nothing leaves this machine until the digest and the signature both exist.
            </p>
          </div>
        </form>
      )}

      {steps.some((s) => s.state !== 'idle') && (
        <ol className="grid gap-2 rounded-xl bg-muted/40 p-2">
          {STEP_META.map((meta, i) => (
            <StepRow key={meta.label} index={i} meta={meta} step={steps[i]} />
          ))}
        </ol>
      )}

      {error && <Denial error={error} heading="Upload refused" />}

      {result?.evidence && (
        <div className="border-gradient space-y-4 rounded-xl p-5 shadow-elev-1">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ok-muted text-ok">
              <ShieldCheck className="size-4" />
            </span>
            <div className="space-y-0.5">
              <p className="text-sm font-semibold">Server verification</p>
              <p className="text-xs text-muted-foreground">
                Digest recomputed from the bytes the server received; signature checked against
                the key on record for this account.
              </p>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="min-w-0 rounded-md bg-muted/60 p-3">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Hash (client, in browser)
              </p>
              <Hash value={result.evidence.sha256Client} block={false} />
            </div>
            <div className="min-w-0 rounded-md bg-muted/60 p-3">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Hash (server, recomputed)
              </p>
              <Hash value={result.evidence.sha256Server} block={false} />
            </div>
          </div>

          <KeyValue
            rows={[
              ['Exhibit code', <code key="c" className="font-mono text-xs">{result.evidence.exhibitCode}</code>],
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

          {result.evidence.triage?.priority && (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="label-xs">Review priority, assigned automatically</span>
                <PriorityBadge
                  priority={result.evidence.triage.priority}
                  disclaimer={result.evidence.triage.disclaimer}
                />
              </div>
              <PriorityReasons triage={result.evidence.triage} limit={3} />
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Computed by the system the moment this exhibit was registered, from its own
                metadata, the integrity of this upload, its media type and the gravity of the
                case. You were not asked for it and cannot change it — which is what makes the
                laboratory&rsquo;s queue worth ordering by.
              </p>
            </div>
          )}
          {result.receipt && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => saveReceipt(result.receipt)}>
                <FileDown className="size-3.5" /> Download the receipt again
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a
                  href={`/verify?seq=${result.receipt.ledgerSeq}&entry=${result.receipt.entryHash}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <ExternalLink className="size-3.5" /> Check it on the public verifier
                </a>
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                The receipt was saved to your downloads. It is your own copy of what you handed
                over: anyone can check it against the register — and the anchored root — without an
                account.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
