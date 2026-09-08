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
import { createRef, forwardRef, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { DotPattern } from '@/components/ui/dot-pattern';
import { AnimatedBeam } from '@/components/ui/animated-beam';
import { BorderBeam } from '@/components/ui/border-beam';
import { AnimatedShinyText } from '@/components/ui/animated-shiny-text';
import { cn } from '@/lib/utils';
import { useCountUp } from '@/hooks/useGsap';

/**
 * The accent, as hex, for the few Magic UI props that take SVG attributes rather
 * than CSS — `<stop stop-color>` cannot resolve `var()`. Chosen to sit correctly on
 * both themes rather than switched per theme, because a beam that changed colour on
 * toggle would draw the eye to the toggle instead of the flow.
 */
export const ACCENT_HEX = Object.freeze({ from: '#6366f1', to: '#22d3ee' });

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
    <div className={cn('surface surface-lift relative overflow-hidden p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        {Icon && (
          <span
            className={cn(
              'grid size-8 place-items-center rounded-md bg-muted text-muted-foreground',
              tone === 'ok' && 'bg-ok-muted text-ok',
              tone === 'warn' && 'bg-warn-muted text-warn',
              tone === 'bad' && 'bg-bad-muted text-bad',
              tone === 'accent' && 'bg-accent-gradient-soft text-accent-from'
            )}
          >
            <Icon className="size-4" />
          </span>
        )}
      </div>
      <p className="mt-3 flex items-baseline gap-1 text-3xl font-semibold tracking-tight tabular">
        {typeof value === 'number' ? <CountUp value={value} delay={delay} /> : value}
        {suffix && <span className="text-base font-medium text-muted-foreground">{suffix}</span>}
      </p>
      {caption && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{caption}</p>}
    </div>
  );
}

// ----------------------------------------------------------------- feature ----

/**
 * One claim, with its limit underneath. The limit is not small print; it is half the
 * point. `highlight` adds a travelling border beam — reserve it for one card per row.
 */
export function FeatureCard({ icon: Icon, title, children, limit, highlight, className }) {
  return (
    <div className={cn('surface surface-lift relative flex flex-col gap-3 overflow-hidden p-6', className)}>
      {highlight && (
        <BorderBeam size={120} duration={9} colorFrom={ACCENT_HEX.from} colorTo={ACCENT_HEX.to} />
      )}
      <span className="grid size-10 place-items-center rounded-lg bg-accent-gradient-soft text-accent-from">
        <Icon className="size-5" />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
      {limit && (
        <p className="mt-auto border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">What it does not prove. </span>
          {limit}
        </p>
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
