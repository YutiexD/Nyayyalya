/**
 * The public front page: a short hero, the five-step workflow, three feature points.
 */
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  FileBadge,
  FlaskConical,
  Landmark,
  ListTree,
  BadgeCheck,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/common/Premium';

const WORKFLOW = [
  { icon: Upload, title: 'Police upload', sub: 'Evidence hashed and signed' },
  { icon: FileBadge, title: 'Certificate', sub: 'Section 63, signed automatically' },
  { icon: Sparkles, title: 'AI analysis', sub: 'Prioritises the lab queue' },
  { icon: FlaskConical, title: 'FSL verdict', sub: 'Signed by the examiner' },
  { icon: Landmark, title: 'Court & counsel', sub: 'Case shared automatically' },
];

const FEATURES = [
  {
    icon: ShieldCheck,
    title: 'One-click verification',
    body: 'Anyone can check a certificate from its link. No account needed.',
  },
  {
    icon: ListTree,
    title: 'Tamper-evident record',
    body: 'Every action is added to a hash-chained ledger. Nothing is edited or deleted.',
  },
  {
    icon: FlaskConical,
    title: 'Expert verdict stays separate',
    body: 'AI analysis only orders the lab queue. Authenticity is decided by the FSL.',
  },
];

export default function LandingPage() {
  return (
    <div className="page-container space-y-16 py-16 sm:py-24">
      {/* ---------------------------------------------------------------- hero */}
      <section className="mx-auto flex max-w-2xl flex-col items-center text-center">
        <BrandMark size="lg" />
        <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">LEXX</h1>
        <p className="mt-3 text-balance text-body text-muted-foreground sm:text-lg">
          Digital evidence from police upload to courtroom, certified and verifiable at every step.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/login">
              <ShieldCheck />
              Sign in
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/verify">
              <BadgeCheck />
              Verify a certificate
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </section>

      {/* ------------------------------------------------------------ workflow */}
      <section aria-labelledby="workflow-heading" className="space-y-4">
        <h2 id="workflow-heading" className="text-center text-label uppercase tracking-wider text-muted-foreground">
          How it works
        </h2>
        <ol className="surface grid gap-px overflow-hidden bg-border sm:grid-cols-5">
          {WORKFLOW.map((step, i) => (
            <li key={step.title} className="flex items-start gap-3 bg-card p-4 sm:flex-col sm:gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
                <step.icon aria-hidden className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-label text-muted-foreground tabular-nums">Step {i + 1}</p>
                <p className="text-sm font-semibold text-foreground">{step.title}</p>
                <p className="text-meta text-muted-foreground">{step.sub}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ------------------------------------------------------------ features */}
      <section className="grid gap-6 sm:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="space-y-1.5">
            <f.icon aria-hidden className="size-5 text-muted-foreground" />
            <h3 className="text-section text-foreground">{f.title}</h3>
            <p className="text-meta text-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
