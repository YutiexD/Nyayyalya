/**
 * Advocate: the disclosure set served on you, and nothing else.
 *
 * Two boundaries are visible on this page and both are deliberate.
 *
 *   Being on record is a fact of the COURT record, not of Lexx. A vakalatnama accepted
 *   by the registrar, or a legal aid order, puts an advocate on record; Lexx mirrors
 *   that and can neither create nor extend it. `GET /api/cases` therefore returns the
 *   cases the court directory says you are on, and an empty list is the access policy
 *   answering rather than an empty database.
 *
 *   Being served is separate again. On record with nothing served is answered with
 *   NO_DISCLOSURE_PACK_SERVED, which is not a failure — it is the registrar not having
 *   served yet, and it is rendered as an explained empty state rather than an error.
 *
 * Exhibits withheld from the pack are reported as a COUNT and a GROUND, never as items.
 * There is deliberately no affordance anywhere on this page for browsing the case file:
 * material outside the served set is refused with EXHIBIT_NOT_IN_DISCLOSURE_SET and the
 * attempt is logged, and a UI that invited the attempt would be misrepresenting what
 * counsel is entitled to.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { FileCheck2, FolderLock, Scale } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { Section, KeyValue, Hash, PageHeader, TableSkeleton, EmptyState } from '@/components/common/Primitives';
import { ForensicOpinion, Denial, Note } from '@/components/common/Verdicts';
import { useCases, useMyPack, useAcknowledgePack } from '@/hooks/queries';
import { useReveal } from '@/hooks/useGsap';
import { humanise, fmtDate, fmtBytes } from '@/lib/utils';

const DAY_MS = 86_400_000;

/** A stable identity for "no cases yet", so effects do not re-run on every render. */
const NO_CASES = Object.freeze([]);

/** Whole days from now until `iso`, negative once it has passed. */
function daysUntil(iso) {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  return Math.ceil((due.getTime() - Date.now()) / DAY_MS);
}

/**
 * The watermark, shown as prominently as it is printed.
 *
 * Every page rendered from this pack carries this advocate's identity and a
 * per-recipient token. Saying so on screen is part of the deterrent: a leaked copy
 * points back to the recipient it was served on, and an advocate who does not know
 * that has not been deterred by it.
 */
function WatermarkPanel({ watermark, pack }) {
  return (
    <Card className="border-warn/40 bg-warn-muted will-reveal">
      <CardContent className="space-y-1 pt-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Served copy — watermarked to you
        </p>
        <p className="text-base font-semibold">{watermark?.label ?? '—'}</p>
        <p className="hash">token {watermark?.token ?? '—'}</p>
        <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
          Redaction variant {pack?.redactionVariant ?? '—'}
          {pack?.maskVictimIdentity ? ' · victim identity masked by order' : ''}. Every document
          rendered from this pack carries this identity and this token.
        </p>
      </CardContent>
    </Card>
  );
}

/** One served exhibit. The laboratory opinion is the only verdict shown here. */
function ExhibitCard({ exhibit }) {
  return (
    <Card className="will-reveal">
      <CardContent className="space-y-3 pt-6">
        <div className="space-y-1.5">
          <p className="font-medium">
            <span className="font-mono">{exhibit.exhibitCode}</span>
            {exhibit.title ? ` — ${exhibit.title}` : ''}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{humanise(exhibit.kind)}</Badge>
            <Badge variant="outline">{exhibit.mimeType ?? '—'}</Badge>
            <Badge variant="outline">{fmtBytes(exhibit.sizeBytes)}</Badge>
            <Badge variant="outline">{humanise(exhibit.courtStatus)}</Badge>
          </div>
        </div>

        {exhibit.description && (
          <p className="text-sm leading-relaxed text-muted-foreground">{exhibit.description}</p>
        )}

        <KeyValue
          rows={[
            ['Recorded digest', <Hash key="kv" value={exhibit.sha256 ?? exhibit.sha256Server} />],
            ['Hash algorithm', exhibit.hashAlgorithm ?? 'SHA-256'],
            ['Captured at', fmtDate(exhibit.capturedAt)],
          ]}
        />

        {/*
          Only the laboratory's opinion appears in a served pack. Machine review
          priority is investigative triage, not disclosable material, and its absence
          here is the point rather than an omission.
        */}
        <ForensicOpinion forensic={exhibit.forensic} />
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------- the pack ----

function PackView({ pack }) {
  const acknowledge = useAcknowledgePack();
  const remaining = daysUntil(pack.dueOn);
  const acknowledged = Boolean(pack.acknowledgedAt);

  const onAcknowledge = () => {
    acknowledge.mutate(pack.packId, {
      onSuccess: () =>
        toast.success('Receipt acknowledged.', {
          description: 'The BNSS s.230 clock is stopped for your copy.',
        }),
      onError: (err) => toast.error(err.message ?? 'The acknowledgement was refused.'),
    });
  };

  return (
    <div className="space-y-6">
      <WatermarkPanel watermark={pack.watermark} pack={pack} />

      <Section
        title="Pack"
        description="What was served, when, and the clock it started. BNSS s.230 requires the accused to have the material within fourteen days of production; acknowledging receipt is what records that it arrived."
      >
        <KeyValue
          rows={[
            ['CNR', <span key="kv" className="font-mono">{pack.cnrNumber ?? 'not committed'}</span>],
            ['FIR', <span key="kv" className="font-mono">{pack.firNumber ?? '—'}</span>],
            [
              'Status',
              <Badge key="kv" variant="outline" className="border-ok/40 bg-ok-muted text-ok">
                {humanise(pack.status)}
              </Badge>,
            ],
            ['Served on', fmtDate(pack.servedOn)],
            ['Due on', fmtDate(pack.dueOn)],
            ['Exhibits in your set', String(pack.exhibitCount ?? 0)],
            [
              'Redaction variant',
              <span key="kv" className="font-mono">{pack.redactionVariant ?? '—'}</span>,
            ],
            ['Victim identity masked', pack.maskVictimIdentity ? 'Yes, by order' : 'No'],
          ]}
        />

        {acknowledged ? (
          <Note>
            Receipt acknowledged {fmtDate(pack.acknowledgedAt)}. The s.230 clock for your copy
            stopped at that moment, and the acknowledgement is in the ledger.
          </Note>
        ) : remaining === null ? (
          <Note tone="warn">
            No due date is recorded on this pack, so the s.230 clock cannot be shown. Acknowledge
            receipt anyway — the record of when the material reached you is the point.
          </Note>
        ) : (
          <Note tone="warn">
            {remaining < 0
              ? `The fourteen-day period ran out ${Math.abs(remaining)} day${Math.abs(remaining) === 1 ? '' : 's'} ago and receipt is still not acknowledged.`
              : `${remaining} day${remaining === 1 ? '' : 's'} remain under BNSS s.230.`}{' '}
            The clock stops when you acknowledge receipt, not when the registrar serves.
          </Note>
        )}

        <Button onClick={onAcknowledge} disabled={acknowledged || acknowledge.isPending}>
          <FileCheck2 className="size-4" />
          {acknowledged
            ? `Acknowledged ${fmtDate(pack.acknowledgedAt)}`
            : acknowledge.isPending
              ? 'Acknowledging…'
              : 'Acknowledge receipt'}
        </Button>

        {acknowledge.isError && (
          <Denial error={acknowledge.error} heading="Acknowledgement refused" />
        )}
      </Section>

      <Section
        title="Exhibits served on you"
        description="These are the only exhibits accessible to you in this case. Any other exhibit is refused with EXHIBIT_NOT_IN_DISCLOSURE_SET, and the attempt is written to the audit log with your identity and the time."
      >
        {(pack.exhibits ?? []).length === 0 ? (
          <EmptyState title="The served pack contains no exhibits" icon={FolderLock}>
            A pack was served on you, but it names no material. Raise it with the registry —
            this is a record you are entitled to have explained.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {pack.exhibits.map((exhibit) => (
              <ExhibitCard key={exhibit.evidenceId} exhibit={exhibit} />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Material withheld"
        description="You are told that material was withheld and on what ground. It is not named and it is not listable — naming the item would disclose the very thing the registrar ruled should be withheld."
      >
        {(pack.withheld ?? []).length === 0 ? (
          <EmptyState title="Nothing withheld">
            The registrar excluded no material from the set served on you.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ground for withholding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pack.withheld ?? []).map((w, i) => (
                <TableRow key={`${w.reason}-${i}`}>
                  <TableCell>{w.reason ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

// -------------------------------------------------------------------- page ----

export default function CounselPage() {
  const cases = useCases({ limit: 100 });
  const [chosenCaseId, setChosenCaseId] = useState(null);

  const list = cases.data?.cases ?? NO_CASES;

  // Land on a case rather than on a picker: an advocate on one case should not have to
  // choose it before seeing anything.
  //
  // Derived during render rather than written back from an effect. Setting state in an
  // effect to fill in a default means the first render goes out with nothing selected
  // and is immediately thrown away — a cascading render, and a visible flash of the
  // empty state on a page whose empty state says "nothing has been disclosed to you".
  const caseId = chosenCaseId ?? (list.length ? String(list[0]._id) : null);
  const setCaseId = setChosenCaseId;

  const pack = useMyPack(caseId);

  /**
   * The pack, exhibit and withheld panels only exist once a pack comes back, so the
   * entrance timeline has to run again whenever the page's shape changes — otherwise a
   * panel that mounted after it would stay at its pre-animation opacity. `packId` is in
   * the list because a served pack stays cached while a different case loads, so the
   * query status alone does not change when the exhibits underneath it do.
   */
  const scope = useReveal('.will-reveal', {
    deps: [caseId, pack.status, pack.data?.packId ?? null],
  });

  // NO_DISCLOSURE_PACK_SERVED is not a failure. It means the registrar has not served
  // yet, which is a normal state of a live case, and rendering it as a red refusal
  // would teach an advocate to read a routine waiting period as an access denial.
  const notServedYet = pack.isError && pack.error?.code === 'NO_DISCLOSURE_PACK_SERVED';

  return (
    <div ref={scope} className="container space-y-6 py-8">
      <PageHeader
        title="Disclosure served on you"
        lede="Access here follows the court directory. A vakalatnama accepted by the registrar, or a legal aid order, is what puts an advocate on record; Lexx mirrors that record into this register and can neither create nor extend it. What you can open is the set served on you, exhibit by exhibit — not the case file."
      />

      <Section
        title="Your cases"
        description="The cases the court directory shows you on record for. This list is built by the server from that record, not from anything chosen here."
      >
        {cases.isPending && <TableSkeleton rows={1} cols={2} />}
        {cases.isError && <Denial error={cases.error} heading="Case list refused" />}

        {cases.isSuccess &&
          (list.length === 0 ? (
            <EmptyState title="No case is open to you" icon={Scale}>
              An advocate appears here only once the registrar has accepted a vakalatnama, or a
              legal aid order has been made, in a case Lexx holds. Lexx reads that record; it
              does not grant access of its own.
            </EmptyState>
          ) : (
            <div className="max-w-xl space-y-2">
              <Label htmlFor="counsel-case">Case</Label>
              <Select value={caseId ?? undefined} onValueChange={setCaseId}>
                <SelectTrigger id="counsel-case">
                  <SelectValue placeholder="Choose a case" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((c) => (
                    <SelectItem key={String(c._id)} value={String(c._id)}>
                      {c.cnrNumber ?? c.firNumber}
                      {c.title ? ` — ${c.title}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
      </Section>

      {caseId && (
        <>
          {pack.isPending && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          )}

          {notServedYet && (
            <Section
              title="Nothing served yet"
              description="You are on record for this case. Service is a separate act by the registrar."
            >
              <EmptyState title="No disclosure pack has been served on you" icon={FolderLock}>
                Until the registrar prepares, approves and serves a pack in this case, there is
                nothing to disclose to you. A pack served on co-accused counsel is not a pack
                served on you, and this page will not show it.
              </EmptyState>
              <Separator />
              <Note>
                This read was written to the audit log with your identity, the case, the reason
                code and the time. Supervisory users can see it in their own feed — which cuts
                both ways, and is meant to.
              </Note>
            </Section>
          )}

          {pack.isError && !notServedYet && (
            <div className="space-y-3">
              <Denial error={pack.error} heading="Disclosure refused" />
              <Note>
                This refusal has been written to the audit log with your identity, the case, the
                reason code and the time.
              </Note>
            </div>
          )}

          {pack.isSuccess && pack.data && <PackView pack={pack.data} />}
        </>
      )}
    </div>
  );
}
