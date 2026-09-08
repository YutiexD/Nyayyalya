/**
 * Shared DOM helpers and the components that carry the system's compliance rules.
 *
 * # No innerHTML, anywhere
 *
 * Everything on these screens is attacker-influenceable at some remove: filenames,
 * case titles, exclusion reasons written by an officer, questions posed to a lab.
 * `el()` sets text with `textContent` and attributes with `setAttribute`, and nothing
 * in this client assigns `innerHTML`. An XSS in an evidence register would be a real
 * finding, not a style nit.
 *
 * # The three claims this file keeps apart
 *
 *   `reviewPriority()` — machine triage. Labelled "Review Priority", HIGH/MEDIUM/LOW,
 *      never "verified", never "confidence", never a percentage, and never rendered
 *      without the API's own disclaimer beside it.
 *   `forensicOpinion()` — a s.79A laboratory's authenticity opinion. Deliberately a
 *      different shape, weight and colour, attributed to the lab and its notification
 *      reference, because it is a different kind of claim entirely.
 *   `denial()`   — a refusal. Always the reason code AND a plain-English sentence.
 */
import { explain } from './api.js';

// ------------------------------------------------------------------ basics ----

/**
 * Is this a DOM node? Duck-typed rather than `instanceof Node`, so these helpers
 * also work in a document-less context (a test runner, a server render) without
 * depending on a global that may not exist there.
 */
const isNode = (v) => Boolean(v) && typeof v === 'object' && typeof v.nodeType === 'number';

/**
 * Build an element.
 * @param {string} tag  tag name, optionally with `.class.names`
 * @param {object|string|Array|Node} [props] attributes, or children if not a plain object
 * @param {Array|string|Node} [children]
 */
export function el(tag, props, children) {
  const [name, ...classes] = String(tag).split('.');
  const node = document.createElement(name);
  if (classes.length) node.className = classes.join(' ');

  let attrs = props;
  let kids = children;
  const isPlainProps =
    props && typeof props === 'object' && !Array.isArray(props) && !isNode(props);
  if (!isPlainProps) {
    attrs = null;
    kids = props;
  }

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = `${node.className} ${value}`.trim();
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'onClick') node.addEventListener('click', value);
      else if (key === 'onSubmit') node.addEventListener('submit', value);
      else if (key === 'onChange') node.addEventListener('change', value);
      else if (key === 'onInput') node.addEventListener('input', value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(node, kids);
  return node;
}

export function append(parent, child) {
  if (child === null || child === undefined || child === false) return parent;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
    return parent;
  }
  parent.appendChild(isNode(child) ? child : document.createTextNode(String(child)));
  return parent;
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

export const mount = (node, ...children) => {
  clear(node);
  append(node, children);
  return node;
};

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// ---------------------------------------------------------------- formatting ----

export function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Long hex, wrapped for a projector: full value, monospaced, selectable. */
export const hash = (value, label) =>
  el('span.hash', { title: label ?? '' }, value ?? '—');

export const shortHash = (value, keep = 12) =>
  !value ? '—' : `${value.slice(0, keep)}…${value.slice(-6)}`;

/**
 * Acronyms that must survive humanise() intact.
 *
 * The naive "lowercase everything, capitalise the first letter" produced `Pocso`,
 * `At fsl`, `Referred to fsl`, `District sp` and `Io` — on the case table, the ledger
 * timeline, the custody status and the referral discipline, which is to say on almost
 * every screen. POCSO and FSL are not words; an Indian audience reads `Pocso` as a
 * typo, and on a projector it is the first thing the eye lands on.
 */
const ACRONYMS = new Set([
  'AI', 'BNS', 'BNSS', 'CCTV', 'CCTNS', 'CNR', 'DNA', 'FIR', 'FSL', 'GPS', 'HDD',
  'ID', 'IMEI', 'IO', 'IP', 'IT', 'MMS', 'OTP', 'PDF', 'PII', 'PIS', 'POCSO', 'QR',
  'SHO', 'SIM', 'SP', 'SSD', 'UID', 'USB', 'UPI', 'URL',
]);

/**
 * Turn an enum value into something a human reads: SEIZED -> "Seized",
 * REFERRED_TO_FSL -> "Referred to FSL", POCSO -> "POCSO".
 */
export const humanise = (code) =>
  !code
    ? ''
    : String(code)
        .split('_')
        .filter(Boolean)
        .map((word, i) => {
          const upper = word.toUpperCase();
          if (ACRONYMS.has(upper)) return upper;
          const lower = word.toLowerCase();
          return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
        })
        .join(' ');

// ---------------------------------------------------------------- chrome ----

/**
 * The page header: who you are, the authority that vouches for you, and the scope
 * your session actually carries. Showing the scope makes "access follows the
 * directory" visible rather than asserted.
 */
export function appHeader({ title, subtitle, session, onSignOut, actions }) {
  const scopeBits = [];
  if (session?.scope?.stationCode) scopeBits.push(`Station ${session.scope.stationCode}`);
  if (session?.scope?.districtCode) scopeBits.push(`District ${session.scope.districtCode}`);
  if (session?.scope?.courtId) scopeBits.push(`Court ${session.scope.courtId}`);
  if (session?.scope?.labId) scopeBits.push(`Lab ${session.scope.labId}`);

  return el('header.app-header', [
    el('div.app-header__brand', [
      el('div.app-header__mark', 'LEXX'),
      el('div', [
        el('h1.app-header__title', title),
        subtitle ? el('p.app-header__subtitle', subtitle) : null,
      ]),
    ]),
    el('div.app-header__session', [
      actions ? el('div.app-header__actions', actions) : null,
      session
        ? el('div.identity', [
            el('div.identity__name', session.name ?? session.authorityId ?? ''),
            el('div.identity__meta', [
              // humanise, like every other enum on every other screen. This chip is
              // on the header of every signed-in page, so MALKHANA_CUSTODIAN and
              // DEFENCE_COUNSEL were the most-seen raw enums in the product.
              el('span.role-chip', humanise(session.role) || ''),
              el('span', session.authorityId ?? ''),
            ]),
            scopeBits.length ? el('div.identity__scope', scopeBits.join(' · ')) : null,
          ])
        : null,
      onSignOut ? el('button.btn.btn--ghost', { type: 'button', onClick: onSignOut }, 'Sign out') : null,
    ]),
  ]);
}

export const section = (heading, note, body) =>
  el('section.panel', [
    el('div.panel__head', [
      el('h2.panel__title', heading),
      note ? el('p.panel__note', note) : null,
    ]),
    el('div.panel__body', body),
  ]);

export const field = (label, control, hint) =>
  el('label.field', [
    el('span.field__label', label),
    control,
    hint ? el('span.field__hint', hint) : null,
  ]);

export const input = (attrs) => el('input.input', { type: 'text', ...attrs });

export const select = (attrs, options) =>
  el(
    'select.input',
    attrs,
    options.map((o) =>
      el('option', { value: typeof o === 'string' ? o : o.value }, typeof o === 'string' ? o : o.label)
    )
  );

export const button = (label, attrs = {}) =>
  el('button.btn', { type: 'button', ...attrs }, label);

export const kv = (rows) =>
  el(
    'dl.kv',
    rows
      .filter(Boolean)
      .flatMap(([k, v]) => [el('dt', k), el('dd', isNode(v) ? v : String(v ?? '—'))])
  );

/**
 * A table built from plain data. Cells take text or nodes; nothing is parsed as HTML.
 */
export function table(columns, rows, { empty = 'Nothing to show.' } = {}) {
  if (!rows.length) return el('p.empty', empty);
  return el('div.table-wrap', [
    el('table.table', [
      el('thead', el('tr', columns.map((c) => el('th', c.header)))),
      el(
        'tbody',
        rows.map((row) =>
          el(
            'tr',
            columns.map((c) => {
              const value = c.cell(row);
              return el('td', { 'data-label': c.header }, isNode(value) ? value : String(value ?? '—'));
            })
          )
        )
      ),
    ]),
  ]);
}

// ---------------------------------------------------------------- messages ----

export const notice = (text, tone = 'info') => el(`div.notice.notice--${tone}`, text);

export const spinner = (text = 'Working…') =>
  el('div.working', [el('span.working__dot'), el('span', text)]);

/**
 * A refusal, rendered so a human can act on it: the machine code stays visible
 * because it is what an auditor cites, and the sentence underneath is what the user
 * actually reads.
 */
export function denial(error, { heading = 'Access denied' } = {}) {
  const code = error?.code ?? 'REQUEST_FAILED';
  const details = error?.details ?? null;

  return el('div.denial', [
    el('div.denial__bar', [
      el('span.denial__badge', 'DENIED'),
      el('span.denial__heading', heading),
      el('span.denial__status', error?.status ? `HTTP ${error.status}` : ''),
    ]),
    el('div.denial__body', [
      el('div.denial__code', [el('span.denial__code-label', 'Reason code'), el('code', code)]),
      el('p.denial__plain', explain(code, error?.message)),
      details?.reason && details.reason !== code
        ? el('p.denial__detail', [
            el('strong', 'Directory reason: '),
            el('code', String(details.reason)),
            ' — ',
            explain(details.reason, ''),
          ])
        : null,
      Array.isArray(details?.missing) && details.missing.length
        ? el('div.denial__detail', [
            el('strong', 'Missing particulars: '),
            el('span', details.missing.join(', ')),
          ])
        : null,
      Array.isArray(details?.fields) && details.fields.length
        ? el('div.denial__detail', [
            el('strong', 'Fields at fault: '),
            el('span', details.fields.join(', ')),
          ])
        : null,
      details?.remedy ? el('p.denial__detail', String(details.remedy)) : null,
      el('p.denial__logged', 'This decision has been written to the audit log.'),
    ]),
  ]);
}

/** Render an error into a container, choosing the right presentation for it. */
export function showError(container, error) {
  mount(container, denial(error, { heading: error?.status === 403 ? 'Access denied' : 'Request refused' }));
}

// ------------------------------------------------------- the three claims ----

/**
 * AI triage. "Review Priority", and nothing that could be read as a verdict.
 *
 * The disclaimer travels with the badge by construction: this function renders both
 * or neither, so a priority cannot appear on screen without it.
 */
export function reviewPriority(triage, { showIndicators = true } = {}) {
  if (!triage?.priority) return el('span.muted', 'Not triaged');
  const priority = String(triage.priority).toUpperCase();

  return el('div.triage', [
    el('div.triage__row', [
      el('span.triage__label', 'Review Priority'),
      el(`span.triage__badge.triage__badge--${priority.toLowerCase()}`, priority),
    ]),
    showIndicators && Array.isArray(triage.indicators) && triage.indicators.length
      ? el(
          'ul.triage__indicators',
          triage.indicators.map((i) => el('li', String(i)))
        )
      : null,
    el(
      'p.triage__disclaimer',
      triage.disclaimer ??
        'Automated triage only. Not expert opinion under BSA s.39 / IT Act s.79A.'
    ),
  ]);
}

/**
 * The laboratory's opinion. The only authenticity claim in the system.
 *
 * Rendered as a bordered, attributed statement rather than a badge, so that it can
 * never be mistaken for the triage chip above at a glance from the back of a room.
 */
export function forensicOpinion(forensic) {
  const status = forensic?.status ?? 'NOT_REFERRED';
  if (status !== 'REPORT_FILED' || !forensic?.opinion) {
    return el('div.forensic.forensic--pending', [
      el('div.forensic__kicker', 'Forensic examination'),
      el('div.forensic__status', humanise(status)),
      el(
        'p.forensic__note',
        'No section 79A laboratory opinion has been filed. Authenticity is undetermined — automated triage is not a substitute.'
      ),
    ]);
  }

  const opinion = String(forensic.opinion).toUpperCase();
  return el(`div.forensic.forensic--${opinion.toLowerCase()}`, [
    el('div.forensic__kicker', 'Forensic opinion — expert evidence'),
    el('div.forensic__opinion', opinion),
    el('div.forensic__attribution', [
      el('div', [el('strong', 'Laboratory: '), forensic.labName ?? forensic.labId ?? '—']),
      el('div', [
        el('strong', 'IT Act s.79A notification: '),
        el('code', forensic.section79ARef ?? 'not recorded'),
      ]),
      forensic.examinerName ? el('div', [el('strong', 'Examiner: '), forensic.examinerName]) : null,
      forensic.reportedAt ? el('div', [el('strong', 'Filed: '), fmtDate(forensic.reportedAt)]) : null,
    ]),
    forensic.examinationSummary ? el('p.forensic__summary', forensic.examinationSummary) : null,
    el(
      'p.forensic__note',
      'This is expert opinion under BSA s.39, given by a notified laboratory. It is independent of, and takes precedence over, automated review prioritisation.'
    ),
  ]);
}

// --------------------------------------------------------------- anchoring ----

const ANCHOR_NETWORK = 'monad-testnet';
const ANCHOR_CHAIN_ID = 10143;
const EXPLORER = 'https://testnet.monadexplorer.com';

export const anchorTxLink = (txHash, url) =>
  !txHash
    ? el('span.muted', 'not yet submitted')
    : el(
        'a.link',
        { href: url || `${EXPLORER}/tx/${txHash}`, target: '_blank', rel: 'noopener noreferrer' },
        shortHash(txHash, 14)
      );

/**
 * A batch computed but never sent. `DRY_RUN` means the Merkle root was built and
 * recorded locally and NOTHING was submitted to any chain.
 */
const isDryRun = (anchor) => anchor?.status === 'DRY_RUN' || (anchor?.anchored && !anchor?.txHash);

/**
 * The anchoring panel.
 *
 * Three things must be on screen every time anchoring is mentioned: the exact network
 * (this is Monad Testnet, chain 10143), the fact that a Merkle root is the only thing
 * published, and — the one added after review — whether the root was actually SENT.
 *
 * The first two are hard-coded here rather than taken from the payload so that a stale
 * server value cannot soften either. The third has to come from the payload, because
 * it is a fact about this deployment; but it is rendered as a banner above the table
 * rather than as a status pill inside it, because `DRY_RUN` sitting quietly in a
 * `Status` row next to a populated Merkle root reads, to anyone not looking for it, as
 * "anchored". A viewer who takes an unanchored root for an anchored one has been
 * misled about the single strongest claim on the page.
 */
export function anchorPanel(anchor) {
  const rows = [
    ['Network', el('code', ANCHOR_NETWORK)],
    ['Chain ID', el('code', String(ANCHOR_CHAIN_ID))],
  ];

  if (anchor?.anchored === false || !anchor) {
    rows.push(['Latest batch', el('span.muted', 'No batch has been anchored yet')]);
  } else {
    rows.push(
      ['Batch', el('code', anchor.batchId ?? '—')],
      ['Merkle root', hash(anchor.merkleRoot)],
      ['Ledger range', `seq ${anchor.fromSeq ?? '—'} – ${anchor.toSeq ?? '—'} (${anchor.leafCount ?? '—'} entries)`],
      ['Status', el('span.pill', anchor.status ?? '—')],
      ['Transaction', anchorTxLink(anchor.txHash, anchor.explorerUrl)],
      ['Block', anchor.blockNumber ?? '—'],
      ['Anchored at', fmtDate(anchor.anchoredAt)]
    );
    if (anchor.contractAddress) rows.push(['Contract', el('code', anchor.contractAddress)]);
  }

  const banner = isDryRun(anchor)
    ? el('div.notice.notice--warn', [
        el('strong', 'DRY RUN — this root has NOT been written to any chain. '),
        'The Merkle root below was computed and recorded locally only; no transaction was submitted, ',
        'so there is nothing on Monad Testnet to check it against. ',
        'Anchoring is off in this deployment (ANCHOR_ENABLED=false).',
      ])
    : null;

  return el('div.anchor', [
    banner,
    kv(rows),
    el('p.anchor__statement', [
      el('strong', 'Only the Merkle root is written on chain. '),
      'No evidence, no file contents, no personal data, no case identifiers and no triage output are published. ',
      'The root proves that a set of ledger entries existed at a point in time and has not changed since; it discloses nothing about them.',
    ]),
  ]);
}

// ---------------------------------------------------------------- download ----

/**
 * Hand the user a file the browser generated. Used for the upload receipt, which is
 * the officer's own independent copy of what they submitted.
 */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename, data) {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

// ---------------------------------------------------------------- async ----

/**
 * Run an async action with a busy state and a single place for error rendering, so
 * no page has to repeat the try/catch/spinner dance.
 */
export async function run(target, action, { busy = 'Working…' } = {}) {
  mount(target, spinner(busy));
  try {
    const result = await action();
    return { ok: true, result };
  } catch (error) {
    showError(target, error);
    return { ok: false, error };
  }
}

/**
 * Disable a button for the duration of an action.
 *
 * The two mutations go through `setBusy` rather than being written inline after the
 * `await`: it keeps the state change in one place, and it is the shape the
 * `require-atomic-updates` rule is looking for.
 */
const setBusy = (btn, disabled, label) => {
  btn.disabled = disabled;
  btn.textContent = label;
};

export async function withBusy(btn, label, action) {
  const original = btn.textContent;
  setBusy(btn, true, label);
  try {
    return await action();
  } finally {
    setBusy(btn, false, original);
  }
}
