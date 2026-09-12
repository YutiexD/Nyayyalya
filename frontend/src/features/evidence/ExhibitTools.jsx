/**
 * Exhibit tools every role that may read an exhibit shares: open the file, and run
 * the four independent integrity checks.
 *
 * One implementation, used by the officer, the court and counsel, so the same exhibit
 * is verified the same way whoever is looking — a court that saw a different verdict
 * layout from the police would reasonably ask which one to believe.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { FileDown, FileCheck2, Link2, ShieldCheck, Anchor, Fingerprint, Loader2, ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { LightTile } from '@/components/common/Premium';
import { Hash, KeyValue } from '@/components/common/Primitives';
import { Denial } from '@/components/common/Verdicts';
import { useVerifyExhibit } from '@/hooks/queries';
import { api } from '@/lib/api';
import { openBlob } from '@/lib/download';
import { humanise } from '@/lib/utils';

/**
 * Open the exhibit's decrypted bytes. Each click mints a fresh single-use token and is
 * written to the audit log as a DOWNLOAD — so it is a button, never a prefetch.
 */
export function OpenExhibitButton({ exhibit, size = 'sm', variant = 'outline' }) {
  const [busy, setBusy] = useState(false);
  const id = exhibit?._id ?? exhibit?.evidenceId;
  if (!id) return null;

  const onOpen = async () => {
    setBusy(true);
    try {
      const blob = await api.evidence.fileBlob(id);
      openBlob(blob, exhibit.exhibitCode ?? 'exhibit');
    } catch (err) {
      toast.error('The file could not be opened', { description: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size={size} variant={variant} onClick={onOpen} disabled={busy}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />}
      Open the file
    </Button>
  );
}

const FILE_TONE = { FILE_INTACT: 'ok', FILE_MODIFIED: 'bad', FILE_MISSING: 'warn' };
const ANCHOR_TONE = {
  ANCHOR_MATCH: 'ok',
  ANCHOR_LOCAL_ONLY: 'warn',
  NOT_ANCHORED: 'warn',
  ANCHOR_UNAVAILABLE: 'warn',
  ANCHOR_MISMATCH: 'bad',
};

const ANCHOR_WHY = {
  ANCHOR_MATCH: 'The recomputed Merkle root matches the root written on chain, and this entry proves as a member of it.',
  ANCHOR_LOCAL_ONLY:
    'The root matches our own stored copy, but it has not been submitted to a chain yet — internal consistency only.',
  NOT_ANCHORED: 'This upload has not been gathered into an anchor batch yet. Batches run every few minutes.',
  ANCHOR_UNAVAILABLE: 'The anchor batch record could not be read.',
  ANCHOR_MISMATCH: 'The root recomputed from the ledger no longer matches the anchored root. Escalate.',
};

/** The four lights, computed server-side from first principles on every click. */
export function VerifyExhibitPanel({ evidenceId }) {
  const verify = useVerifyExhibit();
  const report = verify.data;

  return (
    <div className="space-y-4">
      <Button
        variant="outline"
        disabled={verify.isPending || !evidenceId}
        onClick={() => verify.mutate(evidenceId)}
      >
        {verify.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        Verify this exhibit
      </Button>

      {verify.isError && <Denial error={verify.error} heading="Verification refused" />}

      {report && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <LightTile
              index={1}
              title="Stored file"
              icon={FileCheck2}
              state={humanise(report.fileIntegrity)}
              tone={FILE_TONE[report.fileIntegrity]}
              explanation="The stored bytes, decrypted and re-hashed now, against the digest recorded at upload."
            />
            <LightTile
              index={2}
              title="Uploader signature"
              icon={Fingerprint}
              state={report.signatureValid ? 'Verified' : 'Not verified'}
              tone={report.signatureValid ? 'ok' : 'bad'}
              explanation="The officer's ECDSA signature over the original digest, checked against the key that made it."
            />
            <LightTile
              index={3}
              title="Ledger chain"
              icon={Link2}
              state={humanise(report.chainIntegrity)}
              tone={report.chainIntegrity === 'CHAIN_INTACT' ? 'ok' : 'bad'}
              explanation={
                report.chainCheckedFrom != null
                  ? `Recomputed from sequence ${report.chainCheckedFrom} to ${report.chainCheckedTo}; earlier entries are covered by the anchored root.`
                  : 'Every entry recomputed against the one before it.'
              }
            />
            <LightTile
              index={4}
              title="Anchored root"
              icon={Anchor}
              state={humanise(report.anchorIntegrity)}
              tone={ANCHOR_TONE[report.anchorIntegrity]}
              explanation={ANCHOR_WHY[report.anchorIntegrity]}
            />
          </div>

          <KeyValue
            rows={[
              ['Expected digest', <Hash key="e" value={report.expectedSha256} />],
              ['Recomputed digest', <Hash key="r" value={report.recomputedSha256} />],
              report.anchorTxHash && ['Anchor transaction', <Hash key="t" value={report.anchorTxHash} />],
            ]}
          />

          {report.anchorExplorerUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={report.anchorExplorerUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-3.5" />
                See the anchor on the Monad Testnet explorer
              </a>
            </Button>
          )}

          <p className="text-sm">{report.interpretation}</p>
        </div>
      )}
    </div>
  );
}
