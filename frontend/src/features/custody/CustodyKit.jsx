/**
 * Physical custody, as every role that touches a sealed article sees it.
 *
 *   The label  — what gets printed and stuck on the evidence bag: a QR that opens the
 *                item in Nyayyalya, and the particulars a person checks against the bag by
 *                eye (item code, seal number, FIR, identifiers, who seized it).
 *   The scan   — resolve a label, see where the item is, and act on it: hand it over
 *                (scan one of two) or accept it (scan two of two).
 *   The chain  — the item's whole history, straight from the append-only ledger.
 *
 * A label is identification, never authorization (ADR-011). Opening a scanned label
 * asks the server, which verifies the label's HMAC and then runs the access resolver
 * on the item. Every action below is authorised again when it is attempted.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowRightLeft, Boxes, Copy, Link2, Loader2, PackageCheck, Printer, ScanLine, TimerReset,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

import { KeyValue, Hash, EmptyState } from '@/components/common/Primitives';
import { Denial, Note } from '@/components/common/Verdicts';
import { QrImage } from '@/components/common/QrImage';
import {
  useScanCustodyLabel, useCustodyChain, useCustodyRecipients, useInitiateTransfer, useAcceptTransfer,
  useLiftFreeze, useCustodyItems,
} from '@/hooks/queries';
import { explain } from '@/lib/api';
import { qrDataUrl } from '@/lib/qr';
import { copyText } from '@/lib/download';
import { cn, fmtDate, humanise } from '@/lib/utils';

/** A small status pill. */
export function Pill({ tone = 'neutral', children }) {
  const styles = {
    ok: 'border-ok/40 bg-ok-muted text-ok',
    warn: 'border-warn/40 bg-warn-muted text-warn',
    bad: 'border-bad/40 bg-bad-muted text-bad',
    neutral: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <Badge variant="outline" className={cn('rounded-full', styles[tone] ?? styles.neutral)}>
      {children}
    </Badge>
  );
}

/**
 * Read a label payload out of whatever was scanned or pasted: the raw
 * `NYAYALAY:v1:…` text a desk scanner types, or the `/scan?label=…` link a phone camera
 * opens. Both carry the same signed payload.
 */
export function labelPayloadFrom(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const match = text.match(/[?&]label=([^&#\s]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return text;
}

/** The scan link for an item — what the QR encodes. */
const labelLinkFor = (item) =>
  item?.qrPayload ? `${window.location.origin}/scan?label=${encodeURIComponent(item.qrPayload)}` : null;

// ================================================================= the label ====

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Print a label in its own window, so the page's styles, theme and chrome stay out of
 * it. Black on white, sized for a 100 mm × 70 mm label, QR at a size a phone reads
 * from a shelf.
 */
export async function printCustodyLabel(item) {
  const link = labelLinkFor(item);
  const qr = await qrDataUrl(link, 360);
  const ids = [
    item.identifiers?.imei ? `IMEI ${item.identifiers.imei}` : null,
    item.identifiers?.serialNumber ? `S/N ${item.identifiers.serialNumber}` : null,
  ].filter(Boolean);
  const row = (k, v) => (v ? `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>` : '');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(item.itemCode)} — custody label</title>
<style>
  @page { size: 100mm 70mm; margin: 3mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 9pt/1.25 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #000; background: #fff; }
  .label { width: 94mm; height: 64mm; border: 1.2pt solid #000; border-radius: 2mm; padding: 2.5mm; display: grid; grid-template-columns: 30mm 1fr; grid-template-rows: auto 1fr auto; gap: 1.5mm 3mm; }
  .head { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: baseline; border-bottom: 0.8pt solid #000; padding-bottom: 1mm; }
  .brand { font-weight: 800; letter-spacing: .08em; font-size: 8pt; }
  .code { font: 700 13pt/1 ui-monospace, 'Cascadia Mono', Consolas, monospace; }
  .qr img { width: 30mm; height: 30mm; image-rendering: pixelated; }
  .qr .hint { font-size: 6pt; text-align: center; margin-top: .5mm; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; padding: 0 2mm .4mm 0; white-space: nowrap; vertical-align: top; font-size: 7.5pt; }
  td { padding: 0 0 .4mm; font-size: 8pt; word-break: break-word; }
  .seal td { font-weight: 800; font-size: 9.5pt; }
  .foot { grid-column: 1 / -1; font-size: 5.8pt; border-top: 0.6pt solid #000; padding-top: .8mm; }
  .payload { font: 5.2pt/1.2 ui-monospace, Consolas, monospace; word-break: break-all; }
</style></head><body><div class="label">
  <div class="head"><span class="brand">Nyayyalya · CUSTODY LABEL</span><span class="code">${escapeHtml(item.itemCode)}</span></div>
  <div class="qr">${qr ? `<img src="${qr}" alt="QR">` : ''}<div class="hint">Scan to open in Nyayyalya</div></div>
  <table>
    ${row('Article', item.description)}
    <tr class="seal"><th>Seal no.</th><td>${escapeHtml(item.sealNumber)}</td></tr>
    ${row('Identifiers', ids.join(' · '))}
    ${row('FIR', item.firNumber ? `${item.firNumber}${item.cnrNumber ? ` · CNR ${item.cnrNumber}` : ''}` : '')}
    ${row('Station', item.stationCode)}
    ${row('Seized by', item.bookedBy ? `${item.bookedBy.name} (${item.bookedBy.authorityId})` : '')}
    ${row('Booked', item.createdAt ? new Date(item.createdAt).toLocaleString('en-IN') : '')}
  </table>
  <div class="foot">Identifies the item only — it grants no authority to move it. Check the seal number against the bag before accepting.
    <div class="payload">${escapeHtml(item.qrPayload)}</div></div>
</div>
<script>window.onload = () => { window.focus(); window.print(); };</script>
</body></html>`;

  const w = window.open('', '_blank', 'width=520,height=460');
  if (!w) {
    toast.error('The label window was blocked', { description: 'Allow pop-ups for this site to print labels.' });
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** The label as it appears on screen: the same QR and particulars, with a print button. */
export function CustodyLabelCard({ item, compact = false }) {
  const link = labelLinkFor(item);
  if (!item) return null;
  return (
    <div className="flex flex-wrap items-start gap-4 rounded-lg border bg-muted/30 p-4">
      <QrImage value={link} size={compact ? 96 : 128} alt={`Scan code for ${item.itemCode}`} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm font-semibold">{item.itemCode}</code>
          <Pill tone={item.sealIntact === false ? 'bad' : 'ok'}>
            Seal {item.sealNumber} · {item.sealIntact === false ? 'broken' : 'intact'}
          </Pill>
        </div>
        {!compact && (
          <KeyValue
            rows={[
              ['Article', item.description],
              ['FIR', item.firNumber],
              ['IMEI / serial', [item.identifiers?.imei, item.identifiers?.serialNumber].filter(Boolean).join(' · ') || '—'],
              ['Held by', item.currentHolder ? `${item.currentHolder.name} (${humanise(item.currentHolder.role)})` : '—'],
            ]}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => printCustodyLabel(item)}>
            <Printer className="size-3.5" /> Print label
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () =>
              (await copyText(item.qrPayload)) ? toast.success('Label payload copied') : toast.error('Copy failed')
            }
          >
            <Copy className="size-3.5" /> Copy label text
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The QR opens this item in Nyayyalya from any phone. The copied text is what &ldquo;Resolve a
          label&rdquo; takes when there is no camera.
        </p>
      </div>
    </div>
  );
}

// ================================================================= the chain ====

/** One custody or ledger finding, code first because that is what an auditor cites. */
export function Finding({ finding }) {
  return (
    <li className="space-y-0.5">
      <code className="font-mono text-xs text-bad">{finding.code ?? 'FINDING'}</code>
      {finding.detail && <p className="text-xs leading-relaxed text-muted-foreground">{finding.detail}</p>}
      {finding.ledgerSeq !== undefined && finding.ledgerSeq !== null && (
        <p className="text-xs text-muted-foreground">Ledger sequence {finding.ledgerSeq}</p>
      )}
    </li>
  );
}

/** Who did what, in words, for one ledger event. */
function eventLine(event) {
  const p = event.payload ?? {};
  switch (event.eventType) {
    case 'CUSTODY_ITEM_CREATED':
      return `Seized and booked${p.sealNumber ? ` under seal ${p.sealNumber}` : ''}${p.holderAuthorityId ? ` by ${p.holderAuthorityId}` : ''}.`;
    case 'CUSTODY_TRANSFER_INITIATED':
      return `Handover started by ${p.fromAuthorityId ?? '—'} to ${p.toAuthorityId ?? '—'} → ${humanise(p.proposedStatus)}${p.reason ? ` — “${p.reason}”` : ''}.`;
    case 'CUSTODY_TRANSFERRED':
      return `Received by ${p.toAuthorityId ?? '—'} → ${humanise(p.toStatus)}, seal ${p.sealIntact === false ? 'BROKEN' : 'intact'}.`;
    case 'INTEGRITY_EXCEPTION':
      return `Integrity exception: ${humanise(p.reason)}.`;
    default:
      return null;
  }
}

export function CustodyChainView({ itemId }) {
  const query = useCustodyChain(itemId);

  if (!itemId) {
    return (
      <EmptyState title="No item selected" icon={Boxes}>
        Resolve a label or open a row from the register to read that item&rsquo;s whole recorded
        history.
      </EmptyState>
    );
  }
  if (query.isPending) return <Skeleton className="h-56 w-full" />;
  if (query.isError) return <Denial error={query.error} heading="Chain not readable" />;

  const item = query.data?.item ?? {};
  const analysis = query.data?.analysis ?? {};
  const events = query.data?.events ?? [];

  return (
    <div className="space-y-4">
      <KeyValue
        rows={[
          ['Item', <code key="i" className="font-mono text-xs">{item.itemCode ?? '—'}</code>],
          ['Description', item.description ?? '—'],
          ['FIR', item.firNumber ?? '—'],
          ['Seal', <code key="s" className="font-mono text-xs">{item.sealNumber ?? '—'}</code>],
          ['Seal intact', <Pill key="si" tone={item.sealIntact === false ? 'bad' : 'ok'}>{item.sealIntact === false ? 'Broken' : 'Intact'}</Pill>],
          ['Status', <Pill key="st">{humanise(item.status)}</Pill>],
          ['Location', humanise(item.currentLocation)],
          ['Held by', item.currentHolder ? `${item.currentHolder.name} · ${item.currentHolder.authorityId}` : '—'],
          ['Chain', <Pill key="c" tone={analysis.intact ? 'ok' : 'bad'}>{analysis.intact ? 'Intact' : 'Broken'}</Pill>],
        ]}
      />

      {analysis.findings?.length > 0 && (
        <Note tone="warn">
          <ul className="space-y-2">
            {analysis.findings.map((f, i) => (
              <Finding key={`${f.code}-${i}`} finding={f} />
            ))}
          </ul>
        </Note>
      )}

      {events.length === 0 ? (
        <EmptyState title="No custody events recorded">
          An item with no history in the ledger is itself the finding above.
        </EmptyState>
      ) : (
        <ol className="space-y-4 border-l-2 border-border pl-5">
          {events.map((event) => (
            <li key={event.seq} className="relative space-y-1">
              <span
                className={cn(
                  'absolute -left-[1.625rem] top-1.5 size-2.5 rounded-full ring-4 ring-card',
                  event.eventType === 'INTEGRITY_EXCEPTION' ? 'bg-bad' : 'bg-muted-foreground/50'
                )}
              />
              <p className="text-sm font-medium">{humanise(event.eventType)}</p>
              <p className="text-xs text-muted-foreground">
                {fmtDate(event.occurredAt)} · {humanise(event.actorRole) || '—'} · ledger sequence {event.seq}
              </p>
              {eventLine(event) && <p className="text-xs">{eventLine(event)}</p>}
              <Hash value={event.entryHash} label="Entry hash" />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ============================================================== the handover ====

/**
 * The one-time code a sender hands the receiver. Shown exactly once — the server keeps
 * only its hash — so it lives in the scan panel's state, not in the hand-over form: the
 * form unmounts the moment the item shows a pending handover, and the code with it.
 */
function IssuedHandover({ issued, onDismiss }) {
  const receiver = issued.item?.pendingTransfer?.to;
  return (
    <div className="space-y-3 rounded-lg border border-warn/40 bg-warn-muted/40 p-4">
      <p className="text-sm font-medium">
        One-time handover code for {receiver ? `${receiver.name} (${receiver.authorityId})` : 'the receiver'}
      </p>
      <div className="flex flex-wrap items-start gap-4">
        <QrImage value={issued.transferToken} size={120} alt="Handover code" />
        <div className="min-w-0 flex-1 space-y-2">
          <Hash value={issued.transferToken} className="block rounded-md bg-background p-2" />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () =>
                (await copyText(issued.transferToken)) ? toast.success('Code copied') : toast.error('Copy failed')
              }
            >
              <Copy className="size-3.5" /> Copy code
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Done
            </Button>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TimerReset className="size-3.5" /> Valid until {fmtDate(issued.expiresAt)} ({Math.round(issued.expiresInSec / 60)} minutes), once.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The receiver signs in on their own device, scans this item&rsquo;s label, and enters
            this code with the seal condition. Nyayyalya keeps only the code&rsquo;s hash, so this is
            the only time it can be shown.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Scan one of two: the holder names the receiver and gets a one-time code for them. */
function InitiateHandover({ item, onIssued }) {
  const recipients = useCustodyRecipients(item.id);
  const initiate = useInitiateTransfer();
  const nextStates = useMemo(() => recipients.data?.nextStates ?? [], [recipients.data]);
  const [chosenStatus, setToStatus] = useState('');
  const [toUserId, setToUserId] = useState('');
  const [reason, setReason] = useState('');

  // The first lawful next state until the sender picks another — derived, not stored,
  // so it is right on the first render the recipient list arrives in.
  const toStatus = chosenStatus || nextStates[0] || '';

  const candidates = useMemo(
    () => (recipients.data?.candidates ?? []).filter((c) => c.forStates.includes(toStatus)),
    [recipients.data, toStatus]
  );

  const onSubmit = (e) => {
    e.preventDefault();
    initiate.mutate(
      {
        id: item.id,
        payload: {
          toUserId,
          toStatus,
          toLocation: recipients.data?.locationForState?.[toStatus] ?? 'MALKHANA',
          reason: reason.trim(),
        },
      },
      {
        onSuccess: (d) => {
          toast.success('Handover started', { description: 'Give the one-time code to the receiver.' });
          onIssued?.(d);
        },
      }
    );
  };

  if (recipients.isPending) return <Skeleton className="h-32 w-full" />;
  if (recipients.isError) return <Denial error={recipients.error} heading="Recipients not readable" />;
  if (!nextStates.length) return <Note>This item has no lawful next step from {humanise(item.status)}.</Note>;

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="to-status">Moving it to</Label>
          <Select value={toStatus} onValueChange={(v) => { setToStatus(v); setToUserId(''); }}>
            <SelectTrigger id="to-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              {nextStates.map((s) => (
                <SelectItem key={s} value={s}>{humanise(s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="to-user">Receiver</Label>
          <Select value={toUserId} onValueChange={setToUserId}>
            <SelectTrigger id="to-user"><SelectValue placeholder="Choose who receives it" /></SelectTrigger>
            <SelectContent>
              {candidates.map((c) => (
                <SelectItem key={c.userId} value={c.userId}>
                  {c.name} · {humanise(c.role)} · {c.authorityId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {candidates.length === 0 && (
        <Note tone="warn">
          Nobody with a Nyayyalya account can receive this item into {humanise(toStatus)} yet. A
          receiver appears here once they have signed in to Nyayyalya at least once.
        </Note>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="handover-reason">Reason</Label>
        <Textarea
          id="handover-reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Deposit into the station store after seizure"
        />
      </div>
      <Button type="submit" disabled={initiate.isPending || !toUserId || !reason.trim()}>
        {initiate.isPending ? <Loader2 className="size-4 animate-spin" /> : <ArrowRightLeft className="size-4" />}
        Start handover
      </Button>
      {initiate.isError && <Denial error={initiate.error} heading="Handover not started" />}
    </form>
  );
}

/** Scan two of two: the named receiver presents the code and states the seal's condition. */
function AcceptHandover({ item, onDone }) {
  const accept = useAcceptTransfer();
  const [token, setToken] = useState('');
  const [sealIntact, setSealIntact] = useState(true);

  const onSubmit = (e) => {
    e.preventDefault();
    accept.mutate(
      { id: item.id, payload: { transferToken: token.trim(), sealIntact } },
      {
        onSuccess: (d) => {
          if (d.frozen) {
            toast.warning('Received — custody frozen', { description: d.integrityException?.message });
          } else {
            toast.success(`Received · now ${humanise(d.item?.status)}`);
          }
          setToken('');
          onDone?.();
        },
      }
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-sm">
        Handover from {item.currentHolder?.name ?? 'the holder'} → {humanise(item.pendingTransfer?.toStatus)},
        valid until {fmtDate(item.pendingTransfer?.expiresAt)}.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="handover-code">One-time handover code</Label>
        <Input
          id="handover-code"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="the code the sender was shown"
          className="font-mono"
        />
      </div>
      <label htmlFor="seal-intact" className="flex items-center gap-2.5 text-sm">
        <Checkbox id="seal-intact" checked={sealIntact} onCheckedChange={(v) => setSealIntact(v === true)} />
        Seal {item.sealNumber} is intact
      </label>
      {!sealIntact && (
        <Note tone="warn">
          Reporting a broken seal still records the handover — the item is in your hands — but
          it freezes custody and writes an integrity exception until a supervisor acts.
        </Note>
      )}
      <Button type="submit" disabled={accept.isPending || token.trim().length < 16}>
        {accept.isPending ? <Loader2 className="size-4 animate-spin" /> : <PackageCheck className="size-4" />}
        Accept custody
      </Button>
      {accept.isError && <Denial error={accept.error} heading="Handover not accepted" />}
    </form>
  );
}

/**
 * The station supervisor's decision on a frozen item. A broken seal froze it "until a
 * supervisor acts"; this is the act — recorded in the ledger with its reasons, never
 * erasing the exception it answers.
 */
function LiftFreeze({ item, onDone }) {
  const lift = useLiftFreeze();
  const [note, setNote] = useState('');
  const [newSeal, setNewSeal] = useState('');

  const onSubmit = (e) => {
    e.preventDefault();
    lift.mutate(
      {
        id: item.id,
        payload: { note: note.trim(), ...(newSeal.trim() ? { newSealNumber: newSeal.trim() } : {}) },
      },
      {
        onSuccess: () => {
          toast.success('Freeze lifted', { description: 'The decision is in the ledger; the exception stays in the chain.' });
          onDone?.();
        },
      }
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-sm">
        Frozen: {humanise(item.frozenReason) || 'seal exception'}
        {item.frozenAt ? ` since ${fmtDate(item.frozenAt)}` : ''}.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="freeze-note">Your decision and its basis</Label>
        <Textarea
          id="freeze-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Article inspected against the seizure memo; contents intact. Re-sealed in my presence."
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-seal">New seal number (if re-sealed)</Label>
        <Input id="new-seal" value={newSeal} onChange={(e) => setNewSeal(e.target.value)} placeholder="SEAL-GZB-…" />
      </div>
      <Button type="submit" disabled={lift.isPending || note.trim().length < 10}>
        {lift.isPending ? <Loader2 className="size-4 animate-spin" /> : <PackageCheck className="size-4" />}
        Record decision and lift the freeze
      </Button>
      {lift.isError && <Denial error={lift.error} heading="Freeze not lifted" />}
    </form>
  );
}

// ============================================================== the register ====

/**
 * The custody register for a scope: every article the viewer's scope reaches, where it
 * is, who holds it, and whether a handover is waiting. Opening a row resolves its label
 * in place — so a receiver can accept a handover from the register without hunting for
 * the printed tag, and a holder can start one.
 *
 * @param {object} props
 * @param {object} [props.query]  e.g. `{ caseId }`
 * @param {string} [props.emptyText]
 */
export function CustodyRegisterPanel({ query, emptyText }) {
  const list = useCustodyItems(query);
  const [openId, setOpenId] = useState(null);
  const items = list.data?.items ?? [];
  const open = items.find((i) => i.id === openId) ?? null;

  if (list.isPending) return <Skeleton className="h-24 w-full" />;
  if (list.isError) return <Denial error={list.error} heading="Custody register not readable" />;
  if (!items.length) {
    return (
      <EmptyState title="No custody items" icon={Boxes}>
        {emptyText ?? 'No physical article in your scope.'}
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {items.map((i) => {
          // Judged against when the register was read, so rendering stays pure; the
          // list refetches on focus and after every handover.
          const waiting =
            i.pendingTransfer && new Date(i.pendingTransfer.expiresAt).getTime() > list.dataUpdatedAt;
          return (
            <div
              key={i.id}
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 text-sm',
                openId === i.id && 'border-accent-from/40'
              )}
            >
              <code className="font-mono text-xs">{i.itemCode}</code>
              <span className="min-w-0 flex-1 truncate">{i.description}</span>
              <Pill tone={i.frozen ? 'bad' : 'neutral'}>{i.frozen ? 'Frozen' : humanise(i.status)}</Pill>
              <Pill tone={i.sealIntact === false ? 'bad' : 'ok'}>Seal {i.sealIntact === false ? 'broken' : 'intact'}</Pill>
              {waiting && <Pill tone="warn">Handover waiting</Pill>}
              <span className="text-xs text-muted-foreground">
                {i.currentHolder ? `with ${i.currentHolder.name}` : ''}
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" variant={openId === i.id ? 'default' : 'outline'} onClick={() => setOpenId(openId === i.id ? null : i.id)}>
                  {openId === i.id ? 'Close' : 'Open'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => printCustodyLabel(i)}>
                  <Printer className="size-3.5" /> Label
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {open && (
        <div className="rounded-lg border p-4">
          <ScanPanel key={open.id} initial={open.qrPayload} />
        </div>
      )}
    </div>
  );
}

// ================================================================== the scan ====

/**
 * Resolve a label and act on the item.
 *
 * @param {object} props
 * @param {string} [props.initial]  a payload or scan link to resolve on mount
 * @param {(id:string) => void} [props.onItem]  told the item id once resolved
 */
export function ScanPanel({ initial, onItem, showChain = true }) {
  const scan = useScanCustodyLabel();
  // Seeded once from `initial`; callers that change the label remount with a `key`.
  const [raw, setRaw] = useState(initial ?? '');
  const [issued, setIssued] = useState(null);
  const lastPayload = useRef('');

  const resolve = (value) => {
    const payload = labelPayloadFrom(value);
    if (!payload) return;
    lastPayload.current = payload;
    scan.mutate(payload, {
      onSuccess: (result) => onItem?.(result.item?.id),
      onError: (error) => toast.error('Label not resolved', { description: explain(error.code, error.message) }),
    });
  };

  // A label that arrived in the URL or from a register row is resolved on arrival —
  // a scan should land on a result, not on a form somebody then has to submit.
  useEffect(() => {
    if (initial) resolve(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const refresh = () =>
    lastPayload.current && scan.mutate(lastPayload.current, { onSuccess: (r) => onItem?.(r.item?.id) });

  const item = scan.data?.item;
  const actions = scan.data?.allowedActions ?? [];
  // A handover nobody accepted in time is dead: the code no longer works, and the
  // server lets the holder start a new one. Treat it as absent rather than blocking.
  // Judged against when this scan was made, so rendering stays pure; resolving the
  // label again re-judges it.
  const pendingLive = Boolean(
    item?.pendingTransfer && new Date(item.pendingTransfer.expiresAt).getTime() > (scan.submittedAt || 0)
  );

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          resolve(raw);
        }}
        className="space-y-2"
      >
        <Label htmlFor="scan-input">Label</Label>
        <div className="flex gap-2">
          <Input
            id="scan-input"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="NYAYALAY:v1:IT-…  or the …/scan?label=… link from the QR"
            className="font-mono"
          />
          <Button type="submit" disabled={scan.isPending || !raw.trim()}>
            {scan.isPending ? <Loader2 className="size-4 animate-spin" /> : <ScanLine className="size-4" />}
            Resolve label
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Scan the QR on the evidence bag with a phone, or paste the text printed under it. The
          label&rsquo;s signature is checked on the server; a forged label is refused and logged.
        </p>
      </form>

      {scan.isError && <Denial error={scan.error} heading="Label not resolved" />}

      {item && (
        <div className="space-y-4">
          <Note>{scan.data.notice}</Note>
          <KeyValue
            rows={[
              ['Item', <code key="i" className="font-mono text-xs">{item.itemCode}</code>],
              ['Article', item.description],
              ['FIR', item.firNumber ?? '—'],
              ['Seal', `${item.sealNumber} · ${item.sealIntact === false ? 'BROKEN' : 'intact'}`],
              ['Status', <Pill key="s" tone={item.frozen ? 'bad' : 'neutral'}>{item.frozen ? 'Frozen' : humanise(item.status)}</Pill>],
              ['Location', humanise(item.currentLocation)],
              ['Held by', item.currentHolder ? `${item.currentHolder.name} · ${humanise(item.currentHolder.role)} · ${item.currentHolder.authorityId}` : '—'],
              item.pendingTransfer && [
                pendingLive ? 'Handover pending' : 'Handover expired',
                `to ${item.pendingTransfer.to?.name ?? '—'} → ${humanise(item.pendingTransfer.toStatus)}, ${pendingLive ? 'until' : 'lapsed'} ${fmtDate(item.pendingTransfer.expiresAt)}`,
              ],
              ['Lawful next states', (scan.data.nextStates ?? []).map(humanise).join(', ') || 'none'],
            ]}
          />

          {issued && issued.item?.id === item.id && (
            <IssuedHandover issued={issued} onDismiss={() => setIssued(null)} />
          )}

          {actions.includes('INITIATE_TRANSFER') && !pendingLive && (
            <div className="space-y-3 rounded-lg border p-4">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <ArrowRightLeft className="size-4" /> You hold this item — hand it over
              </p>
              <InitiateHandover
                item={item}
                onIssued={(d) => {
                  setIssued(d);
                  refresh();
                }}
              />
            </div>
          )}

          {actions.includes('ACCEPT_TRANSFER') && pendingLive && (
            <div className="space-y-3 rounded-lg border border-accent-from/40 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <PackageCheck className="size-4" /> This item is being handed to you
              </p>
              <AcceptHandover item={item} onDone={refresh} />
            </div>
          )}

          {actions.includes('LIFT_FREEZE') && (
            <div className="space-y-3 rounded-lg border border-bad/40 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <PackageCheck className="size-4" /> Custody is frozen — your decision as SHO
              </p>
              <LiftFreeze item={item} onDone={refresh} />
            </div>
          )}

          {item.frozen && !actions.includes('LIFT_FREEZE') && (
            <Note tone="warn">
              Custody is frozen after a seal exception. Nothing can move until the station SHO
              records a decision.
            </Note>
          )}

          {!item.frozen && !actions.includes('INITIATE_TRANSFER') && !actions.includes('ACCEPT_TRANSFER') && (
            <p className="text-xs text-muted-foreground">
              You can read this item but hold no part in moving it: only the current holder can hand
              it over, and only the named receiver can accept.
            </p>
          )}

          <CustodyLabelCard item={item} compact />

          {showChain && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Link2 className="size-4" /> Custody chain
              </p>
              <CustodyChainView itemId={item.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
