/**
 * Pieces shared by the police case pages (investigating officer and station).
 *
 *   CaseListItem   one case in the list: title, FIR / court / evidence / last activity, stage
 *   CaseHeading    title, FIR and CNR, stage badge and page-level actions for the selected case
 *   EvidenceTable  exhibit code, title, type, uploaded, certificate, FSL verdict, print QR label
 *   CourtFact      "Court: X", with the jurisdiction reasons behind a small toggle
 *
 * Deliberately nothing about AI analysis or priorities.
 */
import { ChevronRight, FileText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

import { CopyableValue } from '@/components/common/CopyButton';
import { Empty, MetaLine, Row } from '@/components/common/Shell';
import { StageBadge } from '@/components/common/Lifecycle';
import { ForensicBadge } from '@/components/common/Verdicts';
import { CertificateStatusBadge } from '@/features/certificates/CertificatePanel';
import { PrintQrLabelButton } from '@/features/evidence/QrLabel';
import { cn } from '@/lib/utils';

/** Investigative writes stop at the chargesheet. */
export const WRITABLE_STAGES = ['UNDER_INVESTIGATION', 'FURTHER_INVESTIGATION'];

/** "12 Sep 2026". */
export function shortDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A readable file type from the MIME type. */
export function fileType(mimeType) {
  const m = String(mimeType ?? '').toLowerCase();
  if (!m) return 'File';
  if (m.startsWith('video/')) return 'Video';
  if (m.startsWith('audio/')) return 'Audio';
  if (m.startsWith('image/')) return 'Image';
  if (m === 'application/pdf') return 'PDF';
  if (m.includes('zip') || m.includes('compressed') || m.includes('tar')) return 'Archive';
  if (m.includes('sheet') || m.includes('csv') || m.includes('excel')) return 'Spreadsheet';
  if (m.includes('word') || m.includes('document') || m.startsWith('text/')) return 'Document';
  return 'File';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function CaseListItem({ c, selected, onSelect }) {
  const exhibits = c.summary?.exhibits ?? 0;
  return (
    <Row
      title={c.title}
      meta={
        <MetaLine
          items={[
            `FIR ${c.firNumber}`,
            plural(exhibits, 'exhibit'),
            shortDate(c.summary?.lastActivityAt ?? c.updatedAt),
          ]}
        />
      }
      selected={selected}
      onSelect={onSelect}
    >
      <span className="mt-2 flex flex-wrap items-center gap-2">
        <StageBadge stage={c.stage} />
        {c.courtName && <span className="truncate text-meta text-muted-foreground">{c.courtName}</span>}
      </span>
    </Row>
  );
}

export function CaseHeading({ c, actions }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 space-y-2">
        <h2 className="text-xl font-semibold leading-tight tracking-tight text-foreground text-balance">
          {c.title}
        </h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StageBadge stage={c.stage} size="default" />
          <MetaLine
            items={[
              <span key="fir" className="text-foreground">FIR {c.firNumber}</span>,
              c.cnrNumber && (
                <span key="cnr" className="inline-flex items-center gap-1">
                  CNR <CopyableValue value={c.cnrNumber} label="Copy CNR" />
                </span>
              ),
            ]}
          />
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CourtFact({ c }) {
  const reasons = c.jurisdictionComputed?.reasons ?? [];
  const court = c.courtName ?? 'Assigned when the chargesheet is filed';

  return (
    <div className="text-body">
      <p>
        <span className="text-muted-foreground">Court: </span>
        <span className={cn('font-medium', !c.courtName && 'font-normal text-muted-foreground')}>{court}</span>
      </p>
      {reasons.length > 0 && (
        <details className="group mt-1">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-meta text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
            Why this court
          </summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-9 text-meta text-muted-foreground">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The certificate status to show: the card carries `status` (and sometimes `state`). */
const certStatus = (cert) => (cert ? (cert.state === 'ISSUED' ? 'ISSUED' : cert.status ?? cert.state) : null);

/** `caseInfo.firNumber` is printed on the QR labels. */
export function EvidenceTable({ evidence, onOpen, empty, caseInfo }) {
  if (!evidence.length) {
    return empty ?? <Empty title="No evidence yet" icon={FileText} compact />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-5">Exhibit</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Uploaded</TableHead>
          <TableHead>Certificate</TableHead>
          <TableHead>FSL verdict</TableHead>
          <TableHead className="w-12 pr-4">
            <span className="sr-only">QR label</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {evidence.map((e) => (
          <TableRow
            key={e._id}
            className="cursor-pointer"
            onClick={() => onOpen(e._id)}
          >
            <TableCell className="min-w-[14rem] py-3 pl-5">
              <button
                type="button"
                className="block max-w-[22rem] truncate text-left text-[15px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpen(e._id);
                }}
              >
                {e.title}
              </button>
              <code className="font-mono text-[12px] text-muted-foreground">{e.exhibitCode}</code>
            </TableCell>
            <TableCell className="text-meta text-muted-foreground">
              <Badge variant="neutral" size="sm">{fileType(e.mimeType)}</Badge>
            </TableCell>
            <TableCell className="whitespace-nowrap text-meta text-muted-foreground">
              {shortDate(e.createdAt) ?? '—'}
            </TableCell>
            <TableCell>
              <CertificateStatusBadge status={certStatus(e.certificate)} />
            </TableCell>
            <TableCell>
              <ForensicBadge forensic={e.forensic} />
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
