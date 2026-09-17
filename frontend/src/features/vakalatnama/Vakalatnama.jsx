/**
 * Vakalatnama: the only way an advocate comes on record.
 *
 *   FileVakalatnama — the advocate's side. The signed PDF is hashed and signed in this
 *                     browser, then filed against a CNR. Filing grants nothing.
 *   MyFilings       — what the advocate has filed, and how the court ruled.
 *
 * The court's side used to live here too. It is now part of the court's own case
 * panel (`features/court/CourtPage.jsx`), because ruling on a filing is one of the
 * three things a court does to a case and it belongs beside the other two rather than
 * on a tab of its own. The authority moved as well: the registrar is gone, and the
 * presiding judge — the identity the court directory's roster already vouches for —
 * takes counsel on record.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { FileDown, FileSignature, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

import { Empty, RowsSkeleton } from '@/components/common/Shell';
import { Denial } from '@/components/common/Verdicts';
import { useFileVakalatnama, useMyFilings } from '@/hooks/queries';
import { api } from '@/lib/api';
import { getOrCreateKeyPair, hashFile, signHashHex } from '@/lib/crypto';
import { saveBlob } from '@/lib/download';
import { cn, fmtBytes, fmtDate, humanise } from '@/lib/utils';

const STATUS_STYLE = {
  PENDING: 'border-warn/35 bg-warn-muted text-warn',
  ACCEPTED: 'border-ok/35 bg-ok-muted text-ok',
  REJECTED: 'border-bad/35 bg-bad-muted text-bad',
};

async function downloadFiling(filing) {
  try {
    saveBlob(await api.vakalatnama.documentBlob(filing.id), `vakalatnama-${filing.cnrNumber}.pdf`);
  } catch (err) {
    toast.error('The document could not be downloaded', { description: err.message });
  }
}

// ============================================================== the filing ====

/**
 * File a vakalatnama. A dialog, because it is something an advocate does a handful of
 * times and then never again for that case — not something they arrive at the screen
 * to look at.
 */
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
      toast.error('The document could not be hashed and signed on this device', {
        description: err.message,
      });
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
        toast.success('Vakalatnama filed', {
          description: 'It is before the court. It grants you nothing until the court rules.',
        });
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
          <FileSignature className="size-4" />
          File a vakalatnama
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>File a vakalatnama</DialogTitle>
          <DialogDescription>
            How you come on record. The signed PDF is hashed and signed in this browser with
            your registered key before it is sent. Filing grants you nothing — the court the
            case is listed before rules on it, and the court register records the appearance
            before Nyayyalya opens the case to you.
          </DialogDescription>
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
              <p className="text-[12px] text-muted-foreground">
                From the court&rsquo;s cause list or case status page.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vak-side">Appearing for</Label>
              <Select value={appearingFor} onValueChange={setAppearingFor}>
                <SelectTrigger id="vak-side"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACCUSED">The accused (defence counsel)</SelectItem>
                  <SelectItem value="VICTIM">The victim (victim&rsquo;s counsel)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vak-party">Party executing the vakalatnama</Label>
            <Input
              id="vak-party"
              value={partyName}
              onChange={(e) => setPartyName(e.target.value)}
              placeholder="Name as it appears on the document"
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
              <p className="text-[12px] text-muted-foreground">
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
            {busy ? <Loader2 className="size-4 animate-spin" /> : <FileSignature className="size-4" />}
            {signing ? 'Hashing and signing…' : fileIt.isPending ? 'Filing…' : 'Sign and file'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================= the filings ====

export function MyFilings() {
  const query = useMyFilings();
  const filings = query.data?.filings ?? [];

  if (query.isPending) return <RowsSkeleton rows={2} />;
  if (query.isError) return <Denial error={query.error} heading="Filings not readable" />;
  if (!filings.length) {
    return (
      <Empty title="You have filed nothing yet" icon={FileSignature}>
        File a vakalatnama to be taken on record in a case. Until the court accepts it, it
        grants you nothing — not even the knowledge that the case exists.
      </Empty>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {filings.map((f) => (
        <li key={f.id} className="flex items-start justify-between gap-3 px-3.5 py-3">
          <div className="min-w-0 space-y-0.5">
            <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
              <code className="font-mono">{f.cnrNumber}</code>
              <Badge
                variant="outline"
                className={cn('rounded-full px-2 py-0 text-[11px]', STATUS_STYLE[f.status])}
              >
                {humanise(f.status)}
              </Badge>
            </p>
            <p className="text-[12px] text-muted-foreground">
              For the {humanise(f.appearingFor).toLowerCase()} ({f.partyName}) · filed{' '}
              {fmtDate(f.filedAt)}
            </p>
            <p className="text-[12px] text-muted-foreground">
              {f.status === 'PENDING'
                ? 'Before the court, awaiting a ruling.'
                : `${humanise(f.status)} ${fmtDate(f.decidedAt)} by ${f.decidedByAuthorityId ?? '—'}`}
            </p>
            {f.decisionNote && (
              <p className="text-[12px] italic">&ldquo;{f.decisionNote}&rdquo;</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => downloadFiling(f)}
            aria-label="Download the filed document"
          >
            <FileDown className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
