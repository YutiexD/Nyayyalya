/**
 * A lifecycle as a vertical timeline: what happened, when, who did it, and the proof.
 *
 * Each entry: `{ key, label, state, at, description, actor, proofs }` where `state` is
 * done | current | upcoming | not_applicable, `actor` is `{ name, roleLabel, authorityId }`
 * and each proof is `{ label, value, kind: hash|key|ledger|anchor|text, href?, status? }`.
 * Everything past `label` and `state` is optional; an entry without it simply renders
 * shorter. Proofs are closed by default, one toggle per entry.
 */
import { useState } from 'react';
import { Check, ChevronDown, ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/common/CopyButton';
import { MetaLine } from '@/components/common/Shell';
import { cn, fmtDate, humanise } from '@/lib/utils';

const STATE_SR = {
  done: 'Done',
  current: 'In progress',
  upcoming: 'Not yet',
  not_applicable: 'Not applicable',
};

function Marker({ state }) {
  if (state === 'done') {
    return (
      <span className="relative z-10 grid size-5 shrink-0 place-items-center rounded-full bg-ok text-ok-foreground">
        <Check aria-hidden className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span className="relative z-10 grid size-5 shrink-0 place-items-center rounded-full border-2 border-primary bg-card ring-4 ring-primary/15">
        <span className="size-2 rounded-full bg-primary" />
      </span>
    );
  }
  if (state === 'not_applicable') {
    return <span className="relative z-10 size-5 shrink-0 rounded-full border border-dashed border-border bg-card" />;
  }
  return <span className="relative z-10 size-5 shrink-0 rounded-full border-2 border-border bg-card" />;
}

const COPYABLE = new Set(['hash', 'key', 'ledger', 'anchor']);

function anchorBadge(proof) {
  const status = String(proof.status ?? '').toUpperCase();
  if (status === 'FAILED') return { label: 'Anchor failed', variant: 'danger' };
  if (status === 'CONFIRMED' || status === 'ANCHORED' || (!status && proof.href)) {
    return { label: 'Anchored', variant: 'success' };
  }
  if (status) return { label: humanise(status), variant: 'warning' };
  return { label: 'Awaiting anchor', variant: 'warning' };
}

function safeHref(href) {
  return typeof href === 'string' && /^https?:\/\//i.test(href) ? href : null;
}

function ProofList({ proofs }) {
  return (
    <dl className="mt-2 space-y-2 rounded-lg border bg-muted/30 px-3 py-2.5">
      {proofs.map((p, i) => {
        const value = p?.value === null || p?.value === undefined ? '' : String(p.value);
        const href = safeHref(p?.href);
        const badge = p?.kind === 'anchor' ? anchorBadge(p) : null;
        const technical = p?.kind && p.kind !== 'text';
        return (
          <div key={`${p?.label ?? 'proof'}-${i}`} className="min-w-0">
            <dt className="flex flex-wrap items-center gap-1.5 text-label text-muted-foreground">
              {p?.label ?? humanise(p?.kind) ?? 'Proof'}
              {badge && (
                <Badge variant={badge.variant} size="sm" dot>
                  {badge.label}
                </Badge>
              )}
            </dt>
            <dd className="flex min-w-0 items-start gap-1">
              {value ? (
                <span
                  className={cn(
                    'min-w-0 flex-1 py-1 text-meta',
                    technical ? 'break-all font-mono text-[12px] text-foreground/90' : 'break-words text-foreground'
                  )}
                >
                  {value}
                </span>
              ) : (
                <span className="flex-1 py-1 text-meta text-muted-foreground">—</span>
              )}
              {value && COPYABLE.has(p?.kind) && (
                <CopyButton
                  value={value}
                  label={`Copy ${String(p?.label ?? 'value').toLowerCase()}`}
                  className="size-6 shrink-0 [&_svg]:size-3.5"
                />
              )}
              {href && (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`Open ${p?.label ?? 'link'} in a new tab`}
                  title="Open in a new tab"
                  className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Entry({ entry, last, compact }) {
  const [open, setOpen] = useState(false);
  const state = entry.state ?? 'upcoming';
  const muted = state === 'upcoming' || state === 'not_applicable';
  const actor = entry.actor && typeof entry.actor === 'object' ? entry.actor : null;
  const proofs = (Array.isArray(entry.proofs) ? entry.proofs : []).filter(Boolean);
  const when = entry.at ? fmtDate(entry.at) : null;

  return (
    <li aria-current={state === 'current' ? 'step' : undefined} className={cn('relative flex gap-3', !last && 'pb-5')}>
      {!last && (
        <span
          aria-hidden
          className={cn('absolute bottom-0 left-[9.5px] top-5 w-px', state === 'done' ? 'bg-ok/40' : 'bg-border')}
        />
      )}
      <Marker state={state} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p
            className={cn(
              'text-sm leading-5',
              state === 'current' && 'font-semibold text-foreground',
              state === 'done' && 'font-medium text-foreground',
              muted && 'text-muted-foreground'
            )}
          >
            <span className="sr-only">{STATE_SR[state] ?? ''}: </span>
            {entry.label ?? humanise(entry.key)}
          </p>
          {(when || state === 'current') && (
            <span className={cn('shrink-0 text-meta tabular', state === 'current' ? 'text-primary' : 'text-muted-foreground')}>
              {state === 'current' ? (when ? `In progress · since ${when}` : 'In progress') : when}
            </span>
          )}
        </div>

        {entry.description && (
          <p
            className={cn(
              'max-w-prose leading-relaxed text-pretty',
              compact ? 'text-meta' : 'text-[14px]',
              muted ? 'text-muted-foreground' : 'text-foreground/80'
            )}
          >
            {entry.description}
          </p>
        )}

        {actor && (actor.name || actor.roleLabel || actor.authorityId) && (
          <MetaLine
            items={[
              actor.name,
              actor.roleLabel,
              actor.authorityId && (
                <code key="id" className="font-mono text-[12px]">
                  {actor.authorityId}
                </code>
              ),
            ]}
          />
        )}

        {proofs.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex items-center gap-1 rounded-md text-meta font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
              {open ? 'Hide proof' : `Show proof${proofs.length > 1 ? ` (${proofs.length})` : ''}`}
            </button>
            {open && <ProofList proofs={proofs} />}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * @param {object} props
 * @param {object[]} props.entries
 * @param {boolean} [props.compact]  smaller description text (dialogs, side columns)
 */
export function LifecycleTimeline({ entries, compact = false, className }) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    // A step that does not apply is noise unless the server says why.
    (e) => e && (e.state !== 'not_applicable' || e.description)
  );
  if (!list.length) return null;

  return (
    <ol className={className}>
      {list.map((entry, i) => (
        <Entry key={entry.key ?? i} entry={entry} last={i === list.length - 1} compact={compact} />
      ))}
    </ol>
  );
}

/** True when a lifecycle has anything worth showing. */
export const hasLifecycle = (entries) =>
  Array.isArray(entries) && entries.some((e) => e && (e.state !== 'not_applicable' || e.description));
