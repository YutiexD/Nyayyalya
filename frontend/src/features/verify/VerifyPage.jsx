/**
 * The public verifier. No session, no account, no Authorization header.
 *
 * This page is deliberately outside the authenticated surface, so it is the one place
 * in the client that talks to `api` directly rather than through the session-scoped
 * hooks. Both endpoints it uses are public by design:
 *
 *   /public/verify/:token   the QR printed on a section 63 certificate points here.
 *                           Its only credential is the token, and its answer carries
 *                           VALIDITY — never contents.
 *   /api/anchors/latest     roots and chain facts only. Publishing a root is the whole
 *                           point of anchoring: it is what lets someone with no account
 *                           check the claim instead of taking our word for it.
 *
 * The hardest thing on this page is honesty about the second one. A root that was
 * computed and stored but never submitted proves internal consistency and nothing else,
 * and it is rendered amber with that said in words. Painting it green would tell a court
 * that an independent record agrees with us when no independent record exists.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import QRCode from 'qrcode';
import {
  AlertTriangle,
  ExternalLink,
  FileCheck2,
  FileSearch,
  Search,
  ShieldQuestion,
  Upload,
} from 'lucide-react';

import { Backdrop, Eyebrow, LightTile } from '@/components/common/Premium';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

import { Section, KeyValue, Hash, EmptyState } from '@/components/common/Primitives';
import { Denial, Note } from '@/components/common/Verdicts';
import { useLatestAnchor, useRecentAnchors } from '@/hooks/queries';
import { api } from '@/lib/api';
import { useReveal } from '@/hooks/useGsap';
import { humanise, fmtDate } from '@/lib/utils';

/**
 * Read a verification token out of whatever was pasted.
 *
 * Three shapes reach this box in practice: the bare token, the `/public/verify/:token`
 * URL the printed QR encodes, and this page's own `?token=` address once somebody has
 * scanned it and copied the link out of their phone. All three are accepted, because a
 * person holding a certificate should not have to know which of them they have.
 */
const TOKEN_IN_PATH = /\/public\/verify\/([A-Za-z0-9_-]{16,})/;
const TOKEN_IN_QUERY = /[?&]token=([A-Za-z0-9_-]{16,})/;

function verificationTokenFrom(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const inPath = TOKEN_IN_PATH.exec(text);
  if (inPath) return inPath[1];
  const inQuery = TOKEN_IN_QUERY.exec(text);
  if (inQuery) return inQuery[1];
  return /^[A-Za-z0-9_-]{16,}$/.test(text) ? text : null;
}

/**
 * The token a Nyayyalya certificate PDF carries in its own metadata (`Keywords`), written
 * as plain ASCII outside the compressed page streams. Reading it lets a holder check
 * a PDF somebody handed them with nothing but the file.
 */
const TOKEN_IN_PDF = /lexx-verify:([A-Za-z0-9_-]{43})/;

async function readCertificateFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  // latin1 maps every byte to one character, so an ASCII marker survives intact.
  const text = new TextDecoder('latin1').decode(bytes);
  const token = TOKEN_IN_PDF.exec(text)?.[1] ?? TOKEN_IN_QUERY.exec(text)?.[1] ?? null;
  const isPdf = text.startsWith('%PDF-');
  return { sha256, token, isPdf, name: file.name, size: file.size };
}

/** What the register said about the copy in the holder's hand. */
const COPY_STATE = {
  CURRENT: {
    tone: 'ok',
    state: 'Identical to the registered document',
    why: 'Byte for byte, this file is the certificate as the register holds it now.',
  },
  EARLIER_VERSION: {
    tone: 'warn',
    state: 'An earlier version of this certificate',
    why: 'This file was genuinely issued for this certificate, but it has since been re-issued — usually because a signature was added. Ask for the current copy.',
  },
  NO_MATCH: {
    tone: 'bad',
    state: 'Not the registered document',
    why: 'The token is genuine, but this file does not match any version the register issued. Treat this copy as altered or substituted.',
  },
};

/** What each stored-document state means, in one sentence, written for a courtroom. */
const PDF_STATE = {
  PDF_INTACT: [
    'border-ok/40 bg-ok-muted text-ok',
    'The stored document still hashes to the digest published with it.',
  ],
  PDF_MODIFIED: [
    'border-bad/40 bg-bad-muted text-bad',
    'The stored document no longer hashes to the digest published with it. Treat this copy as unproven.',
  ],
  PDF_MISSING: [
    'border-warn/40 bg-warn-muted text-warn',
    'The stored document could not be read, so its digest could not be compared.',
  ],
};

// ------------------------------------------------------- certificate check ----

function CertificateResult({ result, reVerifyUrl, copyFile }) {
  const c = result.certificate ?? {};
  const copyState = result.copy ? COPY_STATE[result.copy.match] : null;
  const [pdfTone, pdfWhy] = PDF_STATE[c.pdfIntegrity] ?? [
    'border-warn/40 bg-warn-muted text-warn',
    'The server returned a document state this page does not recognise.',
  ];

  const [qrSrc, setQrSrc] = useState(null);

  useEffect(() => {
    let alive = true;
    // Fixed dark-on-white, not theme tokens: a scanner needs the contrast the QR
    // specification assumes, and the quiet zone in the image supplies its own plate.
    QRCode.toDataURL(reVerifyUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 160,
      color: { dark: '#0b1220', light: '#ffffff' },
    })
      .then((src) => alive && setQrSrc(src))
      .catch(() => alive && setQrSrc(null));
    return () => {
      alive = false;
    };
  }, [reVerifyUrl]);

  return (
    <div className="space-y-4">
      {/* Two tiles, two distinct facts. The register answered — that is one claim; the
          stored document still hashes to its published digest — that is a second. A
          single green banner would blur them, and the second can fail while the first
          holds. Neither says anything about the evidence itself, and the caption says so. */}
      {/* The holder's own file comes first and full width when there is one: it is the
          question they actually asked. */}
      {copyState && (
        <LightTile
          index={3}
          title="The copy you hold"
          state={copyState.state}
          tone={copyState.tone}
          icon={FileSearch}
          explanation={copyState.why}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <LightTile
          index={1}
          title="Certificate on the register"
          state="Token resolves"
          tone="ok"
          icon={ShieldQuestion}
          explanation="A statement about the certificate, not about the evidence it describes."
        />
        <LightTile
          index={2}
          title="Stored document"
          state={humanise(c.pdfIntegrity) || 'Unknown'}
          tone={c.pdfIntegrity === 'PDF_INTACT' ? 'ok' : c.pdfIntegrity === 'PDF_MODIFIED' ? 'bad' : 'warn'}
          icon={FileCheck2}
          explanation={pdfWhy}
        />
      </div>

      {result.copy && (
        <KeyValue
          rows={[
            ['Your file', copyFile ? `${copyFile.name}` : '—'],
            ['Its SHA-256 (computed in this browser)', <Hash key="kv" value={result.copy.sha256} />],
            result.copy.supersededAt ? ['Superseded on', fmtDate(result.copy.supersededAt)] : null,
          ]}
        />
      )}

      <KeyValue
        rows={[
          ['Statute', c.statute ?? 'Bharatiya Sakshya Adhiniyam, 2023 — section 63'],
          ['Certificate', <span key="kv" className="font-mono">{c.certificateId ?? '—'}</span>],
          ['Template', <span key="kv" className="font-mono">{c.templateVersion ?? '—'}</span>],
          ['Generated', fmtDate(c.generatedAt)],
          ['Exhibit', <span key="kv" className="font-mono">{c.exhibitCode ?? '—'}</span>],
          ['CNR', <span key="kv" className="font-mono">{c.cnrNumber ?? 'not committed'}</span>],
          ['FIR', <span key="kv" className="font-mono">{c.firNumber ?? '—'}</span>],
          ['Evidence digest attested', <Hash key="kv" value={c.evidenceHash} />],
          ['Hash algorithm', c.hashAlgorithm ?? 'SHA-256'],
          ['Document digest', <Hash key="kv" value={c.pdfSha256} />],
          [
            'Document state',
            <Badge key="kv" variant="outline" className={pdfTone}>
              {humanise(c.pdfIntegrity)}
            </Badge>,
          ],
          ['Part A complete', c.partAComplete ? 'Yes' : 'No'],
          ['Part B complete', c.partBComplete ? 'Yes' : 'No'],
        ]}
      />

      {(c.signatures ?? []).length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="text-sm font-medium">Signatures — the two parties to a section 63 certificate</p>
            {c.signatures.map((s) => {
              // Part B exists only where a laboratory report was filed. Blank is then
              // the correct state, not a missing signature, and must not read as one.
              const notApplicable = s.part === 'B' && !c.partBComplete;
              return (
                <div key={s.part} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">
                      Part {s.part} — {s.part === 'A' ? 'the deponent' : 'the forensic expert'}
                    </span>
                    <Badge
                      variant="outline"
                      className={
                        s.present
                          ? 'border-ok/40 bg-ok-muted text-ok'
                          : notApplicable
                            ? 'border-border bg-muted text-muted-foreground'
                            : 'border-warn/40 bg-warn-muted text-warn'
                      }
                    >
                      {s.present ? 'Signed' : notApplicable ? 'Not applicable — no laboratory report' : 'Not signed yet'}
                    </Badge>
                    {s.signedAt && (
                      <span className="text-xs text-muted-foreground">{fmtDate(s.signedAt)}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.part === 'A'
                      ? 'Signed by the person who produced the record (usually the investigating officer), with the key held in their own browser, on their exhibit screen.'
                      : 'Signed by the examiner whose laboratory report Part B reproduces, on their laboratory screen. Filled only from a filed report — never written by Nyayyalya.'}
                  </p>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              Each signature covers the certificate body. When one is added the PDF is re-issued,
              so a copy taken before it will show here as an earlier version.
            </p>
          </div>
        </>
      )}

      <Separator />

      <div className="flex flex-wrap items-start gap-4">
        {qrSrc && (
          <img
            src={qrSrc}
            width={160}
            height={160}
            alt="QR code linking back to this verification result"
            className="rounded-md border"
          />
        )}
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Scan to re-verify this certificate</p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            The same check, from any phone in the room, with no account. The link is printed
            below in full so a camera-less machine can still be used.
          </p>
          <p className="hash">{reVerifyUrl}</p>
        </div>
      </div>

      {result.disclosure && <Note>{result.disclosure}</Note>}
    </div>
  );
}

function CertificateSection() {
  const [searchParams] = useSearchParams();
  const urlToken = searchParams.get('token');

  const [raw, setRaw] = useState('');
  const [malformed, setMalformed] = useState(false);
  const [activeToken, setActiveToken] = useState(null);
  const [copyFile, setCopyFile] = useState(null);
  const [fileProblem, setFileProblem] = useState(null);
  const [dragging, setDragging] = useState(false);
  const autoVerified = useRef(null);
  const fileInput = useRef(null);

  const check = useMutation({
    mutationFn: ({ token, copy }) => api.publicVerifyCertificate(token, copy),
  });

  const run = (input, copy = copyFile?.sha256) => {
    const token = verificationTokenFrom(input);
    if (!token) {
      setMalformed(true);
      setActiveToken(null);
      check.reset();
      return;
    }
    setMalformed(false);
    setActiveToken(token);
    check.mutate({ token, copy });
  };

  /**
   * A PDF somebody was handed. Hashed here, in the browser — the document never
   * leaves this machine, only its digest does — and its token read out of its own
   * metadata, so the holder does not have to find the QR first.
   */
  const takeFile = async (file) => {
    if (!file) return;
    setFileProblem(null);
    let read;
    try {
      read = await readCertificateFile(file);
    } catch {
      setFileProblem('That file could not be read.');
      return;
    }
    if (!read.isPdf) {
      setCopyFile(null);
      setFileProblem('That is not a PDF. A section 63 certificate is issued as a PDF.');
      return;
    }
    setCopyFile(read);
    const token = read.token ?? verificationTokenFrom(raw);
    if (!token) {
      setFileProblem(
        'This PDF carries no Nyayyalya verification token in its metadata (older certificates do not). Paste the token from the QR printed on it, and the file will be compared as well.'
      );
      check.reset();
      return;
    }
    if (read.token) setRaw(read.token);
    run(token, read.sha256);
  };

  /**
   * The QR printed on every certificate points at this page with `?token=`, so a scan
   * must land on a RESULT, not on a form somebody then has to submit. The ref keeps
   * StrictMode's double-invoke from firing the check twice.
   */
  useEffect(() => {
    if (!urlToken || autoVerified.current === urlToken) return;
    autoVerified.current = urlToken;
    setRaw(urlToken);
    run(urlToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlToken]);

  const reVerifyUrl = useMemo(
    () =>
      activeToken && typeof window !== 'undefined'
        ? `${window.location.origin}/verify?token=${activeToken}`
        : '',
    [activeToken]
  );

  /**
   * A 404 here carries `{ valid: false, reason }` rather than the API's error envelope,
   * so the client sees the generic REQUEST_FAILED. Naming it properly is worth doing:
   * an unknown token and a malformed one are answered identically by design, and the
   * user should be told that rather than left with "request failed".
   */
  const denial = check.error && {
    code: check.error.code === 'REQUEST_FAILED' ? 'CERTIFICATE_NOT_FOUND' : check.error.code,
    message:
      check.error.code === 'REQUEST_FAILED'
        ? 'No certificate on the register resolves from this token.'
        : check.error.message,
    details: check.error.details,
  };

  return (
    <Section
      title="Verify a section 63 certificate"
      description="Public. No account required — which is what makes this an independent check rather than our own word for it. The answer reports whether the certificate is genuine and whether the stored document still matches its published digest. It discloses no evidence, no case narrative and no personal data."
    >
      {/* Party A hands Party B a certificate. Party B needs nothing from either of us
          but the file: drop it here and the answer covers THIS copy, not just the token. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
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
        className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
          dragging ? 'border-accent-from bg-accent-gradient-soft' : 'hover:bg-muted/50'
        }`}
      >
        <Upload className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">Were you handed a certificate? Drop the PDF here</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
          It is hashed in this browser and never uploaded. The answer says whether your copy is
          the registered document, an earlier version of it, or not this certificate at all.
        </p>
        {copyFile && (
          <p className="font-mono text-xs text-muted-foreground">
            {copyFile.name} · {copyFile.sha256.slice(0, 16)}…
          </p>
        )}
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
      {fileProblem && <Note tone="warn">{fileProblem}</Note>}

      <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-muted-foreground">
        <Separator className="flex-1" /> or use the token <Separator className="flex-1" />
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(raw);
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="verify-token">Verification token</Label>
          <Input
            id="verify-token"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="paste the token, or the whole /public/verify/… or ?token=… link"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Scan the QR printed on the certificate, or copy the link it points at.
          </p>
        </div>
        <Button type="submit" disabled={check.isPending || !raw.trim()}>
          <Search className="size-4" />
          {check.isPending ? 'Checking the register…' : 'Verify certificate'}
        </Button>
      </form>

      {malformed && (
        <Note tone="warn">
          That does not look like a verification token. A token is at least sixteen
          URL-safe characters; nothing was sent to the register.
        </Note>
      )}

      {check.isPending && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      )}

      {check.isError && (
        <div className="space-y-3">
          <Denial error={denial} heading="Certificate not verified" />
          <Note>
            An unknown token and a malformed token are answered identically, so nothing about
            the register can be learned by guessing at tokens.
          </Note>
        </div>
      )}

      {check.isSuccess && check.data && (
        <CertificateResult result={check.data} reVerifyUrl={reVerifyUrl} copyFile={copyFile} />
      )}
    </Section>
  );
}

// -------------------------------------------------------- upload receipt ----

/**
 * Pull `ledgerSeq` and `entryHash` out of whatever was pasted: the receipt JSON an
 * officer downloaded at upload, or the two values typed separately.
 */
function receiptFrom(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return { seq: String(parsed.ledgerSeq ?? ''), entry: String(parsed.entryHash ?? '') };
    }
  } catch {
    /* not JSON — fall through */
  }
  return null;
}

function ReceiptSection() {
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

  return (
    <Section
      title="Verify an upload receipt"
      description="Public. Every exhibit upload gives the officer a receipt carrying a ledger sequence number and an entry hash. Paste them (or the whole receipt JSON) to check that the register still holds exactly that entry and whether it sits under a root anchored on chain."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(seq, entry);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="receipt-seq">Ledger sequence</Label>
            <Input id="receipt-seq" value={seq} onChange={(e) => setSeq(e.target.value)} placeholder="12" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="receipt-entry">Entry hash</Label>
            <Input
              id="receipt-entry"
              value={entry}
              onChange={(e) => {
                const pasted = receiptFrom(e.target.value);
                if (pasted) {
                  setSeq(pasted.seq);
                  setEntry(pasted.entry);
                } else setEntry(e.target.value);
              }}
              placeholder="64 hex characters — or paste the whole receipt JSON here"
              className="font-mono"
              spellCheck={false}
            />
          </div>
        </div>
        <Button type="submit" disabled={check.isPending || !seq.trim() || entry.trim().length < 64}>
          <Search className="size-4" />
          {check.isPending ? 'Checking…' : 'Verify receipt'}
        </Button>
      </form>

      {notFound && (
        <Denial
          error={{
            code: 'RECEIPT_NOT_FOUND',
            message:
              'The register holds no entry with that sequence and hash. A wrong hash and a missing entry answer identically.',
          }}
          heading="Receipt not verified"
        />
      )}
      {check.isError && !notFound && <Denial error={check.error} heading="Receipt not checked" />}

      {r && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <LightTile
              index={1}
              title="Entry in the register"
              state="Present, unaltered"
              tone="ok"
              icon={FileCheck2}
              explanation={`Sequence ${r.seq} still carries exactly this entry hash (${humanise(r.eventType)}, ${fmtDate(r.recordedAt)}).`}
            />
            <LightTile
              index={2}
              title="Anchored root"
              state={
                !r.anchored
                  ? 'Not batched yet'
                  : r.includedInRoot
                    ? r.onChainVerified
                      ? 'Verified on chain'
                      : r.txHash
                        ? 'In anchored root'
                        : 'Local root only'
                    : 'Proof failed'
              }
              tone={
                !r.anchored ? 'warn' : !r.includedInRoot ? 'bad' : r.onChainVerified || r.txHash ? 'ok' : 'warn'
              }
              icon={ShieldQuestion}
              explanation={
                !r.anchored
                  ? 'Entries are gathered into a Merkle batch every few minutes; check again shortly.'
                  : r.onChainVerified
                    ? 'The NyayyalyaAnchor contract on Monad Testnet itself confirmed this entry against the root it holds.'
                    : r.txHash
                      ? 'The entry proves into a root that was written on chain.'
                      : 'The root was computed here but not submitted — internal consistency only.'
              }
            />
          </div>
          <KeyValue
            rows={[
              ['Merkle root', <Hash key="m" value={r.merkleRoot} />],
              ['Transaction', r.txHash ? <Hash key="t" value={r.txHash} /> : 'none'],
            ]}
          />
          {r.explorerUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={r.explorerUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-4" /> Open the anchoring transaction
              </a>
            </Button>
          )}
          <Note>{r.disclosure}</Note>
        </div>
      )}
    </Section>
  );
}

// --------------------------------------------------------- anchor history ----

function AnchorHistory() {
  const recent = useRecentAnchors();
  const d = recent.data;
  if (recent.isPending) return <Skeleton className="h-24 w-full" />;
  if (recent.isError || !d) return null;

  return (
    <Section
      title="Anchoring history"
      description={
        d.submitting
          ? `Submitting to ${d.network} (chain ${d.chainId}) every ${Math.round((d.intervalMs ?? 300000) / 60000)} minutes. Each confirmed batch links to its transaction.`
          : 'Submission is switched off in this deployment: roots are computed and stored locally, and nothing is sent to a chain.'
      }
    >
      {d.contractExplorerUrl && (
        <Button asChild variant="outline" size="sm">
          <a href={d.contractExplorerUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink className="size-4" /> NyayyalyaAnchor contract on the explorer
          </a>
        </Button>
      )}
      {(d.batches ?? []).length === 0 ? (
        <EmptyState title="No batch yet" />
      ) : (
        <ul className="space-y-2">
          {d.batches.map((b) => (
            <li key={b.batchId} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm">
              <Badge
                variant="outline"
                className={
                  b.status === 'CONFIRMED'
                    ? 'border-ok/40 bg-ok-muted text-ok'
                    : b.status === 'FAILED'
                      ? 'border-bad/40 bg-bad-muted text-bad'
                      : 'border-warn/40 bg-warn-muted text-warn'
                }
              >
                {humanise(b.status)}
              </Badge>
              <span className="tabular-nums">
                seq {b.fromSeq}–{b.toSeq} · {b.leafCount} entries
              </span>
              <span className="text-xs text-muted-foreground">{fmtDate(b.anchoredAt)}</span>
              {b.explorerUrl && (
                <a
                  href={b.explorerUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-auto inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
                >
                  block {b.blockNumber} <ExternalLink className="size-3" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------ where to find it ----

function WhereToFind() {
  return (
    <Section
      title="What to paste, and where it comes from"
      description="Everything this page checks comes printed on a document or shown on a screen — you never need an account to check it."
    >
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="font-medium">Certificate token</dt>
          <dd className="text-muted-foreground">
            The QR on a printed s.63 certificate opens this page with it filled in. On screen, the
            same link has a copy button wherever the certificate is shown: the officer&rsquo;s
            exhibit panel, the court&rsquo;s Exhibits tab, and counsel&rsquo;s served exhibits.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Upload receipt</dt>
          <dd className="text-muted-foreground">
            Downloaded by the officer at the moment of upload (its <code>ledgerSeq</code> and{' '}
            <code>entryHash</code>). The officer&rsquo;s exhibit panel also has a &ldquo;Check this
            receipt&rdquo; link that opens this page with both filled in.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Anchoring</dt>
          <dd className="text-muted-foreground">
            Nothing to paste. Roots and their transactions are listed here as they are made.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Demo mode</dt>
          <dd className="text-muted-foreground">
            <code>npm run seed</code> prints the certificate&rsquo;s verify link, and{' '}
            <code>node scripts/demo-lookup.js</code> prints every token, receipt and label in the
            demo database.
          </dd>
        </div>
      </dl>
    </Section>
  );
}

// ------------------------------------------------------------- anchoring ----

const ANCHOR_STANDING_STATEMENT =
  'Only the Merkle root is ever written on chain — no evidence, no file contents, no personal data, no case identifiers, no AI scores. A root is a fixed-length number that reveals nothing about what went into it, and that is precisely why it is safe to publish at all.';

function AnchorSection() {
  const anchor = useLatestAnchor();
  const a = anchor.data;

  /**
   * The single most important distinction on this page.
   *
   * A batch in DRY_RUN, or one with no transaction hash, had its root computed and
   * stored here and NEVER submitted anywhere. Both sides of any comparison against it
   * are held by this system, so it shows internal consistency and nothing more. It is
   * amber, above the record rather than beside it, and it says so in words.
   */
  const localOnly = Boolean(a?.anchored) && (a.status === 'DRY_RUN' || !a.txHash);

  return (
    <Section
      title="Anchoring record"
      description="Public. Roots and chain facts only — which is exactly what makes the claim checkable by someone with no account here."
    >
      {anchor.isPending && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      )}

      {anchor.isError && <Denial error={anchor.error} heading="Anchoring record unavailable" />}

      {anchor.isSuccess && !a?.anchored && (
        <EmptyState title="No batch has been anchored yet">
          {a?.message ??
            'Nothing has been batched. Ledger entries are anchored on a timer, and until a batch exists there is no root to publish or to check.'}
        </EmptyState>
      )}

      {anchor.isSuccess && a?.anchored && (
        <div className="space-y-4">
          {localOnly && (
            <Alert className="border-warn/40 bg-warn-muted">
              <AlertTriangle className="size-4" />
              <AlertTitle>This root was recorded locally. Nothing was submitted.</AlertTitle>
              <AlertDescription className="space-y-2 text-sm leading-relaxed">
                <p>
                  The Merkle root below was computed from the ledger and stored by this system.
                  It was never sent to a chain, so there is no transaction on Monad Testnet to
                  check it against and no independent party holds a copy.
                </p>
                <p>
                  Treat it as evidence of internal consistency only — that our own records agree
                  with each other — and not as independent corroboration. A verifier that
                  presented this as &ldquo;published on chain&rdquo; would be overstating the
                  claim to a court.
                </p>
              </AlertDescription>
            </Alert>
          )}

          <KeyValue
            rows={[
              ['Network', <span key="kv" className="font-mono">{a.network ?? '—'}</span>],
              ['Chain ID', <span key="kv" className="font-mono">{a.chainId ?? '—'}</span>],
              ['Batch', <span key="kv" className="font-mono">{a.batchId ?? '—'}</span>],
              ['Merkle root', <Hash key="kv" value={a.merkleRoot} />],
              [
                'Ledger range',
                a.fromSeq === undefined
                  ? '—'
                  : `sequences ${a.fromSeq}–${a.toSeq} · ${a.leafCount ?? 0} entries`,
              ],
              [
                'Status',
                <Badge key="kv"
                  variant="outline"
                  className={
                    localOnly
                      ? 'border-warn/40 bg-warn-muted text-warn'
                      : 'border-ok/40 bg-ok-muted text-ok'
                  }
                >
                  {humanise(a.status)}
                </Badge>,
              ],
              [
                'Transaction',
                a.txHash ? (
                  <Hash value={a.txHash} />
                ) : (
                  <span className="text-muted-foreground">
                    none — this root was never submitted
                  </span>
                ),
              ],
              ['Block', a.blockNumber ? <span className="font-mono">{a.blockNumber}</span> : '—'],
              [
                'Contract',
                a.contractAddress ? <Hash value={a.contractAddress} /> : '—',
              ],
              ['Anchored at', fmtDate(a.anchoredAt)],
            ]}
          />

          {a.txHash && a.explorerUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={a.explorerUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-4" />
                Open the transaction on the block explorer
              </a>
            </Button>
          )}

          <Note>{ANCHOR_STANDING_STATEMENT}</Note>
        </div>
      )}
    </Section>
  );
}

// -------------------------------------------------------------------- page ----

export default function VerifyPage() {
  const scope = useReveal();

  return (
    <div ref={scope}>
      {/* The one page a stranger lands on from a printed QR. It gets the same field the
          front page has, so it reads as the same product — and the headline says what
          the page is for before a single form appears. */}
      <section className="relative overflow-hidden">
        <Backdrop />
        <div className="container relative flex flex-col items-center pt-4 pb-14 text-center sm:pt-6 sm:pb-16">
          <div className="will-reveal">
            <Eyebrow>Public · no account, no session, no request for your identity</Eyebrow>
          </div>
          <h1 className="mt-5 max-w-3xl text-balance text-display-sm will-reveal">
            Independent <span className="text-gradient">verification</span>
          </h1>
          <p className="mt-4 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground will-reveal">
            Three checks that need nothing from us but what is printed on a document: whether
            a section 63 certificate is genuine and unaltered, whether an upload receipt is
            still in the register and under an anchored root, and what was actually anchored
            from the ledger.
          </p>
        </div>
      </section>

      <div className="container space-y-8 pb-16">
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          <CertificateSection />
          <ReceiptSection />
          <WhereToFind />
        </div>
        <div className="space-y-6">
          <AnchorSection />
          <AnchorHistory />

          <Section
            title="What this page proves"
            description="Two different claims, made by two different people, that this product is careful never to blend."
          >
            <div className="max-w-prose space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">
                  This set of ledger entries existed in this form at this time.
                </span>{' '}
                That is what a certificate and an anchored root can establish. A digest fixes
                the bytes; a chained ledger fixes their order; a Merkle root fixes the whole
                batch to a moment. None of it says anything about whether a recording shows
                what someone claims it shows.
              </p>
              <p>
                <span className="font-medium text-foreground">The evidence is authentic.</span>{' '}
                That is a different claim, and this page does not make it. It is made by a
                laboratory notified under IT Act s.79A, in an opinion signed by the examiner
                who did the work, in the vocabulary AUTHENTIC, MANIPULATED or INCONCLUSIVE.
                Nothing automated in this system produces it, and no score on any screen is a
                substitute for it.
              </p>
              <p>
                Between the two sits the officer who uploaded the exhibit. The hash and the
                signature were made in their browser, on their device, with a key registered
                to them — so the record names who attested to those bytes, and when. What that
                officer swore to is theirs; what the laboratory concluded is the
                laboratory&rsquo;s; and the ledger only records that both were said.
              </p>
            </div>
          </Section>
        </div>
      </div>
      </div>
    </div>
  );
}
