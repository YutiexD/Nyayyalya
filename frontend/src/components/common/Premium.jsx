/**
 * Presentation pieces for the public pages (landing, sign-in, verifier).
 *
 * They used to carry the product's decoration: beams, shimmer, a dot field, colour
 * pools, a pulsing lamp. All of that is gone. The exports and their props are kept so
 * the pages compile, but every piece now renders in the same calm, institutional style
 * as the application screens: flat surfaces, one accent, no animated decoration.
 */
import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { DotPattern } from '@/components/ui/dot-pattern';
import { cn } from '@/lib/utils';
import { useCountUp } from '@/hooks/useGsap';

/**
 * The accent as hex, for the few third-party props that take SVG attributes rather
 * than CSS. Deliberately low-contrast so any remaining beam reads as a hairline.
 */
export const ACCENT_HEX = Object.freeze({ from: '#3f5bb5', to: '#94a3b8' });

// ----------------------------------------------------------------- backdrop ----

/**
 * A field behind a hero. By default it renders nothing: application and sign-in
 * surfaces sit on the plain page background. Pass `dots` or `pools` explicitly for a
 * very faint texture on a marketing section.
 */
export function Backdrop({ className, dots = false, pools = false }) {
  if (!dots && !pools) return null;
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {dots && (
        <DotPattern
          width={24}
          height={24}
          cr={1}
          className="mask-radial fill-foreground/[0.05]"
        />
      )}
      {pools && (
        <div className="absolute -top-40 left-1/2 h-[24rem] w-[40rem] -translate-x-1/2 rounded-full bg-primary/[0.05] blur-3xl" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- branding ----

/** The mark: the shield on a solid accent tile. */
export function BrandMark({ className, size = 'md' }) {
  const dims = { sm: 'size-7 rounded-md', md: 'size-9 rounded-lg', lg: 'size-14 rounded-xl' }[size];
  const icon = { sm: 'size-4', md: 'size-5', lg: 'size-7' }[size];
  return (
    <span
      className={cn('grid shrink-0 place-items-center bg-primary text-primary-foreground', dims, className)}
    >
      <ShieldCheck className={icon} strokeWidth={2.25} />
    </span>
  );
}

/** A small label above a heading. Static. */
export function Eyebrow({ children, className }) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground',
        className
      )}
    >
      {children}
    </div>
  );
}

// -------------------------------------------------------------------- stats ----

/**
 * A number that counts up to itself. Under reduced motion the final value is printed
 * immediately, never a misleading 0.
 */
function CountUp({ value, delay = 0 }) {
  const ref = useRef(null);
  const [armed, setArmed] = useState(delay === 0);
  useEffect(() => {
    if (delay === 0) return undefined;
    const t = setTimeout(() => setArmed(true), delay * 1000);
    return () => clearTimeout(t);
  }, [delay]);
  useCountUp(ref, armed ? value : 0);
  return <span ref={ref}>{delay === 0 ? value : 0}</span>;
}

const TONE_ICON = {
  ok: 'bg-ok-muted text-ok',
  warn: 'bg-warn-muted text-warn',
  bad: 'bg-bad-muted text-bad',
  accent: 'bg-primary/10 text-primary',
};

/**
 * A figure with a label and caption.
 * @deprecated Metric tiles are being removed from application pages. Acceptable on the
 * landing page only.
 */
export function StatCard({ label, value, suffix, caption, icon: Icon, tone, className, delay = 0 }) {
  return (
    <div className={cn('surface relative p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        {Icon && (
          <span
            className={cn(
              'grid size-8 place-items-center rounded-md bg-muted text-muted-foreground',
              TONE_ICON[tone]
            )}
          >
            <Icon className="size-4" />
          </span>
        )}
      </div>
      <p className="mt-2 flex items-baseline gap-1 text-3xl font-semibold tracking-tight tabular">
        {typeof value === 'number' ? <CountUp value={value} delay={delay} /> : value}
        {suffix && <span className="text-base font-medium text-muted-foreground">{suffix}</span>}
      </p>
      {caption && <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{caption}</p>}
    </div>
  );
}

// ----------------------------------------------------------------- feature ----

/**
 * One claim, with its limit underneath. `highlight` gives the card an accent border
 * (it no longer adds an animated beam).
 */
export function FeatureCard({ icon: Icon, title, children, limit, highlight, className }) {
  return (
    <div className={cn('surface relative flex flex-col gap-3 p-6', highlight && 'border-primary/35', className)}>
      <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-5" />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
      {limit && (
        <p className="mt-auto border-t pt-3 text-[13px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">What it does not prove. </span>
          {limit}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pipeline ----

function Node({ icon: Icon, label, sub, accent, className }) {
  return (
    <div className={cn('relative z-10 flex min-w-0 flex-1 flex-col items-center gap-2 text-center', className)}>
      <span
        className={cn(
          'grid size-14 place-items-center rounded-xl border bg-card shadow-elev-1',
          accent && 'border-primary/40'
        )}
      >
        <Icon className={cn('size-6', accent ? 'text-primary' : 'text-foreground/75')} />
      </span>
      <span className="text-[13px] font-medium">{label}</span>
      {sub && <span className="max-w-[10rem] text-xs leading-snug text-muted-foreground">{sub}</span>}
    </div>
  );
}

/**
 * The flow, drawn: nodes in a row joined by a static hairline.
 *
 * @param {object} props
 * @param {Array<{icon, label, sub?, accent?}>} props.nodes
 */
export function PipelineBeam({ nodes, className }) {
  return (
    <div className={cn('relative flex w-full items-start justify-between gap-4 py-4', className)}>
      <div
        aria-hidden
        className="absolute left-[12%] right-[12%] top-[calc(1rem+1.75rem)] h-px bg-border"
      />
      {nodes.map((n) => (
        <Node key={n.label} {...n} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ verdict ----

/**
 * One verification check as a status tile. The tone carries the meaning; the icon and
 * the state text repeat it for anyone who cannot rely on colour.
 */
export function LightTile({ index, title, state, explanation, tone, icon: Icon, className }) {
  const frame = {
    ok: 'border-ok/25 bg-ok-muted/40',
    warn: 'border-warn/25 bg-warn-muted/40',
    bad: 'border-bad/25 bg-bad-muted/40',
  }[tone] ?? '';
  const lamp = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' }[tone] ?? 'bg-muted-foreground/60';
  const text = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }[tone] ?? 'text-muted-foreground';

  return (
    <div className={cn('surface p-5', frame, className)}>
      <div className="flex items-center justify-between">
        <span className="label-xs">Check {index}</span>
        <span aria-hidden className={cn('inline-flex size-2 rounded-full', lamp)} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        {Icon && <Icon className={cn('size-4', text)} />}
        <p className="text-sm font-medium">{title}</p>
      </div>
      <p className={cn('mt-1 text-lg font-semibold tracking-tight', text)}>{state}</p>
      {explanation && <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{explanation}</p>}
    </div>
  );
}
