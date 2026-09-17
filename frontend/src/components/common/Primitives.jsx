/**
 * Small display primitives shared by the older views (sign-in and certificate panels).
 * They render with exactly the same styles as the
 * `Shell` vocabulary, so a screen built from either set looks like one product.
 * New code should import from `@/components/common/Shell` directly.
 */
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, Facts, SectionHeader } from '@/components/common/Shell';
import { cn } from '@/lib/utils';

/**
 * A titled surface. Same look as `Shell.Panel`: header with title left and actions
 * right, a hairline, then the content.
 */
export function Section({ title, description, actions, children, className }) {
  return (
    <section className={cn('surface overflow-hidden', className)}>
      {(title || actions) && (
        <SectionHeader
          title={title}
          description={description}
          actions={actions}
          className="min-h-14 border-b px-5 py-3"
        />
      )}
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

/**
 * Key/value rows. Same as `Shell.Facts`.
 *
 * @param {object} props
 * @param {Array<[string, React.ReactNode]>} props.rows
 */
export function KeyValue({ rows, className }) {
  return <Facts rows={rows} className={className} />;
}

/**
 * A cryptographic digest, inline. Full value, monospaced, selectable in one gesture.
 */
export function Hash({ value, label, className }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn('hash', className)} title={label}>
      {value}
    </span>
  );
}

/** Page heading. Same type as `Shell.Workspace`. */
export function PageHeader({ title, lede, actions, className }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-title text-foreground">{title}</h1>
        {lede && (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground text-pretty">{lede}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** What a table shows while its query is in flight. */
export function TableSkeleton({ rows = 4, cols = 4 }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className="h-9 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** An empty result. Same as `Shell.Empty`. */
export function EmptyState({ title, children, icon }) {
  return (
    <Empty title={title} icon={icon}>
      {children}
    </Empty>
  );
}
