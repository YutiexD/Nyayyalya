/**
 * Exhibit tools every role that may read an exhibit shares: open or preview the file,
 * and run the exhibit integrity checks.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, ExternalLink, FileDown, Loader2, ShieldCheck, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Row, Rows } from '@/components/common/Shell';
import { Denial } from '@/components/common/Verdicts';
import { useVerifyExhibit } from '@/hooks/queries';
import { api } from '@/lib/api';
import { openBlob } from '@/lib/download';
import { humanise } from '@/lib/utils';

const exhibitId = (exhibit) => exhibit?._id ?? exhibit?.evidenceId ?? null;

/** Media a browser can show inline safely. PDFs open in a tab instead. */
const PREVIEWABLE = /^(image\/(png|jpeg|gif|webp)|video\/|audio\/)/;

/**
 * Open the exhibit's file. Each click mints a fresh single-use token and is audited as
 * a DOWNLOAD — so it is a button, never a prefetch.
 */
export function OpenExhibitButton({ exhibit, size = 'sm', variant = 'outline', label = 'Open file' }) {
  const [busy, setBusy] = useState(false);
  const id = exhibitId(exhibit);
  if (!id) return null;

  const onOpen = async () => {
    setBusy(true);
    try {
      openBlob(await api.evidence.fileBlob(id), exhibit.exhibitCode ?? 'exhibit');
    } catch (err) {
      toast.error('The file could not be opened', { description: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size={size} variant={variant} onClick={onOpen} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <FileDown />}
      {label}
    </Button>
  );
}

/**
 * Open file, plus an inline preview for images, video and audio (loaded on request).
 * `children` are extra actions rendered in the same button row.
 */
export function ExhibitFile({ exhibit, children }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const id = exhibitId(exhibit);
  const canPreview = PREVIEWABLE.test(exhibit?.mimeType ?? '');

  useEffect(() => {
    if (!preview) return undefined;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  if (!id) return null;

  const load = async () => {
    setLoading(true);
    try {
      const blob = await api.evidence.fileBlob(id);
      if (PREVIEWABLE.test(blob.type)) setPreview({ url: URL.createObjectURL(blob), type: blob.type });
      else openBlob(blob, exhibit.exhibitCode ?? 'exhibit');
    } catch (err) {
      toast.error('The file could not be loaded', { description: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {canPreview &&
          (preview ? (
            <Button size="sm" variant="outline" onClick={() => setPreview(null)}>
              <X />
              Hide preview
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <Eye />}
              Preview
            </Button>
          ))}
        <OpenExhibitButton exhibit={exhibit} />
        {children}
      </div>
      {preview && (
        <div className="overflow-hidden rounded-lg border bg-muted/40">
          {preview.type.startsWith('image/') && (
            <img src={preview.url} alt={exhibit.title ?? 'Exhibit'} className="mx-auto max-h-[50vh] object-contain" />
          )}
          {preview.type.startsWith('video/') && (
            <video src={preview.url} controls className="mx-auto max-h-[50vh] w-full" />
          )}
          {preview.type.startsWith('audio/') && <audio src={preview.url} controls className="w-full p-3" />}
        </div>
      )}
    </div>
  );
}

const TONE = { ok: 'success', warn: 'warning', bad: 'danger' };
const FILE_TONE = { FILE_INTACT: 'ok', FILE_MODIFIED: 'bad', FILE_MISSING: 'warn' };
const ANCHOR_TONE = {
  ANCHOR_MATCH: 'ok',
  ANCHOR_LOCAL_ONLY: 'warn',
  NOT_ANCHORED: 'warn',
  ANCHOR_UNAVAILABLE: 'warn',
  ANCHOR_MISMATCH: 'bad',
};

/** The exhibit integrity checks, recomputed on the server on every click. */
export function VerifyExhibitPanel({ evidenceId }) {
  const verify = useVerifyExhibit();
  const mine = verify.variables === evidenceId;
  const report = mine ? verify.data : null;

  const rows = report
    ? [
        ['Stored file', humanise(report.fileIntegrity), FILE_TONE[report.fileIntegrity]],
        ['Uploader signature', report.signatureValid ? 'Valid' : 'Invalid', report.signatureValid ? 'ok' : 'bad'],
        ['Ledger chain', humanise(report.chainIntegrity), report.chainIntegrity === 'CHAIN_INTACT' ? 'ok' : 'bad'],
        ['Anchored root', humanise(report.anchorIntegrity), ANCHOR_TONE[report.anchorIntegrity]],
      ]
    : [];

  return (
    <div className="space-y-3">
      <Button
        size="sm"
        variant="outline"
        disabled={verify.isPending || !evidenceId}
        onClick={() => verify.mutate(evidenceId)}
      >
        {verify.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
        Check exhibit integrity
      </Button>

      {mine && verify.isError && <Denial error={verify.error} heading="Check refused" />}

      {report && (
        <Rows className="rounded-lg border">
          {rows.map(([label, state, tone]) => (
            <Row
              key={label}
              title={label}
              badge={
                <Badge variant={TONE[tone] ?? 'neutral'} size="sm" dot>
                  {state || '—'}
                </Badge>
              }
            />
          ))}
        </Rows>
      )}

      {report?.anchorExplorerUrl && (
        <Button asChild variant="link" size="sm">
          <a href={report.anchorExplorerUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink />
            View anchor transaction
          </a>
        </Button>
      )}
    </div>
  );
}
