/**
 * The laboratory's verdict on one exhibit.
 *
 * The verdict is hashed and signed in this browser over the same statement the server
 * rebuilds from the fields it receives, so the opinion cannot change between signing
 * and sending. The report PDF is optional; its digest is covered by the signature.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, PenLine } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Denial } from '@/components/common/Verdicts';
import { useRecordVerdict } from '@/hooks/queries';
import { getOrCreateKeyPair, hashFile, hashString, signHashHex } from '@/lib/crypto';
import { cn } from '@/lib/utils';

/** The whole authenticity vocabulary. There is no fourth value. */
const OPINIONS = [
  { value: 'AUTHENTIC', label: 'Authentic', active: 'border-ok/50 bg-ok-muted text-ok' },
  { value: 'MANIPULATED', label: 'Manipulated', active: 'border-bad/50 bg-bad-muted text-bad' },
  { value: 'INCONCLUSIVE', label: 'Inconclusive', active: 'border-warn/50 bg-warn-muted text-warn' },
];

/** Built exactly as the server rebuilds it (controllers/fsl.js `verdictStatement`). */
const verdictStatement = ({ exhibitCode, opinion, examinationSummary, documentSha256 }) =>
  ['LEXX-FSL-VERDICT', 'v1', exhibitCode, opinion, examinationSummary, documentSha256 ?? '-'].join('|');

export function VerdictForm({ exhibit, onRecorded }) {
  const record = useRecordVerdict();
  const [opinion, setOpinion] = useState('');
  const [summary, setSummary] = useState('');
  const [file, setFile] = useState(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState(null);

  const busy = signing || record.isPending;
  const ready = Boolean(opinion && summary.trim());

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!ready || busy) return;

    setSignError(null);
    setSigning(true);
    const examinationSummary = summary.trim();

    let documentSha256 = null;
    let verdictSha256;
    let verdictSignature;
    try {
      if (file) documentSha256 = await hashFile(file);
      verdictSha256 = await hashString(
        verdictStatement({ exhibitCode: exhibit.exhibitCode, opinion, examinationSummary, documentSha256 })
      );
      const keyPair = await getOrCreateKeyPair();
      verdictSignature = await signHashHex(verdictSha256, keyPair.privateKey);
    } catch (err) {
      setSignError({ code: 'VERDICT_NOT_SIGNED', message: err.message });
      return;
    } finally {
      setSigning(false);
    }

    const form = new FormData();
    form.set('opinion', opinion);
    form.set('examinationSummary', examinationSummary);
    form.set('verdictSha256', verdictSha256);
    form.set('verdictSignature', verdictSignature);
    if (file) form.set('report', file);

    record.mutate(
      { evidenceId: exhibit._id, form },
      {
        onSuccess: (result) => {
          onRecorded?.(result);
          toast.success('Verdict recorded');
        },
      }
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <p className="text-label font-medium text-muted-foreground" id="verdict-opinion">
          Opinion
        </p>
        <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="verdict-opinion">
          {OPINIONS.map((o) => {
            const selected = opinion === o.value;
            return (
              <button
                key={o.value}
                type="button"
                disabled={busy}
                onClick={() => setOpinion(o.value)}
                aria-pressed={selected}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-meta font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
                  selected ? o.active : 'text-foreground hover:bg-muted/60'
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="verdict-summary" className="text-label text-muted-foreground">
          Finding
        </Label>
        <Textarea
          id="verdict-summary"
          required
          rows={4}
          disabled={busy}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="verdict-file" className="text-label text-muted-foreground">
          Report PDF (optional)
        </Label>
        <Input
          id="verdict-file"
          type="file"
          accept="application/pdf"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>

      <Button type="submit" disabled={busy || !ready} className="w-full sm:w-auto">
        {busy ? <Loader2 className="animate-spin" /> : <PenLine />}
        {signing ? 'Signing…' : record.isPending ? 'Recording…' : 'Sign and record verdict'}
      </Button>

      {signError && <Denial error={signError} heading="Verdict not signed" />}
      {record.isError && <Denial error={record.error} heading="Verdict not recorded" />}
    </form>
  );
}
