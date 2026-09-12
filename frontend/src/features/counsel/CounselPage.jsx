/**
 * The advocate's workspace.
 *
 * ## The question this screen answers
 *
 * "What has the court given me, and what do I have to do about it?"
 *
 * An advocate is the one user here who is not an operator of this system. They do not
 * manage evidence, order queues or audit anything — they read a case and the material
 * served on them, and they acknowledge receipt. So this is the shortest screen in the
 * product, and everything technical about how the register works has been taken off it.
 *
 * ## The two boundaries, both deliberate, both visible
 *
 * **Being on record** is a fact of the COURT record, not of Lexx. A vakalatnama the
 * court accepts, or a legal aid order, puts an advocate on record; Lexx mirrors that
 * and can neither create nor extend it. An empty case list is the access policy
 * answering, not an empty database.
 *
 * **Being served** is separate again. On record with nothing served is answered with
 * NO_DISCLOSURE_PACK_SERVED — which is not a failure, it is the court not having
 * shared the file yet, and it is rendered as an explained empty state rather than an
 * error.
 *
 * Material withheld from the file is reported as a COUNT and a GROUND, never as items.
 * There is deliberately no affordance anywhere on this page for browsing the case
 * file: anything outside the served set is refused and the attempt is logged, and a
 * UI that invited the attempt would be misrepresenting what counsel is entitled to.
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, FolderLock, Scale } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

import {
  Counter, CounterRow, DetailSkeleton, Disclosure, Empty, Facts, Panel, Row, Rows,
  RowsSkeleton, SplitView, Workspace,
} from '@/components/common/Shell';
import { StageBadge } from '@/components/common/Lifecycle';
import { Denial, ForensicBadge, Note } from '@/components/common/Verdicts';
import { ExhibitDialog, useExhibitDialog } from '@/features/evidence/ExhibitDialog';
import { FileVakalatnama, MyFilings } from '@/features/vakalatnama/Vakalatnama';
import { useAcknowledgePack, useCases, useMyPack } from '@/hooks/queries';
import { explain } from '@/lib/api';
import { fmtBytes, fmtDate } from '@/lib/utils';

const DAY_MS = 86_400_000;

/** Whole days from now until `iso`, negative once it has passed. */
function daysUntil(iso) {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  return Math.ceil((due.getTime() - Date.now()) / DAY_MS);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The BNSS s.230 clock, as one sentence.
 *
 * It reads from the served file and from nothing else, so with nothing served there
 * is no clock — a countdown on a clock that has not started would be an invention.
 */
function ClockLine({ pack }) {
  if (!pack) return null;
  if (pack.acknowledgedAt) {
    return (
      <Note>
        <span className="font-medium text-foreground">Receipt acknowledged</span>{' '}
        {fmtDate(pack.acknowledgedAt)}. The fourteen-day clock under BNSS s.230 stopped then.
      </Note>
    );
  }

  const remaining = daysUntil(pack.dueOn);
  if (remaining === null) {
    return <Note tone="warn">No due date is recorded on this file.</Note>;
  }
  if (remaining < 0) {
    return (
      <Note tone="warn">
        The fourteen days under BNSS s.230 ran out {plural(Math.abs(remaining), 'day')} ago and
        receipt is still not acknowledged.
      </Note>
    );
  }
  return (
    <Note tone="warn">
      <span className="font-medium text-foreground">{plural(remaining, 'day')}</span> left under
      BNSS s.230, until {fmtDate(pack.dueOn)}. The clock stops when you acknowledge receipt.
    </Note>
  );
}

// ============================================================== the case file ====

function CaseFile({ caseId, caseDoc }) {
  const pack = useMyPack(caseId);
  const acknowledge = useAcknowledgePack();
  const exhibitDialog = useExhibitDialog();

  if (!caseId) {
    return (
      <Panel title="No case selected">
        <Empty title="Choose a case" icon={Scale}>
          Open one from the list to read what the court has shared with you.
        </Empty>
      </Panel>
    );
  }
  if (pack.isPending) {
    return (
      <Panel title="Case file">
        <DetailSkeleton />
      </Panel>
    );
  }

  // Nothing served is not an error. It is the court not having shared the file yet.
  if (pack.isError) {
    const notServed = pack.error?.code === 'NO_DISCLOSURE_PACK_SERVED';
    return (
      <Panel title={caseDoc ? `FIR ${caseDoc.firNumber}` : 'Case file'}>
        {notServed ? (
          <Empty title="The court has not shared the case file yet" icon={FolderLock}>
            You are on record for this case, which is a separate thing from being served. When
            the court shares the file you will see exactly what it contains, and the count and
            the ground for anything withheld.
          </Empty>
        ) : (
          <Denial error={pack.error} heading="Case file not readable" />
        )}
      </Panel>
    );
  }

  const p = pack.data;
  const exhibits = p?.exhibits ?? [];
  const withheld = p?.withheld ?? [];

  return (
    <div className="space-y-5">
      <Panel
        title={caseDoc ? `FIR ${caseDoc.firNumber}` : 'Case file'}
        actions={
          !p?.acknowledgedAt && (
            <Button
              size="sm"
              disabled={acknowledge.isPending}
              onClick={() =>
                acknowledge.mutate(p.packId, {
                  onSuccess: () => toast.success('Receipt acknowledged'),
                  onError: (err) => toast.error(explain(err.code, err.message)),
                })
              }
            >
              <Check className="size-4" />
              Acknowledge receipt
            </Button>
          )
        }
      >
        <div className="space-y-4">
          {caseDoc && (
            <div className="space-y-1">
              <h3 className="text-lg font-semibold leading-tight">{caseDoc.title}</h3>
              <div className="flex flex-wrap items-center gap-2">
                <StageBadge stage={caseDoc.stage} />
                {caseDoc.cnrNumber && (
                  <code className="font-mono text-[11px] text-muted-foreground">
                    CNR {caseDoc.cnrNumber}
                  </code>
                )}
              </div>
            </div>
          )}

          <ClockLine pack={p} />

          <Facts
            rows={[
              ['Shared with you', fmtDate(p?.servedOn)],
              ['Exhibits in the file', exhibits.length],
              withheld.length > 0 && ['Withheld', plural(withheld.length, 'exhibit')],
              p?.redactionVariant && ['Redaction variant', p.redactionVariant],
              p?.maskVictimIdentity && ['Victim identity', 'Masked'],
            ]}
          />
        </div>
      </Panel>

      <Panel
        title="Evidence served on you"
        description="Open one to read its record, the file itself, and the laboratory's opinion where there is one."
      >
        {exhibits.length === 0 ? (
          <Empty title="The file contains no exhibits" icon={FolderLock}>
            That is what was served. It is not a filtered view of something larger.
          </Empty>
        ) : (
          <ul className="-mx-5 -my-5 divide-y">
            {exhibits.map((e) => (
              <Row
                key={e.evidenceId}
                title={e.title}
                meta={
                  <>
                    <code className="font-mono">{e.exhibitCode}</code> · {e.mimeType} ·{' '}
                    {fmtBytes(e.sizeBytes)}
                  </>
                }
                badge={<ForensicBadge forensic={e.forensic} />}
                onSelect={() => exhibitDialog.open(e.evidenceId)}
              />
            ))}
          </ul>
        )}
      </Panel>

      {withheld.length > 0 && (
        <Panel title="Material withheld">
          <p className="mb-3 text-[13px] leading-relaxed text-muted-foreground">
            The court withheld {plural(withheld.length, 'exhibit')} from this file. You are told
            that it exists and on what ground — not what it is.
          </p>
          <ul className="space-y-2">
            {withheld.map((w, i) => (
              <li key={i} className="rounded-lg border border-warn/35 bg-warn-muted/30 p-3 text-[13px]">
                {w.reason ?? 'No ground recorded.'}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {p?.watermark && (
        <Disclosure
          label="Your copy is watermarked"
          hint="Every page carries a token unique to you."
        >
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            The token below identifies YOUR copy of this file. A leaked page can be traced back
            to the person it was served on, and that mapping is in an append-only record nobody
            can edit afterwards — including the court.
          </p>
          <Facts
            dense
            rows={[
              ['Watermark', p.watermark.label ?? '—'],
              ['Token', <code key="t" className="hash">{p.watermark.token}</code>],
            ]}
          />
        </Disclosure>
      )}

      {/* Review priority is investigative workload ordering. It is never disclosed to
          a party, so the dialog is asked not to render it — and the server does not
          send it either. Two independent guarantees, deliberately. */}
      <ExhibitDialog
        evidenceId={exhibitDialog.evidenceId}
        onClose={exhibitDialog.close}
        showPriority={false}
      />
    </div>
  );
}

// ==================================================================== page ====

export default function CounselPage() {
  const cases = useCases();
  const list = useMemo(() => cases.data?.cases ?? [], [cases.data]);
  const [chosen, setChosen] = useState(null);

  // Derived rather than corrected by an effect: the advocate lands on their first
  // case without a render in which nothing is selected.
  const caseDoc = list.find((c) => String(c._id) === String(chosen)) ?? list[0] ?? null;
  const selected = caseDoc ? String(caseDoc._id) : null;
  const ready = cases.isSuccess;

  return (
    <Workspace
      eyebrow="Legal · counsel"
      title="Your cases"
      lede="You see the cases the court record says you are on, and the material the court has shared with you in each."
      action={<FileVakalatnama />}
    >
      {cases.isError && <Denial error={cases.error} heading="Cases not readable" />}

      <CounterRow>
        <Counter label="Cases you are on" value={ready ? list.length : '—'} />
      </CounterRow>

      {ready && list.length === 0 ? (
        <Panel title="No case is open to you">
          <Empty title="You are not on record in any case" icon={Scale}>
            An advocate comes on record by filing a vakalatnama, which the court then rules on —
            or by a legal aid order. File one above; until the court accepts it, it grants you
            nothing, not even the knowledge that the case exists.
          </Empty>
          <Separator className="my-5" />
          <MyFilings />
        </Panel>
      ) : (
        <>
          <SplitView
            list={
              <Panel title="On record" bodyClassName="p-0">
                {cases.isPending && <RowsSkeleton rows={3} />}
                {list.length > 0 && (
                  <Rows>
                    {list.map((c) => (
                      <Row
                        key={c._id}
                        title={c.title}
                        meta={`FIR ${c.firNumber}`}
                        badge={<StageBadge stage={c.stage} />}
                        selected={String(c._id) === String(selected)}
                        onSelect={() => setChosen(String(c._id))}
                      />
                    ))}
                  </Rows>
                )}
              </Panel>
            }
            detail={<CaseFile caseId={selected} caseDoc={caseDoc} />}
          />

          <Disclosure
            label="Your filings"
            hint="Vakalatnamas you have put before a court, and where each one stands."
          >
            <MyFilings />
          </Disclosure>
        </>
      )}
    </Workspace>
  );
}
