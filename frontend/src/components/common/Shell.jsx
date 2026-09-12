/**
 * The layout vocabulary every screen is built from.
 *
 * ## The rule these components exist to enforce
 *
 * **One screen answers one question.** The old role views were tabbed workspaces —
 * five tabs, four stat cards, two tables and a form, all mounted at once — and the
 * cost was not that they looked busy. It was that nobody could tell what to do next.
 * Everything was equally present, so nothing was prominent, and a presenter had to
 * narrate which quarter of the screen to look at.
 *
 * So the pieces here are deliberately few, and each has one job:
 *
 *   `Workspace`   the page frame: a title that says whose screen this is, one lede,
 *                 and at most one primary action.
 *   `Focus`       the answer to the screen's question, stated as a sentence and a
 *                 number. At most one per screen.
 *   `Counter`     a small figure in a row of small figures. Never a card.
 *   `Panel`       a titled region. A screen has two or three, not seven.
 *   `SplitView`   list on the left, detail on the right — the shape that replaced
 *                 tabs, because it keeps the list in view while you read one row.
 *   `Disclosure`  the secondary material, closed by default. This is where the
 *                 hashes, the ledger and the chain-of-custody detail now live: still
 *                 one click away, no longer in front of someone who came to do
 *                 something else.
 *   `Rows`/`Row`  a list of things you can open. Replaces most of the tables.
 *
 * ## Why so few tables
 *
 * A table is right when a reader will COMPARE values down a column. It is wrong when
 * they are scanning for one item to open, which is what almost every list in this
 * product is for — and an eight-column table of mixed codes, dates and badges is the
 * single biggest source of the density this redesign was asked to remove.
 */
import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// ------------------------------------------------------------------- page ----

/**
 * The page frame.
 *
 * @param {object} props
 * @param {string} props.eyebrow   who this screen belongs to, e.g. "Forensic laboratory"
 * @param {string} props.title     the question this screen answers, in the user's words
 * @param {string} [props.lede]    one sentence. If it needs two, the screen is doing too much.
 * @param {React.ReactNode} [props.action]  the one primary action, if there is one
 */
export function Workspace({ eyebrow, title, lede, action, children, className }) {
  return (
    <div className={cn('container max-w-7xl space-y-8 py-8 sm:py-10', className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 space-y-1.5">
          {eyebrow && <p className="label-xs">{eyebrow}</p>}
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h1>
          {lede && (
            <p className="max-w-2xl text-[15px] leading-relaxed text-muted-foreground text-pretty">
              {lede}
            </p>
          )}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </header>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ focus ----

/**
 * The screen's answer, said once and said large.
 *
 * A dashboard with four equal stat cards makes the reader choose which number
 * matters. This makes that choice for them: one figure, a sentence saying what it
 * means, and — when there is something to do about it — the button to do it.
 *
 * `tone` colours the figure, and only the figure. Never the panel.
 */
const FOCUS_TONE = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
  neutral: 'text-foreground',
};

export function Focus({ value, label, detail, tone = 'neutral', action, aside, className }) {
  return (
    <section
      className={cn(
        'surface flex flex-wrap items-center justify-between gap-x-8 gap-y-5 p-5 sm:p-6',
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-5">
        <p
          className={cn(
            'shrink-0 text-4xl font-semibold tabular tracking-tight sm:text-5xl',
            FOCUS_TONE[tone] ?? FOCUS_TONE.neutral
          )}
        >
          {value}
        </p>
        <div className="min-w-0 space-y-0.5">
          <p className="text-[15px] font-medium leading-snug">{label}</p>
          {detail && (
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
              {detail}
            </p>
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
 * A small figure in a row of small figures. Deliberately NOT a card: the row reads as
 * one object, so five of these cost the eye about as much as one used to.
 *
 * `onClick` makes it a filter — which is what most of these figures are really for.
 */
export function Counter({ label, value, tone = 'neutral', active, onClick, className }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex min-w-[6.5rem] flex-1 flex-col gap-0.5 rounded-lg border px-3.5 py-2.5 text-left transition-colors',
        onClick && 'hover:bg-muted/60',
        active ? 'border-ring/50 bg-muted/70' : 'border-border bg-card',
        className
      )}
      aria-pressed={onClick ? Boolean(active) : undefined}
    >
      <span className="label-xs">{label}</span>
      <span className={cn('text-xl font-semibold tabular', FOCUS_TONE[tone] ?? FOCUS_TONE.neutral)}>
        {value}
      </span>
    </Tag>
  );
}

/** A row of Counters. */
export function CounterRow({ children, className }) {
  return <div className={cn('flex flex-wrap gap-2.5', className)}>{children}</div>;
}

// ----------------------------------------------------------------- panels ----

/**
 * A titled region.
 *
 * `description` is optional and should usually be omitted — the old screens explained
 * every panel in two sentences of legal reasoning, which is excellent documentation
 * and terrible signage. The explanations that carry a compliance obligation have been
 * kept; the ones that restated the title have not.
 */
export function Panel({ title, description, actions, footer, children, className, bodyClassName }) {
  return (
    <section className={cn('surface overflow-hidden', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b px-5 py-3.5">
          <div className="min-w-0 space-y-0.5">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('p-5', bodyClassName)}>{children}</div>
      {footer && <div className="border-t bg-muted/30 px-5 py-3 text-[13px]">{footer}</div>}
    </section>
  );
}

/**
 * List on the left, the selected thing on the right.
 *
 * The shape that replaced the tab strips. A tab hides the list the moment you open a
 * row; this keeps both, which is what you want when the job is "work through these".
 * It stacks on narrow screens, list first.
 */
export function SplitView({ list, detail, className }) {
  return (
    <div className={cn('grid items-start gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]', className)}>
      <div className="min-w-0">{list}</div>
      <div className="min-w-0">{detail}</div>
    </div>
  );
}

// ------------------------------------------------------- progressive detail ----

/**
 * Secondary material, closed by default.
 *
 * This is the component that does most of the decluttering. Digests, ledger entries,
 * custody chains, denial feeds and integrity checks are all still here and all still
 * one click away — they are simply no longer competing for attention with the thing
 * the user actually came to do.
 *
 * A real `<button>` with `aria-expanded`, not a `<details>`: the content has to be
 * unmounted when closed so its queries do not run, and `<details>` keeps it mounted.
 */
export function Disclosure({ label, hint, defaultOpen = false, children, className }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className={cn('rounded-lg border', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">{label}</span>
          {hint && <span className="block text-[13px] text-muted-foreground">{hint}</span>}
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
        <div id={id} className="space-y-4 border-t px-4 py-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- rows ----

/** A list of openable things. */
export function Rows({ children, className }) {
  return <ul className={cn('divide-y', className)}>{children}</ul>;
}

/**
 * One openable thing.
 *
 * Three slots and no more: what it is (`title` + `meta`), its state (`badge`), and —
 * optionally — one line of context (`children`). Anything else belongs in the detail
 * pane, which is the whole point of having one.
 */
export function Row({ title, meta, badge, selected, onSelect, children, className }) {
  return (
    <li className={className}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
          selected ? 'row-selected' : 'hover:bg-muted/50'
        )}
      >
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
          </span>
          {meta && <span className="block truncate text-[13px] text-muted-foreground">{meta}</span>}
          {children}
        </span>
        {badge && <span className="shrink-0 pt-0.5">{badge}</span>}
      </button>
    </li>
  );
}

// ----------------------------------------------------------------- states ----

/**
 * An empty result, explained.
 *
 * Every empty state in this product says which of two things it is: nothing has
 * happened yet, or you are not entitled to see what has. A blank box says neither,
 * and in an evidence register the difference is the whole product.
 */
export function Empty({ title, children, icon: Icon, action, className }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center',
        className
      )}
    >
      {Icon && <Icon aria-hidden className="size-5 text-muted-foreground" />}
      <p className="text-sm font-medium">{title}</p>
      {children && (
        <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground text-pretty">
          {children}
        </p>
      )}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

/** What a list shows while its query is in flight. */
export function RowsSkeleton({ rows = 4 }) {
  return (
    <div className="space-y-px" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <div className="flex-1 space-y-1.5">
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
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

// ------------------------------------------------------------------ facts ----

/**
 * Label-and-value pairs.
 *
 * Rows that are `null`, `undefined` or `false` are dropped, so a caller can write
 * `cond && ['Label', value]` inline and an absent fact leaves no empty line behind.
 */
export function Facts({ rows, className, dense }) {
  const visible = (rows ?? []).filter(Boolean);
  if (!visible.length) return null;
  return (
    <dl
      className={cn(
        'grid gap-x-6 sm:grid-cols-[minmax(8rem,auto)_1fr]',
        dense ? 'gap-y-1.5' : 'gap-y-2.5',
        className
      )}
    >
      {visible.map(([label, value], i) => (
        <div key={`${label}-${i}`} className="contents">
          <dt className="text-[13px] text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-[13px] font-medium">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A cryptographic digest.
 *
 * Full value, monospaced, selectable in one gesture. Never truncated where somebody
 * is expected to compare it — a hash a viewer cannot read in full is a hash they
 * cannot check, which defeats the point of showing it.
 */
export function Digest({ value, label, block = true, className }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn('hash', block && 'block rounded-md bg-muted/60 p-2', className)}
      title={label}
    >
      {value}
    </span>
  );
}
