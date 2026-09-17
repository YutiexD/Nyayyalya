/**
 * The public verifier. No session and no account.
 *
 * Two ways in, one result:
 *   `?token=`  a certificate link or QR  -> GET /public/verify/:token
 *   `?label=`  a printed exhibit label   -> GET /public/evidence/:labelToken
 * Either runs immediately. Without one, the page offers one input (certificate link,
 * label link or a raw code) or a PDF drop. Upload receipts (`?seq=&entry=`) and the
 * anchoring record are secondary, collapsed.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  Check, ChevronDown, ExternalLink, Loader2, ShieldAlert, ShieldCheck, ShieldX, Upload, X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Workspace, Disclosure, Facts, Rows, MetaLine, Empty, Digest } from '@/components/common/Shell';
import { Denial } from '@/components/common/Verdicts';
import { CopyableValue } from '@/components/common/CopyButton';
import { LifecycleTimeline, hasLifecycle } from '@/components/common/LifecycleTimeline';
import { CertificateStatusBadge } from '@/features/certificates/CertificatePanel';
import { useLatestAnchor, useRecentAnchors } from '@/hooks/queries';
import { ROLE_LABEL, api } from '@/lib/api';
import { cn, fmtBytes, fmtDate, humanise } from '@/lib/utils';

// ------------------------------------------------------------------ input ----

const TOKEN_IN_PATH = /\/public\/verify\/([A-Za-z0-9_-]{16,})/;
const TOKEN_IN_QUERY = /[?&]token=([A-Za-z0-9_-]{16,})/;
const LABEL_IN_PATH = /\/public\/evidence\/([A-Za-z0-9_-]{8,})/;
const LABEL_IN_QUERY = /[?&]label=([A-Za-z0-9_-]{8,})/;
const TOKEN_IN_PDF = /lexx-verify:([A-Za-z0-9_-]{43})/;

/**
 * A certificate link, a label link, or a bare code. A bare code is `auto`: tried as a
 * certificate first, then as a label.
 * @returns {{ kind: 'certificate'|'label'|'auto', token: string } | null}
 */
function parseInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const patterns = [
    [LABEL_IN_QUERY, 'label'],
    [LABEL_IN_PATH, 'label'],
    [TOKEN_IN_PATH, 'certificate'],
    [TOKEN_IN_QUERY, 'certificate'],
  ];
  for (const [re, kind] of patterns) {
    const m = re.exec(text);
    if (m) return { kind, token: m[1] };
  }
  return /^[A-Za-z0-9_-]{10,}$/.test(text) ? { kind: 'auto', token: text } : null;
}

/** Hash a PDF in the browser and read the token from its metadata. Only the digest is sent. */
async function readCertificateFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const text = new TextDecoder('latin1').decode(bytes);
  const token = TOKEN_IN_PDF.exec(text)?.[1] ?? TOKEN_IN_QUERY.exec(text)?.[1] ?? null;
  return { sha256, token, isPdf: text.startsWith('%PDF-'), name: file.name };
}

async function runCheck({ kind, token, copy }) {
  if (kind === 'label') return api.publicEvidenceByLabel(token);
  try {
    return await api.publicVerifyCertificate(token, copy);
  } catch (err) {
    if (kind === 'auto' && err?.status === 404) return api.publicEvidenceByLabel(token);
    throw err;
  }
}

/** How often a shown result is quietly re-checked. */
// Each re-check re-hashes the evidence server-side and counts against the public rate limit.
const REFRESH_MS = 60_000;

const NOT_FOUND_TEXT = {
  certificate: 'No certificate matches this link or code.',
  label: 'No exhibit matches this label.',
  auto: 'Nothing matches this link or code.',
};

const COPY_MATCH = {
  CURRENT: { label: 'Matches the issued certificate', variant: 'success' },
  EARLIER_VERSION: { label: 'Earlier version', variant: 'warning' },
  NO_MATCH: { label: 'Does not match', variant: 'danger' },
};

// ------------------------------------------------------------ formatting ----

const OUTCOME = {
  VERIFIED: { title: 'Verified', Icon: ShieldCheck, box: 'border-ok/30', band: 'bg-ok-muted', text: 'text-ok' },
  FAILED: { title: 'Failed', Icon: ShieldX, box: 'border-bad/30', band: 'bg-bad-muted', text: 'text-bad' },
  NO_CERTIFICATE: {
    title: 'No certificate', Icon: ShieldAlert, box: 'border-warn/30', band: 'bg-warn-muted', text: 'text-warn',
  },
};

const FACT_GRID = 'grid-cols-[8.5rem_minmax(0,1fr)] sm:grid-cols-[11rem_minmax(0,1fr)]';

const shortDay = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const mono = (value) => (value ? <span className="font-mono">{value}</span> : null);

const roleText = (role, roleLabel) =>
  roleLabel || (typeof ROLE_LABEL[role] === 'string' ? ROLE_LABEL[role] : humanise(role)) || null;

/** A MIME type reads as "Image", "Video"…; anything else is shown as sent. */
function fileTypeText(value) {
  const m = String(value ?? '').toLowerCase();
  if (!m) return null;
  if (!m.includes('/')) return value;
  if (m.startsWith('image/')) return 'Image';
  if (m.startsWith('video/')) return 'Video';
  if (m.startsWith('audio/')) return 'Audio';
  if (m === 'application/pdf') return 'PDF';
  return value;
}

// ----------------------------------------------------------------- result ----

function ResultHeader({ outcome, subtitle }) {
  const { Icon } = outcome;
  return (
    <section role="status" className={cn('overflow-hidden rounded-xl border bg-card', outcome.box)}>
      <div className={cn('flex items-center gap-4 px-5 py-5', outcome.band)}>
        <Icon aria-hidden className={cn('size-9 shrink-0', outcome.text)} />
        <div className="min-w-0">
          <p className={cn('text-title', outcome.text)}>{outcome.title}</p>
          {subtitle && <p className="text-meta text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
    </section>
  );
}

function Group({ title, children }) {
  return (
    <section className="space-y-3 px-5 py-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Collapsible({ label, aside, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-5 py-3 text-left text-meta text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="font-medium text-foreground">{label}</span>
        <span className="flex items-center gap-1.5">
          {aside}
          <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && <div className="px-5 pb-4">{children}</div>}
    </div>
  );
}

function ChecksList({ checks }) {
  const passed = checks.filter((c) => c.ok).length;
  return (
    <Collapsible label="Checks" aside={`${passed}/${checks.length} passed`}>
      <ul className="space-y-2">
        {checks.map((ch, i) => (
          <li key={ch.key ?? i} className="flex items-start gap-2">
            {ch.ok ? (
              <Check aria-label="Passed" className="mt-0.5 size-4 shrink-0 text-ok" />
            ) : (
              <X aria-label="Failed" className="mt-0.5 size-4 shrink-0 text-bad" />
            )}
            <span className="min-w-0">
              <span className="block text-meta text-foreground">{ch.label ?? humanise(ch.key)}</span>
              {ch.detail && (
                <span className="block break-words text-label text-muted-foreground">{String(ch.detail)}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Collapsible>
  );
}

function VerificationResult({ data, copyFile }) {
  const ev = data.evidence ?? {};
  // The certificate endpoint's older payload kept exhibit and case numbers on `certificate`.
  const cert = data.certificate ?? null;
  const kase = data.case ?? {};
  const by = data.uploadedBy ?? null;
  const forensic = data.forensic ?? null;
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const lifecycle = Array.isArray(data.lifecycle) ? data.lifecycle : [];

  const resultCode = data.result ?? (data.valid ? 'VERIFIED' : 'FAILED');
  const outcome = OUTCOME[resultCode] ?? OUTCOME.FAILED;
  const exhibitCode = ev.exhibitCode ?? cert?.exhibitCode ?? null;
  const copy = data.copy ? COPY_MATCH[data.copy.match] : null;

  const hasCertificate = resultCode !== 'NO_CERTIFICATE' && Boolean(cert && (cert.certificateId || cert.status));
  const signedBy =
    cert?.signedBy ?? (typeof data.issuer === 'string' ? data.issuer : data.issuer?.name) ?? null;
  const last = cert?.lastVerification ?? null;

  const source = ev.source
    ? [
        [ev.source.make, ev.source.model].filter(Boolean).join(' '),
        ev.source.sourceType && humanise(ev.source.sourceType),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const station =
    kase.stationName && kase.stationCode
      ? `${kase.stationName} (${kase.stationCode})`
      : kase.stationName ?? kase.stationCode ?? null;
  const caseRows = [
    ['FIR', mono(kase.firNumber ?? cert?.firNumber)],
    [
      'CNR',
      (kase.cnrNumber ?? cert?.cnrNumber) && (
        <CopyableValue key="cnr" value={kase.cnrNumber ?? cert?.cnrNumber} label="Copy CNR" />
      ),
    ],
    station && ['Police station', station],
    kase.courtName && ['Court', kase.courtName],
    (kase.stageLabel || kase.stage) && ['Current stage', kase.stageLabel || humanise(kase.stage)],
  ];

  const technical = [
    ev.sha256 && [`${ev.hashAlgorithm ?? 'SHA-256'}`, <Digest key="h" value={ev.sha256} />],
    cert?.certificateId && ['Certificate ID', mono(cert.certificateId)],
    cert?.pdfSha256 && ['Certificate PDF', <Digest key="p" value={cert.pdfSha256} />],
    cert?.authorityKeyFingerprint && ['Signing key', <Digest key="k" value={cert.authorityKeyFingerprint} />],
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <ResultHeader
        outcome={outcome}
        subtitle={[exhibitCode, data.verifiedAt && `checked ${fmtDate(data.verifiedAt)}`].filter(Boolean).join(' · ')}
      />

      <div className="surface divide-y overflow-hidden">
        <Group title="Evidence">
          <Facts
            className={FACT_GRID}
            rows={[
              ['Exhibit', mono(exhibitCode)],
              [
                'Title',
                ev.titleWithheld ? (
                  <span className="font-normal text-muted-foreground">Withheld (protected case)</span>
                ) : (
                  ev.title ?? null
                ),
              ],
              ev.fileType && ['File type', fileTypeText(ev.fileType)],
              Number.isFinite(ev.sizeBytes) && ['Size', fmtBytes(ev.sizeBytes)],
              ev.registeredAt && ['Registered', fmtDate(ev.registeredAt)],
              ev.capturedAt && ['Captured', fmtDate(ev.capturedAt)],
              source && ['Source device', source],
            ]}
          />
        </Group>

        {by && (
          <Group title="Uploaded by">
            <Facts
              className={FACT_GRID}
              rows={[
                ['Name', by.name ?? null],
                (by.roleLabel || by.role) && ['Role', roleText(by.role, by.roleLabel)],
                by.authorityId && ['Authority ID', mono(by.authorityId)],
                by.unit && ['Unit', by.unit],
              ]}
            />
          </Group>
        )}

        {caseRows.some((r) => r && r[1]) && (
          <Group title="Case">
            <Facts className={FACT_GRID} rows={caseRows} />
          </Group>
        )}

        <Group title="Section 63 certificate">
          {hasCertificate ? (
            <Facts
              className={FACT_GRID}
              rows={[
                ['Status', <CertificateStatusBadge key="s" status={cert.status} />],
                ['Issued', fmtDate(cert.issuedAt ?? cert.generatedAt)],
                ['Signed by', signedBy],
                last?.result && [
                  'Last verified',
                  <span key="l" className="inline-flex flex-wrap items-center gap-2">
                    <Badge variant={last.result === 'VERIFIED' ? 'success' : 'danger'} size="sm" dot>
                      {last.result === 'VERIFIED' ? 'Verified' : humanise(last.result)}
                    </Badge>
                    <span className="text-meta font-normal text-muted-foreground">
                      {[fmtDate(last.at), last.byRole && `by ${roleText(last.byRole)}`].filter(Boolean).join(' ')}
                    </span>
                  </span>,
                ],
                copy && [
                  'Your PDF',
                  <Badge key="p" variant={copy.variant} size="sm" dot title={copyFile?.name}>
                    {copy.label}
                  </Badge>,
                ],
              ]}
            />
          ) : (
            <Badge variant="warning" size="sm" dot>
              Not issued
            </Badge>
          )}
        </Group>

        {forensic && (
          <Group title="Forensic examination">
            <p className={cn('text-sm', forensic.status === 'EXAMINED' ? 'text-foreground' : 'text-muted-foreground')}>
              {forensic.status === 'EXAMINED'
                ? [
                    'Examined',
                    shortDay(forensic.examinedAt) && `on ${shortDay(forensic.examinedAt)}`,
                    forensic.labName && `by ${forensic.labName}`,
                  ]
                    .filter(Boolean)
                    .join(' ')
                : 'Not yet examined'}
            </p>
          </Group>
        )}

        {hasLifecycle(lifecycle) && (
          <Group title="Lifecycle">
            <LifecycleTimeline entries={lifecycle} />
          </Group>
        )}

        {checks.length > 0 && <ChecksList checks={checks} />}

        {technical.length > 0 && (
          <Collapsible label="Technical details">
            <Facts dense className={FACT_GRID} rows={technical} />
          </Collapsible>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ check ----

function EvidenceCheck() {
  const [searchParams] = useSearchParams();
  const urlToken = searchParams.get('token');
  const urlLabel = searchParams.get('label');

  const [raw, setRaw] = useState('');
  const [problem, setProblem] = useState(null);
  const [copyFile, setCopyFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const autoVerified = useRef(null);
  const fileInput = useRef(null);

  const check = useMutation({ mutationFn: runCheck });

  // While a result is on screen, re-run the same check quietly every 20 s (only while the
  // tab is visible) so a certificate issued, verified or superseded elsewhere shows up.
  // The last good result stays on screen if a refresh fails.
  const [fresh, setFresh] = useState(null);
  useEffect(() => {
    const vars = check.isSuccess ? check.variables : null;
    if (!vars) return undefined;
    let cancelled = false;
    let last = Date.now();
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      last = Date.now();
      try {
        const data = await runCheck(vars);
        if (!cancelled) setFresh({ vars, data });
      } catch {
        /* keep showing the last result */
      }
    };
    const timer = setInterval(refresh, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= REFRESH_MS) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check.isSuccess, check.variables]);
  const result = fresh && fresh.vars === check.variables ? fresh.data : check.data;

  const run = (parsed, copy) => {
    if (!parsed) {
      setProblem('Enter a certificate or label link, or a code.');
      check.reset();
      return;
    }
    setProblem(null);
    check.mutate({ ...parsed, copy });
  };

  const takeFile = async (file) => {
    if (!file) return;
    setProblem(null);
    let read;
    try {
      read = await readCertificateFile(file);
    } catch {
      setProblem('That file could not be read.');
      return;
    }
    if (!read.isPdf) {
      setCopyFile(null);
      setProblem('Choose a certificate PDF.');
      return;
    }
    setCopyFile(read);
    const typed = parseInput(raw);
    const token = read.token ?? (typed && typed.kind !== 'label' ? typed.token : null);
    if (!token) {
      setProblem('No verification code found in this PDF. Paste the certificate link as well.');
      check.reset();
      return;
    }
    if (read.token) setRaw(read.token);
    run({ kind: 'certificate', token }, read.sha256);
  };

  // Opening a certificate link or scanning a label is the click: verify straight away.
  useEffect(() => {
    const parsed = urlLabel
      ? { kind: 'label', token: urlLabel }
      : urlToken
        ? { kind: 'certificate', token: urlToken }
        : null;
    if (!parsed) return;
    const key = `${parsed.kind}:${parsed.token}`;
    if (autoVerified.current === key) return;
    autoVerified.current = key;
    setRaw(urlLabel ? `${window.location.origin}/verify?label=${urlLabel}` : urlToken);
    run(parsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlToken, urlLabel]);

  const notFound =
    check.isError && (check.error?.status === 404 || check.error?.code === 'REQUEST_FAILED');

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(parseInput(raw), copyFile?.sha256);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          takeFile(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          'surface space-y-3 p-4 transition-colors',
          dragging && 'border-primary/50 bg-muted/40'
        )}
      >
        <label htmlFor="verify-token" className="sr-only">
          Certificate or label link, or code
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="verify-token"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Paste certificate or label link, or code"
            autoComplete="off"
            spellCheck={false}
            className="h-10 flex-1"
          />
          <Button type="submit" className="h-10 px-5" disabled={check.isPending || !raw.trim()}>
            {check.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Verify
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Upload aria-hidden className="size-3.5" />
            Or drop a certificate PDF
          </button>
          {copyFile && <span className="truncate">{copyFile.name}</span>}
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              takeFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        {problem && <p className="text-meta text-warn">{problem}</p>}
      </form>

      {check.isPending && (
        <div className="surface space-y-3 p-5" aria-busy="true">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}

      {notFound && (
        <ResultHeader
          outcome={OUTCOME.FAILED}
          subtitle={NOT_FOUND_TEXT[check.variables?.kind] ?? NOT_FOUND_TEXT.auto}
        />
      )}
      {check.isError && !notFound && <Denial error={check.error} heading="Verification not run" />}

      {check.isSuccess && result && <VerificationResult data={result} copyFile={copyFile} />}
    </div>
  );
}

// ---------------------------------------------------------------- receipt ----

function ReceiptCheck() {
  const [searchParams] = useSearchParams();
  const [seq, setSeq] = useState(searchParams.get('seq') ?? '');
  const [entry, setEntry] = useState(searchParams.get('entry') ?? '');
  const autoRan = useRef(false);
  const check = useMutation({ mutationFn: ({ s, e }) => api.publicVerifyReceipt(s, e) });

  const run = (s, e) => check.mutate({ s: String(s).trim(), e: String(e).trim().toLowerCase() });

  useEffect(() => {
    const s = searchParams.get('seq');
    const e = searchParams.get('entry');
    if (s && e && !autoRan.current) {
      autoRan.current = true;
      run(s, e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const r = check.data;
  const notFound = check.isError && check.error?.status === 404;

  const onEntryChange = (value) => {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        setSeq(String(parsed.ledgerSeq ?? ''));
        setEntry(String(parsed.entryHash ?? ''));
        return;
      }
    } catch {
      /* not receipt JSON */
    }
    setEntry(value);
  };

  const anchorState = !r
    ? null
    : !r.anchored
      ? { label: 'Not batched yet', variant: 'warning' }
      : !r.includedInRoot
        ? { label: 'Proof failed', variant: 'danger' }
        : r.onChainVerified
          ? { label: 'Verified on chain', variant: 'success' }
          : r.txHash
            ? { label: 'In anchored root', variant: 'success' }
            : { label: 'Local root only', variant: 'warning' };

  return (
    <div className="space-y-3">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          run(seq, entry);
        }}
      >
        <Input
          aria-label="Ledger sequence"
          value={seq}
          onChange={(e) => setSeq(e.target.value)}
          placeholder="Sequence"
          className="sm:w-28"
        />
        <Input
          aria-label="Entry hash"
          value={entry}
          onChange={(e) => onEntryChange(e.target.value)}
          placeholder="Entry hash or receipt JSON"
          className="flex-1 font-mono"
          spellCheck={false}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={check.isPending || !seq.trim() || entry.trim().length < 64}
        >
          {check.isPending && <Loader2 className="animate-spin" />}
          Check
        </Button>
      </form>

      {notFound && (
        <Badge variant="danger" dot>
          Receipt not found
        </Badge>
      )}
      {check.isError && !notFound && <Denial error={check.error} heading="Receipt not checked" />}

      {r && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success" dot>
              Entry present
            </Badge>
            <Badge variant={anchorState.variant} dot>
              {anchorState.label}
            </Badge>
            <MetaLine items={[`Seq ${r.seq}`, humanise(r.eventType), fmtDate(r.recordedAt)]} />
          </div>
          {r.explorerUrl && (
            <a
              href={r.explorerUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-meta font-medium underline-offset-4 hover:underline"
            >
              View transaction <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- anchoring ----

const BATCH_VARIANT = { CONFIRMED: 'success', FAILED: 'danger' };

function AnchoringRecord() {
  const latest = useLatestAnchor();
  const recent = useRecentAnchors();
  const a = latest.data;
  const batches = recent.data?.batches ?? [];

  if (latest.isPending) return <Skeleton className="h-20 w-full" />;
  if (latest.isError) return <Denial error={latest.error} heading="Anchoring record unavailable" />;
  if (!a?.anchored) return <Empty compact title="No batch anchored yet" />;

  const localOnly = a.status === 'DRY_RUN' || !a.txHash;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={localOnly ? 'warning' : 'success'} dot>
          {localOnly ? 'Local only' : humanise(a.status)}
        </Badge>
        <MetaLine items={[a.network, fmtDate(a.anchoredAt)]} />
      </div>

      <Facts
        dense
        rows={[
          a.fromSeq !== undefined && ['Ledger range', `${a.fromSeq}–${a.toSeq} · ${a.leafCount ?? 0} entries`],
          ['Merkle root', <Digest key="m" value={a.merkleRoot} block={false} />],
          a.blockNumber && ['Block', <span key="b" className="font-mono">{a.blockNumber}</span>],
        ]}
      />

      {a.txHash && a.explorerUrl && (
        <Button asChild variant="outline" size="sm">
          <a href={a.explorerUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink /> View on explorer
          </a>
        </Button>
      )}

      {batches.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-label text-muted-foreground">Recent batches</p>
          <Rows className="rounded-lg border">
            {batches.map((b) => (
              <li key={b.batchId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-meta">
                <Badge variant={BATCH_VARIANT[b.status] ?? 'warning'} size="sm">
                  {humanise(b.status)}
                </Badge>
                <span className="tabular-nums">
                  {b.fromSeq}–{b.toSeq}
                </span>
                <span className="text-muted-foreground">{fmtDate(b.anchoredAt)}</span>
                {b.explorerUrl && (
                  <a
                    href={b.explorerUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="ml-auto inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                  >
                    Block {b.blockNumber} <ExternalLink className="size-3" />
                  </a>
                )}
              </li>
            ))}
          </Rows>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- page ----

export default function VerifyPage() {
  const [searchParams] = useSearchParams();
  const hasReceipt = Boolean(searchParams.get('seq') && searchParams.get('entry'));

  return (
    <Workspace eyebrow="Public · no sign-in" title="Verify certificate" className="max-w-3xl">
      <EvidenceCheck />

      <div className="space-y-3 pt-2">
        <Disclosure label="Upload receipt" defaultOpen={hasReceipt}>
          <ReceiptCheck />
        </Disclosure>
        <Disclosure label="Anchoring record">
          <AnchoringRecord />
        </Disclosure>
      </div>
    </Workspace>
  );
}
