/**
 * The compositions that give the register its finish.
 *
 * Every piece here is a Magic UI or shadcn part arranged for this product, with the
 * accent colours pinned to the token sheet. Nothing in a page picks a gradient stop
 * or a beam colour on its own — that is how a design stays one design across seven
 * role views built by different hands.
 *
 * Restraint is the rule. A beam traces a flow the viewer is meant to follow; a border
 * beam marks the single card that matters right now; a number ticks up because it is
 * a count and not because counting is fun. A page that used all of these at once
 * would look like a landing page for a crypto exchange, which is the opposite of what
 * a court should feel looking at it.
 */
import { createRef, forwardRef, useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { DotPattern } from '@/components/ui/dot-pattern';
import { AnimatedBeam } from '@/components/ui/animated-beam';
import { BorderBeam } from '@/components/ui/border-beam';
import { AnimatedShinyText } from '@/components/ui/animated-shiny-text';
import { LenticularCard } from '@/components/ui/lenticular-card';
import { cn } from '@/lib/utils';
import { useCountUp } from '@/hooks/useGsap';

/**
 * The accent, as hex, for the few Magic UI props that take SVG attributes rather
 * than CSS — `<stop stop-color>` cannot resolve `var()`. Chosen to sit correctly on
 * both themes rather than switched per theme, because a beam that changed colour on
 * toggle would draw the eye to the toggle instead of the flow.
 */
export const ACCENT_HEX = Object.freeze({ from: '#006241', to: '#00754A' });

// ----------------------------------------------------------------- backdrop ----

/**
 * A quiet field behind a hero or a sign-in: a dot grid masked to the centre, and two
 * out-of-focus colour pools. `absolute` and `pointer-events-none`, so it costs the
 * page nothing in layout and never intercepts a click.
 */
export function Backdrop({ className, dots = true, pools = true }) {
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {dots && (
        <DotPattern
          width={22}
          height={22}
          cr={1}
          className="mask-radial fill-foreground/[0.08] dark:fill-foreground/[0.10]"
        />
      )}
      {pools && (
        <>
          <div className="absolute -top-32 left-1/2 h-[28rem] w-[44rem] -translate-x-1/2 rounded-full bg-accent-from/10 blur-3xl dark:bg-accent-from/15" />
          <div className="absolute -bottom-40 right-[-10%] h-[22rem] w-[32rem] rounded-full bg-accent-to/10 blur-3xl dark:bg-accent-to/10" />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- branding ----

/** The mark. A gradient tile with the shield, at any size. */
export function BrandMark({ className, size = 'md' }) {
  const dims = { sm: 'size-7 rounded-md', md: 'size-9 rounded-lg', lg: 'size-14 rounded-2xl' }[size];
  const icon = { sm: 'size-3.5', md: 'size-4.5', lg: 'size-7' }[size];
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center bg-accent-gradient text-white shadow-elev-1',
        dims,
        className
      )}
    >
      <ShieldCheck className={icon} strokeWidth={2.25} />
    </span>
  );
}

/** A small label above a heading. Shines once, softly, to say "start here". */
export function Eyebrow({ children, className }) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border bg-card/60 px-3 py-1 text-xs font-medium shadow-elev-1',
        className
      )}
    >
      <AnimatedShinyText className="text-muted-foreground">{children}</AnimatedShinyText>
    </div>
  );
}

// -------------------------------------------------------------------- stats ----

/**
 * A number that counts up to itself.
 *
 * GSAP rather than Magic UI's NumberTicker, and the reason is what each does when the
 * viewer has asked for reduced motion: this one prints the final value immediately;
 * the motion-based ticker leaves its start value of 0 on screen. "0 tests" on a
 * projector is not a degraded animation, it is a false statement.
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

/**
 * A figure worth counting up to. Only for quantities: entries checked, exhibits in
 * a pack, tests passing. Never for anything a viewer might read mid-flight and
 * believe — a digit that changes while being read is worse than no animation.
 */
export function StatCard({ label, value, suffix, caption, icon: Icon, tone, className, delay = 0 }) {
  return (
    <LenticularCard className={cn('surface relative overflow-hidden rounded-2xl p-6', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
        {Icon && (
          <span
            className={cn(
              'grid size-9 place-items-center rounded-full border border-border/60 bg-muted/50 text-muted-foreground',
              tone === 'ok' && 'border-ok/30 bg-ok-muted/60 text-ok',
              tone === 'warn' && 'border-warn/30 bg-warn-muted/60 text-warn',
              tone === 'bad' && 'border-bad/30 bg-bad-muted/60 text-bad',
              tone === 'accent' && 'border-accent-from/20 bg-accent-gradient-soft text-accent-from'
            )}
          >
            <Icon className="size-[18px]" strokeWidth={1.75} />
          </span>
        )}
      </div>
      <p className="mt-4 flex items-baseline gap-1 text-4xl font-semibold tracking-tight tabular">
        {typeof value === 'number' ? <CountUp value={value} delay={delay} /> : value}
        {suffix && <span className="text-base font-medium text-muted-foreground">{suffix}</span>}
      </p>
      {caption && <p className="mt-auto pt-3 text-[13px] leading-relaxed text-muted-foreground">{caption}</p>}
    </LenticularCard>
  );
}

// ----------------------------------------------------------------- feature ----

/**
 * One claim, with its limit underneath. The limit is not small print; it is half the
 * point. `highlight` adds a travelling border beam — reserve it for one card per row.
 */
export function FeatureCard({ icon: Icon, title, children, limit, highlight, className }) {
  const noiseId = useId();
  return (
    <div className={cn(
      'surface relative flex flex-col overflow-hidden transition-all duration-300',
      'hover:-translate-y-1 hover:shadow-elev-2',
      highlight && 'border-accent-from/30',
      className,
    )}>
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.035] mix-blend-soft-light dark:opacity-[0.07]">
        <filter id={noiseId}>
          <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="4" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${noiseId})`} />
      </svg>
      {highlight && (
        <BorderBeam size={120} duration={9} colorFrom={ACCENT_HEX.from} colorTo={ACCENT_HEX.to} />
      )}
      <div className="relative flex flex-1 flex-col gap-4 p-7">
        <span className="grid size-11 place-items-center rounded-xl border border-border/60 bg-accent-gradient-soft text-accent-from shadow-sm">
          <Icon className="size-5" strokeWidth={1.75} />
        </span>
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
      {limit && (
        <div className="relative mt-auto border-t border-border/60 bg-muted/40 px-7 py-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground/70">What it does not prove. </span>
            {limit}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pipeline ----

const Node = forwardRef(function Node({ icon: Icon, label, sub, accent, className }, ref) {
  return (
    <div ref={ref} className={cn('relative z-10 flex flex-col items-center gap-2 text-center', className)}>
      <span
        className={cn(
          'grid size-14 place-items-center rounded-2xl border bg-card shadow-elev-2',
          accent && 'border-gradient glow'
        )}
      >
        <Icon className={cn('size-6', accent ? 'text-accent-from' : 'text-foreground/80')} />
      </span>
      <span className="text-xs font-semibold">{label}</span>
      {sub && <span className="max-w-[9rem] text-[11px] leading-snug text-muted-foreground">{sub}</span>}
    </div>
  );
});

/**
 * The flow, drawn. Nodes in a row, a beam travelling between each adjacent pair.
 *
 * @param {object} props
 * @param {Array<{icon, label, sub?, accent?}>} props.nodes
 */
export function PipelineBeam({ nodes, className }) {
  const container = useRef(null);
  // One ref object per node, created once. Held in STATE rather than in a ref so the
  // array can be read during render — `ref={...}` and `fromRef={...}` need the
  // objects at render time, and reading `someRef.current` while rendering is exactly
  // what React forbids. The node count is fixed by the caller, so this never resizes.
  const [refs] = useState(() => nodes.map(() => createRef()));

  return (
    <div ref={container} className={cn('relative flex w-full items-start justify-between gap-4 py-4', className)}>
      {nodes.map((n, i) => (
        <Node key={n.label} ref={refs[i]} {...n} />
      ))}
      {nodes.slice(1).map((_, i) => (
        <AnimatedBeam
          key={`beam-${i}`}
          containerRef={container}
          fromRef={refs[i]}
          toRef={refs[i + 1]}
          duration={4}
          delay={i * 0.6}
          pathColor="currentColor"
          pathOpacity={0.15}
          pathWidth={2}
          gradientStartColor={ACCENT_HEX.from}
          gradientStopColor={ACCENT_HEX.to}
          startYOffset={-26}
          endYOffset={-26}
          className="text-foreground"
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ verdict ----

/**
 * One of the four verification lights, as a premium status tile. The tone carries the
 * meaning; the icon and label repeat it for anyone who cannot rely on colour.
 */
export function LightTile({ index, title, state, explanation, tone, icon: Icon, className }) {
  const ring = {
    ok: 'border-ok/40 bg-ok-muted/60',
    warn: 'border-warn/40 bg-warn-muted/60',
    bad: 'border-bad/40 bg-bad-muted/60',
  }[tone] ?? 'border-border bg-muted/40';
  const lamp = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' }[tone] ?? 'bg-muted-foreground';
  const text = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }[tone] ?? 'text-muted-foreground';

  return (
    <div className={cn('surface relative overflow-hidden border p-5', ring, className)}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Check {index}
        </span>
        <span className="relative flex size-2.5">
          <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-40', lamp)} />
          <span className={cn('relative inline-flex size-2.5 rounded-full', lamp)} />
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {Icon && <Icon className={cn('size-4', text)} />}
        <p className="text-sm font-medium">{title}</p>
      </div>
      <p className={cn('mt-1 text-lg font-semibold tracking-tight', text)}>{state}</p>
      {explanation && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{explanation}</p>}
    </div>
  );
}
