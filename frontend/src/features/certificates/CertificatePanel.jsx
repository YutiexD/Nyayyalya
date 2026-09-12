/**
 * BSA s.63 certificates for one exhibit: issue, sign, download, and — the point of
 * this panel — hand over the thing the public verifier needs.
 *
 * Every certificate carries a verification token. The printed PDF encodes it as a
 * QR; this panel shows the same link, the same QR and a copy button, so the value a
 * court officer has to paste into /verify is never more than one click away.
 *
 * Signing is done here, in the browser: the signer's private key signs the canonical
 * body hash the server computed (`bodyHash`), exactly as evidence is signed. The server
 * then checks that the signer IS the person the certificate names in that part.
 */
import { useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import { Copy, ExternalLink, FileBadge, FileDown, Loader2, PenLine } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { KeyValue, Hash, EmptyState } from '@/components/common/Primitives';
import { Denial, Note } from '@/components/common/Verdicts';
import { QrImage } from '@/components/common/QrImage';
import {
  useCertificatesFor,
  useGenerateCertificate,
  useSignPartA,
  useSignPartB,
} from '@/hooks/queries';
import { selectSession } from '@/features/auth/authSlice';
import { api } from '@/lib/api';
import { getOrCreateKeyPair, signHashHex } from '@/lib/crypto';
import { copyText, saveBlob } from '@/lib/download';
import { cn, fmtDate } from '@/lib/utils';

/** The link a phone lands on. Built from this origin, so it works wherever the client is served. */
export const verifyLinkFor = (token) =>
  token ? `${window.location.origin}/verify?token=${encodeURIComponent(token)}` : null;

function SignatureBadge({ present, label }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full',
        present ? 'border-ok/40 bg-ok-muted text-ok' : 'border-warn/40 bg-warn-muted text-warn'
      )}
    >
      {label} {present ? 'signed' : 'not signed'}
    </Badge>
  );
}

function CertificateCard({ certificate: c, canSignPartA, canSignPartB, exhibitCode }) {
  const session = useSelector(selectSession);
  const signA = useSignPartA();
  const signB = useSignPartB();
  const [signing, setSigning] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const link = verifyLinkFor(c.verificationToken);
  const hasA = c.signatures?.some((s) => s.role === 'PARTY');
  const hasB = c.signatures?.some((s) => s.role === 'EXPERT');
  const isDeponent = session?.authorityId && c.partA?.deponentAuthorityId === session.authorityId;

  const sign = async (part) => {
    setSigning(part);
    try {
      const keyPair = await getOrCreateKeyPair();
      const signature = await signHashHex(c.bodyHash, keyPair.privateKey);
      const mutation = part === 'A' ? signA : signB;
      await mutation.mutateAsync({ id: c.certificateId, payload: { signature } });
      toast.success(`Part ${part} signed`, {
        description: 'The signature covers the certificate body; the PDF has been re-rendered to show it.',
      });
    } catch (err) {
      toast.error(`Part ${part} not signed`, { description: err.message });
    } finally {
      setSigning(null);
    }
  };

  const download = async () => {
    setDownloading(true);
    try {
      saveBlob(await api.certificates.pdfBlob(c.certificateId), `s63-certificate-${exhibitCode ?? c.certificateId}.pdf`);
    } catch (err) {
      toast.error('The PDF could not be downloaded', { description: err.message });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <FileBadge className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Certificate {c.certificateId.slice(-6)}</span>
        <span className="text-xs text-muted-foreground">issued {fmtDate(c.generatedAt)}</span>
        <SignatureBadge present={hasA} label="Part A" />
        <SignatureBadge present={hasB} label="Part B" />
        {!c.partBComplete && (
          <Badge variant="outline" className="rounded-full">
            Part B blank — no laboratory report
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <QrImage value={link} size={132} alt="QR code for the public verifier" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            What to paste into the public verifier
          </p>
          <Hash value={link} className="block rounded-md bg-muted/60 p-2" />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () =>
                (await copyText(link)) ? toast.success('Verification link copied') : toast.error('Copy failed')
              }
            >
              <Copy className="size-3.5" /> Copy link
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () =>
                (await copyText(c.verificationToken))
                  ? toast.success('Token copied')
                  : toast.error('Copy failed')
              }
            >
              <Copy className="size-3.5" /> Copy token only
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={link} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-3.5" /> Open the verifier
              </a>
            </Button>
            <Button size="sm" variant="outline" onClick={download} disabled={downloading}>
              {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />}
              Download PDF
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The printed PDF carries this same QR. Anyone can scan it, with no account, and learn
            whether the certificate is genuine and unaltered — never what it says. Whoever you
            hand the PDF to (the other side, the court) can also drop the file itself on the
            public verifier: it tells them whether their copy is the registered document.
          </p>
        </div>
      </div>

      <KeyValue
        rows={[
          ['Deponent (Part A)', `${c.partA?.deponentName ?? '—'} · ${c.partA?.deponentAuthorityId ?? ''}`],
          ['Expert (Part B)', c.partB?.expertName ? `${c.partB.expertName} · ${c.partB.labName ?? ''}` : '—'],
          ['Evidence digest', <Hash key="h" value={c.partA?.hashValue} />],
          ['Document digest', <Hash key="d" value={c.pdfSha256} />],
        ]}
      />

      {(canSignPartA || canSignPartB) && (
        <div className="flex flex-wrap gap-2">
          {canSignPartA && !hasA && (
            <Button size="sm" onClick={() => sign('A')} disabled={Boolean(signing) || !isDeponent}>
              {signing === 'A' ? <Loader2 className="size-3.5 animate-spin" /> : <PenLine className="size-3.5" />}
              Sign Part A as deponent
            </Button>
          )}
          {canSignPartB && !hasB && c.partBComplete && (
            <Button size="sm" onClick={() => sign('B')} disabled={Boolean(signing)}>
              {signing === 'B' ? <Loader2 className="size-3.5 animate-spin" /> : <PenLine className="size-3.5" />}
              Sign Part B as examiner
            </Button>
          )}
          {canSignPartA && !hasA && !isDeponent && (
            <p className="text-xs text-muted-foreground">
              Part A names {c.partA?.deponentAuthorityId}; only they can sign it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} [props.evidenceId]  list by exhibit (everyone who may read it)
 * @param {string} [props.referralId]  list by referral (the examiner, after reporting)
 * @param {string} [props.exhibitCode]
 * @param {boolean} [props.canGenerate] the investigating officer, or the court
 * @param {boolean} [props.canSignPartA]
 * @param {boolean} [props.canSignPartB]
 */
export function CertificatePanel({ evidenceId, referralId, exhibitCode, canGenerate, canSignPartA, canSignPartB }) {
  const list = useCertificatesFor({ evidenceId, referralId });
  const generate = useGenerateCertificate();
  const certificates = list.data?.certificates ?? [];

  return (
    <div className="space-y-4">
      {canGenerate && evidenceId && (
        <div className="space-y-2">
          <Button
            onClick={() =>
              generate.mutate(evidenceId, {
                onSuccess: (d) =>
                  toast.success('Section 63 certificate issued', {
                    description: d.partBNote ?? 'Part B reproduces the laboratory report.',
                  }),
              })
            }
            disabled={generate.isPending}
          >
            {generate.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileBadge className="size-4" />}
            {certificates.length ? 'Issue a fresh certificate' : 'Generate s.63 certificate'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Part A is filled from the exhibit record and the ledger; Part B only from a filed
            laboratory report. If the record cannot support Part A, nothing is issued and the
            missing fields are listed.
          </p>
          {generate.isError && (
            <div className="space-y-2">
              <Denial error={generate.error} heading="Certificate not generated" />
              {Array.isArray(generate.error?.details?.missing) && (
                <Note tone="warn">Missing: {generate.error.details.missing.join(', ')}</Note>
              )}
            </div>
          )}
        </div>
      )}

      {list.isError && <Denial error={list.error} heading="Certificates not readable" />}
      {/* A certificate is a point-in-time statement. One issued before the laboratory
          reported has a blank Part B for good, and the examiner can sign nothing until a
          fresh one exists — so whoever can issue is told, and the lab is told why it waits. */}
      {list.isSuccess && list.data?.freshCertificateNeeded && (
        <Note tone="warn">
          {canGenerate
            ? 'A laboratory report has been filed since the newest certificate was issued, so its Part B is blank. Issue a fresh certificate: it will carry Part B, and the examiner can then sign it. Part A must be signed again on the new one.'
            : canSignPartB
              ? 'Your report is filed, but the newest certificate was issued before it and so has no Part B to sign. Ask the investigating officer or the court registry to issue a fresh certificate; it will appear here to sign.'
              : 'A laboratory report has been filed since the newest certificate was issued. A fresh certificate, carrying Part B, is due from the officer or the registry.'}
        </Note>
      )}
      {list.isSuccess && list.data?.reportFiled && certificates.length === 0 && canSignPartB && (
        <Note>
          No certificate has been issued for this exhibit yet. The investigating officer or the
          court registry issues it; once they do, Part B — your report — is here to sign.
        </Note>
      )}

      {list.isSuccess && certificates.length === 0 && (
        <EmptyState title="No certificate issued for this exhibit" icon={FileBadge}>
          {canGenerate
            ? 'Generate one above. Its QR and link are what the public verifier takes.'
            : 'The investigating officer or the court registry issues certificates.'}
        </EmptyState>
      )}

      {certificates.map((c) => (
        <CertificateCard
          key={c.certificateId}
          certificate={c}
          exhibitCode={exhibitCode ?? list.data?.exhibitCode}
          canSignPartA={canSignPartA}
          canSignPartB={canSignPartB}
        />
      ))}
    </div>
  );
}
