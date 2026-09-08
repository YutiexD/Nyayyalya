/**
 * The public front page.
 *
 * The temptation on a page like this is to make claims. The discipline is to make
 * exactly four, state who is accountable for each, and then say plainly what the system
 * does NOT claim — because the credibility of an evidence register in front of a court
 * comes from the boundary of its claims, not their size.
 *
 * The motion is there to guide reading order and nothing else: the headline arrives
 * first, the flow diagram animates the path a file actually takes, and the figures
 * count because they are counts. Nothing loops except the beam, and the beam is a
 * diagram.
 */
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  FileSearch,
  Fingerprint,
  Link2,
  ListTree,
  Landmark,
  MonitorSmartphone,
  Network,
  ScanSearch,
  ShieldCheck,
  FlaskConical,
  FileCheck2,
  Ban,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ShimmerButton } from '@/components/ui/shimmer-button';

import {
  Backdrop,
  Eyebrow,
  StatCard,
  FeatureCard,
  PipelineBeam,
} from '@/components/common/Premium';
import { useReveal } from '@/hooks/useGsap';

/**
 * The four claims. Each names the mechanism and, in `limit`, what it does not prove —
 * a claim without its limit is the thing that gets torn apart in cross-examination.
 */
const CLAIMS = [
  {
    icon: Fingerprint,
    title: 'Hashed and signed in the browser',
    body: 'An exhibit is hashed with SHA-256 and signed on the officer’s own device before a byte reaches the server, using a key generated in that browser and never transmitted. The server recomputes the hash from the bytes it received and refuses the upload if the two disagree.',
    limit:
      'That the file is genuine. It proves who attested to these bytes and that they have not changed since — not what happened in front of the officer’s camera.',
    highlight: true,
  },
  {
    icon: ListTree,
    title: 'An append-only ledger',
    body: 'Every act — upload, custody transfer, referral, disclosure, denial — becomes an entry whose hash includes its predecessor. Nothing is edited and nothing is deleted; a correction is a new entry. Recomputing the chain shows whether any record moved, and exactly where.',
    limit:
      'That an entry is true. It proves the sequence is unbroken and unedited — a false statement, faithfully recorded, stays false.',
  },
  {
    icon: FileSearch,
    title: 'Disclosure scoped per exhibit',
    body: 'An advocate sees the set served on them and nothing else. Access follows the court record — a vakalatnama accepted by the registrar, or a legal aid order — which Lexx mirrors and cannot create. Material outside the served set is refused by reason code, and the refusal is logged.',
    limit:
      'Completeness of the case file. It proves what was served on whom; what was withheld is a decision the court ruled on, not one the system made.',
  },
  {
    icon: Link2,
    title: 'Merkle roots, anchored',
    body: 'Ledger entries are batched and reduced to one Merkle root. Where a funded key is configured, that root is submitted to Monad Testnet; where it is not, the root is computed and stored locally and nothing is submitted. The verifier states which of the two happened, every time.',
    limit:
      'Anything, while in DRY RUN. A root held only by this system proves internal consistency; the verifier says so in those words rather than showing a tick.',
  },
];

const FLOW = [
  { icon: MonitorSmartphone, label: 'Officer’s browser', sub: 'SHA-256, then ECDSA P-256' },
  { icon: ListTree, label: 'Append-only ledger', sub: 'hash-chained, never edited', accent: true },
  { icon: Network, label: 'Merkle root', sub: 'the only thing published' },
  { icon: Landmark, label: 'Court & verifier', sub: 'checkable without an account' },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const scope = useReveal();

  return (
    <div ref={scope}>
      {/* --------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden">
        <Backdrop />
        <div className="container relative flex flex-col items-center py-24 text-center sm:py-32">
          <div className="will-reveal">
            <Eyebrow>Digital evidence register · Indian criminal justice chain</Eyebrow>
          </div>

          <div className="will-reveal">
            <h1 className="mt-6 max-w-4xl text-balance text-display-sm sm:text-display lg:text-display-lg">
              Evidence that can be checked,
              <br />
              <span className="text-gradient">not merely trusted.</span>
            </h1>
          </div>

          <div className="will-reveal">
            <p className="mt-6 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground sm:text-lg">
              A register for digital evidence from the officer who seizes a device, through the
              malkhana and the laboratory, to the court, the advocate on record and anyone holding
              a printed certificate. Hashed and signed before a byte is sent. Nothing deleted, ever.
            </p>
          </div>

          <div className="will-reveal">
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <ShimmerButton
                onClick={() => navigate('/login')}
                shimmerColor="#a5b4fc"
                background="hsl(var(--primary))"
                className="h-11 px-6 text-sm font-medium text-primary-foreground shadow-elev-2"
              >
                <ShieldCheck className="mr-2 size-4" />
                Sign in
              </ShimmerButton>
              <Button
                variant="outline"
                size="lg"
                className="h-11 rounded-full px-6"
                onClick={() => navigate('/verify')}
              >
                <ScanSearch className="size-4" />
                Public verifier
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>

          <div className="will-reveal">
            <p className="mt-5 text-xs text-muted-foreground">
              The verifier needs no account. That is deliberate: a check you have to be let in to
              run is not an independent check.
            </p>
          </div>
        </div>

        {/* The path a file takes, drawn. */}
        <div className="container relative pb-20">
          <div className="will-reveal">
            <div className="surface mx-auto max-w-4xl px-6 py-8 sm:px-10">
              <PipelineBeam nodes={FLOW} />
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- stats */}
      <section className="container -mt-6 pb-16">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard className="will-reveal" label="Backend tests" value={453} icon={FileCheck2} tone="accent" caption="Unit, integration, an authorization matrix and a red-team suite that attacks the API assuming a hostile client." />
          <StatCard className="will-reveal" label="Contract tests" value={36} icon={Link2} tone="accent" caption="Anti-replay, access control, Merkle proofs and second-preimage resistance on the anchoring contract." delay={0.1} />
          <StatCard className="will-reveal" label="Independent checks" value={4} icon={ShieldCheck} tone="ok" caption="File, signature, ledger chain and anchored root — each recomputed from first principles, never read from a stored flag." delay={0.2} />
          <StatCard className="will-reveal" label="Evidence bytes on-chain" value={0} icon={Ban} tone="ok" caption="Only a Merkle root is ever published. No file, no name, no case identifier, no AI score." delay={0.3} />
        </div>
      </section>

      {/* ------------------------------------------------------------ problem */}
      <section className="container pb-16">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
          <div className="will-reveal">
            <Eyebrow>The problem</Eyebrow>
            <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight">
              Digital evidence is trivially copyable and trivially alterable, and the chain it
              travels along is long.
            </h2>
          </div>
          <div className="will-reveal space-y-4 text-base leading-relaxed text-muted-foreground">
            <p>
              A phone seized at a scene passes through a seizing officer, a malkhana, one or more
              investigating officers, a forensic science laboratory, a court registry and counsel
              on both sides. At every hand-off the question a court eventually asks is the same:
              is the file in front of me the file that was seized?
            </p>
            <p>
              The Bharatiya Sakshya Adhiniyam asks for a certificate. The Bharatiya Nagarik
              Suraksha Sanhita asks that the accused be served the material. Neither says how
              anyone checks. LEXX is the check — and it is built so that the checking does not
              require trusting LEXX.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- claims */}
      <section className="container pb-16">
        <div className="mb-8 will-reveal">
          <Eyebrow>Four claims, each with its limit</Eyebrow>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight">
            What the register proves — and, beside each, what it does not.
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {CLAIMS.map((c) => (
            <FeatureCard
              key={c.title}
              icon={c.icon}
              title={c.title}
              limit={c.limit}
              highlight={c.highlight}
              className="will-reveal"
            >
              {c.body}
            </FeatureCard>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ not claimed */}
      <section className="container pb-16">
        <div className="surface will-reveal relative overflow-hidden border-gradient p-8 sm:p-10">
          <div className="grid gap-6 md:grid-cols-[auto_1fr] md:gap-10">
            <span className="grid size-12 place-items-center rounded-xl bg-bad-muted text-bad">
              <FlaskConical className="size-6" />
            </span>
            <div className="space-y-3">
              <h2 className="text-2xl font-semibold tracking-tight">
                What the system does not claim
              </h2>
              <p className="max-w-3xl text-base leading-relaxed text-muted-foreground">
                No automated step in LEXX ever determines whether evidence is authentic. Machine
                triage produces one field — a review priority for a human queue — labelled that
                way in the API, in the database and on screen, never as a percentage and never
                with the word “verified” beside it. An opinion on authenticity comes from a
                section 79A laboratory, is signed by a named examiner, and is rendered on every
                screen in a shape that cannot be mistaken for the machine’s.
              </p>
              <p className="text-sm text-muted-foreground">
                Three claims, three different people: the officer signed what they uploaded, the
                laboratory examined it, the ledger proves nothing changed since. LEXX makes none
                of these claims itself. It makes each one checkable.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- cta */}
      <section className="relative overflow-hidden border-t">
        <Backdrop dots={false} />
        <div className="container relative flex flex-col items-center gap-5 py-20 text-center">
          <h2 className="will-reveal text-balance text-3xl font-semibold tracking-tight">
            Open the register, or check a certificate without one.
          </h2>
          <div className="will-reveal flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" className="h-11 rounded-full px-6" onClick={() => navigate('/login')}>
              <ShieldCheck className="size-4" />
              Sign in
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-11 rounded-full px-6"
              onClick={() => navigate('/verify')}
            >
              Verify a certificate
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
