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
  Search,
  ShieldQuestion,
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
import { useLatestAnchor } from '@/hooks/queries';
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

function CertificateResult({ result, reVerifyUrl }) {
  const c = result.certificate ?? {};
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
            <p className="text-sm font-medium">Signatures</p>
            {c.signatures.map((s) => (
              <div key={s.part} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  Part {s.part} — {humanise(s.role)}
                </span>
                <Badge
                  variant="outline"
                  className={
                    s.present
                      ? 'border-ok/40 bg-ok-muted text-ok'
                      : 'border-warn/40 bg-warn-muted text-warn'
                  }
                >
                  {s.present ? 'Signed' : 'Not signed'}
                </Badge>
                {s.signedAt && (
                  <span className="text-xs text-muted-foreground">{fmtDate(s.signedAt)}</span>
                )}
              </div>
            ))}
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
  const autoVerified = useRef(null);

  const check = useMutation({ mutationFn: (token) => api.publicVerifyCertificate(token) });

  const run = (input) => {
    const token = verificationTokenFrom(input);
    if (!token) {
      setMalformed(true);
      setActiveToken(null);
      check.reset();
      return;
    }
    setMalformed(false);
    setActiveToken(token);
    check.mutate(token);
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
      accent
      title="Verify a section 63 certificate"
      description="Public. No account required — which is what makes this an independent check rather than our own word for it. The answer reports whether the certificate is genuine and whether the stored document still matches its published digest. It discloses no evidence, no case narrative and no personal data."
    >
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
        <CertificateResult result={check.data} reVerifyUrl={reVerifyUrl} />
      )}
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
        <div className="container relative flex flex-col items-center py-14 text-center sm:py-16">
          <div className="will-reveal">
            <Eyebrow>Public · no account, no session, no request for your identity</Eyebrow>
          </div>
          <h1 className="mt-5 max-w-3xl text-balance text-display-sm will-reveal">
            Independent <span className="text-gradient">verification</span>
          </h1>
          <p className="mt-4 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground will-reveal">
            Two checks that need nothing from us but a token: whether a section 63 certificate
            is genuine and still matches its published digest, and what was actually anchored
            from the ledger.
          </p>
        </div>
      </section>

      <div className="container space-y-8 pb-12">
      <div className="grid gap-6 lg:grid-cols-2">
        <CertificateSection />
        <div className="space-y-6">
          <AnchorSection />

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
