/**
 * One exhibit, worked on by the laboratory: the file, the AI analysis, the FSL verdict
 * and the s.63 certificate. The case-list card renders at once; the full record replaces
 * it when it arrives (and a refused full read simply leaves the card in place).
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { FlaskConical } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { MetaLine } from '@/components/common/Shell';
import { AiAnalysisPanel, ForensicOpinion } from '@/components/common/Verdicts';
import { ExhibitFile } from '@/features/evidence/ExhibitTools';
import { CertificateCard } from '@/features/certificates/CertificatePanel';
import { QrLabelSection } from '@/features/evidence/QrLabel';
import { ExhibitLifecycleSection, exhibitCnr } from '@/features/evidence/ExhibitDialog';
import { CopyableValue } from '@/components/common/CopyButton';
import { useExhibit, useRetryAiAnalysis } from '@/hooks/queries';
import { fmtBytes, fmtDate, humanise } from '@/lib/utils';

import { VerdictForm } from './VerdictForm';

function VerdictSection({ exhibit }) {
  const [recorded, setRecorded] = useState(null);
  const forensic = exhibit.forensic?.opinion ? exhibit.forensic : recorded?.forensic;

  if (forensic?.opinion) return <ForensicOpinion forensic={forensic} />;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label="FSL verdict">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-section text-foreground">
          <FlaskConical aria-hidden className="size-4 text-muted-foreground" />
          FSL verdict
        </h3>
        <Badge variant="muted" size="sm">
          Not recorded
        </Badge>
      </div>
      <VerdictForm exhibit={exhibit} onRecorded={setRecorded} />
    </section>
  );
}

function Workspace({ card, caseInfo }) {
  const query = useExhibit(card._id);
  const retry = useRetryAiAnalysis();
  const e = query.data?.evidence ?? card;

  const onRetry = () =>
    retry.mutate(e._id, {
      onSuccess: () => toast.success('AI analysis re-queued'),
    });

  return (
    <>
      <DialogHeader className="space-y-1 border-b px-6 py-4">
        <DialogTitle className="pr-8 text-section">{e.title ?? 'Exhibit'}</DialogTitle>
        <DialogDescription asChild>
          <div>
            <MetaLine
              items={[
                <code key="code" className="font-mono text-foreground">
                  {e.exhibitCode}
                </code>,
                humanise(e.kind) || e.mimeType,
                e.sizeBytes ? fmtBytes(e.sizeBytes) : null,
                e.createdAt && `Uploaded ${fmtDate(e.createdAt)}`,
                exhibitCnr(e) && (
                  <span key="cnr" className="inline-flex items-center gap-1">
                    CNR <CopyableValue value={exhibitCnr(e)} label="Copy CNR" />
                  </span>
                ),
              ]}
            />
          </div>
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-5 p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-5">
            <ExhibitFile exhibit={e} />
            <AiAnalysisPanel
              analysis={e.aiAnalysis}
              onRetry={onRetry}
              retrying={retry.isPending}
              retryError={retry.error}
            />
          </div>
          <div className="min-w-0 space-y-5">
            <VerdictSection exhibit={e} />
            <CertificateCard evidenceId={e._id} exhibitCode={e.exhibitCode} />
            <QrLabelSection exhibit={e} caseInfo={caseInfo} />
            <ExhibitLifecycleSection evidenceId={e._id} />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.card   the evidence card to open; closed when null
 * @param {{ firNumber?: string }} [props.caseInfo]  printed on the QR label
 * @param {() => void} props.onClose
 */
export function LabExhibitDialog({ card, caseInfo, onClose }) {
  return (
    <Dialog open={Boolean(card)} onOpenChange={(open) => !open && onClose?.()}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100%-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        {card && <Workspace key={card._id} card={card} caseInfo={caseInfo} />}
      </DialogContent>
    </Dialog>
  );
}
