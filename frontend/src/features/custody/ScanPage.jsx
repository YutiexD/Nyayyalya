/**
 * Where a scanned custody label lands.
 *
 * The QR on every printed label encodes `/scan?label=<signed payload>`, so a phone
 * camera opens this page directly. Signed out, the route guard sends the user to sign
 * in and back here afterwards; signed in, the label is resolved on arrival.
 *
 * Arriving here grants nothing. The server verifies the label's signature and then
 * decides — through the same resolver as every other request — whether this person may
 * see the item, and whether they may hand it over or accept it.
 */
import { useSearchParams } from 'react-router-dom';

import { PageHeader, Section } from '@/components/common/Primitives';
import { Eyebrow } from '@/components/common/Premium';
import { ScanPanel } from '@/features/custody/CustodyKit';
import { useReveal } from '@/hooks/useGsap';

export default function ScanPage() {
  const [params] = useSearchParams();
  const label = params.get('label') ?? '';
  const scope = useReveal();

  return (
    <div ref={scope} className="container max-w-4xl space-y-8 py-10">
      <div className="space-y-3">
        <div className="will-reveal">
          <Eyebrow>Custody · scan a label</Eyebrow>
        </div>
        <PageHeader
          title="Scanned evidence label"
          lede="The label identifies the item. What you can do with it — see it, hand it over, receive it — is decided by the server for you, for this item, now."
        />
      </div>
      <Section title="Resolve the label">
        <ScanPanel key={label} initial={label} />
      </Section>
    </div>
  );
}
