/**
 * The s.63 certificate for one exhibit, as a compact card.
 *
 * The server issues and signs exactly one certificate per exhibit when the evidence is
 * uploaded. Nobody signs or generates anything here: the card shows the certificate's
 * status and lets anyone who can see the exhibit verify it in one click, download the
 * PDF, or copy the public verification link.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, FileBadge, FileDown, Link2, Loader2, ShieldCheck, ShieldX, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MetaLine } from '@/components/common/Shell';
import { Denial } from '@/components/common/Verdicts';
import { useCertificateFor, useVerifyCertificate } from '@/hooks/queries';
import { api } from '@/lib/api';
import { copyText, saveBlob } from '@/lib/download';
import { cn, fmtDate, humanise } from '@/lib/utils';

const SIGNER = 'LEXX Certificate Authority';

/** The public verifier link for a token, built from this origin. */
export const verifyLinkFor = (token) =>
  token ? `${window.location.origin}/verify?token=${encodeURIComponent(token)}` : null;

/** The link to share: the server's own URL when usable, else one built from the token. */
function verificationLink(c) {
  const url = c?.verificationUrl;
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  if (typeof url === 'string' && url.startsWith('/')) return `${window.location.origin}${url}`;
  return verifyLinkFor(c?.verificationToken);
}

const STATUS = {
  ACTIVE: { label: 'Issued', variant: 'success' },
  ISSUED: { label: 'Issued', variant: 'success' },
  SUPERSEDED: { label: 'Superseded', variant: 'muted' },
  PENDING_ISSUE: { label: 'Pending', variant: 'warning' },
  PENDING: { label: 'Pending', variant: 'warning' },
};

/** Issued / Superseded / Pending. */
export function CertificateStatusBadge({ status, size = 'sm', className }) {
  const s = STATUS[status] ?? { label: humanise(status) || 'Pending', variant: status ? 'neutral' : 'warning' };
  return (
    <Badge variant={s.variant} size={size} dot className={className}>
      {s.label}
    </Badge>
  );
}

/**
 * A verification result (`POST /api/certificates/:id/verify`, or the public verifier):
 * a clear Verified / Failed banner, with the individual checks behind a toggle.
 */
export function VerificationResult({ result, className }) {
  const [open, setOpen] = useState(false);
  if (!result) return null;

  const ok = result.result === 'VERIFIED';
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const passed = checks.filter((c) => c.ok).length;
  const Icon = ok ? ShieldCheck : ShieldX;

  return (
    <div
      role="status"
      className={cn(
        'overflow-hidden rounded-lg border',
        ok ? 'border-ok/25 bg-ok-muted' : 'border-bad/25 bg-bad-muted',
        className
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!checks.length}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon aria-hidden className={cn('size-5 shrink-0', ok ? 'text-ok' : 'text-bad')} />
        <span className={cn('text-sm font-semibold', ok ? 'text-ok' : 'text-bad')}>{ok ? 'Verified' : 'Failed'}</span>
        {result.verifiedAt && <span className="text-meta text-muted-foreground">{fmtDate(result.verifiedAt)}</span>}
        {checks.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-label text-muted-foreground">
            {passed}/{checks.length} checks
            <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          </span>
        )}
      </button>
      {open && checks.length > 0 && (
        <ul className="space-y-1.5 border-t bg-card/70 px-3.5 py-3">
          {checks.map((ch, i) => (
            <li key={ch.key ?? i} className="flex items-start gap-2">
              {ch.ok ? (
                <Check aria-label="Passed" className="mt-0.5 size-3.5 shrink-0 text-ok" />
              ) : (
                <X aria-label="Failed" className="mt-0.5 size-3.5 shrink-0 text-bad" />
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
      )}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} [props.evidenceId]     the exhibit; the card reads its certificate register
 * @param {string} [props.exhibitCode]    for the PDF filename
 * @param {object} [props.certificate]    a certificate view already in hand (skips the read)
 * @param {'card'|'plain'} [props.variant='card']  `plain` drops the border (inside a Panel)
 */
export function CertificateCard({ evidenceId, exhibitCode, certificate: provided, variant = 'card', className }) {
  const list = useCertificateFor(provided ? null : evidenceId);
  const verify = useVerifyCertificate();
  const [downloading, setDownloading] = useState(false);

  const data = list.data ?? {};
  const c = provided ?? data.active ?? null;
  const id = c?.certificateId ?? null;
  const code = exhibitCode ?? c?.exhibitCode ?? data.exhibitCode;
  const superseded = (data.certificates ?? []).filter((x) => x.status === 'SUPERSEDED').length;
  const link = c ? verificationLink(c) : null;
  // The mutation outlives a change of exhibit; only show a result for this certificate.
  const verified = id && verify.variables === id ? verify : null;
  const last = c?.lastVerification;

  const card = variant === 'card';
  const shell = cn(card && 'rounded-lg border bg-card', className);
  const pad = card ? 'px-4' : '';

  if (!provided && evidenceId && list.isPending) {
    return (
      <div className={cn(shell, 'space-y-2 py-3', pad)} aria-busy="true">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-3 w-64" />
      </div>
    );
  }
  if (!provided && list.isError) {
    return <Denial error={list.error} heading="Certificate not readable" className={className} />;
  }

  const download = async () => {
    setDownloading(true);
    try {
      saveBlob(await api.certificates.pdfBlob(id), `s63-certificate-${code ?? id}.pdf`);
    } catch (err) {
      toast.error('The certificate could not be downloaded', { description: err.message });
    } finally {
      setDownloading(false);
    }
  };

  const copy = async () => {
    if (await copyText(link)) toast.success('Verification link copied');
    else toast.error('Could not copy the link');
  };

  return (
    <section className={shell} aria-label="Section 63 certificate">
      <div className={cn('flex items-start gap-3 py-3', pad)}>
        <FileBadge aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Section 63 certificate</p>
          <MetaLine
            items={
              c
                ? [
                    c.issuedAt && `Issued ${fmtDate(c.issuedAt)}`,
                    `Signed by ${c.signedBy ?? SIGNER}`,
                    superseded > 0 && `${superseded} superseded`,
                  ]
                : ['Not issued yet']
            }
          />
        </div>
        <CertificateStatusBadge
          status={!c || c.state === 'PENDING_ISSUE' ? 'PENDING_ISSUE' : c.status ?? c.state}
        />
      </div>

      {c && (
        <div className={cn('flex flex-wrap items-center gap-2 pb-3', pad)}>
          <Button size="sm" onClick={() => verify.mutate(id)} disabled={!id || verify.isPending}>
            {verify.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Verify certificate
          </Button>
          <Button size="sm" variant="outline" onClick={download} disabled={!id || downloading}>
            {downloading ? <Loader2 className="animate-spin" /> : <FileDown />}
            Download PDF
          </Button>
          {link && (
            <Button size="sm" variant="ghost" onClick={copy}>
              <Link2 />
              Copy link
            </Button>
          )}
          {!verified?.data && last?.at && (
            <span className="text-label text-muted-foreground">
              Last verified {fmtDate(last.at)} · {last.result === 'VERIFIED' ? 'Verified' : 'Failed'}
            </span>
          )}
        </div>
      )}

      {verified && (verified.data || verified.isError) && (
        <div className={cn('pb-3', pad)}>
          {verified.isError ? (
            <Denial error={verified.error} heading="Verification not run" />
          ) : (
            <VerificationResult result={verified.data} />
          )}
        </div>
      )}
    </section>
  );
}

/** @deprecated Use `CertificateCard`. Kept so existing imports compile; extra props are ignored. */
export const CertificatePanel = CertificateCard;
