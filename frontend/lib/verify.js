/**
 * The four traffic lights (spec §8 F5).
 *
 * `POST /api/evidence/:id/verify` recomputes four things from first principles and
 * reports them separately. This module renders them separately and — deliberately —
 * never combines them into a single verdict.
 *
 * The case that matters is FILE_MODIFIED with CHAIN_INTACT: light one red, light
 * three GREEN. A single "overall status" would render that as simply "failed", which
 * is exactly wrong. Two independent records disagreeing tells you precisely which
 * one moved: the file was touched, the log was not, and the original hash is still
 * provable. That distinction is the whole insight, so the lights stay independent
 * and the server's `interpretation` sentence is given top billing.
 */
import { el, kv, hash, fmtDate, anchorTxLink, notice } from './ui.js';
import { api } from './api.js';

const GREEN = 'ok';
const RED = 'bad';
const AMBER = 'warn';

/** What each light means, per state. One sentence, written for a courtroom. */
const FILE_STATES = {
  FILE_INTACT: [GREEN, 'Stored file matches its recorded hash', 'The bytes on disk hash to exactly the digest recorded at ingest.'],
  FILE_MODIFIED: [RED, 'Stored file has been modified', 'The bytes on disk no longer hash to the digest recorded at ingest. Something changed the stored object after it was received.'],
  FILE_MISSING: [AMBER, 'Stored object is missing', 'The object could not be found in the vault. The ledger still holds its hash and its history.'],
};

const CHAIN_STATES = {
  CHAIN_INTACT: [GREEN, 'Ledger chain is unbroken', 'Every entry hash was recomputed from its predecessor and matched. No record has been altered, inserted or removed.'],
  CHAIN_BROKEN: [RED, 'Ledger chain does not verify', 'A recomputed entry hash did not match. Treat every record after the break as unproven and escalate.'],
};

/**
 * ANCHOR_LOCAL_ONLY is amber, deliberately, and it is the state this deployment is
 * usually in. The root recomputed from the ledger matches the root we stored and the
 * entry proves as a member of it — but that root was never submitted to a chain, so
 * both sides of the comparison are ours. Painting that green would tell a court that
 * an independent record agrees with us when no independent record exists.
 */
const ANCHOR_STATES = {
  ANCHOR_MATCH: [GREEN, 'Anchored root matches', 'The Merkle root recomputed from the ledger equals the root published on chain, and this entry proves as a member of it.'],
  ANCHOR_LOCAL_ONLY: [AMBER, 'Root matches locally — NOT on chain', 'The recomputed root matches the stored root and this entry proves as a member of it, but the batch was never submitted (DRY RUN). Both roots are held by this system, so this shows internal consistency only — not independent corroboration.'],
  ANCHOR_MISMATCH: [RED, 'Anchored root does not match', 'The root recomputed from the ledger differs from the published root, or this entry does not prove as a member of it.'],
  NOT_ANCHORED: [AMBER, 'Not yet anchored', 'This entry has not been included in an anchor batch yet. Batches are published on a timer.'],
  ANCHOR_UNAVAILABLE: [AMBER, 'Anchor record unavailable', 'The batch this entry belongs to could not be read, so the published root could not be compared.'],
};

function light(index, tone, title, state, explanation) {
  return el(`div.light.light--${tone}`, [
    el('div.light__head', [
      el('span.light__lamp'),
      el('span.light__index', `Check ${index}`),
    ]),
    el('div.light__title', title),
    el('div.light__state', state),
    el('p.light__explain', explanation),
  ]);
}

/**
 * The four lights, always all four, always in the same order.
 * @param {object} result the `/verify` response
 */
export function trafficLights(result) {
  const [fileTone, fileState, fileWhy] = FILE_STATES[result.fileIntegrity] ?? [
    AMBER,
    String(result.fileIntegrity ?? 'unknown'),
    'The server returned a file state this client does not recognise.',
  ];

  const signatureOk = result.signatureValid === true;
  const [chainTone, chainState, chainWhy] = CHAIN_STATES[result.chainIntegrity] ?? [
    AMBER,
    String(result.chainIntegrity ?? 'unknown'),
    'The server returned a chain state this client does not recognise.',
  ];
  const [anchorTone, anchorState, anchorWhy] = ANCHOR_STATES[result.anchorIntegrity] ?? [
    AMBER,
    String(result.anchorIntegrity ?? 'unknown'),
    'The server returned an anchor state this client does not recognise.',
  ];

  return el('div.lights', [
    light(1, fileTone, 'File integrity', fileState, fileWhy),
    light(
      2,
      signatureOk ? GREEN : RED,
      'Uploader signature',
      signatureOk ? 'Signature verifies' : 'Signature does not verify',
      signatureOk
        ? 'The hash recorded at ingest was signed by the private key registered to the uploading officer, on their own device.'
        : 'The recorded signature does not verify against the uploader’s registered public key. Investigate the signing key.'
    ),
    light(3, chainTone, 'Ledger chain', chainState, chainWhy),
    light(4, anchorTone, 'On-chain anchor', anchorState, anchorWhy),
  ]);
}

/** The sentence the room should read. Rendered before the detail, in full. */
export const interpretation = (result) =>
  el('div.interpretation', [
    el('div.interpretation__kicker', 'What this means'),
    el('p.interpretation__text', result.interpretation ?? '—'),
  ]);

/** The numbers behind the lights, so the claim can be checked rather than believed. */
export function verificationDetail(result) {
  const rows = [
    ['Exhibit', el('code', result.exhibitCode ?? '—')],
    ['Verified at', fmtDate(result.verifiedAt)],
    ['Hash recorded at ingest', hash(result.expectedSha256)],
    ['Hash recomputed now', result.recomputedSha256 ? hash(result.recomputedSha256) : el('span.muted', 'could not be recomputed')],
    ['Ledger entries checked', result.entriesChecked ?? '—'],
  ];

  if (result.brokenAtSeq !== null && result.brokenAtSeq !== undefined) {
    rows.push(['Chain breaks at sequence', el('code.bad-text', String(result.brokenAtSeq))]);
  }
  if (result.chainBreakReason) rows.push(['Break reason', el('code', String(result.chainBreakReason))]);
  if (result.publishedRoot) rows.push(['Published Merkle root', hash(result.publishedRoot)]);
  if (result.computedRoot) rows.push(['Recomputed Merkle root', hash(result.computedRoot)]);

  rows.push(['Anchor network', el('code', result.anchorNetwork ?? 'monad-testnet')]);
  rows.push(['Chain ID', el('code', '10143')]);
  if (result.anchorTxHash) {
    rows.push(['Anchor transaction', anchorTxLink(result.anchorTxHash, result.anchorExplorerUrl)]);
  }

  return el('div.verify-detail', [
    kv(rows),
    el(
      'p.anchor__statement',
      'Only the Merkle root is written on chain — no evidence, no file contents, no personal data.'
    ),
  ]);
}

/** Lights, interpretation and detail as one block. */
export const verificationReport = (result) =>
  el('div.verify-report', [
    interpretation(result),
    trafficLights(result),
    el(
      'p.lights__note',
      'These four checks are independent and are never combined into a single verdict. A modified file with an intact ledger is not a failure of the system — it is the system telling you exactly which record moved.'
    ),
    verificationDetail(result),
  ]);

/** Run the verification for one exhibit. */
export const verifyExhibit = (evidenceId) => api.evidence.verify(evidenceId);

/**
 * The panel used on the public verifier, where there may be no session at all.
 * `/verify` is a scoped, audited endpoint: an anonymous visitor is told so plainly
 * rather than being shown an empty panel.
 */
export const signInRequired = () =>
  notice(
    'Recomputing an exhibit’s integrity is an audited action on a scoped record, so it requires a signed-in session. Certificate verification below needs no account.',
    'info'
  );
