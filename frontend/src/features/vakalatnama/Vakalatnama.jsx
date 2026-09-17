/**
 * Vakalatnama: how an advocate comes on record.
 *
 *   FileVakalatnama   counsel: the signed PDF is hashed and signed in this browser, then
 *                     filed against a CNR.
 *   MyFilings         counsel: what they have filed and how the court ruled.
 *   FilingRuling      court: accept or reject one pending filing. Accepting gives the
 *                     advocate the case and every exhibit automatically.
 *   FilingStatusBadge Pending / Accepted / Rejected.
 */
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Check, FileDown, FileSignature, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

import { CopyableValue } from '@/components/common/CopyButton';
import { Empty, MetaLine, Row, Rows, RowsSkeleton } from '@/components/common/Shell';
import { Denial } from '@/components/common/Verdicts';
import { useFileVakalatnama, useMyFilings, useRuleOnFiling } from '@/hooks/queries';
import { api } from '@/lib/api';
import { getOrCreateKeyPair, hashFile, signHashHex } from '@/lib/crypto';
import { saveBlob } from '@/lib/download';
import { cn, fmtBytes, fmtDate, humanise } from '@/lib/utils';

/** The one line the court sees when ruling on a filing. */
export const ACCEPT_ACCESS_COPY = 'Accepting gives this advocate access to the case and its evidence automatically.';

const FILING_STATUS = {
  PENDING: { label: 'Pending', variant: 'warning' },
  ACCEPTED: { label: 'Accepted', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'danger' },
  WITHDRAWN: { label: 'Withdrawn', variant: 'muted' },
};

export function FilingStatusBadge({ status, size = 'sm', className }) {
  const s = FILING_STATUS[status] ?? { label: humanise(status) || '—', variant: 'neutral' };
  return (
    <Badge variant={s.variant} size={size} dot className={className}>
      {s.label}
    </Badge>
  );
}

async function downloadFiling(filing) {
  try {
    saveBlob(await api.vakalatnama.documentBlob(filing.id), `vakalatnama-${filing.cnrNumber}.pdf`);
  } catch (err) {
    toast.error('The document could not be downloaded', { description: err.message });
  }
}

// ============================================================== the filing ====

export function FileVakalatnama() {
  const fileIt = useFileVakalatnama();
  const [open, setOpen] = useState(false);
  const [cnr, setCnr] = useState('');
  const [appearingFor, setAppearingFor] = useState('ACCUSED');
  const [partyName, setPartyName] = useState('');
  const [file, setFile] = useState(null);
  const [signing, setSigning] = useState(false);

  const busy = signing || fileIt.isPending;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    setSigning(true);
    let sha256;
    let signature;
    try {
      sha256 = await hashFile(file);
      const keyPair = await getOrCreateKeyPair();
      signature = await signHashHex(sha256, keyPair.privateKey);
    } catch (err) {
      toast.error('The document could not be signed on this device', { description: err.message });
      return;
    } finally {
      setSigning(false);
    }

    const form = new FormData();
    form.set('cnrNumber', cnr.trim().toUpperCase());
    form.set('appearingFor', appearingFor);
    form.set('partyName', partyName.trim());
    form.set('documentSha256', sha256);
    form.set('documentSignature', signature);
    form.set('document', file);

    fileIt.mutate(form, {
      onSuccess: () => {
        toast.success('Vakalatnama filed', { description: 'Awaiting the court.' });
        setCnr('');
        setPartyName('');
        setFile(null);
        setOpen(false);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <FileSignature />
          File vakalatnama
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>File vakalatnama</DialogTitle>
          <DialogDescription>Once the court accepts it, the case and its evidence open to you.</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="vak-cnr">CNR number</Label>
              <Input
                id="vak-cnr"
                value={cnr}
                onChange={(e) => setCnr(e.target.value)}
                placeholder="UPGB010012342026"
                className="font-mono uppercase"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vak-side">Appearing for</Label>
              <Select value={appearingFor} onValueChange={setAppearingFor}>
                <SelectTrigger id="vak-side">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACCUSED">Accused</SelectItem>
                  <SelectItem value="VICTIM">Victim</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vak-party">Party name</Label>
            <Input
              id="vak-party"
              value={partyName}
              onChange={(e) => setPartyName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vak-doc">Signed vakalatnama (PDF)</Label>
            <Input
              id="vak-doc"
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
              disabled={busy}
            />
            {file && (
              <p className="text-label text-muted-foreground">
                {file.name} · {fmtBytes(file.size)}
              </p>
            )}
          </div>

          {fileIt.isError && <Denial error={fileIt.error} heading="Vakalatnama not filed" />}

          <Button
            type="submit"
            className="w-full"
            disabled={busy || !file || !cnr.trim() || partyName.trim().length < 2}
          >
            {busy ? <Loader2 className="animate-spin" /> : <FileSignature />}
            {signing ? 'Signing…' : fileIt.isPending ? 'Filing…' : 'Sign and file'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================= the filings ====

/** The advocate's filings as rows. Put it in a Panel with `bodyClassName="p-0"`. */
export function MyFilings({ className }) {
  const query = useMyFilings();
  const filings = query.data?.filings ?? [];

  if (query.isPending) return <RowsSkeleton rows={2} />;
  if (query.isError) return <Denial error={query.error} heading="Filings not readable" />;
  if (!filings.length) {
    return <Empty compact title="No filings yet" icon={FileSignature} />;
  }

  return (
    <Rows className={className}>
      {filings.map((f) => (
        <Row
          key={f.id}
          title={<CopyableValue value={f.cnrNumber} label="Copy CNR" />}
          meta={
            <MetaLine
              items={[
                `For the ${humanise(f.appearingFor).toLowerCase()}${f.partyName ? ` (${f.partyName})` : ''}`,
                `Filed ${fmtDate(f.filedAt)}`,
                f.status === 'ACCEPTED' && 'Access granted',
                f.status === 'REJECTED' && f.decidedAt && `Rejected ${fmtDate(f.decidedAt)}`,
              ]}
            />
          }
          badge={<FilingStatusBadge status={f.status} />}
          actions={
            <Button variant="ghost" size="icon-sm" onClick={() => downloadFiling(f)} aria-label="Download filed document">
              <FileDown />
            </Button>
          }
        >
          {f.decisionNote && (
            <span className="block truncate text-label italic text-muted-foreground">&ldquo;{f.decisionNote}&rdquo;</span>
          )}
        </Row>
      ))}
    </Rows>
  );
}

// ============================================================== the court ====

/**
 * The court's ruling on one pending filing: Accept, or Reject with a reason.
 *
 * @param {object} props
 * @param {object} props.filing                 a filing view with `id`
 * @param {(decision: 'ACCEPT'|'REJECT') => void} [props.onDone]
 */
export function FilingRuling({ filing, onDone, className }) {
  const rule = useRuleOnFiling();
  const noteId = useId();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  const decide = (decision) =>
    rule.mutate(
      { id: filing.id, decision, note: decision === 'REJECT' ? note.trim() : undefined },
      {
        onSuccess: () => {
          if (decision === 'ACCEPT') {
            toast.success('Vakalatnama accepted', { description: 'The advocate now has access to the case.' });
          } else {
            toast.success('Vakalatnama rejected');
          }
          setRejecting(false);
          setNote('');
          onDone?.(decision);
        },
      }
    );

  return (
    <div className={cn('space-y-2', className)}>
      {rejecting ? (
        <div className="space-y-2">
          <Label htmlFor={noteId}>Reason for rejection</Label>
          <Textarea id={noteId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={rule.isPending || note.trim().length < 3}
              onClick={() => decide('REJECT')}
            >
              {rule.isPending && <Loader2 className="animate-spin" />}
              Reject
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)} disabled={rule.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={rule.isPending} onClick={() => decide('ACCEPT')}>
            {rule.isPending ? <Loader2 className="animate-spin" /> : <Check />}
            Accept
          </Button>
          <Button size="sm" variant="outline" disabled={rule.isPending} onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      )}
      <p className="text-meta text-muted-foreground">{ACCEPT_ACCESS_COPY}</p>
      {rule.isError && <Denial error={rule.error} heading="Ruling not recorded" />}
    </div>
  );
}
