/**
 * One exhibit, for every role that may read it.
 *
 * Header (code, title, type, uploaded date), the file, the s.63 certificate and the FSL
 * verdict. The AI analysis is rendered for the laboratory ONLY — decided here from the
 * session, independently of the server also omitting it for everyone else.
 */
import { useState } from 'react';
import { useSelector } from 'react-redux';

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

import { DetailSkeleton, Disclosure, MetaLine } from '@/components/common/Shell';
import { CopyableValue } from '@/components/common/CopyButton';
import { LifecycleTimeline, hasLifecycle } from '@/components/common/LifecycleTimeline';
import { Skeleton } from '@/components/ui/skeleton';
import { AiAnalysisPanel, Denial, ForensicBadge, ForensicOpinion } from '@/components/common/Verdicts';
import { ExhibitFile } from '@/features/evidence/ExhibitTools';
import { CertificateCard } from '@/features/certificates/CertificatePanel';
import { QrLabelSection } from '@/features/evidence/QrLabel';
import { selectSession } from '@/features/auth/authSlice';
import { useEvidenceLifecycle, useExhibit, useRetryAiAnalysis } from '@/hooks/queries';
import { fmtBytes, fmtDate, humanise } from '@/lib/utils';

/**
 * The exhibit's lifecycle, read when the section is opened (it is unmounted while closed).
 * A refusal or a server without the endpoint leaves a quiet line rather than an error card.
 */
function ExhibitLifecycleBody({ evidenceId }) {
  const query = useEvidenceLifecycle(evidenceId, { retry: false });
  const entries = query.data?.lifecycle;
  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    );
  }
  if (query.isError || !hasLifecycle(entries)) {
    return <p className="text-meta text-muted-foreground">No lifecycle recorded for this exhibit.</p>;
  }
  return <LifecycleTimeline entries={entries} compact />;
}

export function ExhibitLifecycleSection({ evidenceId, className }) {
  if (!evidenceId) return null;
  return (
    <Disclosure label="Lifecycle" className={className}>
      <ExhibitLifecycleBody evidenceId={evidenceId} />
    </Disclosure>
  );
}

/** The CNR an exhibit response may carry, in either of the shapes the server uses. */
export const exhibitCnr = (e) => e?.cnrNumber ?? e?.case?.cnrNumber ?? null;

/** Whether a session belongs to the forensic laboratory — the only audience for AI analysis. */
export const isFslSession = (session) =>
  session?.role === 'FSL_EXAMINER' || session?.authority === 'FSL';

/**
 * @param {object} props
 * @param {string|null} props.evidenceId   open when set, closed when null
 * @param {() => void} props.onClose
 * @param {React.ReactNode} [props.actions] role-specific buttons, shown beside Open file
 * @param {{ firNumber?: string }} [props.caseInfo]  printed on the QR label
 */
export function ExhibitDialog({ evidenceId, onClose, actions, caseInfo }) {
  const session = useSelector(selectSession);
  const isFsl = isFslSession(session);
  const query = useExhibit(evidenceId);
  const retry = useRetryAiAnalysis();
  const e = query.data?.evidence;

  return (
    <Dialog open={Boolean(evidenceId)} onOpenChange={(open) => !open && onClose?.()}>
      <DialogContent className="max-h-[90vh] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1.5 border-b px-5 py-4 text-left">
          <DialogTitle className="pr-8 text-section">{e?.title ?? 'Exhibit'}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {e && (
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
              )}
              {e && <ForensicBadge forensic={e.forensic} />}
            </div>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-5rem)]">
          <div className="space-y-5 p-5">
            {query.isPending && <DetailSkeleton />}
            {query.isError && <Denial error={query.error} heading="Exhibit not readable" />}

            {e && (
              <>
                {e.description && (
                  <p className="whitespace-pre-line text-body text-foreground/90">{e.description}</p>
                )}

                <ExhibitFile exhibit={e}>{actions}</ExhibitFile>

                <CertificateCard evidenceId={e._id} exhibitCode={e.exhibitCode} />

                <QrLabelSection exhibit={e} caseInfo={caseInfo} />

                {e.forensic?.opinion && <ForensicOpinion forensic={e.forensic} />}

                <ExhibitLifecycleSection key={e._id} evidenceId={e._id} />

                {isFsl && e.aiAnalysis && (
                  <AiAnalysisPanel
                    analysis={e.aiAnalysis}
                    onRetry={() => retry.mutate(e._id)}
                    retrying={retry.isPending}
                    retryError={retry.variables === e._id ? retry.error : null}
                  />
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/** Convenience: the open/close state most callers need around one dialog. */
export function useExhibitDialog() {
  const [evidenceId, setEvidenceId] = useState(null);
  return { evidenceId, open: setEvidenceId, close: () => setEvidenceId(null) };
}
