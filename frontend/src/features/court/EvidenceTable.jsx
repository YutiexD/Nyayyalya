/**
 * The exhibits on a case, as one table, for the court and for counsel.
 *
 * Columns: exhibit (code + title), type, added, FSL verdict, s.63 certificate. The
 * certificate is verified in place with one click; clicking a row opens the exhibit.
 * Rows are in exhibit-code order — nothing here is ordered or labelled by any automated
 * assessment.
 */
import { toast } from 'sonner';
import { FileAudio, FileImage, FileText, FileVideo, Loader2, ShieldCheck, ShieldX } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Empty } from '@/components/common/Shell';
import { ForensicBadge } from '@/components/common/Verdicts';
import { CertificateStatusBadge } from '@/features/certificates/CertificatePanel';
import { PrintQrLabelButton } from '@/features/evidence/QrLabel';
import { useVerifyCertificate } from '@/hooks/queries';
import { explain } from '@/lib/api';
import { fmtDate, humanise } from '@/lib/utils';

function KindIcon({ mimeType }) {
  const m = mimeType ?? '';
  const Icon = m.startsWith('image/')
    ? FileImage
    : m.startsWith('video/')
      ? FileVideo
      : m.startsWith('audio/')
        ? FileAudio
        : FileText;
  return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

/** One click: Verify → Verified / Failed. Clicking the result runs it again. */
function VerifyCertificate({ certificateId }) {
  const verify = useVerifyCertificate();
  if (!certificateId) return null;

  const run = (event) => {
    event.stopPropagation();
    verify.mutate(certificateId, {
      onError: (err) => toast.error('Verification not run', { description: explain(err.code, err.message) }),
    });
  };

  if (verify.isPending) {
    return (
      <Button size="xs" variant="ghost" disabled>
        <Loader2 className="animate-spin" />
        Verifying
      </Button>
    );
  }

  if (verify.data) {
    const ok = verify.data.result === 'VERIFIED';
    return (
      <button
        type="button"
        onClick={run}
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Verify the certificate again"
      >
        <Badge variant={ok ? 'success' : 'danger'} size="default">
          {ok ? <ShieldCheck /> : <ShieldX />}
          {ok ? 'Verified' : 'Failed'}
        </Badge>
      </button>
    );
  }

  return (
    <Button size="xs" variant="outline" onClick={run}>
      <ShieldCheck />
      Verify
    </Button>
  );
}

/**
 * @param {object} props
 * @param {Array<{id: string, exhibitCode: string, title: string, kind?: string, mimeType?: string,
 *   createdAt?: string, forensic?: object, certificateId?: string|null, certificateStatus?: string,
 *   label?: {token: string, url: string}}>} props.items
 * @param {(id: string) => void} props.onOpen
 * @param {{ firNumber?: string }} [props.caseInfo]  printed on the QR labels
 */
export function EvidenceTable({ items, onOpen, caseInfo }) {
  if (!items.length) return <Empty compact title="No evidence on this case" icon={FileText} />;

  const rows = [...items].sort((a, b) =>
    String(a.exhibitCode ?? '').localeCompare(String(b.exhibitCode ?? ''), undefined, { numeric: true })
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-5">Exhibit</TableHead>
          <TableHead className="hidden md:table-cell">Type</TableHead>
          <TableHead className="hidden sm:table-cell">Added</TableHead>
          <TableHead>FSL verdict</TableHead>
          <TableHead>s.63 certificate</TableHead>
          <TableHead className="w-12 pr-4">
            <span className="sr-only">QR label</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((e) => (
          <TableRow
            key={e.id}
            tabIndex={0}
            className="cursor-pointer"
            onClick={() => onOpen(e.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen(e.id);
              }
            }}
          >
            <TableCell className="py-3 pl-5">
              <div className="flex min-w-0 items-center gap-3">
                <KindIcon mimeType={e.mimeType} />
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-medium leading-6 text-foreground">{e.title}</p>
                  <code className="font-mono text-[12px] text-muted-foreground">{e.exhibitCode}</code>
                </div>
              </div>
            </TableCell>
            <TableCell className="hidden text-meta text-muted-foreground md:table-cell">
              {humanise(e.kind) || e.mimeType || '—'}
            </TableCell>
            <TableCell className="hidden whitespace-nowrap text-meta text-muted-foreground sm:table-cell">
              {fmtDate(e.createdAt)}
            </TableCell>
            <TableCell>
              <ForensicBadge forensic={e.forensic} />
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-2">
                <CertificateStatusBadge status={e.certificateStatus} />
                <VerifyCertificate certificateId={e.certificateId} />
              </div>
            </TableCell>
            <TableCell className="pr-4 text-right">
              <PrintQrLabelButton exhibit={e} caseInfo={caseInfo} iconOnly />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
