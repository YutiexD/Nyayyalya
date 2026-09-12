/**
 * Small display primitives shared by every role view.
 *
 * These are compositions of shadcn parts, not new components: a key/value row is a
 * `<dl>` with the project's spacing, and a section is a Card with a consistent header.
 * The point is that two screens describing the same kind of thing describe it the same
 * way — an evidence register that renders a hash three different ways looks unreliable
 * whether or not it is.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A titled panel, for the surfaces that have not moved to `Shell.Panel` — the public
 * verifier, sign-in, and the deep custody and certificate panels that sit INSIDE the
 * new panels rather than beside them.
 *
 * The travelling border beam is gone. It marked "look here first" on one panel per
 * screen, which was a reasonable idea and a restless thing to sit in front of for a
 * whole shift; the new screens carry that emphasis in their layout instead.
 */
export function Section({ title, description, actions, children, className }) {
  return (
    <Card className={cn('surface relative overflow-hidden', className)}>
      {(title || actions) && (
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
          <div className="space-y-0.5">
            {title && <CardTitle className="text-sm">{title}</CardTitle>}
            {description && (
              <CardDescription className="max-w-prose text-[13px] leading-relaxed">
                {description}
              </CardDescription>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </CardHeader>
      )}
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/**
 * Key/value rows.
 *
 * @param {object} props
 * @param {Array<[string, React.ReactNode]>} props.rows
 */
export function KeyValue({ rows, className }) {
  const visible = (rows ?? []).filter(Boolean);
  if (!visible.length) return null;
  return (
    <dl className={cn('grid gap-x-6 gap-y-2.5 sm:grid-cols-[minmax(9rem,auto)_1fr]', className)}>
      {visible.map(([label, value], i) => (
        <div key={`${label}-${i}`} className="contents">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-sm font-medium">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A cryptographic digest.
 *
 * Full value, monospaced, selectable in one gesture — never truncated in a context
 * where somebody is expected to compare it. A hash a viewer cannot read in full is a
 * hash they cannot check, which defeats the purpose of showing it.
 */
export function Hash({ value, label, className }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn('hash', className)} title={label}>
      {value}
    </span>
  );
}

/** Page heading with the standing explanation beneath it. */
export function PageHeader({ title, lede, actions, className }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {lede && (
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {lede}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
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

/** An empty result, explained. A blank box reads as a failure; this does not. */
export function EmptyState({ title, children, icon: Icon }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed py-10 text-center">
      {Icon && <Icon className="size-6 text-muted-foreground" />}
      <p className="text-sm font-medium">{title}</p>
      {children && (
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{children}</p>
      )}
    </div>
  );
}
