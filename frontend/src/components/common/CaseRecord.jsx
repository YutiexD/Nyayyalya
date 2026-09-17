/**
 * Two blocks every case view shares.
 *
 *   CaseClosure   "Case closed": when, by whom, what was filed, its fingerprint and signer
 *                 key, and the document itself.
 *   CaseTimeline  the case lifecycle in full (descriptions, actors, proofs), collapsed.
 *                 The compact stepper stays at the top of each case; this is the detail.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronRight, FileText, Loader2, Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CopyableValue } from '@/components/common/CopyButton';
import { Disclosure, Facts, MetaLine } from '@/components/common/Shell';
import { LifecycleTimeline, hasLifecycle } from '@/components/common/LifecycleTimeline';
import { api, explain } from '@/lib/api';
import { openBlob } from '@/lib/download';
import { cn, fmtBytes, fmtDate, humanise } from '@/lib/utils';

export const CLOSED_STAGES = new Set(['CLOSED', 'DISPOSED']);

const KIND_LABEL = {
  FINAL_JUDGMENT: 'Final judgment',
  DECLARATION: 'Declaration',
  ORDER: 'Closing order',
};

function OpenClosureDocument({ caseId, closure }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      openBlob(await api.cases.closureDocumentBlob(caseId), closure.fileName ?? 'closing-document.pdf');
    } catch (err) {
      toast.error('The document could not be opened', { description: explain(err.code, err.message) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={open} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <FileText />}
      Open document
    </Button>
  );
}

/**
 * @param {object} props
 * @param {string} props.caseId
 * @param {object} props.caseDoc     needs `stage`; `closure` and `closedOn` when present
 * @param {'card'|'plain'} [props.variant='card']
 */
export function CaseClosure({ caseId, caseDoc, closure: given, variant = 'card', className }) {
  const closure = given ?? caseDoc?.closure ?? null;
  if (!CLOSED_STAGES.has(caseDoc?.stage) && !closure) return null;

  const signer = closure?.signedBy ?? null;
  const when = closure?.uploadedAt ?? caseDoc?.closedOn ?? null;
  const kind = closure?.kindLabel ?? KIND_LABEL[closure?.kind] ?? (closure?.kind ? humanise(closure.kind) : null);
  const hasDocument = Boolean(closure?.hasDocument ?? closure?.fileName);

  return (
    <section
      aria-label="Case closed"
      className={cn(variant === 'card' && 'rounded-lg border bg-muted/20 p-4', 'space-y-3', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Lock aria-hidden className="size-4 text-muted-foreground" />
            Case closed
          </p>
          <MetaLine items={[when && fmtDate(when), kind]} />
        </div>
        {hasDocument && caseId && <OpenClosureDocument caseId={caseId} closure={closure} />}
      </div>

      {closure && (
        <Facts
          dense
          rows={[
            signer &&
              (signer.name || signer.authorityId) && [
                'Closed by',
                <MetaLine
                  key="by"
                  className="text-foreground"
                  items={[
                    signer.name,
                    signer.roleLabel,
                    signer.authorityId && (
                      <code key="id" className="font-mono text-[12px]">
                        {signer.authorityId}
                      </code>
                    ),
                  ]}
                />,
              ],
            closure.note && ['Note', <span key="n" className="whitespace-pre-line">{closure.note}</span>],
            hasDocument &&
              closure.fileName && [
                'Document',
                [closure.fileName, Number.isFinite(closure.sizeBytes) && fmtBytes(closure.sizeBytes)]
                  .filter(Boolean)
                  .join(' · '),
              ],
            closure.sha256 && [
              'SHA-256',
              <CopyableValue key="h" value={closure.sha256} label="Copy SHA-256" breakAll valueClassName="text-[12px]" />,
            ],
            closure.signerKeyFingerprint && [
              'Signer key',
              <CopyableValue
                key="k"
                value={closure.signerKeyFingerprint}
                label="Copy signer key fingerprint"
                breakAll
                valueClassName="text-[12px]"
              />,
            ],
          ]}
        />
      )}
    </section>
  );
}

/**
 * @param {object} props
 * @param {object[]} props.entries   `workflow.lifecycle`
 * @param {'section'|'disclosure'} [props.variant='disclosure']
 *   `section`: a hairline-topped toggle inside a case surface; `disclosure`: a standalone box.
 */
export function CaseTimeline({ entries, variant = 'disclosure', className }) {
  const [open, setOpen] = useState(false);
  if (!hasLifecycle(entries)) return null;

  if (variant === 'disclosure') {
    return (
      <Disclosure label="Case timeline" className={className}>
        <LifecycleTimeline entries={entries} />
      </Disclosure>
    );
  }

  return (
    <div className={cn('border-t', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-6 py-4 text-left text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight aria-hidden className={cn('size-4 transition-transform', open && 'rotate-90')} />
        Case timeline
      </button>
      {open && (
        <div className="px-6 pb-6">
          <LifecycleTimeline entries={entries} />
        </div>
      )}
    </div>
  );
}
