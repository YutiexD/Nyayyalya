/**
 * The public verifier. No session, no account, no Authorization header.
 *
 * Two things live here:
 *
 *   1. Certificate verification (beat 9). The QR printed on a section 63 certificate
 *      points at `/public/verify/:token`, and that endpoint is deliberately mounted
 *      outside `/api` with no authentication in front of it. Its only credential is
 *      the 32-byte token in the path, and its answer carries validity — never
 *      contents. Anyone handed a printed certificate can check it here without being
 *      given access to anything else.
 *
 *   2. The four independent integrity lights (beat 5), for anyone who does hold a
 *      session. Recomputing an exhibit's integrity is a scoped, audited action, so
 *      an anonymous visitor is told that plainly rather than shown an empty panel.
 *
 * Plus the anchoring record from `/api/anchors/latest`, which is public because
 * publishing a root is the entire point of anchoring: it lets someone with no
 * account check that what we anchored matches what is on chain.
 */
import { api, getSession, getAccessToken } from '../lib/api.js';
import { verificationReport, signInRequired } from '../lib/verify.js';
import { verificationTokenFrom, qrBlock } from '../lib/qr.js';
import {
  el,
  mount,
  append,
  section,
  field,
  input,
  kv,
  hash,
  notice,
  denial,
  showError,
  spinner,
  anchorPanel,
  fmtDate,
  withBusy,
} from '../lib/ui.js';

const root = document.getElementById('app');

// ==================================================== 1. CERTIFICATE CHECK ====

const PDF_STATE = {
  PDF_INTACT: ['ok', 'The stored document still hashes to the digest published with it.'],
  PDF_MODIFIED: ['bad', 'The stored document no longer hashes to the digest published with it. Treat this copy as unproven.'],
  PDF_MISSING: ['warn', 'The stored document could not be read, so its digest could not be compared.'],
};

function certificateView(result) {
  const c = result.certificate ?? {};
  const [pdfTone, pdfWhy] = PDF_STATE[c.pdfIntegrity] ?? ['warn', 'Unrecognised document state.'];

  const signatureRows = (c.signatures ?? []).map((s) =>
    el('div.row', [
      el('span.verdict__label', `Part ${s.part} — ${s.role}`),
      el(`span.pill.pill--${s.present ? 'ok' : 'warn'}`, s.present ? 'SIGNED' : 'NOT SIGNED'),
      s.signedAt ? el('span.muted', fmtDate(s.signedAt)) : null,
    ])
  );

  return el('div.stack', [
    notice('This certificate is on the register and its token resolves.', 'ok'),
    kv([
      ['Statute', c.statute ?? 'Bharatiya Sakshya Adhiniyam, 2023 — section 63'],
      ['Certificate', el('code', c.certificateId ?? '—')],
      ['Template', el('code', c.templateVersion ?? '—')],
      ['Generated', fmtDate(c.generatedAt)],
      ['Exhibit', el('code', c.exhibitCode ?? '—')],
      ['CNR', el('code', c.cnrNumber ?? 'not committed')],
      ['FIR', el('code', c.firNumber ?? '—')],
      ['Evidence digest attested', hash(c.evidenceHash)],
      ['Hash algorithm', el('code', c.hashAlgorithm ?? 'SHA-256')],
      ['Document digest', hash(c.pdfSha256)],
      ['Document state', el(`span.pill.pill--${pdfTone}`, c.pdfIntegrity ?? '—')],
      ['Part A complete', c.partAComplete ? 'Yes' : 'No'],
      ['Part B complete', c.partBComplete ? 'Yes' : 'No'],
    ]),
    notice(pdfWhy, pdfTone),
    signatureRows.length ? section('Signatures', null, el('div.stack', signatureRows)) : null,
    notice(
      'This page reports whether the certificate is genuine and whether the stored document still matches its published digest. It discloses no evidence, no case content and no personal data — a holder of the exhibit can recompute the attested digest themselves and compare.',
      'info'
    ),
  ]);
}

function certificateSection() {
  const tokenInput = input({ placeholder: 'paste the token, or the whole /public/verify/… URL' });
  const resultSlot = el('div');
  const goBtn = el('button.btn', { type: 'submit' }, 'Verify certificate');

  async function verify(raw) {
    const token = verificationTokenFrom(raw);
    if (!token) {
      mount(resultSlot, notice('That does not look like a verification token.', 'warn'));
      return;
    }
    mount(resultSlot, spinner('Checking the register…'));
    try {
      const result = await api.publicVerifyCertificate(token);
      mount(resultSlot, certificateView(result));
      // A scannable copy of this page's own address, so the certificate can be
      // re-checked from a phone in the room without anyone typing a token.
      append(
        resultSlot,
        await qrBlock(`${location.origin}/public/verify/${token}`, {
          caption: 'Scan to re-verify this certificate',
          size: 150,
        })
      );
    } catch (error) {
      // A 404 here answers an unknown token and a malformed one identically, so the
      // shape of the token space cannot be mapped from outside.
      mount(resultSlot, [
        denial(
          {
            status: error.status,
            code: error.code === 'REQUEST_FAILED' ? 'CERTIFICATE_NOT_FOUND' : error.code,
            message: error.message,
            details: error.details,
          },
          { heading: 'Certificate not verified' }
        ),
        notice(
          'An unknown token and a malformed token are answered identically, so nothing about the register can be learned by guessing.',
          'info'
        ),
      ]);
    }
  }

  const form = el(
    'form',
    {
      onSubmit: (e) => {
        e.preventDefault();
        withBusy(goBtn, 'Checking…', () => verify(tokenInput.value));
      },
    },
    [
      field(
        'Verification token',
        tokenInput,
        'Scan the QR printed on the certificate, or copy the link it points at.'
      ),
      el('div.row', [goBtn]),
    ]
  );

  // A token in the URL (which is what the printed QR points at) verifies on load.
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    tokenInput.value = fromUrl;
    verify(fromUrl);
  }

  return section(
    'Verify a section 63 certificate',
    'Public. No account required — that is what makes this an independent check rather than our own word for it.',
    [form, resultSlot]
  );
}

// ====================================================== 2. INTEGRITY LIGHTS ====

function integritySection() {
  const idInput = input({ placeholder: '24-character exhibit id' });
  const resultSlot = el('div');
  const goBtn = el('button.btn', { type: 'submit' }, 'Run the four checks');

  const signedIn = Boolean(getSession() && getAccessToken());

  const form = el(
    'form',
    {
      onSubmit: (e) => {
        e.preventDefault();
        const id = idInput.value.trim();
        if (!id) return;
        withBusy(goBtn, 'Verifying…', async () => {
          mount(resultSlot, spinner('Recomputing hash, signature, chain and anchor…'));
          try {
            mount(resultSlot, verificationReport(await api.evidence.verify(id)));
          } catch (error) {
            showError(resultSlot, error);
          }
        });
      },
    },
    [field('Exhibit id', idInput), el('div.row', [goBtn])]
  );

  return section(
    'Integrity of an exhibit',
    'Four checks, each recomputed from first principles and reported separately. They are never collapsed into one verdict — a modified file with an intact ledger tells you exactly which record moved.',
    signedIn
      ? [form, resultSlot]
      : [
          signInRequired(),
          el('div', { style: 'height:12px' }),
          el('a.link', { href: 'login.html' }, 'Sign in'),
        ]
  );
}

// ============================================================ 3. ANCHORING ====

function anchorSection() {
  const slot = el('div', spinner('Reading the anchoring record…'));

  (async () => {
    try {
      const anchor = await api.publicLatestAnchor();
      mount(slot, anchorPanel(anchor));
    } catch (error) {
      showError(slot, error);
    }
  })();

  return section(
    'Anchoring record',
    'Public. Roots and chain facts only — which is exactly what makes the claim checkable by someone with no account here.',
    slot
  );
}

// ------------------------------------------------------------------ render ----

append(root, [
  el('h2.page-title', 'Independent verification'),
  el(
    'p.page-lede',
    'Two checks that need nothing from us but a token: whether a section 63 certificate is genuine, and whether the batch root we published on chain still matches the ledger.'
  ),
  el('div.grid.grid--2', [certificateSection(), el('div.stack', [anchorSection(), integritySection()])]),
]);
