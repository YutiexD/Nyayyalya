/**
 * One exhibit, in full — the same way for every role that may read it.
 *
 * ## Why a dialog
 *
 * An exhibit has a lot to say: its device record, its digest, its review priority and
 * the reasons behind it, its forensic opinion, its four integrity checks, its s.63
 * certificate and its upload receipt. All of that used to live inline underneath the
 * evidence table, so every screen that listed exhibits was really two screens stacked,
 * and the second one appeared and disappeared as rows were clicked.
 *
 * It is a dialog now. The list stays where it was, the detail comes forward when it is
 * asked for, and the things that are genuinely secondary — the hashes, the checks, the
 * certificate — stay closed inside it until someone wants them.
 *
 * ## Why one component for four roles
 *
 * A court that saw a different verdict layout from the police would reasonably ask
 * which one to believe. What differs between roles is what they may DO, so the actions
 * are props; what an exhibit IS does not differ, so it is written once.
 */
import { useState } from 'react';

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

import { Disclosure, Facts, Digest, DetailSkeleton } from '@/components/common/Shell';
import {
  Denial, ForensicBadge, ForensicOpinion, Note, PriorityBadge, PriorityReasons,
} from '@/components/common/Verdicts';
import { OpenExhibitButton, VerifyExhibitPanel } from '@/features/evidence/ExhibitTools';
import { CertificatePanel } from '@/features/certificates/CertificatePanel';
import { useExhibit, useLedger } from '@/hooks/queries';
import { fmtBytes, fmtDate, humanise } from '@/lib/utils';

/**
 * The upload receipt — the ledger sequence and entry hash — plus the link that checks
 * it on the public verifier. Read back from the case ledger so the officer never has
 * to find the file they downloaded at upload.
 */
function Receipt({ exhibit }) {
  const ledger = useLedger(exhibit.caseId);
  if (!exhibit.ledgerSeq) return null;

  const entry = (ledger.data?.entries ?? []).find((x) => x.seq === exhibit.ledgerSeq);
  const link = entry ? `/verify?seq=${exhibit.ledgerSeq}&entry=${entry.entryHash}` : null;

  return (
    <div className="space-y-3">
      <Facts
        rows={[
          ['Ledger sequence', <span key="s" className="tabular">{exhibit.ledgerSeq}</span>],
          ['Entry hash', <Digest key="h" value={entry?.entryHash} />],
        ]}
      />
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-block text-[13px] font-medium underline underline-offset-4"
        >
          Check this receipt on the public verifier
        </a>
      )}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string|null} props.evidenceId   open when set, closed when null
 * @param {() => void} props.onClose
 * @param {boolean} [props.showPriority]   review priority is never shown to a party
 * @param {boolean} [props.canIssueCertificate]
 * @param {boolean} [props.canSignPartA]
 * @param {boolean} [props.canSignPartB]
 * @param {React.ReactNode} [props.actions]  role-specific actions, shown at the top
 */
export function ExhibitDialog({
  evidenceId,
  onClose,
  showPriority = true,
  canIssueCertificate = false,
  canSignPartA = false,
  canSignPartB = false,
  actions,
}) {
  const query = useExhibit(evidenceId);
  const e = query.data?.evidence;

  return (
    <Dialog open={Boolean(evidenceId)} onOpenChange={(open) => !open && onClose?.()}>
      <DialogContent className="max-h-[88vh] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-2 border-b p-5 text-left">
          <DialogTitle className="pr-8 text-base leading-snug">
            {e?.title ?? 'Exhibit'}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              {e && <code className="font-mono text-[12px]">{e.exhibitCode}</code>}
              {e && showPriority && (
                <PriorityBadge
                  priority={e.triage?.priority}
                  disclaimer={e.triage?.disclaimer}
                />
              )}
              {e && <ForensicBadge forensic={e.forensic} />}
            </div>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-5 p-5">
            {query.isPending && <DetailSkeleton />}
            {query.isError && <Denial error={query.error} heading="Exhibit not readable" />}

            {e && (
              <>
                {actions && <div className="flex flex-wrap gap-2">{actions}</div>}

                {/* The laboratory's finding, if there is one. The ONLY authenticity
                    claim on this screen, and it is stated before anything else so it
                    is never mistaken for the machine's priority below. */}
                {e.forensic?.opinion ? (
                  <ForensicOpinion forensic={e.forensic} />
                ) : (
                  <Note>
                    No laboratory opinion on this exhibit yet
                    {e.forensic?.status ? ` (${humanise(e.forensic.status).toLowerCase()})` : ''}.
                    Nothing on this screen states whether the file is authentic — and the case
                    is readable, and the exhibit usable, while a laboratory works through its
                    queue.
                  </Note>
                )}

                {showPriority && e.triage?.priority && (
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <p className="label-xs">Review priority — why</p>
                    <PriorityReasons triage={e.triage} className="mt-2" limit={5} />
                  </div>
                )}

                <Facts
                  rows={[
                    ['Type', `${humanise(e.kind)} · ${e.mimeType ?? '—'} · ${fmtBytes(e.sizeBytes)}`],
                    [
                      'Source device',
                      [humanise(e.sourceDevice?.sourceType), e.sourceDevice?.make, e.sourceDevice?.model]
                        .filter(Boolean)
                        .join(' · ') || '—',
                    ],
                    ['Serial / IMEI', e.sourceDevice?.serialNumber ?? e.sourceDevice?.imeiOrUid ?? '—'],
                    ['Captured', fmtDate(e.capturedAt)],
                    ['Registered', fmtDate(e.createdAt)],
                    e.courtStatus && ['Court status', humanise(e.courtStatus)],
                  ]}
                />

                <OpenExhibitButton exhibit={e} />

                <Separator />

                <Disclosure
                  label="Check this exhibit"
                  hint="Four independent checks, recomputed from scratch."
                >
                  <VerifyExhibitPanel evidenceId={e._id} />
                </Disclosure>

                <Disclosure label="Digest and upload receipt">
                  <Facts rows={[['Recorded digest', <Digest key="d" value={e.sha256Server} />]]} />
                  <Receipt exhibit={e} />
                </Disclosure>

                <Disclosure
                  label="Section 63 certificate"
                  hint="The certificate a court reads alongside the exhibit."
                >
                  <CertificatePanel
                    evidenceId={e._id}
                    exhibitCode={e.exhibitCode}
                    canGenerate={canIssueCertificate}
                    canSignPartA={canSignPartA}
                    canSignPartB={canSignPartB}
                  />
                </Disclosure>
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
