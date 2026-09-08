/**
 * The public front page.
 *
 * The temptation on a page like this is to make claims. The discipline is to make
 * exactly four, state who is accountable for each, and then say plainly what the system
 * does NOT claim — because the credibility of an evidence register in front of a court
 * comes from the boundary of its claims, not their size.
 */
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  FileSearch,
  Fingerprint,
  Link2,
  ListTree,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

import { Section } from '@/components/common/Primitives';
import { Note } from '@/components/common/Verdicts';
import { useReveal } from '@/hooks/useGsap';

/**
 * The four claims. Each names the mechanism and, in the second sentence, its limit —
 * a claim without its limit is the thing that gets torn apart in cross-examination.
 */
const CLAIMS = [
  {
    icon: Fingerprint,
    title: 'Hashed and signed in the browser',
    body: 'An exhibit is hashed with SHA-256 and signed on the officer’s own device before a byte reaches the server, using a key generated in that browser and never transmitted. The server recomputes the hash from the bytes it received and refuses the upload if the two disagree, so the record names who attested to those bytes and when — not merely that a file arrived.',
  },
  {
    icon: ListTree,
    title: 'An append-only ledger',
    body: 'Every act — upload, custody transfer, referral, disclosure, denial — becomes an entry whose hash includes its predecessor. Nothing is edited and nothing is deleted; a correction is a new entry. Recomputing the chain shows whether any record moved, and exactly where, rather than returning a single pass or fail.',
  },
  {
    icon: FileSearch,
    title: 'Disclosure scoped per exhibit',
    body: 'An advocate sees the set served on them and nothing else. Access follows the court record — a vakalatnama accepted by the registrar, or a legal aid order — which Lexx mirrors and cannot create. Material outside the served set is refused by reason code, and the refusal is logged with the identity that attempted it.',
  },
  {
    icon: Link2,
    title: 'Merkle roots, anchored',
    body: 'Ledger entries are batched and reduced to one Merkle root. Where a funded key is configured, that root is submitted to Monad Testnet; where it is not, the root is computed and stored locally and nothing is submitted. The public verifier states which of the two actually happened, every time, and never treats the second as the first.',
  },
];

export default function LandingPage() {
  const scope = useReveal();

  return (
    <div ref={scope} className="container space-y-14 py-12">
      {/* ------------------------------------------------------------ hero */}
      <section className="space-y-7">
        <Badge variant="secondary" className="will-reveal">
          Digital evidence register
        </Badge>

        <div className="space-y-4">
          <h1 className="max-w-4xl text-balance text-4xl font-semibold tracking-tight will-reveal sm:text-5xl">
            Evidence that can be checked,
            <br />
            not merely trusted.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground will-reveal">
            LEXX is a register for digital evidence in the Indian criminal justice chain: from
            the officer who seizes a device, through the malkhana and the laboratory, to the
            court, the advocate on record and anyone holding a printed certificate.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 will-reveal">
          <Button asChild size="lg">
            <Link to="/login">
              <ShieldCheck className="size-4" />
              Sign in
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/verify">
              <ScanSearch className="size-4" />
              Public verifier
            </Link>
          </Button>
        </div>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground will-reveal">
          The verifier needs no account. That is deliberate: a check you have to be let in to
          run is not an independent check.
        </p>
      </section>

      <Separator />

      {/* --------------------------------------------------------- problem */}
      <Section
        title="The problem"
        description="Digital evidence is trivially copyable and trivially alterable, and the chain it travels along is long."
      >
        <div className="max-w-prose space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            A phone seized at a scene passes through a seizing officer, a malkhana, one or more
            investigating officers, a forensic science laboratory, a court registry and counsel
            on both sides. Every handover is a point at which the object can be substituted, the
            copy can drift from the original, or the record of what happened can be written after
            the fact.
          </p>
          <p>
            Under BSA s.63 the party producing electronic evidence must certify it, and under
            BNSS s.230 the accused must have the material within fourteen days of production. A
            register that cannot show, entry by entry, what was received and when, leaves those
            duties resting on somebody&rsquo;s recollection.
          </p>
          <p>
            LEXX does not ask to be believed about any of this. It makes four narrow, mechanical
            claims, and every one of them can be recomputed by someone who does not trust us.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------- claims */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight will-reveal">
          What this system claims
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {CLAIMS.map(({ icon: Icon, title, body }) => (
            <Section
              key={title}
              title={
                <span className="flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" />
                  {title}
                </span>
              }
            >
              <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{body}</p>
            </Section>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------- what it does not */}
      <Section
        title="What this system does not claim"
        description="Stated as prominently as the claims, because a product that blurs these two is worse than one that makes neither."
      >
        <div className="max-w-prose space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">
              No automated step ever determines authenticity.
            </span>{' '}
            Machine analysis in LEXX produces a review priority — HIGH, MEDIUM or LOW —
            which orders a queue of human work. It is never labelled verified, never expressed as
            a confidence or a percentage, and it never appears in a disclosure pack, because
            investigative triage is not evidence.
          </p>
          <p>
            <span className="font-medium text-foreground">
              Authenticity is a laboratory&rsquo;s finding, and only a laboratory&rsquo;s.
            </span>{' '}
            The vocabulary is exactly AUTHENTIC, MANIPULATED or INCONCLUSIVE, produced by a
            laboratory notified under IT Act s.79A, in a report signed by the examiner who did
            the work. There is no route in this product by which any other component can produce
            those words.
          </p>
          <p>
            <span className="font-medium text-foreground">
              A hash proves bytes, not truth.
            </span>{' '}
            An intact digest establishes that a file has not changed since it was received. It
            says nothing about whether the recording shows what a party says it shows, and this
            product never lets one stand in for the other.
          </p>
        </div>

        <Note tone="warn">
          Anchoring is reported honestly rather than optimistically. Where a Merkle root was
          computed and stored but never submitted to a chain, the verifier says so in amber and
          calls it internal consistency — not independent corroboration.
        </Note>
      </Section>

      {/* ------------------------------------------------------------- CTA */}
      <Section
        title="Check it yourself"
        description="The fastest way to judge an evidence register is to try to catch it overstating something."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <Link to="/verify">
              Open the public verifier
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="ghost">
            <Link to="/login">Sign in with an authority identifier</Link>
          </Button>
        </div>
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          LEXX holds no identities of its own. Officers exist in the police directory, judges and
          registrars in the court directory, advocates and examiners in the Bar Council and FSL
          directory. Roles and jurisdiction are read from those records at every sign-in, so a
          transfer, suspension or roster change takes effect immediately and nothing typed on a
          form can change them.
        </p>
      </Section>
    </div>
  );
}
