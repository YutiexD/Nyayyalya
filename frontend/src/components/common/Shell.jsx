/**
 * The layout vocabulary every screen is built from.
 *
 * ## The rule these components exist to enforce
 *
 * **One screen answers one question.** A screen should be readable within seconds on a
 * projector: a title, the one primary action, a list of things to work through, and
 * the selected thing in full. Everything else is one click away in a `Disclosure`.
 *
 *   `Workspace`      page frame: title (24px), optional eyebrow and lede, primary action.
 *   `Panel`          a titled surface. Header: title left, actions right. A screen has
 *                    two or three, not seven. `variant="plain"` drops the box entirely.
 *   `SectionHeader`  the same header, unboxed, for grouping content inside a panel.
 *   `SplitView`      list on the left, detail on the right.
 *   `Rows` / `Row`   a list inside ONE surface, separated by hairlines. Not a card per item.
 *   `MetaLine`       secondary facts on one muted line, dot-separated.
 *   `Facts`          label / value pairs.
 *   `Disclosure`     secondary material, closed by default.
 *   `Empty`          a calm empty state: small icon, one short line.
 *
 * `Focus`, `Counter` and `CounterRow` are deprecated: metric tiles are being removed
 * from the role pages. They still render so existing pages compile.
 */
import { Fragment, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// ------------------------------------------------------------------- page ----

/**
 * The page frame. Content is centred at max 1280px.
 *
 * @param {object} props
 * @param {string} [props.eyebrow]  who this screen belongs to, e.g. "Forensic laboratory". Rendered small.
 * @param {React.ReactNode} props.title   the question this screen answers
 * @param {React.ReactNode} [props.lede]  one short sentence, muted. Prefer omitting it.
 * @param {React.ReactNode} [props.action]  the primary action, right-aligned (`actions` is an alias)
 */
export function Workspace({ eyebrow, title, lede, action, actions, children, className, headerClassName }) {
  const act = action ?? actions;
  return (
    <div className={cn('page-container space-y-6 py-6 sm:py-8', className)}>
      <header
        className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', headerClassName)}
      >
        <div className="min-w-0 space-y-1">
          {eyebrow && <p className="text-[13px] font-medium text-muted-foreground">{eyebrow}</p>}
          <h1 className="text-title text-foreground">{title}</h1>
          {lede && (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground text-pretty">{lede}</p>
          )}
        </div>
        {act && <div className="flex shrink-0 flex-wrap items-center gap-2">{act}</div>}
      </header>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- headers ----

/**
 * A section heading: title (16px semibold) left, actions right, optional muted
 * description. Unboxed; `Panel` uses it for its own header.
 */
export function SectionHeader({ title, description, actions, className, as: Heading = 'h2' }) {
  if (!title && !actions) return null;
  return (
    <div
      className={cn(
        'flex flex-wrap justify-between gap-x-4 gap-y-2',
        description ? 'items-start' : 'items-center',
        className
      )}
    >
      <div className="min-w-0">
        {title && <Heading className="text-section text-foreground">{title}</Heading>}
        {description && (
          <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ focus ----

const FOCUS_TONE = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
  neutral: 'text-foreground',
};

/**
 * One figure and a sentence saying what it means.
 * @deprecated Metric tiles are being removed from role pages. Put the fact in the list or
 * the detail panel instead.
 */
export function Focus({ value, label, detail, tone = 'neutral', action, aside, className }) {
  return (
    <section
      className={cn('surface flex flex-wrap items-center justify-between gap-x-8 gap-y-4 p-5', className)}
    >
      <div className="flex min-w-0 items-center gap-4">
        <p
          className={cn(
            'shrink-0 text-3xl font-semibold tabular tracking-tight',
            FOCUS_TONE[tone] ?? FOCUS_TONE.neutral
          )}
        >
          {value}
        </p>
        <div className="min-w-0 space-y-0.5">
          <p className="text-[15px] font-medium leading-snug">{label}</p>
          {detail && (
            <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground text-pretty">{detail}</p>
          )}
        </div>
      </div>
      {(aside || action) && (
        <div className="flex flex-wrap items-center gap-3">
          {aside}
          {action}
        </div>
      )}
    </section>
  );
}

/**
 * A small figure in a row of small figures. `onClick` makes it a filter.
 * @deprecated Metric tiles are being removed from role pages. For filtering, use Tabs or
 * a segmented set of `Button variant="secondary" | "ghost"`.
 */
export function Counter({ label, value, tone = 'neutral', active, onClick, className }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex min-w-[6.5rem] flex-1 flex-col gap-0.5 rounded-lg border bg-card px-4 py-2.5 text-left transition-colors',
        onClick && 'hover:bg-muted/50',
        active && 'border-primary/40 bg-primary/[0.05]',
        className
      )}
      aria-pressed={onClick ? Boolean(active) : undefined}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-lg font-semibold tabular', FOCUS_TONE[tone] ?? FOCUS_TONE.neutral)}>
        {value}
      </span>
    </Tag>
  );
}

/**
 * A row of Counters.
 * @deprecated See `Counter`.
 */
export function CounterRow({ children, className }) {
  return <div className={cn('flex flex-wrap gap-2', className)}>{children}</div>;
}

// ----------------------------------------------------------------- panels ----

/**
 * A titled region.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.title]
 * @param {React.ReactNode} [props.description]  small and muted; usually omit it
 * @param {React.ReactNode} [props.actions]      right-aligned in the header
 * @param {React.ReactNode} [props.footer]
 * @param {'card'|'plain'} [props.variant='card']  `plain`: no surface, just header + content
 * @param {boolean} [props.divider=true]          hairline under the header (card variant)
 * @param {string} [props.bodyClassName]          e.g. "p-0" when the body is a `Rows` list
 */
export function Panel({
  title,
  description,
  actions,
  footer,
  children,
  className,
  bodyClassName,
  headerClassName,
  variant = 'card',
  divider = true,
  id,
}) {
  const hasHeader = Boolean(title || actions);

  if (variant === 'plain') {
    return (
      <section id={id} className={cn('space-y-3', className)}>
        {hasHeader && (
          <SectionHeader
            title={title}
            description={description}
            actions={actions}
            className={headerClassName}
          />
        )}
        <div className={bodyClassName}>{children}</div>
        {footer && <div className="text-[13px] text-muted-foreground">{footer}</div>}
      </section>
    );
  }

  return (
    <section id={id} className={cn('surface overflow-hidden', className)}>
      {hasHeader && (
        <SectionHeader
          title={title}
          description={description}
          actions={actions}
          className={cn('min-h-14 px-5 py-3', divider && 'border-b', headerClassName)}
        />
      )}
      <div className={cn('p-5', hasHeader && !divider && 'pt-0', bodyClassName)}>{children}</div>
      {footer && (
        <div className="border-t bg-muted/30 px-5 py-3 text-[13px] text-muted-foreground">{footer}</div>
      )}
    </section>
  );
}

/**
 * List on the left, the selected thing on the right. Stacks on narrow screens.
 * `sticky` keeps the list in view while a long detail pane scrolls.
 */
export function SplitView({ list, detail, className, sticky = false }) {
  return (
    <div className={cn('grid items-start gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]', className)}>
      <div className={cn('min-w-0', sticky && 'lg:sticky lg:top-20')}>{list}</div>
      <div className="min-w-0">{detail}</div>
    </div>
  );
}

// ------------------------------------------------------- progressive detail ----

/**
 * Secondary material, closed by default. Content is unmounted while closed, so its
 * queries do not run.
 */
export function Disclosure({ label, hint, defaultOpen = false, children, className }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className={cn('rounded-xl border bg-card', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          open ? 'rounded-t-xl' : 'rounded-xl'
        )}
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          {hint && <span className="mt-0.5 block text-[13px] text-muted-foreground">{hint}</span>}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <div id={id} className="space-y-4 border-t px-5 py-5">
          {children}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- rows ----

/** A list of rows inside one surface, separated by hairlines. */
export function Rows({ children, className }) {
  return <ul className={cn('divide-y divide-border', className)}>{children}</ul>;
}

/**
 * One row (about 60px tall).
 *
 * @param {object} props
 * @param {React.ReactNode} props.title     15px medium, truncated
 * @param {React.ReactNode} [props.meta]    13px muted, one line (see `MetaLine`)
 * @param {React.ReactNode} [props.badge]   status, right-aligned inside the clickable area
 * @param {React.ReactNode} [props.actions] buttons, right-aligned OUTSIDE the clickable area
 * @param {React.ReactNode} [props.leading] an icon or avatar before the title
 * @param {boolean} [props.selected]
 * @param {() => void} [props.onSelect]     makes the row a button; without it the row is static
 * @param {boolean} [props.disabled]
 * @param {React.ReactNode} [props.children] one extra line of context under the meta
 */
export function Row({
  title,
  meta,
  badge,
  actions,
  leading,
  selected,
  onSelect,
  disabled,
  children,
  className,
}) {
  const interactive = typeof onSelect === 'function';
  const Main = interactive ? 'button' : 'div';
  const multiline = Boolean(children);

  return (
    <li
      className={cn(
        'relative flex items-stretch transition-colors',
        selected ? 'row-selected' : interactive && !disabled && 'hover:bg-muted/50',
        className
      )}
    >
      <Main
        type={interactive ? 'button' : undefined}
        onClick={interactive ? onSelect : undefined}
        disabled={interactive ? disabled : undefined}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex min-h-[60px] min-w-0 flex-1 gap-3 px-5 py-3 text-left',
          multiline ? 'items-start' : 'items-center',
          interactive &&
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
          actions && 'pr-3'
        )}
      >
        {leading && (
          <span className={cn('flex shrink-0 text-muted-foreground', multiline && 'pt-0.5')}>{leading}</span>
        )}
        <span className="block min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium leading-6 text-foreground">{title}</span>
          {meta && <span className="block truncate text-[13px] leading-5 text-muted-foreground">{meta}</span>}
          {children}
        </span>
        {badge && (
          <span className={cn('flex shrink-0 items-center gap-1.5', multiline && 'pt-0.5')}>{badge}</span>
        )}
      </Main>
      {actions && <div className="flex shrink-0 items-center gap-1.5 pr-5">{actions}</div>}
    </li>
  );
}

/**
 * Secondary facts on one muted line, separated by dots. Falsy items are dropped.
 * `<MetaLine items={['FIR 0124/2026', fmtDate(d), '3 exhibits']} />`
 */
export function MetaLine({ items, className }) {
  const parts = (items ?? []).filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  if (!parts.length) return null;
  return (
    <span
      className={cn(
        'inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground',
        className
      )}
    >
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
          )}
          <span className="min-w-0">{p}</span>
        </Fragment>
      ))}
    </span>
  );
}

// ----------------------------------------------------------------- states ----

/**
 * An empty result: small icon, a short title, at most one line of explanation.
 * `bordered` adds a dashed outline for use outside a panel; `compact` halves the padding.
 */
export function Empty({ title, children, icon: Icon, action, className, bordered = false, compact = false }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center',
        compact ? 'gap-1 px-4 py-6' : 'gap-1.5 px-6 py-10',
        bordered && 'rounded-xl border border-dashed',
        className
      )}
    >
      {Icon && (
        <span className="mb-1.5 grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon aria-hidden className="size-4" />
        </span>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children && (
        <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground text-pretty">{children}</p>
      )}
      {action && <div className="pt-3">{action}</div>}
    </div>
  );
}

/** What a list shows while its query is in flight. */
export function RowsSkeleton({ rows = 4 }) {
  return (
    <div className="divide-y" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex min-h-[60px] items-center gap-3 px-5 py-3">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** What a detail pane shows while its query is in flight. */
export function DetailSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

// ------------------------------------------------------------------ facts ----

/**
 * Label / value pairs in two columns.
 *
 * Rows that are `null`, `undefined` or `false` are dropped, so a caller can write
 * `cond && ['Label', value]` inline. `dense` tightens spacing; `divided` puts a hairline
 * between rows.
 */
export function Facts({ rows, className, dense, divided = false }) {
  const visible = (rows ?? []).filter(Boolean);
  if (!visible.length) return null;

  if (divided) {
    return (
      <dl className={cn('divide-y', className)}>
        {visible.map(([label, value], i) => (
          <div
            key={`${label}-${i}`}
            className={cn('grid grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)] gap-x-6', dense ? 'py-1.5' : 'py-2.5')}
          >
            <dt className="text-[13px] leading-5 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-sm leading-5 text-foreground">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <dl
      className={cn(
        'grid grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)] gap-x-6',
        dense ? 'gap-y-1.5' : 'gap-y-2.5',
        className
      )}
    >
      {visible.map(([label, value], i) => (
        <div key={`${label}-${i}`} className="contents">
          <dt className="text-[13px] leading-5 text-muted-foreground">{label}</dt>
          <dd
            className={cn(
              'min-w-0 break-words leading-5 text-foreground',
              dense ? 'text-[13px]' : 'text-sm font-medium'
            )}
          >
            {value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A cryptographic digest. Full value, monospaced, selectable in one gesture. Never
 * truncated where somebody is expected to compare it.
 */
export function Digest({ value, label, block = true, className }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn('hash', block && 'block rounded-md border bg-muted/50 px-2.5 py-2', className)}
      title={label}
    >
      {value}
    </span>
  );
}
