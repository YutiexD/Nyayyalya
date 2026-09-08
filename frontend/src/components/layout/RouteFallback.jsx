import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shown while a lazy route chunk loads.
 *
 * Deliberately shaped like the page that is arriving — a header line, a couple of
 * cards — rather than a spinner. A spinner tells the viewer to wait; a skeleton tells
 * them what is about to be there, and stops the layout jumping when it lands.
 */
export function RouteFallback() {
  return (
    <div className="container py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}
